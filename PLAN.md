# Sentry Lighthouse Lab — Plan

A small self-hosted service that runs Lighthouse audits on prebuilt Sentry SDK test apps it receives from GitHub Actions. Deployed as a single Docker container on Northflank. Replaces the current in-CI Lighthouse jobs in `getsentry/sentry-javascript` (PR #20850) because shared GitHub-hosted runners are too flaky for stable Lighthouse measurements.

The CI pipeline in `sentry-javascript` will be repurposed to **build** the test apps and **upload** them; everything else — running Lighthouse, storing reports, displaying trends — moves here.

---

## Why this exists

Google's own Lighthouse docs are explicit: shared-tenancy / burstable CI runners are the #1 cause of LHCI variance ([variability.md](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)). `ubuntu-latest` / `ubuntu-24.04-large-js` runners on GitHub Actions are exactly that. Even with 5-run median aggregation, we're seeing run-to-run score jitter (`+2 / -5` on the same code) in PR #20850 — that's *measurement noise*, not signal.

This service is a dedicated single-tenant Northflank VM (Northflank provides consistent compute, no noisy neighbors). Same hardware every night, same Chrome version, no cold caches, no shared CPU. The measurement-noise problem goes away.

---

## Scope (MVP)

### In scope

- HTTP API to receive prebuilt test-app bundles from CI
- A worker that runs Lighthouse against each (app, mode) cell with 5 runs + median aggregation
- SQLite-backed history of builds, runs, and per-cell results
- Read-only HTML dashboard at `/` showing recent builds, score trends, links to full HTML Lighthouse reports
- Token-auth on the upload endpoint
- Single Docker image deployable to Northflank with a persistent volume

### Test apps (matrix)

| App slug | Type | Source in `sentry-javascript` |
|---|---|---|
| `default-browser` | static (webpack output) | `dev-packages/e2e-tests/test-applications/default-browser` |
| `nextjs-16` | SSR (next start) | `dev-packages/e2e-tests/test-applications/nextjs-16` |
| `react-19` | static (CRA output) | `dev-packages/e2e-tests/test-applications/react-19` |

### Modes (per app)

| Mode | What's tested |
|---|---|
| `no-sentry` | App built with `SENTRY_LIGHTHOUSE_MODE=no-sentry` — SDK dynamically excluded |
| `init-only` | `Sentry.init({ dsn })` with no integrations |
| `tracing-replay` | `Sentry.init` with `browserTracingIntegration` + `replayIntegration` |

Total matrix: **3 apps × 3 modes = 9 cells per build**. Lighthouse is run 5x per cell with simulated throttling, so 45 individual Lighthouse runs per build. At ~20s per run (apps are small), that's **~15 minutes per build** if runs are serialized (recommended — Google says never run multiple Lighthouse instances on one machine at the same time).

### Out of scope (MVP)

- Multi-project support (this server is single-purpose: sentry-javascript Lighthouse)
- Comparison UI ("diff PR vs develop") — the existing LHCI server has this; we can swap in `@lhci/server` later if we want it
- Per-PR runs (we run on nightly + manual triggers only)
- Slack/email notifications
- Public-facing dashboard (gated behind basic auth or VPN)
- Trend charts beyond a simple time-series table (can add Recharts later)

---

## Architecture

```
                        ┌────────────────────────────────────────┐
                        │   Northflank: sentry-lighthouse-lab    │
                        │   ┌─────────────────────────────────┐  │
                        │   │  Fastify HTTP server (Node)     │  │
   GitHub Actions       │   │                                 │  │
   nightly build  ─────►│──►│  POST /api/builds (multipart)   │  │
   uploads bundles      │   │  POST /api/builds/:id/run       │  │
                        │   │  GET  /api/builds               │  │
                        │   │  GET  /api/builds/:id           │  │
                        │   │  GET  /api/runs/:id/report.html │  │
                        │   │  GET  /  (dashboard)            │  │
                        │   └──────────────┬──────────────────┘  │
                        │                  │                      │
                        │   ┌──────────────▼──────────────────┐  │
   Browser (you) ──────►│──►│  In-process queue + worker     │  │
   reads dashboard      │   │  – unpacks bundles              │  │
                        │   │  – starts each app              │  │
                        │   │  – runs lhci collect (5 runs)  │  │
                        │   │  – writes results to SQLite     │  │
                        │   └──────────────┬──────────────────┘  │
                        │                  │                      │
                        │   ┌──────────────▼──────────────────┐  │
                        │   │  Persistent volume /data        │  │
                        │   │  ├─ db.sqlite                   │  │
                        │   │  ├─ builds/<buildId>/           │  │
                        │   │  │   └─ <app>-<mode>.tar.gz    │  │
                        │   │  └─ reports/<runId>/            │  │
                        │   │      ├─ lhr-1.json … lhr-5.json│  │
                        │   │      └─ report-<repr>.html      │  │
                        │   └─────────────────────────────────┘  │
                        └────────────────────────────────────────┘
```

Everything is in **one container**, **one process** for MVP. The HTTP server and the worker share a single Node event loop and an in-memory job queue. This is fine for the load profile (one nightly build, occasional manual triggers).

If we ever need to scale: extract the worker to its own container, replace the in-memory queue with Redis or a Northflank job, swap SQLite for Postgres. Not now.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS | Matches `sentry-javascript`; Lighthouse needs Node ≥ 18 |
| HTTP server | Fastify 5.x | Lighter than Express, native multipart support via `@fastify/multipart`, schema validation built in |
| Lighthouse | `@lhci/cli` 0.15.x | Same tool the existing PR uses — same `lighthouserc.cjs` config carries over |
| Chrome | Bundled into image via `playwright-chromium` or `puppeteer` | Pinned Chrome version = reproducible across runs |
| Storage (DB) | SQLite via `better-sqlite3` | Zero infra, fits the load, file lives on the persistent volume |
| Storage (files) | Native fs on `/data` volume | Tarballs and HTML reports |
| Auth | Bearer token via `@fastify/bearer-auth` | Single shared upload token, env-configurable |
| Dashboard | Server-rendered HTML via Fastify + tiny inline CSS, optional Alpine.js for sorting | No SPA, no build step |
| Tarball handling | `tar` package | Streaming extract |
| Process management | None — single Node process, exit-on-crash, Northflank restarts | Simple |

**No** ORM, **no** frontend framework, **no** Postgres. The point is to keep this so small the user can read all the code in an afternoon.

---

## Repository layout

```
sentry-lhci/
├── PLAN.md                          # this file
├── README.md                        # quick start, deploy notes
├── Dockerfile
├── .dockerignore
├── package.json
├── pnpm-lock.yaml                   # or package-lock.json — TBD
├── tsconfig.json
├── src/
│   ├── server.ts                    # Fastify app bootstrap
│   ├── routes/
│   │   ├── builds.ts                # POST /api/builds, GET /api/builds, GET /api/builds/:id
│   │   ├── runs.ts                  # GET /api/runs/:id, GET /api/runs/:id/report.html
│   │   └── dashboard.ts             # GET / (HTML)
│   ├── worker/
│   │   ├── queue.ts                 # in-memory FIFO queue + persistence to SQLite
│   │   ├── runner.ts                # main worker loop
│   │   ├── lighthouse.ts            # invoke lhci collect, parse manifest
│   │   └── app-server.ts            # spin up the test app (static or SSR)
│   ├── db/
│   │   ├── schema.sql               # CREATE TABLE statements
│   │   ├── migrations/              # numbered .sql files
│   │   └── index.ts                 # better-sqlite3 instance + helpers
│   ├── lib/
│   │   ├── auth.ts                  # bearer token verification
│   │   ├── config.ts                # env var parsing
│   │   ├── logger.ts                # pino logger
│   │   └── paths.ts                 # filesystem paths (/data/builds/…, etc.)
│   └── types.ts                     # shared TS types: Build, Run, Cell, etc.
├── views/
│   ├── layout.html                  # base HTML template
│   ├── dashboard.html               # build list
│   └── build.html                   # single build detail
├── lighthouserc.cjs                 # shared LHCI config (mirrors sentry-javascript)
└── scripts/
    ├── dev.sh                       # nodemon-style dev runner
    └── migrate.sh                   # apply migrations
```

---

## HTTP API contract

All authenticated endpoints require `Authorization: Bearer <UPLOAD_TOKEN>` (config below). The dashboard and read endpoints can be optionally gated behind HTTP basic auth (separate creds, set via env).

### `POST /api/builds`

Upload a build. Multipart form-data with:

| Field | Type | Description |
|---|---|---|
| `metadata` | JSON string | See schema below |
| `bundle` | file (repeated, one per cell) | tar.gz of the prebuilt app for one (app, mode) cell |

**`metadata` schema:**

```json
{
  "commit": "06f87a5f7…",
  "branch": "feat/lighthouse-ci",
  "triggeredBy": "github-actions",
  "workflowRunUrl": "https://github.com/getsentry/sentry-javascript/actions/runs/12345",
  "cells": [
    {
      "app": "default-browser",
      "mode": "no-sentry",
      "bundleField": "bundle-0",
      "serve": "static",
      "staticDir": "build",
      "url": "http://localhost:3000/"
    },
    {
      "app": "nextjs-16",
      "mode": "tracing-replay",
      "bundleField": "bundle-3",
      "serve": "server",
      "startCmd": "pnpm start",
      "readyPattern": "Ready in",
      "url": "http://localhost:3000/"
    }
  ]
}
```

`bundleField` is the form field name of the corresponding tar.gz upload, so the server can match metadata → file across the multipart parts.

**Response:** `202 Accepted`

```json
{
  "buildId": "01HXXXX…",
  "status": "queued",
  "buildUrl": "/api/builds/01HXXXX…",
  "dashboardUrl": "/builds/01HXXXX…"
}
```

The server enqueues all cells and returns immediately. CI does not block on Lighthouse completion.

**Bundle format (per cell):**

A gzipped tar of the entire `test-application/` directory **after** `pnpm test:build` has run. Includes:
- `node_modules/` — yes, the whole tree (so the server doesn't need to `pnpm install`)
- Built output (`build/`, `dist/`, or `.next/`)
- `package.json`, lockfile, config files
- Public assets

Yes the bundles will be large (estimated 100–500 MB compressed per cell). That's fine — it's an internal pipeline. We can revisit later if storage becomes an issue (the SDK tarballs are the same across modes, so dedup is possible).

### `GET /api/builds`

List recent builds, newest first. Query params: `?limit=50&before=<buildId>` for pagination.

```json
{
  "builds": [
    {
      "buildId": "01HXXXX…",
      "commit": "06f87a5f7",
      "branch": "feat/lighthouse-ci",
      "createdAt": "2026-05-13T00:00:00Z",
      "status": "completed",
      "cellsTotal": 9,
      "cellsCompleted": 9,
      "cellsFailed": 0
    }
  ]
}
```

### `GET /api/builds/:buildId`

Build detail, including all cells and their median run results.

```json
{
  "buildId": "01HXXXX…",
  "commit": "06f87a5f7",
  "branch": "feat/lighthouse-ci",
  "createdAt": "2026-05-13T00:00:00Z",
  "completedAt": "2026-05-13T00:15:02Z",
  "status": "completed",
  "cells": [
    {
      "cellId": "01HYYYY…",
      "app": "default-browser",
      "mode": "no-sentry",
      "status": "completed",
      "runs": 5,
      "medianRun": {
        "performanceScore": 1.0,
        "lcp": 754,
        "tbt": 12,
        "totalBytes": 3072,
        "reportUrl": "/api/runs/01HZZZZ…/report.html"
      }
    }
  ]
}
```

### `GET /api/runs/:runId/report.html`

Returns the full Lighthouse HTML report for a single run (the representative one from the 5-run set). Content-Type: `text/html`.

### `GET /` and `GET /builds/:buildId`

Server-rendered HTML dashboard. See "Dashboard" below.

### `POST /api/builds/:buildId/rerun` (nice-to-have)

Re-enqueues a build using the previously uploaded bundles. Useful when you want to verify a flaky-looking result.

---

## Storage schema

SQLite via `better-sqlite3` (synchronous, fast, single-file). One database file: `/data/db.sqlite`.

```sql
CREATE TABLE builds (
  build_id          TEXT PRIMARY KEY,            -- ULID
  commit_sha        TEXT NOT NULL,
  branch            TEXT NOT NULL,
  triggered_by      TEXT,                        -- 'github-actions' | 'manual'
  workflow_run_url  TEXT,                        -- nullable
  created_at        TEXT NOT NULL,               -- ISO 8601
  completed_at      TEXT,                        -- ISO 8601, NULL while running
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);
CREATE INDEX builds_created_at ON builds(created_at DESC);

CREATE TABLE cells (
  cell_id           TEXT PRIMARY KEY,            -- ULID
  build_id          TEXT NOT NULL REFERENCES builds(build_id) ON DELETE CASCADE,
  app               TEXT NOT NULL,
  mode              TEXT NOT NULL,               -- 'no-sentry' | 'init-only' | 'tracing-replay'
  serve_mode        TEXT NOT NULL,               -- 'static' | 'server'
  bundle_path       TEXT NOT NULL,               -- absolute path under /data/builds/<buildId>/
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error             TEXT,                        -- failure message, nullable
  started_at        TEXT,
  completed_at      TEXT
);
CREATE INDEX cells_build_id ON cells(build_id);

CREATE TABLE runs (
  run_id            TEXT PRIMARY KEY,            -- ULID
  cell_id           TEXT NOT NULL REFERENCES cells(cell_id) ON DELETE CASCADE,
  run_index         INTEGER NOT NULL,            -- 1..5
  is_representative INTEGER NOT NULL DEFAULT 0,  -- the LHCI median-run pick
  -- Key metrics (denormalized for fast dashboard queries; full LHR in JSON files)
  performance_score REAL,                        -- 0..1
  lcp_ms            INTEGER,
  fcp_ms            INTEGER,
  tbt_ms            INTEGER,
  cls               REAL,
  total_bytes       INTEGER,
  lhr_json_path     TEXT NOT NULL,               -- path under /data/reports/<runId>/
  report_html_path  TEXT,                        -- path to .html report, nullable
  collected_at      TEXT NOT NULL
);
CREATE INDEX runs_cell_id ON runs(cell_id);
CREATE INDEX runs_cell_id_representative ON runs(cell_id, is_representative);
```

Filesystem layout under `/data`:

```
/data/
├── db.sqlite
├── builds/
│   └── 01HXXXX…/                    # buildId
│       ├── default-browser-no-sentry.tar.gz
│       ├── default-browser-init-only.tar.gz
│       └── … (one per cell)
└── reports/
    └── 01HZZZZ…/                    # runId
        ├── lhr-1.json
        ├── lhr-2.json
        ├── lhr-3.json
        ├── lhr-4.json
        ├── lhr-5.json
        └── lhr-3.report.html        # representative run, HTML report
```

We keep the bundles for 7 days, then a cleanup cron deletes them (the analyzed results stay forever in SQLite + reports stay on disk indefinitely until disk usage warrants cleanup).

---

## Worker / runner

A single async loop pulls from the `cells` table (`status = 'queued'` ordered by `created_at`), processes one cell at a time, and updates rows.

### Per-cell flow

```
1. Mark cell row: status='running', started_at=NOW
2. Make a temp dir: /tmp/lhci-cell-<cellId>/
3. tar -xzf <bundle_path> -C /tmp/lhci-cell-<cellId>/
4. If serve_mode === 'static':
     – Start a tiny static server (http-server or built-in) on port 3000
       pointing at /tmp/lhci-cell-<cellId>/<staticDir>
   else if serve_mode === 'server':
     – exec startCmd in the temp dir
     – tail stdout, wait for readyPattern (regex) for up to 60s
5. Run `npx -y @lhci/cli@0.15.x collect --url=http://localhost:3000/ \
                                        --numberOfRuns=5 \
                                        --settings.chromeFlags="--no-sandbox --headless=new" \
                                        --settings.onlyCategories=performance`
   – Output lands in <tempDir>/.lighthouseci/
6. Parse manifest.json:
     – For each lhr-*.json:
         * Insert a `runs` row with metrics
         * Move the file to /data/reports/<runId>/lhr-<index>.json
     – Find the `isRepresentativeRun` entry, set is_representative=1 on that row
     – Move that run's .html report alongside
7. Shut down the app server (SIGTERM, then SIGKILL after 5s)
8. rm -rf /tmp/lhci-cell-<cellId>/
9. Mark cell row: status='completed', completed_at=NOW
10. If all cells for build are done → mark build completed
```

Failure paths:
- `tar` extract fails → cell `status='failed'`, error stored, move on
- App server doesn't print `readyPattern` within 60s → SIGKILL, fail cell
- `lhci collect` exits non-zero → fail cell
- Any error → log to stderr (Northflank captures), cell marked failed, worker continues to the next cell

The worker does **not** retry. Manual rerun is available via `POST /api/builds/:id/rerun` if needed.

### Concurrency

**One cell at a time.** Per Google's variability docs: running multiple Lighthouse instances simultaneously on the same machine destroys measurement validity. We serialize.

### Ports

- `3000` — the test app being measured (reused across cells; only one cell runs at a time)
- `8080` (or `process.env.PORT`) — the Fastify HTTP server (Northflank-facing)

---

## Dashboard

Server-rendered HTML, no SPA. Two pages:

### `/`

A reverse-chronological list of recent builds. Columns:
- Date / time
- Commit (short SHA, links to GitHub)
- Branch
- Status (✅ completed / 🟡 running / ❌ failed)
- # cells completed / total
- Median performance score (averaged across cells, sparkline if we get fancy)

Click a row → `/builds/:buildId`.

### `/builds/:buildId`

Single build detail. For each app, a section showing the 3 modes side-by-side:

```
┌─── default-browser ────────────────────────────────────────┐
│  Mode            Score   LCP      TBT      Bytes   Report  │
│  no-sentry       100     754ms    12ms     3KB     [view]  │
│  init-only       95      1400ms   25ms     87KB    [view]  │
│  tracing-replay  88      1500ms   85ms     220KB   [view]  │
│                                                            │
│  Δ (SDK):     -5 / +646ms / +13ms / +84KB                  │
│  Δ (Features): -7 / +100ms / +60ms / +133KB                │
└────────────────────────────────────────────────────────────┘
```

Plus a small trend chart per cell: scores from the last 30 builds. Implementation note: do this with inline SVG generated server-side from SQL `SELECT performance_score FROM runs WHERE cell_id IN (…) ORDER BY collected_at LIMIT 30`. No chart library needed.

### Auth on the dashboard

Optional HTTP Basic auth (`DASHBOARD_USERNAME` + `DASHBOARD_PASSWORD` env vars). If unset, dashboard is public — fine if Northflank gates the public URL.

---

## Authentication & security

### Upload token

One env var: `UPLOAD_TOKEN`. CI sends `Authorization: Bearer $UPLOAD_TOKEN`. Without a valid token, `POST /api/builds` returns 401.

The token is just a long random string. Generated once during deployment, stored in Northflank secrets, mirrored as a GitHub Actions repo secret (`LIGHTHOUSE_LAB_TOKEN`) in `sentry-javascript`.

### Threat model

- **Anyone with the upload token can push arbitrary tar.gz files.** Mitigation: token lives in Northflank + GitHub secrets, never in source. Server validates tar extraction stays within `/tmp/<cellId>/` (no `../` traversal). Server has a max upload size limit (e.g., 600 MB per file).
- **Anyone with the dashboard URL can read all reports.** Mitigation: basic auth (optional) or Northflank IP allowlist. Reports don't contain user data (test apps use synthetic DSNs), so the leak surface is small.
- **Worker runs arbitrary code (the uploaded apps).** Mitigation: the entire container is the security boundary — it's our code being uploaded by our CI. Don't expose this server to public uploads. If we ever did, sandbox via container-per-run or Firecracker.

### Network exposure

Northflank-facing port: just the Fastify server. The test app on `localhost:3000` is bound to `127.0.0.1`, never exposed externally.

---

## Deployment on Northflank

The user handles the actual Northflank deployment. The plan only ensures the image is Northflank-friendly.

### Northflank concepts we need

- **Service**: the long-running Docker container (1 instance, no autoscaling)
- **Volume**: a persistent volume mounted at `/data` (size: start with 20 GB, grow as needed)
- **Port**: expose 8080 (Fastify) to public HTTPS
- **Secrets**: `UPLOAD_TOKEN`, optional `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`
- **Resources**: 2 vCPU, 4 GB RAM minimum (matches Google's Lighthouse hardware recommendation: 2 dedicated cores, 4 GB RAM)

### Environment variables

| Name | Required | Description |
|---|---|---|
| `PORT` | yes (Northflank sets it) | Fastify listen port |
| `DATA_DIR` | no, default `/data` | Persistent storage root |
| `UPLOAD_TOKEN` | yes | Bearer token CI uses to upload |
| `DASHBOARD_USERNAME` | no | If set, dashboard is behind basic auth |
| `DASHBOARD_PASSWORD` | no | Required if username is set |
| `MAX_UPLOAD_BYTES` | no, default `629145600` (600 MB) | Per-file size limit |
| `BUNDLE_RETENTION_DAYS` | no, default `7` | How long to keep build tarballs |
| `LOG_LEVEL` | no, default `info` | pino log level |

### Healthcheck

`GET /healthz` returns `200 OK` with body `{"ok": true, "version": "<sha>"}`. Northflank pings this every 30s.

### Auto-restart

Northflank restarts on crash. The worker resumes by querying `cells WHERE status='running'` on startup, marking them `failed` (a cell that was mid-run when the container died can't be safely resumed — its temp dir is gone).

---

## Dockerfile

```dockerfile
FROM node:22-bookworm-slim

# Chrome dependencies + Chromium (Playwright bundles a known-good Chrome version).
# We use playwright-chromium's bundled binary so the Chrome version is reproducible
# across rebuilds, instead of `apt install chromium` which floats.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 \
    libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
    tar gzip \
    && rm -rf /var/lib/apt/lists/*

# pnpm for running SSR apps that ship pnpm-lock.yaml
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

# Build TypeScript -> dist/
RUN pnpm build

# Pre-fetch Chrome via Playwright so the first run is fast
RUN npx playwright install chromium

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080

# Run migrations on boot, then start the server.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
```

`.dockerignore`:
```
node_modules
dist
.git
.vscode
*.log
.DS_Store
```

Final image size estimate: ~600–800 MB (mostly Chrome + node_modules). Acceptable.

---

## Local development

```bash
# Setup
pnpm install
cp .env.example .env
# edit .env to set UPLOAD_TOKEN

# Run migrations + start in watch mode
pnpm dev

# In another terminal — simulate a CI upload from a fixture
pnpm run e2e:upload-fixture
```

The `e2e:upload-fixture` script:
1. Builds a tiny static HTML "app" into `fixtures/example/build/`
2. Tars it into `fixtures/example.tar.gz`
3. POSTs it to `localhost:8080/api/builds` with a fake metadata JSON
4. Polls `/api/builds/<id>` until completed
5. Prints the dashboard URL

This is how an agent can verify the whole pipeline end-to-end locally without GitHub Actions.

---

## Implementation phases

This is the agent's checklist. Each phase is one PR / commit pile.

### Phase 1 — Skeleton

- Initialize repo: `package.json`, `tsconfig.json`, `pnpm-lock.yaml`
- Fastify server with `/healthz` only
- pino logger
- Dockerfile builds and the container boots
- SQLite migration runner (raw SQL files, no ORM)
- Schema in `src/db/schema.sql` matches the spec above
- Bearer auth middleware (just the upload routes, not the dashboard)
- README with "deploy on Northflank" notes

**Acceptance:** `docker build && docker run -p 8080:8080 -v $(pwd)/data:/data` works; `curl localhost:8080/healthz` returns 200.

### Phase 2 — Upload endpoint

- `POST /api/builds` accepts multipart with metadata JSON + N file fields
- Validates metadata against a JSON schema (Fastify's built-in schema validation)
- Stores tar.gz files under `/data/builds/<buildId>/`
- Inserts `builds` row + N `cells` rows (all `status='queued'`)
- Returns 202 with `buildId`
- `GET /api/builds` + `GET /api/builds/:buildId` (read-only, list + detail)

**Acceptance:** Local fixture script uploads a 3-cell build, dashboard shows it as queued. Tarballs are on disk.

### Phase 3 — Worker

- Background async loop: pull queued cells, process serially
- For each cell: extract tar, start app server (static or SSR), run `lhci collect`, parse results, write to DB
- Static app server: just `node` + `http-server` style (no need for express)
- SSR app server: `exec startCmd`, tail stdout, wait for `readyPattern`
- LHR JSON files written to `/data/reports/<runId>/`
- HTML report file moved alongside the median run's JSON
- Cleanup: temp dir removed after each cell, regardless of outcome

**Acceptance:** Upload a fixture build, watch `cells` table transition `queued → running → completed`. All metrics populated. Reports browsable on disk.

### Phase 4 — Dashboard

- `GET /` — recent builds list (server-rendered HTML)
- `GET /builds/:buildId` — single build detail with grouped tables per app
- Inline SVG sparkline for per-cell history (last 30 builds)
- `GET /api/runs/:runId/report.html` — serves the cached HTML report
- Optional HTTP Basic auth via env vars

**Acceptance:** Open `http://localhost:8080/`, see a list of builds. Click into one, see all 9 cells, click a "[view]" link, see the full Lighthouse HTML report.

### Phase 5 — Hardening

- Bundle retention cleanup cron (delete tarballs older than `BUNDLE_RETENTION_DAYS`)
- `POST /api/builds/:buildId/rerun`
- Graceful shutdown: SIGTERM → finish current cell, then exit
- Worker-recovery on startup: any cell `running` from before becomes `failed`
- Disk-full guard: if `/data` is >90% full, reject new uploads with 507

**Acceptance:** Container survives a kill -9 mid-run, the next start cleanly resumes the queue.

---

## Companion changes in `sentry-javascript`

These are out of scope for THIS plan but listed so we can plan them next:

1. **Delete `.github/workflows/lighthouse.yml`** (just landed in PR #20850). The nightly Lighthouse work moves out of the repo entirely.

2. **Add a new workflow `.github/workflows/lighthouse-bundle.yml`** that:
   - Triggers on the nightly schedule (`cron: '0 0 * * *'`) and `workflow_dispatch`
   - Does its own SDK build + tarball generation (same as the deleted lighthouse.yml)
   - For each (app, mode) cell in the matrix:
     - Copies the test app to a temp dir
     - Runs `pnpm test:build` with the right `SENTRY_LIGHTHOUSE_MODE` env var
     - Tars up the whole `runner.temp/test-application/` into `bundles/<app>-<mode>.tar.gz`
   - Posts all tarballs + a `metadata.json` to the new server via `curl` (or `actions/http-client`)
   - Reports the returned dashboard URL to the workflow summary

3. **Instrument `react-19`** with `SENTRY_LIGHTHOUSE_MODE` (currently in the original plan but never executed — `TODO-aeab11f0`).

4. **Delete `dev-packages/lighthouse-tests/`** entirely. The matrix, the report script, the lighthouserc — none of it is needed in `sentry-javascript` anymore. The lab repo owns the runner config.
   - Actually we still need a tiny `bundle-and-upload.mjs` script in `sentry-javascript` to drive step 2 above. It lives under `dev-packages/lighthouse-tests/` (rename to `lighthouse-bundle/`?) but most files go away.

5. **Secret `LIGHTHOUSE_LAB_TOKEN`** added to the repo, mirroring the Northflank `UPLOAD_TOKEN`.

6. **Secret `LIGHTHOUSE_LAB_URL`** with the Northflank service URL.

We'll plan this side properly once the server is partly functional.

---

## Open questions / decisions needed

1. **Which React app?** I propose `react-19` (Vite + React Router or CRA) because it's not yet instrumented and that's a clean greenfield. Alternative: `react-router-7-spa` (already instrumented but has the NO_FCP issue; might be fixed by stable hardware). **Default: `react-19`, instrument it as part of the companion-CI PR.**

2. **Authentication model.** Single shared upload token (MVP) vs. per-build short-lived tokens. **Default: single token.** Easy upgrade later.

3. **Should the lab also handle PR runs?** The maintainer asked for nightly-only. Worth keeping the option open via a `?dryRun=true` mode that doesn't persist, but **out of scope for MVP.**

4. **Should we use `@lhci/server` as-is** instead of building a custom Fastify wrapper? It already has the API, schema, dashboard, and diff UI. The trade-off: it doesn't accept tar.gz bundles — it accepts uploaded LHR JSONs from `lhci upload`. So the architecture changes: GitHub Actions would have to run Lighthouse itself (back to the flake problem) and only upload results. **The whole point of this plan is to move the *Lighthouse run* to the dedicated server, not just the storage.** So we're not using `@lhci/server` directly. We could optionally also push results to an `@lhci/server` instance for the nice diff UI, but that's bonus.

5. **Trend duration on the dashboard.** Last 30 builds? Last 30 days? **Default: last 30 builds per cell** (~one month of nightlies).

6. **Bundle size limit.** 600 MB feels generous. **Default: 600 MB**, error loudly if exceeded.

7. **What happens on weekends / holidays / no commits?** Nightly still runs, results show "unchanged from previous" — fine, no special handling.

8. **How does the human know a regression happened?** MVP: they look at the dashboard. Follow-up: GitHub Issue auto-opened when a cell's median score drops > 5 points from the trailing 7-day average. **Not MVP.**

---

## Why this is the right shape

- **One concern per service.** The CI's job is to *build*. This server's job is to *measure*. Today both are tangled in GitHub Actions and the measurement is unreliable.
- **Cheap to abandon.** If Northflank goes south, we're out one Docker image and a small Fastify server. The CI's bundling step still produces valid artifacts; we can swap the upload target.
- **Easy to grow.** Want comparison-vs-baseline like LHCI server? Add a route. Want Slack notifications? Add a hook. Want multi-project? Add a `projects` table. The schema is intentionally boring.
- **Boring tech.** Fastify + SQLite + raw SQL + server-rendered HTML. No framework du jour. The next engineer who reads this code understands it in 30 minutes.

---

## Quick reference: what an implementing agent needs to start

```
1. Read this file end to end.
2. Read these for context (in this repo, since you don't have access to sentry-javascript):
   - https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
     (everything `lighthouserc.cjs` does)
   - https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md
     (why we serialize runs, why 5 + median)
3. Start with Phase 1. Don't skip phases.
4. Commit often. Use Conventional Commits (feat:, chore:, fix:, refactor:, …).
5. When you finish Phase 3, ping the human — that's the first natural review point.
```
