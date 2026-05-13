# sentry-lighthouse

Self-hosted Lighthouse lab for [`getsentry/sentry-javascript`](https://github.com/getsentry/sentry-javascript). Accepts prebuilt SDK test-app bundles from GitHub Actions, runs Lighthouse on stable hardware, ships every run to Sentry as a distribution metric.

## Hosted

- **Public URL:** <https://lighthouse.sentry.gg> — the upload endpoint CI posts to and the read API.
- **Northflank service:** [`sentry / sentry-lighthouse / sentry-lighthouse`](https://app.northflank.com/o/sentry/t/davidsentrys-team/project/sentry-lighthouse/services/sentry-lighthouse) — build logs, env vars, volume, restarts.
- **Sentry project:** metrics land in `o447951` under the `lighthouse.*` namespace (see [Metrics shipped to Sentry](#metrics-shipped-to-sentry) below).

Liveness check: `curl https://lighthouse.sentry.gg/healthz`.

## Why a dedicated service?

Google's own Lighthouse docs are explicit that shared-tenancy CI runners are the #1 cause of measurement variance. Running Lighthouse on `ubuntu-latest` produced run-to-run jitter (`+2 / -5` on the same code) that drowned the signal we care about. Moving the measurement onto a single-tenant Northflank instance with a pinned Chrome version makes the noise go away — a recent fixture run on the deployed service had a 5-run LCP spread of 80 ms vs ~200 ms+ typical on shared runners.

## Architecture

```
                ┌──────────────────────────────────────────┐
                │   sentry-lighthouse container             │
                │                                          │
   GitHub CI ─► │  src/server.js                           │
   POST bundle  │   • Fastify HTTP (8080)                  │
                │   • bearer-auth on uploads               │
                │   • SQLite queue                         │
                │   • Worker: lhci collect, 1 cell at a    │
                │     time, writes LHR JSON + HTML to      │
                │     /data/reports/<runId>/               │
                │   • Periodic bundle retention sweep      │
                │                                          │
                │  src/publisher.js                        │
                │   • Polls cells WHERE published_at IS    │
                │     NULL                                 │
                │   • @sentry/node Sentry.metrics.*        │
                │   • One distribution envelope per run    │
                │     per metric (score/lcp/fcp/tbt/cls/   │
                │     bytes)                               │
                │   • Marks published_at after flush       │
                │                                          │
                │  src/supervisor.js                       │
                │   • PID 1; spawns both children, fans    │
                │     out SIGTERM, exits if either dies    │
                │                                          │
                │  Persistent volume /data                 │
                │   ├─ db.sqlite                           │
                │   ├─ builds/<buildId>/<app>-<mode>.tgz   │
                │   └─ reports/<runId>/{lhr-N.json,        │
                │                       report.html}       │
                └──────────────────────────────────────────┘
                                  │
                                  ▼ metrics over HTTPS
                          ┌────────────────┐
                          │  Sentry org    │
                          │  (dashboards)  │
                          └────────────────┘
```

The container is one image, two long-running Node processes, one SQLite file. No Postgres, no Redis, no message queue, no SPA.

## Quick start (local)

```bash
# 1. Install deps (Node 22.22.2 pinned via .node-version)
pnpm install

# 2. Configure
cp .env.example .env
echo "UPLOAD_TOKEN=$(openssl rand -hex 32)" >> .env
# Optionally set SENTRY_DSN to actually ship to Sentry. Without one, the
# publisher still runs but emits nothing (useful when iterating).

# 3. Run (server + publisher under one supervisor)
pnpm dev
# → http://localhost:8080/healthz

# 4. Trigger an end-to-end fixture run (one tiny static cell)
pnpm fixture:upload
```

To run the fixture against the deployed service instead of localhost:

```bash
LAB_URL=https://lighthouse.sentry.gg \
  UPLOAD_TOKEN=<token from Northflank env> \
  pnpm fixture:upload
```

Individual processes if you're debugging:

```bash
pnpm dev:server     # just the HTTP server + worker
pnpm dev:publisher  # just the publisher (against an existing DB)
```

## Quick start (Docker)

```bash
pnpm docker:build      # bakes `git rev-parse --short HEAD` in as GIT_SHA
pnpm docker:run
```

`docker:run` mounts `./data` so SQLite + reports persist between container restarts.

## HTTP API

All write endpoints require `Authorization: Bearer $UPLOAD_TOKEN`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Liveness + queue depth (`queue.queued`, `running`, `pendingPublish`) |
| `POST` | `/api/builds` | bearer | Upload (multipart): `metadata` JSON field + one tar.gz per cell |
| `GET` | `/api/builds` | none | Paginated list of recent builds |
| `GET` | `/api/builds/:buildId` | none | Build detail with every cell's runs + reportUrls |
| `POST` | `/api/builds/:buildId/rerun` | bearer | Re-enqueue all cells using the stored tarballs |
| `GET` | `/api/runs/:runId/report.html` | none | Lighthouse HTML report for one run |

## Metrics shipped to Sentry

Per Lighthouse run (default 5 per cell):

| Metric | Type | Unit |
| --- | --- | --- |
| `lighthouse.score` | distribution | `ratio` |
| `lighthouse.lcp` | distribution | `millisecond` |
| `lighthouse.fcp` | distribution | `millisecond` |
| `lighthouse.tbt` | distribution | `millisecond` |
| `lighthouse.cls` | distribution | — |
| `lighthouse.bytes` | distribution | `byte` |
| `lighthouse.cell.completed` | counter | — |

Attributes attached to every envelope: `app`, `mode`, `branch`, `commit`, `serve_mode`, `run_index`. Sentry's distribution histograms compute p50/p90/p99 in the dashboard — we don't pre-aggregate.

## Config (env vars)

See [`.env.example`](./.env.example). Required: `UPLOAD_TOKEN`. Recommended: `SENTRY_DSN`. Everything else has sensible defaults.

## Deployment (Northflank)

The live deployment is configured per the table below. To stand up another instance, point a Northflank service at this Dockerfile and match these settings:

| Setting | Value |
| --- | --- |
| Image | this Dockerfile (build from repo) |
| Build args | `GIT_SHA=${CI_GIT_COMMIT_SHORT_SHA}` so `/healthz` reports the real commit |
| Ports | `8080` → public HTTPS |
| Volume | 20 GB persistent volume mounted at `/data` — not optional, holds SQLite + bundles + reports |
| Resources | 2 vCPU / 4 GB RAM (matches Lighthouse's hardware recommendation) |
| Healthcheck | `GET /healthz` every 30s |
| Secrets | `UPLOAD_TOKEN`, `SENTRY_DSN` |
| Env | `SENTRY_ENVIRONMENT=production` (the rest have sensible defaults in the Dockerfile) |

The CI side (the `sentry-javascript` workflow that builds test apps and POSTs them here) lives in a separate PR. The full hand-off doc for that work — API contract, bundle format, file-by-file checklist of what to change in `sentry-javascript` — is in [`docs/sentry-javascript-handoff.md`](./docs/sentry-javascript-handoff.md).
