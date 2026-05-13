# sentry-lhci

Self-hosted Lighthouse lab for [`getsentry/sentry-javascript`](https://github.com/getsentry/sentry-javascript). Accepts prebuilt SDK test-app bundles from GitHub Actions, runs Lighthouse on stable hardware, ships every run to Sentry as a distribution metric.

See [`PLAN.md`](./PLAN.md) for the original design rationale (the "why dedicated hardware" answer). One thing has changed since: instead of building our own HTML dashboard, we ship metrics to Sentry's new metrics product and let Sentry's dashboards take over visualisation.

## Architecture

```
                ┌──────────────────────────────────────────┐
                │   sentry-lhci container (Northflank)     │
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

- Image: this Dockerfile, baked with `GIT_SHA` build-arg
- Volume: 20 GB mounted at `/data`
- Ports: expose 8080 only
- Secrets: `UPLOAD_TOKEN`, `SENTRY_DSN`
- Resources: 2 vCPU / 4 GB RAM (matches Lighthouse's hardware recommendation)
- Healthcheck: `GET /healthz` every 30s

The CI side (the `sentry-javascript` workflow that builds test apps and POSTs them here) is tracked separately — see [`PLAN.md`](./PLAN.md) → "Companion changes in `sentry-javascript`".
