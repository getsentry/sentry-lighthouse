#!/usr/bin/env node
// Dev-only seed. Populates SQLite with a realistic spread of builds/cells/runs
// (multiple apps × modes, a slow perf trend, a couple of failures) plus small
// placeholder HTML reports on disk, so the dashboard has something rich to
// render without standing up the whole CI → worker → Lighthouse pipeline.
//
//   node --env-file-if-exists=.env scripts/seed-dev-data.js
//
// Inserts ONLY terminal builds (completed/failed) so a running worker won't
// try to process them. Safe to run repeatedly; it appends fresh builds.

import { mkdir, writeFile } from 'node:fs/promises';

import { getDb, closeDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { newId } from '../src/lib/ids.js';
import { reportDir, reportHtmlPath, lhrJsonPath } from '../src/lib/paths.js';

const NUM_BUILDS = 14;
const RUNS_PER_CELL = 5;

const APPS = [
  { app: 'react-spa', serve: 'static', staticDir: 'build', baseLcp: 1700, baseBytes: 175_000 },
  { app: 'nextjs-ssr', serve: 'server', startCmd: 'node server.js', baseLcp: 2400, baseBytes: 260_000 },
  { app: 'vue-spa', serve: 'static', staticDir: 'dist', baseLcp: 1450, baseBytes: 150_000 },
];
const MODES = [
  { mode: 'no-sentry', sentry: false, lcpAdd: 0, tbtBase: 70, bytesAdd: 0, scoreAdj: 0.0 },
  { mode: 'init-only', sentry: true, lcpAdd: 90, tbtBase: 150, bytesAdd: 34_000, scoreAdj: -0.03 },
  { mode: 'tracing-replay', sentry: true, lcpAdd: 280, tbtBase: 340, bytesAdd: 96_000, scoreAdj: -0.09 },
];

const BRANCHES = ['main', 'main', 'main', 'lms/replay-perf', 'fix/lcp-regression'];

const rnd = (min, max) => min + Math.random() * (max - min);
const jit = pct => 1 + (Math.random() * 2 - 1) * pct;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

// A per-build "health" factor in [-1, 1] that drifts: starts mediocre, dips
// (a regression), then recovers — so the trend sparklines tell a story.
function healthAt(i, n) {
  const t = i / (n - 1);
  const dip = -0.55 * Math.exp(-((t - 0.45) ** 2) / 0.02); // a notch around 45%
  const climb = -0.25 + t * 0.6;
  return clamp(climb + dip + (Math.random() * 2 - 1) * 0.06, -1, 1);
}

function placeholderReport({ app, mode, runIndex, score, lcp, fcp, tbt, cls, bytes }) {
  const pct = Math.round(score * 100);
  const color = pct >= 90 ? '#0c6' : pct >= 50 ? '#fa3' : '#f55';
  return `<!doctype html><html><head><meta charset="utf-8"><title>LHR ${app}/${mode} #${runIndex}</title>
<style>body{font-family:system-ui;background:#0b0b12;color:#eee;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#16161f;border:1px solid #2a2a3a;border-radius:16px;padding:32px 40px;max-width:520px}
.gauge{font-size:64px;font-weight:800;color:${color}}.row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid #23232f}
.k{color:#999}.v{font-family:ui-monospace,monospace}.tag{opacity:.6;font-size:13px}</style></head>
<body><div class="card"><div class="tag">placeholder Lighthouse report (seeded)</div>
<h1>${app} · ${mode} · run #${runIndex}</h1><div class="gauge">${pct}</div>
<div class="row"><span class="k">LCP</span><span class="v">${lcp} ms</span></div>
<div class="row"><span class="k">FCP</span><span class="v">${fcp} ms</span></div>
<div class="row"><span class="k">TBT</span><span class="v">${tbt} ms</span></div>
<div class="row"><span class="k">CLS</span><span class="v">${cls.toFixed(3)}</span></div>
<div class="row"><span class="k">Total bytes</span><span class="v">${bytes.toLocaleString()}</span></div>
</div></body></html>`;
}

async function main() {
  runMigrations();
  const db = getDb();

  const insertBuild = db.prepare(`
    INSERT INTO builds (build_id, commit_sha, branch, triggered_by, workflow_run_url, created_at, completed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCell = db.prepare(`
    INSERT INTO cells (cell_id, build_id, app, mode, serve_mode, static_dir, start_cmd, ready_pattern, url,
                       bundle_path, install_cmd, status, error, queued_at, started_at, completed_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRun = db.prepare(`
    INSERT INTO runs (run_id, cell_id, run_index, is_representative, performance_score, lcp_ms, fcp_ms, tbt_ms,
                      cls, total_bytes, run_duration_ms, sentry_sdk_init_ms, sentry_sdk_pre_init_ms,
                      lhr_json_path, report_html_path, collected_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const now = Date.now();
  const reportWrites = [];
  let builds = 0, cells = 0, runs = 0;

  for (let i = 0; i < NUM_BUILDS; i++) {
    const createdMs = now - (NUM_BUILDS - 1 - i) * rnd(13, 19) * 3_600_000;
    const createdAt = new Date(createdMs).toISOString();
    const completedAt = new Date(createdMs + rnd(3, 9) * 60_000).toISOString();
    const branch = BRANCHES[Math.floor(Math.random() * BRANCHES.length)];
    const health = healthAt(i, NUM_BUILDS);

    // ~1 in 8 builds is a total wipeout (e.g. a bad commit broke every app).
    const totalFailure = Math.random() < 0.12 && i > 1;
    // Otherwise a single flaky cell occasionally fails.
    const flakyFails = !totalFailure && Math.random() < 0.3;

    const buildId = newId();
    const buildStatus = totalFailure ? 'failed' : (flakyFails ? 'failed' : 'completed');
    insertBuild.run(buildId, hex(40), branch, 'github-actions',
      'https://github.com/getsentry/sentry-javascript/actions/runs/' + Math.floor(rnd(1e9, 9e9)),
      createdAt, completedAt, buildStatus);
    builds++;

    const flakyTarget = flakyFails ? `${APPS[Math.floor(Math.random() * APPS.length)].app}` : null;

    const tx = db.transaction(() => {
      for (const a of APPS) {
        for (const m of MODES) {
          const cellId = newId();
          const fails = totalFailure || (flakyTarget === a.app && m.mode === 'tracing-replay');
          const status = fails ? 'failed' : 'completed';
          const url = a.serve === 'static' ? 'http://localhost:3000/' : 'http://localhost:3000/';
          // most cells published; leave the newest build unpublished to populate the "pending publish" stat
          const published = !fails && i < NUM_BUILDS - 1 ? completedAt : null;
          const error = fails
            ? (totalFailure
              ? 'lhci collect failed: Chrome did not produce a trace (renderer crashed); exit code 1'
              : `start-server-command timed out after 60000ms waiting for ready pattern "localhost" (server exited early)`)
            : null;

          insertCell.run(cellId, buildId, a.app, m.mode, a.serve,
            a.staticDir ?? null, a.startCmd ?? null, a.serve === 'server' ? 'localhost' : null, url,
            `/data/builds/${buildId}/${a.app}-${m.mode}.tar.gz`, a.serve === 'server' ? 'pnpm install --frozen-lockfile' : null,
            status, error, createdAt, fails ? null : createdAt, completedAt, published);
          cells++;
          if (fails) continue;

          // Score: drift with health + per-mode penalty.
          const scoreBase = clamp(0.9 + health * 0.08 + m.scoreAdj, 0.42, 1);
          for (let r = 1; r <= RUNS_PER_CELL; r++) {
            const runId = newId();
            const lcp = Math.round((a.baseLcp + m.lcpAdd) * (1 - health * 0.12) * jit(0.06));
            const fcp = Math.round(lcp * rnd(0.55, 0.7));
            const tbt = Math.round(m.tbtBase * (1 - health * 0.25) * jit(0.18));
            const cls = clamp(rnd(0.01, 0.06) + (m.sentry ? rnd(0, 0.04) : 0) - health * 0.02, 0, 0.4);
            const bytes = Math.round((a.baseBytes + m.bytesAdd) * jit(0.02));
            const score = clamp(scoreBase * jit(0.025), 0.4, 1);
            const runDuration = Math.round(rnd(4200, 7200));
            const preInit = m.sentry ? Math.round(rnd(2, 6)) : null;
            const sdkInit = m.sentry ? Math.round((m.mode === 'tracing-replay' ? rnd(28, 46) : rnd(11, 20))) : null;

            const jsonPath = lhrJsonPath(runId, r);
            const htmlPath = reportHtmlPath(runId);
            insertRun.run(runId, cellId, r, score, lcp, fcp, tbt, cls, bytes,
              runDuration, sdkInit, preInit, jsonPath, htmlPath, completedAt);
            runs++;
            reportWrites.push({ runId, html: placeholderReport({ app: a.app, mode: m.mode, runIndex: r, score, lcp, fcp, tbt, cls, bytes }) });
          }
        }
      }
    });
    tx();
  }

  // Write placeholder report files so the "view report" links resolve.
  for (const w of reportWrites) {
    await mkdir(reportDir(w.runId), { recursive: true });
    await writeFile(reportHtmlPath(w.runId), w.html, 'utf8');
  }

  console.log(`seeded ${builds} builds, ${cells} cells, ${runs} runs, ${reportWrites.length} reports`);
  closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
