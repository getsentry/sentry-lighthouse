# Hand-off: `sentry-javascript` integration with `sentry-lighthouse`

**Audience:** an agent (or engineer) picking up the open PR on the
`feat/lighthouse-ci` branch of [`getsentry/sentry-javascript`](https://github.com/getsentry/sentry-javascript).

**Goal:** rewire that PR so it stops running Lighthouse inside GitHub Actions
and instead ships prebuilt test-app bundles to the dedicated lab service that
now exists at <https://lighthouse.sentry.gg>. The lab runs Lighthouse on stable
hardware, persists results, and ships every run to Sentry as a distribution
metric. The CI's job becomes "build the apps, tar them, POST them, log the
dashboard link in the workflow summary." Nothing more.

When the work in this doc lands, you should be able to trigger
`Nightly: Lighthouse` on a feature branch in `sentry-javascript`, see the
workflow finish in well under 5 minutes (instead of 20+), and find the
resulting metrics on the Sentry dashboard within seconds of CI exiting.

---

## 1. Context: what already exists

### 1.1 The lab (this repo)

- Source: <https://github.com/getsentry/sentry-lighthouse>
- Live service: <https://lighthouse.sentry.gg>
- Northflank service:
  [`sentry / sentry-lighthouse / sentry-lighthouse`](https://app.northflank.com/o/sentry/t/davidsentrys-team/project/sentry-lighthouse/services/sentry-lighthouse)
- Sentry org: `o447951` — metrics land under the `lighthouse.*` namespace.

The lab is one Docker container with two processes under a supervisor:
- HTTP server + Lighthouse worker (queue + serialised `lhci collect`).
- Sentry publisher (polls SQLite, ships
  `Sentry.metrics.distribution('lighthouse.score', …)` etc.).

It's stable. **Do not change the lab's API while doing this work** — extend it
later in a separate PR if you find you need to.

### 1.2 The PR you're picking up

Branch: `feat/lighthouse-ci`. Tip commit at hand-off time:
`06f87a5f7 refactor(lighthouse-ci): drop PR-commenting logic from report script`.

Today the PR contains:

| File / dir | Status |
| --- | --- |
| `.github/workflows/lighthouse.yml` | runs lhci on GitHub Actions runners — **delete most of, keep build steps** |
| `dev-packages/lighthouse-tests/lighthouse-matrix.mjs` | matrix generator — **rewrite** as a bundle+upload driver |
| `dev-packages/lighthouse-tests/lighthouserc.cjs` | **delete** — lab owns the lhci config now |
| `dev-packages/lighthouse-tests/report.mjs` | post-run reporting → Job Summary — **delete** |
| `dev-packages/lighthouse-tests/package.json` | trim deps; rename pkg to `lighthouse-bundle` if you want |
| `dev-packages/e2e-tests/test-applications/default-browser/src/index.js` | already instrumented with `SENTRY_LIGHTHOUSE_MODE` — **keep as-is** |
| `dev-packages/e2e-tests/test-applications/nextjs-16/...` | already instrumented (`NEXT_PUBLIC_SENTRY_LIGHTHOUSE_MODE`) — **keep as-is** |
| `dev-packages/e2e-tests/test-applications/react-router-7-spa/...` | instrumented but excluded from matrix (NO_FCP issue) — **drop from matrix entirely** |
| `dev-packages/e2e-tests/test-applications/react-19/src/index.tsx` | **not instrumented yet** — needs the `SENTRY_LIGHTHOUSE_MODE` gating like `default-browser` has |

The "Companion changes in `sentry-javascript`" list in the lab's original PLAN
(now deleted; see git history if you need it) called for all of this. This doc
supersedes that list.

---

## 2. The new matrix (confirmed)

3 apps × 3 modes = 9 cells per build.

> **Throttle-method fan-out:** the lab measures every uploaded `(app, mode)`
> spec twice — once per `throttle_method` (`simulate` = Lantern, `devtools` =
> real browser-applied Slow 4G). So the 9 uploaded specs become **18 cells**
> per build. The CI upload contract is unchanged; it still posts 9 specs, and
> the lab fans each one out. Every Sentry metric and cell-scoped error carries
> the `throttle_method` attribute so the two methods can be compared.

| App slug | Type | Bundle layout | `installCmd` |
| --- | --- | --- | --- |
| `default-browser` | static (webpack) | the `build/` dir | none |
| `react-19` | static (CRA / `react-scripts build`) | the `build/` dir | none |
| `nextjs-16` | server (`next start`) | source + `.next/` + `package.json` + `pnpm-lock.yaml` + the packed SDK `.tgz` files referenced by the lockfile | `pnpm install --frozen-lockfile --prefer-offline` |

Modes:

- `no-sentry` — app built with `SENTRY_LIGHTHOUSE_MODE=no-sentry` so the SDK is
  tree-shaken out (baseline).
- `init-only` — `Sentry.init({ dsn })` with no integrations.
- `tracing-replay` — `Sentry.init` + `browserTracingIntegration` +
  `replayIntegration`.

The mode value flows through one or both of:
- `SENTRY_LIGHTHOUSE_MODE` (webpack: `default-browser`)
- `NEXT_PUBLIC_SENTRY_LIGHTHOUSE_MODE` (Next.js: `nextjs-16`)
- `REACT_APP_SENTRY_LIGHTHOUSE_MODE` (CRA: `react-19`) — **you'll add this**

---

## 3. The HTTP API contract

Base URL: `https://lighthouse.sentry.gg`. All examples use
`$LIGHTHOUSE_LAB_URL` and `$LIGHTHOUSE_UPLOAD_TOKEN` from the workflow's
secrets — see [§7. Secrets](#7-secrets).

### 3.1 `POST /api/builds`

Multipart form-data. **Headers:**

```
Authorization: Bearer <LIGHTHOUSE_UPLOAD_TOKEN>
Content-Type: multipart/form-data; boundary=...
```

**Fields:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `metadata` | JSON string | yes | See schema below |
| `bundle-0`, `bundle-1`, … | file (one per cell) | yes | gzipped tarball of the cell's bundle |

**`metadata` schema:**

```jsonc
{
  "commit":        "06f87a5f7…",                  // required, ≥7 chars
  "branch":        "feat/lighthouse-ci",          // required
  "triggeredBy":   "github-actions",              // optional
  "workflowRunUrl":"https://github.com/getsentry/sentry-javascript/actions/runs/12345",
                                                   // optional but recommended for traceability
  "cells": [                                       // required, ≥1
    {
      "app":          "default-browser",          // required; [a-z0-9][a-z0-9-]*
      "mode":         "no-sentry",                // required; same pattern
      "bundleField":  "bundle-0",                 // required; matches a file-field name above
      "serve":        "static",                   // required; "static" | "server"
      "staticDir":    "build",                    // required when serve=static (path inside the bundle)
      "startCmd":     null,                       // required when serve=server
      "readyPattern": null,                       // optional regex for server-ready detection
      "url":          null,                       // optional, default http://localhost:3000/
      "installCmd":   null                        // optional shell command run before lhci collect
    },
    // …8 more cells…
  ]
}
```

**Response (`202 Accepted`):**

```json
{
  "buildId":     "01HXXXX…",
  "status":      "queued",
  "cells":       18,
  "buildUrl":    "/api/builds/01HXXXX…",
  "dashboardUrl":"/builds/01HXXXX…"
}
```

`cells` is the post-fan-out count: each uploaded spec becomes one cell per
`throttle_method`, so 9 uploaded specs → 18 cells.

**Failure modes** (all return `{ "error": "<slug>", "message": "<human>" }`):

| Status | When |
| --- | --- |
| 401 | missing/invalid bearer token |
| 415 | `Content-Type` is not multipart |
| 400 | metadata missing, not JSON, fails schema, or references a `bundleField` that wasn't uploaded |
| 400 | duplicate `(app, mode)` cells, duplicate `bundleField`, `serve=static` without `staticDir`, `serve=server` without `startCmd` |
| 413 | a file exceeded `MAX_UPLOAD_BYTES` (100 MB default) |
| 507 | `/data` volume on the lab is >90% full (operations issue — not a CI bug) |

### 3.2 `GET /api/builds/:buildId`

No auth. Returns the build + every cell + every run with metrics and a per-run
`reportUrl` pointing at the Lighthouse HTML report on the lab. The workflow
should poll this to:

1. Confirm the lab accepted the upload (`status` ≠ `failed`).
2. Wait for terminal status (`completed` or `failed`).
3. Surface `dashboardUrl` and any failed cells in the Job Summary.

Sample shape (trimmed):

```json
{
  "buildId": "01HXXXX…",
  "commit":  "06f87a5f7",
  "branch":  "feat/lighthouse-ci",
  "status":  "completed",
  "completedAt": "2026-05-13T09:12:43.909Z",
  "cells": [
    {
      "cellId": "01HYYYY…",
      "app":    "default-browser",
      "mode":   "no-sentry",
      "throttleMethod": "simulate",
      "status": "completed",
      "publishedAt": "2026-05-13T09:12:45.835Z",
      "runs": [
        {
          "runId": "01HZZZZ…",
          "runIndex": 1,
          "performanceScore": 1,
          "lcpMs": 714,
          "fcpMs": 714,
          "tbtMs": 7,
          "cls": 0,
          "totalBytes": 1426,
          "reportUrl": "/api/runs/01HZZZZ…/report.html"
        }
        // …4 more runs…
      ]
    }
    // …8 more cells…
  ]
}
```

### 3.3 Other endpoints (informational)

- `GET /healthz` — liveness + queue depth, no auth. Workflow should call this
  once before posting and abort if it's not 200, so a dead lab doesn't waste
  CI time.
- `GET /api/runs/:runId/report.html` — the Lighthouse HTML for one run, served
  inline. Linked from the `reportUrl` field above.
- `POST /api/builds/:buildId/rerun` (bearer-auth) — re-enqueue all cells of an
  existing build using the stored tarballs. Useful if a result looks flaky.
  Not part of CI flow; available for human use.

---

## 4. Bundle format spec

The lab is strict about the schema fields but agnostic about the *contents* of
your tarballs. The conventions below are recommendations that match the
worker's expectations.

### 4.1 Static cells (`default-browser`, `react-19`)

The bundle is just the pre-built static directory.

```
build/
├── index.html
├── static/js/…
└── …
```

Tar from one level up so the archive contains a top-level `build/` directory:

```bash
tar -czf "$OUT/default-browser-no-sentry.tar.gz" -C "$RUNNER_TEMP/test-application" build
```

Cell metadata:
```json
{
  "app":         "default-browser",
  "mode":        "no-sentry",
  "bundleField": "bundle-0",
  "serve":       "static",
  "staticDir":   "build"
}
```

Bundle size: ~1–5 MB. No `installCmd`.

### 4.2 Server cells (`nextjs-16`)

The bundle must contain enough that `pnpm install --frozen-lockfile` followed
by `pnpm start` works on a fresh Linux container.

```
test-application/
├── .next/                                # build output
├── public/
├── pages/ or app/
├── package.json                          # with pnpm.overrides pointing at the .tgz files
├── pnpm-lock.yaml
├── next.config.js
└── packed/                               # the SDK tarballs (see note below)
    ├── sentry-nextjs-packed.tgz
    └── sentry-node-packed.tgz
```

**Critical:** the `package.json` `pnpm.overrides` (or `overrides`) field
references the packed SDK tgz files by relative path. Today the CI's
`yarn ci:pnpm-overrides` script points them at
`<workspace>/dev-packages/e2e-tests/packed/*.tgz` — an absolute workspace path.
**Rewrite the overrides to use a path that's still valid after the tar
extracts on the lab**, e.g. `file:./packed/sentry-*.tgz`, and place the actual
`.tgz` files at `./packed/` *inside* the bundle.

Concretely, the bundle prep script's job is:

```bash
# inside the runner.temp test-application dir, AFTER `pnpm test:build` ran
rm -rf node_modules                                      # the whole point of the change
mkdir packed
cp $GITHUB_WORKSPACE/dev-packages/e2e-tests/packed/sentry-*.tgz packed/

# rewrite the pnpm overrides to point at the in-bundle copy
node -e "
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.pnpm = pkg.pnpm || {};
  pkg.pnpm.overrides = Object.fromEntries(
    Object.entries(pkg.pnpm.overrides || {}).map(([name, val]) => {
      const m = val.match(/sentry-[^/]+-packed\\.tgz/);
      return m ? [name, 'file:./packed/' + m[0]] : [name, val];
    })
  );
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"

# tar everything (no node_modules)
tar -czf "$OUT/nextjs-16-tracing-replay.tar.gz" \
  --exclude=node_modules --exclude=.git \
  -C "$RUNNER_TEMP" test-application
```

Cell metadata:
```json
{
  "app":          "nextjs-16",
  "mode":         "tracing-replay",
  "bundleField":  "bundle-3",
  "serve":        "server",
  "startCmd":     "pnpm start",
  "readyPattern": "Ready in",
  "url":          "http://localhost:3000/",
  "installCmd":   "pnpm install --frozen-lockfile --prefer-offline"
}
```

The lab spawns `installCmd` via `sh -c` with the bundle's extract dir as cwd
and `PATH` inherited (pnpm 9.15.9 is on the image via corepack). After the
install exits zero, lhci runs with the server start command and waits for the
ready pattern.

Bundle size estimate: 10–50 MB depending on `.next/` size.

---

## 5. Changes required in `sentry-javascript`

### 5.1 Instrument `react-19` (closes the old TODO-aeab11f0)

Mirror the pattern from `default-browser/src/index.js`. CRA exposes env vars
prefixed `REACT_APP_*`, so the gate is `process.env.REACT_APP_SENTRY_LIGHTHOUSE_MODE`.

File: `dev-packages/e2e-tests/test-applications/react-19/src/index.tsx`

Required edits:
- Read `const lighthouseMode = process.env.REACT_APP_SENTRY_LIGHTHOUSE_MODE;`
- Skip the entire `Sentry.init(...)` block when `lighthouseMode === 'no-sentry'`
  (and consider dynamic-importing `@sentry/react` so webpack can drop it from
  the bundle in that mode, matching what `default-browser` does — this is the
  one place where the build pipeline cares about the difference).
- For `init-only`: `Sentry.init` with no integrations.
- For `tracing-replay`: include `Sentry.browserTracingIntegration()` +
  `Sentry.replayIntegration()`.
- Default behaviour when `lighthouseMode` is unset: whatever the file does
  today (don't break the existing playwright E2E).

Verify by running `REACT_APP_SENTRY_LIGHTHOUSE_MODE=no-sentry pnpm test:build`
locally and confirming `build/static/js/*.js` doesn't contain `@sentry`.

### 5.2 Replace `.github/workflows/lighthouse.yml`

The current file has two jobs: `job_build` (SDK build + matrix generation)
and `job_lighthouse` (the 15-cell matrix that runs lhci per cell on
`ubuntu-24.04-large-js`).

**Keep:** the entire `job_build` job — SDK build, tarball generation, and
upload to GH artifacts. We still need the packed SDK tgz files.

**Replace `job_lighthouse` with a new `job_bundle_and_upload` job** that, for
each cell:

1. Checks out the repo.
2. Restores deps + the SDK tarball artifacts (same actions you have today).
3. Copies the test app to `$RUNNER_TEMP/test-application`.
4. Applies pnpm overrides (existing `ci:pnpm-overrides` script).
5. Runs `pnpm test:build` with the right `SENTRY_LIGHTHOUSE_MODE` env var (or
   the framework-specific prefix variant).
6. Strips `node_modules` and rewrites `pnpm.overrides` to in-bundle paths,
   per [§4.2](#42-server-cells-nextjs-16). (Skip for static cells — they only
   tar `build/`.)
7. Tars the bundle into `$RUNNER_TEMP/bundles/<app>-<mode>.tar.gz`.
8. *(Once, after the per-cell jobs)* runs `bundle-and-upload.mjs` to POST every
   tarball + the metadata JSON to `$LIGHTHOUSE_LAB_URL/api/builds`.
9. Polls `GET /api/builds/<buildId>` until terminal, then writes a Job
   Summary with the dashboard URL and any failed cells.

**Single-job vs split:** I'd combine prep + upload into one job (no matrix).
Per-cell parallelism gained you nothing once Lighthouse moved off the runner;
the bundle prep is the cheap part. Loop over the 9 cells inside one job, post
once, poll once.

Skeleton (yaml is illustrative — adapt to your existing build.yml conventions):

```yaml
job_bundle_and_upload:
  name: Bundle test apps and upload to Lighthouse lab
  needs: [job_build]
  runs-on: ubuntu-24.04
  timeout-minutes: 20
  env:
    LIGHTHOUSE_LAB_URL:   ${{ secrets.LIGHTHOUSE_LAB_URL }}
    LIGHTHOUSE_UPLOAD_TOKEN: ${{ secrets.LIGHTHOUSE_UPLOAD_TOKEN }}
    E2E_TEST_DSN:                'https://username@domain/123'
    NEXT_PUBLIC_E2E_TEST_DSN:    'https://username@domain/123'
    REACT_APP_E2E_TEST_DSN:      'https://username@domain/123'
  steps:
    - uses: actions/checkout@v6
    - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v5.0.0
      with: { version: 9.15.9 }
    - uses: actions/setup-node@v6
      with: { node-version-file: 'package.json' }
    - uses: ./.github/actions/install-dependencies
    - uses: actions/download-artifact@v7
      with:
        name: lighthouse-build-tarball-output
        path: ${{ github.workspace }}/packages
    - name: Prepare E2E tests
      working-directory: dev-packages/e2e-tests
      run: |
        yarn test:prepare
        yarn test:validate

    - name: Liveness check
      run: |
        curl -fsS "$LIGHTHOUSE_LAB_URL/healthz" > /dev/null

    - name: Bundle every cell and upload
      run: node dev-packages/lighthouse-bundle/bundle-and-upload.mjs
```

### 5.3 `dev-packages/lighthouse-bundle/bundle-and-upload.mjs`

This is the new entrypoint. Sketch — adapt to existing helpers in the repo:

```javascript
// dev-packages/lighthouse-bundle/bundle-and-upload.mjs
// Builds every (app, mode) cell, tars each, POSTs the whole set to the lab,
// polls until terminal, writes a Job Summary.

import { execSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';

const LAB_URL = process.env.LIGHTHOUSE_LAB_URL;
const TOKEN   = process.env.LIGHTHOUSE_UPLOAD_TOKEN;
if (!LAB_URL || !TOKEN) {
  throw new Error('LIGHTHOUSE_LAB_URL and LIGHTHOUSE_UPLOAD_TOKEN must be set');
}

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd();
const RUNNER_TEMP = process.env.RUNNER_TEMP ?? path.join(WORKSPACE, '.tmp');

const APPS = [
  { app: 'default-browser', serve: 'static', staticDir: 'build', envPrefix: 'SENTRY' },
  { app: 'react-19',        serve: 'static', staticDir: 'build', envPrefix: 'REACT_APP_SENTRY' },
  { app: 'nextjs-16',       serve: 'server',
    startCmd: 'pnpm start', readyPattern: 'Ready in',
    envPrefix: 'NEXT_PUBLIC_SENTRY',
    installCmd: 'pnpm install --frozen-lockfile --prefer-offline' },
];
const MODES = ['no-sentry', 'init-only', 'tracing-replay'];

const bundles = [];          // { fieldName, tarPath, cell }

for (const def of APPS) {
  for (const mode of MODES) {
    const fieldName = `bundle-${bundles.length}`;
    const cell = await prepareCell(def, mode, fieldName);
    bundles.push(cell);
  }
}

const metadata = {
  commit: process.env.GITHUB_SHA,
  branch: process.env.GITHUB_REF_NAME,
  triggeredBy: 'github-actions',
  workflowRunUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  cells: bundles.map(b => b.cell),
};

const form = new FormData();
form.append('metadata', JSON.stringify(metadata));
for (const b of bundles) {
  const buf = await readFile(b.tarPath);
  form.append(b.fieldName, new Blob([buf], { type: 'application/gzip' }), path.basename(b.tarPath));
}

const res = await fetch(`${LAB_URL}/api/builds`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
const { buildId, dashboardUrl } = await res.json();
console.log(`uploaded buildId=${buildId}`);
console.log(`dashboard: ${LAB_URL}${dashboardUrl}`);

// Poll until terminal, then surface in Job Summary.
let build;
const deadline = Date.now() + 25 * 60 * 1000; // 25 min ceiling
while (Date.now() < deadline) {
  const r = await fetch(`${LAB_URL}/api/builds/${buildId}`);
  build = await r.json();
  console.log(`status=${build.status} cells completed/failed: ${build.cells.filter(c=>c.status==='completed').length}/${build.cells.filter(c=>c.status==='failed').length} of ${build.cells.length}`);
  if (build.status === 'completed' || build.status === 'failed') break;
  await wait(15_000);
}

await writeSummary(build, LAB_URL);
process.exit(build.status === 'failed' ? 1 : 0);

async function prepareCell(def, mode, fieldName) {
  const tempApp = path.join(RUNNER_TEMP, `app-${def.app}-${mode}`);
  await rm(tempApp, { recursive: true, force: true });
  await mkdir(tempApp, { recursive: true });

  // Copy app, apply pnpm overrides, build with the right env var.
  execSync(
    `yarn ci:copy-to-temp ./test-applications/${def.app} ${tempApp}`,
    { cwd: path.join(WORKSPACE, 'dev-packages/e2e-tests'), stdio: 'inherit' },
  );
  execSync(
    `yarn ci:pnpm-overrides ${tempApp} ${WORKSPACE}/dev-packages/e2e-tests/packed`,
    { cwd: path.join(WORKSPACE, 'dev-packages/e2e-tests'), stdio: 'inherit' },
  );
  execSync('pnpm test:build', {
    cwd: tempApp,
    stdio: 'inherit',
    env: {
      ...process.env,
      SENTRY_E2E_WORKSPACE_ROOT: WORKSPACE,
      // set ALL the common prefix variants so the app's bundler picks up whichever it exposes
      SENTRY_LIGHTHOUSE_MODE: mode,
      NEXT_PUBLIC_SENTRY_LIGHTHOUSE_MODE: mode,
      REACT_APP_SENTRY_LIGHTHOUSE_MODE: mode,
    },
  });

  const tarPath = path.join(RUNNER_TEMP, 'bundles', `${def.app}-${mode}.tar.gz`);
  await mkdir(path.dirname(tarPath), { recursive: true });

  if (def.serve === 'static') {
    execSync(`tar -czf ${tarPath} -C ${tempApp} ${def.staticDir}`, { stdio: 'inherit' });
  } else {
    // SSR: bundle source + .next/, copy packed tgz into bundle, rewrite overrides
    // … (see §4.2 above for the inlined steps)
    rewriteOverridesToInBundle(tempApp);
    execSync(
      `tar -czf ${tarPath} --exclude=node_modules --exclude=.git -C ${RUNNER_TEMP} ${path.basename(tempApp)}`,
      { stdio: 'inherit' },
    );
  }

  return {
    fieldName,
    tarPath,
    cell: {
      app: def.app,
      mode,
      bundleField: fieldName,
      serve: def.serve,
      ...(def.serve === 'static'
        ? { staticDir: def.staticDir }
        : { startCmd: def.startCmd, readyPattern: def.readyPattern, installCmd: def.installCmd }),
    },
  };
}

async function writeSummary(build, labUrl) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (!out) return;
  const lines = [
    `## Lighthouse — ${build.status}`,
    `- Build: \`${build.buildId}\``,
    `- Commit: \`${build.commit}\``,
    `- Dashboard: ${labUrl}/api/builds/${build.buildId}`,
    `- Sentry metrics: filter by \`commit=${build.commit}\` in the lab project`,
    '',
    '| App | Mode | Status | Median score | Runs | Report |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const c of build.cells) {
    const median = c.runs?.length
      ? median0to1(c.runs.map(r => r.performanceScore).filter(s => s != null))
      : '—';
    const report = c.runs?.[0]?.reportUrl ? `[view](${labUrl}${c.runs[0].reportUrl})` : '—';
    lines.push(`| ${c.app} | ${c.mode} | ${c.status} | ${median} | ${c.runs?.length ?? 0} | ${report} |`);
  }
  await writeFile(out, lines.join('\n') + '\n', { flag: 'a' });
}

function median0to1(xs) {
  if (xs.length === 0) return '—';
  xs.sort((a,b)=>a-b);
  const m = xs.length % 2 === 0
    ? (xs[xs.length/2 - 1] + xs[xs.length/2]) / 2
    : xs[(xs.length-1)/2];
  return m.toFixed(2);
}
```

This is a sketch. Reuse existing helpers (`yarn ci:copy-to-temp`,
`yarn ci:pnpm-overrides`) — those already work and there's no reason to
reimplement them.

### 5.4 Files to delete

After §5.3 lands:

- `dev-packages/lighthouse-tests/lighthouserc.cjs` — lab owns the lhci config.
- `dev-packages/lighthouse-tests/report.mjs` — Job Summary now happens in
  `bundle-and-upload.mjs`.
- `dev-packages/lighthouse-tests/lighthouse-matrix.mjs` — matrix logic moves
  into `bundle-and-upload.mjs`.

Rename the package dir to `dev-packages/lighthouse-bundle/` since "tests" is
no longer accurate.

### 5.5 Files to keep untouched

- `dev-packages/e2e-tests/test-applications/default-browser/src/index.js` —
  already correct.
- `dev-packages/e2e-tests/test-applications/nextjs-16/...` — already correct.
- `yarn ci:copy-to-temp`, `yarn ci:pnpm-overrides`, `yarn build:tarball` — all
  reused as-is by the new job.

---

## 6. Test apps that need new env-var prefixes

Only `react-19`. CRA's prefix is `REACT_APP_*`. Other two apps already pick
up the right variable.

The workflow sets all three prefix variants at once (see the `env:` block in
the YAML sketch). Each app reads whichever its bundler exposes. CI doesn't
care which apps consume which prefixes.

---

## 7. Secrets

Add to `getsentry/sentry-javascript` repo secrets:

| Name | Value |
| --- | --- |
| `LIGHTHOUSE_LAB_URL` | `https://lighthouse.sentry.gg` |
| `LIGHTHOUSE_UPLOAD_TOKEN` | the token already in Northflank's `UPLOAD_TOKEN` env (ask Daniel for the value) |

Use `secrets.*` in the workflow — no fallback to env. If a fork tries to run
the workflow, the missing secrets will short-circuit the upload step with a
clear error instead of silently uploading nothing.

---

## 8. End-to-end verification

Once the new workflow is on a feature branch:

```bash
# 1. From the GitHub UI: Actions → Nightly: Lighthouse → Run workflow
#    Pick the feat branch. Job should finish in <5 min, not 20.
```

```bash
# 2. From your laptop, check the lab saw the build:
curl https://lighthouse.sentry.gg/api/builds | jq '.builds[0]'
# Expect: commit=<your branch's HEAD SHA>, branch=<your branch>, cellsTotal=18,
#         cellsCompleted=18, cellsFailed=0, status=completed.
#         (18 = 9 uploaded specs × 2 throttle methods.)
```

```bash
# 3. Drill in:
curl https://lighthouse.sentry.gg/api/builds/<buildId> | jq '.cells[] | {app, mode, throttleMethod, status, runs: (.runs | length)}'
# Expect 18 lines (9 specs × 2 throttle methods), all status=completed, all runs=5.
```

```bash
# 4. View one of the HTML reports in a browser:
open https://lighthouse.sentry.gg/api/runs/<runId>/report.html
```

```bash
# 5. In Sentry's metrics product (org o447951), filter on
#    commit=<your branch's HEAD SHA> and confirm you see 18 cells × 5 runs ×
#    6 metric names = 540 distribution data points plus 18 counter envelopes.
#    Group by throttle_method to compare simulate vs devtools.
```

```bash
# 6. Check the Job Summary on the workflow run page: should have a table with
#    18 rows (one per cell × throttle method), every reportUrl resolvable.
```

If any of those checks fails, fix it before merging. Errors that surface in
the lab's logs but not the workflow logs are visible at
<https://app.northflank.com/o/sentry/t/davidsentrys-team/project/sentry-lighthouse/services/sentry-lighthouse/logs>.

---

## 9. Known gotchas

- **Bundle size cap.** Default is `MAX_UPLOAD_BYTES=104857600` (100 MB) per
  file. If a `nextjs-16` cell's bundle exceeds this you'll see HTTP 413.
  Either trim `.next/` (don't include sourcemaps if you don't need them) or
  ask for the env var to be bumped on the lab. Static cells should never get
  close.
- **pnpm overrides absolute-path trap.** `yarn ci:pnpm-overrides` writes
  workspace-absolute paths. If you don't rewrite to `file:./packed/*.tgz`
  before tarring, the lab's `pnpm install --frozen-lockfile` will fail
  immediately with "Cannot resolve … from …".
- **`installCmd` is run via `sh -c`.** Shell metacharacters work. Don't
  embed untrusted strings — but in our case the workflow is the only source.
- **First nightly is slower than subsequent ones.** The lab uses a persistent
  pnpm store on `/data/.pnpm-store`. First install populates the cache;
  subsequent installs hard-link.
- **The lab serialises Lighthouse runs.** 9 cells × 5 runs × ~5 s ≈ ~4 min on
  the wire, plus install time for the SSR cell. Don't poll with a 5 s
  timeout.
- **`workflow_dispatch` is your friend.** Don't wait for the nightly cron to
  test changes — trigger manually.

---

## 10. Out of scope (for this PR)

Do **not** roll any of the following into the same PR:

- Comparison UI (Δ between PR and main).
- Per-PR runs (current scope is nightly + `workflow_dispatch` only).
- Slack/email notifications.
- Adding more apps to the matrix (vue-3, svelte-5, astro-5, etc.).
- Lab-side schema changes (e.g. dropping the vestigial
  `runs.is_representative` column).

Each of those is its own PR; opening separate tickets is fine.

---

## Appendix A: Sentry metric schema (for dashboard authors)

| Metric | Type | Unit | Value range | Attributes |
| --- | --- | --- | --- | --- |
| `lighthouse.score` | distribution | `percentage` | 0–100 (LHR's 0..1 multiplied by 100 so dashboards render `78%`) | `app, mode, branch, commit, serve_mode, throttle_method, run_index` |
| `lighthouse.lcp` | distribution | `millisecond` | non-negative | same |
| `lighthouse.fcp` | distribution | `millisecond` | non-negative | same |
| `lighthouse.tbt` | distribution | `millisecond` | non-negative | same |
| `lighthouse.cls` | distribution | `number` | non-negative (typically 0–0.25, can exceed 1) | same |
| `lighthouse.bytes` | distribution | `byte` | non-negative | same |
| `lighthouse.cell.completed` | counter | — | always 1 | `app, mode, branch, commit, serve_mode, throttle_method, result (completed\|failed), runs` |

Note on units: Sentry's metrics product accepts only a fixed set of unit strings (see the API error if you pass an invalid one — the allowed list includes `integer`, `number`, `millisecond`, `byte`, `percentage`, but not `ratio` or `percent`). Picking a valid unit is what enables `p50` / `p90` / `p99` aggregates in dashboards; an invalid unit silently downgrades the metric to a string-typed field and aggregates refuse to run.

Every cell-scoped metric and error also carries `throttle_method`, which is
`simulate` (Lantern, math-modeled Slow 4G) or `devtools` (real browser-applied
Slow 4G). Group/split by it to compare the two test methods.

Plus auto-attached: `service=sentry-lighthouse`, `deploy_env=<env>`,
`sentry.release=<git-sha>`. Use `app`, `mode`, `branch`, `commit`,
`throttle_method` to slice; use `commit` to pin to a specific build for
regression analysis.

---

## Appendix B: When you need to talk to the lab

- **Daniel Griesser** owns the lab; ping him in Slack with `#topic-lighthouse`
  or open an issue on
  [`getsentry/sentry-lighthouse`](https://github.com/getsentry/sentry-lighthouse).
- The lab's settings, env vars, volume size, and logs are in Northflank under
  `davidsentrys-team / sentry-lighthouse / sentry-lighthouse`.
- The `UPLOAD_TOKEN` Northflank holds is the single source of truth. Don't
  rotate it without also rotating `LIGHTHOUSE_UPLOAD_TOKEN` in the
  `sentry-javascript` repo secrets.
