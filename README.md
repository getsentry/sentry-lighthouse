# sentry-lhci

Self-hosted Lighthouse lab for [`getsentry/sentry-javascript`](https://github.com/getsentry/sentry-javascript). Accepts prebuilt SDK test-app bundles from GitHub Actions, runs Lighthouse on stable hardware, exposes results via a dashboard.

See [`PLAN.md`](./PLAN.md) for the full design and rationale.

## Status

Phase 1 — skeleton, `/healthz`, SQLite migrations, Docker. Upload + worker + dashboard land in subsequent phases.

## Quick start (local)

```bash
# 1. Install deps (Node 22 is pinned via .node-version)
pnpm install

# 2. Configure
cp .env.example .env
# Generate a strong upload token:
echo "UPLOAD_TOKEN=$(openssl rand -hex 32)" >> .env

# 3. Run
pnpm dev
# → http://localhost:8080/healthz
```

`pnpm dev` runs the server with `--watch` (auto-reload on file changes) and reads `.env` automatically.

## Quick start (Docker)

```bash
pnpm docker:build
pnpm docker:run
# → http://localhost:8080/healthz
```

The `docker:build` script bakes the current `git rev-parse --short HEAD` into the image as `GIT_SHA`, which `/healthz` surfaces.

## Endpoints (current)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Liveness probe. Returns `{ ok, version, packageVersion, uptimeSec }`. |
| `POST` | `/api/builds` | bearer | Stub — returns 501 until Phase 2. Validates `Authorization: Bearer $UPLOAD_TOKEN`. |

## Config (env vars)

See [`.env.example`](./.env.example) for the full list. Required: `UPLOAD_TOKEN` (≥24 chars).

## Deployment (Northflank)

The image is single-process, single-container, with one persistent volume mounted at `/data`. Northflank-specific notes are in [`PLAN.md`](./PLAN.md) → "Deployment on Northflank".
