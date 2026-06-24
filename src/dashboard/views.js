// Server-rendered HTML for the dashboard. Plain template literals — no view
// engine, no client framework, in keeping with the project's "no SPA" stance.
// All caller/DB-derived strings pass through esc(); inline SVG draws the
// sparklines so there's no chart dependency either.

import {
  esc, fmtPct, relTime, absTime, fmtDuration, shortSha,
  median, minOf, maxOf, fmtScore,
} from './format.js';
import {
  activeMetrics, headlineMetrics, formatMetric, rateMetric,
} from './metrics.js';
import { config } from '../lib/config.js';

const RATE_COLOR = { good: '#3fd9a6', ni: '#f5a623', poor: '#f5555d', none: '#8b87a8' };
const ACCENT = '#a78bfa';

// --- Document shell -------------------------------------------------------

export function layout({ title, body, activeNav = '', overview = null, refresh = false }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
${refresh ? '<meta name="dashboard-refresh" content="5" />' : ''}
<title>${esc(title)} · Lighthouse Lab</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(faviconSvg())}" />
<link rel="stylesheet" href="/assets/dashboard.css" />
</head>
<body>
${navBar(activeNav, overview)}
<main class="container">
${body}
</main>
<footer class="site-footer">
  <span>sentry-lighthouse</span>
  <span class="dot">·</span>
  <span>${esc(config.gitSha)}</span>
  <span class="dot">·</span>
  <a href="/healthz">/healthz</a>
  <span class="dot">·</span>
  <a href="/api/builds">JSON API</a>
</footer>
<script src="/assets/dashboard.js" defer></script>
</body>
</html>`;
}

function navBar(active, overview) {
  const q = overview?.queue;
  const pills = q
    ? `<div class="queue-pills" title="Worker queue">
        ${queuePill('queued', q.queued, 'queued')}
        ${queuePill('running', q.running, 'running')}
        ${queuePill('publish', q.pendingPublish, 'to publish')}
      </div>`
    : '';
  return `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">
      ${brandMark()}
      <span class="brand-name">Lighthouse Lab</span>
    </a>
    <nav class="topnav">
      <a class="${active === 'home' ? 'active' : ''}" href="/">Builds</a>
    </nav>
    <div class="topbar-spacer"></div>
    ${pills}
  </div>
</header>`;
}

function queuePill(kind, count, label) {
  const n = count ?? 0;
  return `<span class="qpill qpill-${kind} ${n > 0 ? 'live' : 'idle'}">
    <span class="qpill-n">${n}</span><span class="qpill-l">${esc(label)}</span>
  </span>`;
}

// --- Home page ------------------------------------------------------------

export function renderHome({ overview, builds, trends, now = Date.now() }) {
  const stats = statCards(overview);
  const trendSection = trends.length ? `
  <section class="panel">
    <div class="panel-head">
      <h2>Trends by app &amp; mode</h2>
      <span class="panel-sub">median performance over recent builds</span>
    </div>
    <div class="trend-grid">
      ${trends.map(t => trendCard(t, now)).join('')}
    </div>
  </section>` : '';

  const buildsSection = `
  <section class="panel">
    <div class="panel-head">
      <h2>Recent builds</h2>
      <span class="panel-sub">${builds.length} shown</span>
    </div>
    ${builds.length ? buildsTable(builds, now) : emptyState('No builds yet', 'Upload a build via <code>POST /api/builds</code> or run <code>pnpm fixture:upload</code>.')}
  </section>`;

  return layout({
    title: 'Builds',
    activeNav: 'home',
    overview,
    refresh: overview.queue.queued > 0 || overview.queue.running > 0,
    body: stats + trendSection + buildsSection,
  });
}

function statCards(o) {
  return `<section class="stat-row">
    ${statCard('Builds', o.buildsTotal, `${o.buildsLast7} in last 7d`)}
    ${statCard('Cell pass rate', o.passRate == null ? '—' : fmtPct(o.passRate), `${o.cellsCompleted}/${o.cellsCompleted + o.cellsFailed} ok`, o.passRate == null ? 'none' : rateForPass(o.passRate))}
    ${statCard('Runs collected', o.runsTotal, 'lighthouse runs')}
    ${statCard('In flight', o.queue.queued + o.queue.running, `${o.queue.pendingPublish} awaiting publish`, (o.queue.queued + o.queue.running) > 0 ? 'live' : 'idle')}
  </section>`;
}

function statCard(label, value, sub, tone = '') {
  return `<div class="stat-card ${tone ? `tone-${tone}` : ''}">
    <div class="stat-value">${esc(String(value))}</div>
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-sub">${sub}</div>
  </div>`;
}

function rateForPass(r) {
  if (r >= 0.95) return 'good';
  if (r >= 0.8) return 'ni';
  return 'poor';
}

function buildsTable(builds, now) {
  const rows = builds.map(b => {
    const status = statusBadge(b.status);
    const score = b.avg_score == null
      ? '<span class="muted">—</span>'
      : scorePill(b.avg_score, 'sm');
    const cells = cellTally(b);
    return `<a class="brow" href="/builds/${esc(b.build_id)}">
      <span class="brow-status">${status}</span>
      <span class="brow-commit"><code>${esc(shortSha(b.commit_sha))}</code><span class="brow-branch">${esc(b.branch)}</span></span>
      <span class="brow-score">${score}</span>
      <span class="brow-cells">${cells}</span>
      <span class="brow-time" title="${esc(absTime(b.created_at))}">${esc(relTime(b.created_at, now))}</span>
      <span class="brow-arrow">→</span>
    </a>`;
  }).join('');

  return `<div class="btable">
    <div class="brow brow-head">
      <span>Status</span><span>Commit</span><span>Avg perf</span><span>Cells</span><span>Created</span><span></span>
    </div>
    ${rows}
  </div>`;
}

function cellTally(b) {
  const parts = [];
  if (b.cells_completed) parts.push(`<span class="tally tally-ok">${b.cells_completed} ok</span>`);
  if (b.cells_failed) parts.push(`<span class="tally tally-fail">${b.cells_failed} failed</span>`);
  if (b.cells_pending) parts.push(`<span class="tally tally-pending">${b.cells_pending} pending</span>`);
  if (!parts.length) parts.push(`<span class="tally muted">${b.cells_total} cells</span>`);
  return parts.join('');
}

function trendCard(t, now) {
  const latest = t.latest;
  const prev = t.points.length > 1 ? t.points[t.points.length - 2] : null;
  const delta = (latest.score != null && prev?.score != null)
    ? deltaBadge((latest.score - prev.score) * 100)
    : '';
  return `<a class="trend-card" href="/builds/${esc(latest.buildId)}">
    <div class="trend-head">
      <div class="trend-title">
        <span class="app">${esc(t.app)}</span>
        <span class="mode">${esc(t.mode)}</span>
      </div>
      ${latest.score == null ? '' : scorePill(latest.score, 'sm')}
    </div>
    ${trendSpark(t.points, p => (p.score == null ? null : p.score * 100), { rate: rateMetric({ kind: 'score' }, latest.score) })}
    <div class="trend-foot">
      <span class="trend-foot-label">${t.points.length} builds</span>
      ${delta}
      <span class="trend-foot-time" title="${esc(absTime(latest.createdAt))}">${esc(relTime(latest.createdAt, now))}</span>
    </div>
  </a>`;
}

function deltaBadge(diff) {
  if (Math.abs(diff) < 0.5) return '<span class="delta delta-flat">±0</span>';
  const up = diff > 0;
  return `<span class="delta ${up ? 'delta-up' : 'delta-down'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(diff))}</span>`;
}

// --- Build detail page ----------------------------------------------------

export function renderBuild({ build, cells, now = Date.now() }) {
  const okCells = cells.filter(c => c.status === 'completed').length;
  const failCells = cells.filter(c => c.status === 'failed').length;
  const pendingCells = cells.filter(c => c.status === 'queued' || c.status === 'running').length;
  const refresh = pendingCells > 0;

  const meta = [
    metaItem('Branch', `<code>${esc(build.branch)}</code>`),
    metaItem('Commit', `<code>${esc(shortSha(build.commit_sha))}</code>`),
    build.triggered_by ? metaItem('Trigger', esc(build.triggered_by)) : '',
    metaItem('Created', `<span title="${esc(absTime(build.created_at))}">${esc(relTime(build.created_at, now))}</span>`),
    build.completed_at ? metaItem('Duration', esc(fmtDuration(build.created_at, build.completed_at) ?? '—')) : '',
    build.workflow_run_url ? metaItem('CI', `<a href="${esc(build.workflow_run_url)}" rel="noreferrer noopener" target="_blank">workflow ↗</a>`) : '',
  ].filter(Boolean).join('');

  const header = `
  <div class="crumbs"><a href="/">Builds</a> <span class="dot">/</span> <span><code>${esc(shortSha(build.commit_sha))}</code></span></div>
  <section class="build-head">
    <div class="build-head-top">
      <h1>${statusBadge(build.status)} Build <code class="bid">${esc(build.build_id)}</code></h1>
      <div class="build-actions">
        <button id="rerun-btn" class="btn" data-build="${esc(build.build_id)}">Re-run build</button>
      </div>
    </div>
    <div class="meta-grid">${meta}</div>
    <div class="build-tally">${okCells ? `<span class="tally tally-ok">${okCells} completed</span>` : ''}${failCells ? `<span class="tally tally-fail">${failCells} failed</span>` : ''}${pendingCells ? `<span class="tally tally-pending">${pendingCells} in progress</span>` : ''}</div>
  </section>`;

  const cellHtml = cells.length
    ? cells.map(c => renderCell(c, now)).join('')
    : emptyState('No cells', 'This build has no cells.');

  return layout({
    title: `Build ${shortSha(build.commit_sha)}`,
    activeNav: '',
    overview: null,
    refresh,
    body: header + `<div class="cells">${cellHtml}</div>`,
  });
}

function metaItem(label, value) {
  return `<div class="meta-item"><span class="meta-label">${esc(label)}</span><span class="meta-value">${value}</span></div>`;
}

function renderCell(cell, now) {
  const head = `
  <div class="cell-head">
    <div class="cell-title">
      <span class="app">${esc(cell.app)}</span>
      <span class="mode">${esc(cell.mode)}</span>
      <span class="serve">${esc(cell.serve_mode)}</span>
    </div>
    <div class="cell-head-right">
      ${cell.runs.length ? `<span class="runs-count">${cell.runs.length} runs</span>` : ''}
      ${cell.published_at ? '<span class="pub-dot" title="Published to Sentry">published</span>' : ''}
      ${statusBadge(cell.status)}
    </div>
  </div>`;

  let bodyHtml;
  if (cell.status === 'failed') {
    bodyHtml = `<div class="cell-error">
      <div class="cell-error-label">Failure</div>
      <pre>${esc(cell.error || 'unknown error')}</pre>
    </div>`;
  } else if (cell.status === 'queued' || cell.status === 'running') {
    bodyHtml = `<div class="cell-pending">${cell.status === 'running' ? 'Running Lighthouse…' : 'Waiting in queue…'}</div>`;
  } else if (cell.runs.length === 0) {
    bodyHtml = `<div class="cell-pending">Completed but no runs were recorded.</div>`;
  } else {
    bodyHtml = headlineCards(cell) + runsTable(cell);
  }

  return `<section class="cell-card status-${esc(cell.status)}">${head}${bodyHtml}</section>`;
}

function headlineCards(cell) {
  const cards = headlineMetrics().map(m => {
    const values = cell.runs.map(r => r[m.key]);
    const med = median(values);
    const lo = minOf(values);
    const hi = maxOf(values);
    const rate = rateMetric(m, med);
    const big = m.kind === 'score'
      ? `<span class="hc-score" style="color:${RATE_COLOR[rate]}">${formatMetric(m, med)}</span>`
      : `<span class="hc-num" style="color:${RATE_COLOR[rate]}">${formatMetric(m, med)}</span>`;
    const spread = (lo == null || hi == null || lo === hi)
      ? '<span class="hc-spread muted">no spread</span>'
      : `<span class="hc-spread">${formatMetric(m, lo)} – ${formatMetric(m, hi)}</span>`;
    return `<div class="hcard">
      <div class="hc-label">${esc(m.short)}</div>
      <div class="hc-value">${big}</div>
      ${rangeStrip(m, values)}
      <div class="hc-foot">${spread}</div>
    </div>`;
  }).join('');
  return `<div class="hcards">${cards}</div>`;
}

function runsTable(cell) {
  const metrics = activeMetrics();
  const header = `<tr><th class="rt-idx">Run</th>${metrics.map(m => `<th title="${esc(m.label)}">${esc(m.short)}</th>`).join('')}<th class="rt-report">Report</th></tr>`;

  const body = cell.runs.map(r => {
    const cellsHtml = metrics.map(m => {
      const v = r[m.key];
      const rate = rateMetric(m, v);
      return `<td class="num rate-${rate}">${formatMetric(m, v)}</td>`;
    }).join('');
    const report = r.report_html_path
      ? `<td class="rt-report"><a href="/api/runs/${esc(r.run_id)}/report.html" target="_blank" rel="noopener">view ↗</a></td>`
      : '<td class="rt-report muted">—</td>';
    return `<tr><td class="rt-idx">#${r.run_index}</td>${cellsHtml}${report}</tr>`;
  }).join('');

  const footer = `<tr class="rt-median"><td class="rt-idx">median</td>${metrics.map(m => {
    const med = median(cell.runs.map(r => r[m.key]));
    const rate = rateMetric(m, med);
    return `<td class="num rate-${rate}">${formatMetric(m, med)}</td>`;
  }).join('')}<td class="rt-report"></td></tr>`;

  return `<details class="runs-details">
    <summary>All ${cell.runs.length} runs</summary>
    <div class="rt-scroll">
      <table class="runs-table">
        <thead>${header}</thead>
        <tbody>${body}</tbody>
        <tfoot>${footer}</tfoot>
      </table>
    </div>
  </details>`;
}

// --- Shared bits ----------------------------------------------------------

export function renderError({ code, title, message }) {
  return layout({
    title: `${code}`,
    body: `<section class="panel error-panel">
      <div class="error-code">${esc(String(code))}</div>
      <h1>${esc(title)}</h1>
      <p>${esc(message)}</p>
      <a class="btn" href="/">← Back to builds</a>
    </section>`,
  });
}

function statusBadge(status) {
  const labels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' };
  return `<span class="badge badge-${esc(status)}">${esc(labels[status] ?? status)}</span>`;
}

function scorePill(score, size = '') {
  const rate = rateMetric({ kind: 'score' }, score);
  return `<span class="score-pill rate-${rate} ${size ? `pill-${size}` : ''}">${fmtScore(score)}</span>`;
}

function emptyState(title, html) {
  return `<div class="empty">
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-body">${html}</div>
  </div>`;
}

// --- Inline SVG sparklines ------------------------------------------------

/** Dot strip showing the spread of a metric across a cell's runs. */
function rangeStrip(metric, values) {
  const xs = values.filter(v => v != null && Number.isFinite(v));
  const W = 116, H = 26, pad = 8;
  if (xs.length === 0) return `<svg class="strip" width="${W}" height="${H}" aria-hidden="true"></svg>`;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const med = median(xs);
  const span = hi - lo;
  const xOf = v => span === 0 ? W / 2 : pad + ((v - lo) / span) * (W - 2 * pad);
  const cy = H / 2;
  const baseline = `<line x1="${pad}" y1="${cy}" x2="${W - pad}" y2="${cy}" class="strip-base" />`;
  const dots = xs.map(v => `<circle cx="${xOf(v).toFixed(1)}" cy="${cy}" r="2.4" class="strip-dot" />`).join('');
  const rate = rateMetric(metric, med);
  const mx = xOf(med).toFixed(1);
  const medianMark = `<rect x="${(mx - 1.4).toFixed(1)}" y="${cy - 7}" width="2.8" height="14" rx="1.4" fill="${RATE_COLOR[rate]}" />`;
  const title = span === 0 ? `all runs ${formatMetric(metric, med)}` : `median ${formatMetric(metric, med)} · spread ${formatMetric(metric, lo)}–${formatMetric(metric, hi)}`;
  return `<svg class="strip" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${baseline}${dots}${medianMark}</svg>`;
}

/** Line sparkline across builds. accessor(point) → number|null. */
function trendSpark(points, accessor, { domainMin = null, domainMax = null, rate = 'none' } = {}) {
  const W = 240, H = 56, pad = 6;
  const ys = points.map(accessor);
  const present = ys.filter(v => v != null && Number.isFinite(v));
  if (present.length === 0) return `<svg class="trend-spark" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  // Autoscale to the data with a little headroom so the trend's *shape* reads,
  // rather than anchoring to 0 (which flattens every series against the top).
  const dataMin = Math.min(...present);
  const dataMax = Math.max(...present);
  const dpad = Math.max(1.5, (dataMax - dataMin) * 0.25);
  const lo = domainMin != null ? domainMin : dataMin - dpad;
  const hi = domainMax != null ? domainMax : dataMax + dpad;
  const span = hi - lo || 1;
  const n = points.length;
  const xOf = i => n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const yOf = v => H - pad - ((v - lo) / span) * (H - 2 * pad);

  const coords = [];
  ys.forEach((v, i) => { if (v != null && Number.isFinite(v)) coords.push([xOf(i), yOf(v)]); });
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${H - pad} L${coords[0][0].toFixed(1)} ${H - pad} Z`;
  const last = coords[coords.length - 1];
  const color = rate === 'none' ? ACCENT : RATE_COLOR[rate];

  return `<svg class="trend-spark" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    <path d="${area}" fill="${color}" fill-opacity="0.12" stroke="none" />
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${color}" />
  </svg>`;
}

// --- Tiny inline brand glyphs --------------------------------------------

function brandMark() {
  return `<svg class="brand-mark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2c-1 0-1.9.5-2.4 1.4L1.8 17.2C.8 18.9 2 21 4 21h16c2 0 3.2-2.1 2.2-3.8L14.4 3.4A2.8 2.8 0 0 0 12 2Z" fill="${ACCENT}" fill-opacity="0.18" stroke="${ACCENT}" stroke-width="1.5"/>
    <circle cx="12" cy="13.5" r="3.2" fill="none" stroke="${ACCENT}" stroke-width="1.6"/>
    <line x1="14.3" y1="15.8" x2="16.5" y2="18" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
}

function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="11" r="7" fill="none" stroke="#a78bfa" stroke-width="2.4"/><line x1="17" y1="16" x2="21" y2="20" stroke="#a78bfa" stroke-width="2.6" stroke-linecap="round"/></svg>`;
}
