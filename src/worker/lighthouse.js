// Wrap `@lhci/cli collect` so the rest of the worker doesn't deal with argv
// shape or output discovery.
//
// Output layout once `collect` finishes (we discovered the hard way that
// `manifest.json` is only written by `lhci upload`, not `lhci collect`):
//
//   <extractDir>/.lighthouseci/lhr-<unixMs>.json   (one per run)
//   <extractDir>/.lighthouseci/lhr-<unixMs>.html   (one per run, matching basename)
//
// We pair each .json with its sibling .html by filename, sort by timestamp
// (= collection order = runIndex), and hand callers a flat array. The runner
// doesn't have to know about lhci's on-disk layout.

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../lib/config.js';
import { spawnAndLog } from './spawn.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
// `node_modules/.bin/lhci` is the binary @lhci/cli installs. We resolve
// absolutely so the worker's cwd (the extracted bundle) doesn't matter.
const lhciBin = resolve(projectRoot, 'node_modules', '.bin', 'lhci');

/**
 * Run `lhci collect` for one cell.
 *
 * @param {object} args
 * @param {object} args.cell  - DB row, snake_case columns
 * @param {string} args.extractDir - temp dir holding the extracted bundle
 * @param {object} args.log   - pino child logger
 * @returns {Promise<Array<{runIndex:number,jsonPath:string,htmlPath:string|null}>>}
 */
export async function collectLighthouse({ cell, extractDir, log }) {
  // Same run count for both methods, but the wall-clock budget is method-
  // dependent: 'devtools' applies real Slow 4G in real time, so the same number
  // of runs takes much longer than Lantern ('simulate') and needs more headroom.
  const isDevtools = cell.throttle_method === 'devtools';
  const timeoutMs = isDevtools ? config.cellTimeoutMsDevtools : config.cellTimeoutMs;

  const cliArgs = [
    'collect',
    `--numberOfRuns=${config.numRuns}`,
    '--settings.onlyCategories=performance',
    // Throttle method = the test dimension. 'simulate' is Lantern (default,
    // math-modeled Slow 4G); 'devtools' applies real Slow 4G network + CPU
    // throttling in Chrome. Passed for both so the LHR's
    // configSettings.throttlingMethod records which method produced the run.
    // Slow 4G itself is Lighthouse's mobile default, so no throttling values
    // need to be set — only the method changes.
    `--settings.throttlingMethod=${cell.throttle_method ?? 'simulate'}`,
    // --no-sandbox is required for Chromium-as-root inside Docker. Harmless on
    // Mac. headless=new uses the modern (Chrome 112+) headless mode.
    '--settings.chromeFlags=--no-sandbox --headless=new',
  ];

  if (cell.serve_mode === 'static') {
    // lhci spins up its own static server pointed at staticDir. We don't pass
    // --url; lhci finds index.html.
    cliArgs.push(`--static-dist-dir=${join(extractDir, cell.static_dir)}`);
  } else {
    // SSR. lhci runs startCmd, waits for readyPattern in its stdout, then
    // crawls the supplied URL.
    cliArgs.push(`--start-server-command=${cell.start_cmd}`);
    cliArgs.push(`--start-server-ready-pattern=${cell.ready_pattern}`);
    cliArgs.push('--start-server-ready-timeout=60000');
    cliArgs.push(`--url=${cell.url}`);
  }

  log.info({ args: cliArgs, numRuns: config.numRuns, timeoutMs }, 'lhci collect: starting');
  await spawnAndLog(lhciBin, cliArgs, {
    cwd: extractDir,
    env: { ...process.env, NODE_ENV: 'production' },
    log,
    timeoutMs,
    label: 'lhci',
  });

  return discoverRuns(join(extractDir, '.lighthouseci'));
}

/**
 * Walk `.lighthouseci/` and pair each `lhr-<ts>.json` with its sibling
 * `lhr-<ts>.html`. Runs are returned in collection order (ascending timestamp).
 */
async function discoverRuns(lhciDir) {
  const entries = await readdir(lhciDir);
  const jsonFiles = entries
    .filter(f => /^lhr-\d+\.json$/.test(f))
    .sort();

  if (jsonFiles.length === 0) {
    throw new Error(`lhci produced no lhr-*.json in ${lhciDir}`);
  }

  const htmlSet = new Set(entries.filter(f => /^lhr-\d+\.html$/.test(f)));

  return jsonFiles.map((jsonName, idx) => {
    const stem = jsonName.replace(/\.json$/, '');
    const htmlName = `${stem}.html`;
    return {
      runIndex: idx + 1,
      jsonPath: join(lhciDir, jsonName),
      htmlPath: htmlSet.has(htmlName) ? join(lhciDir, htmlName) : null,
    };
  });
}

/**
 * Extract the metrics we keep in SQLite from a parsed LHR JSON object.
 * `null`-safe; missing audits return null on that field.
 */
export function extractMetrics(lhr) {
  const audit = name => lhr?.audits?.[name]?.numericValue ?? null;
  const round = v => (v == null ? null : Math.round(v));
  return {
    score: lhr?.categories?.performance?.score ?? null,
    lcpMs: round(audit('largest-contentful-paint')),
    lcpElement: lcpElementSelector(lhr),
    fcpMs: round(audit('first-contentful-paint')),
    tbtMs: round(audit('total-blocking-time')),
    cls: audit('cumulative-layout-shift'),
    bytes: round(audit('total-byte-weight')),
    // `timing.total` is Lighthouse's own measure of how long this single run
    // took end-to-end. Lives at the LHR root, not under `audits`.
    runDurationMs: round(lhr?.timing?.total ?? null),
    sentrySdkInitMs: round(userTimingMeasure(lhr, 'sentry-sdk-init-duration')),
    sentrySdkPreInitMs: round(userTimingMeasure(lhr, 'sentry-sdk-pre-init-duration')),
    elementTimings: elementTimingMeasures(lhr),
  };
}

const ELEMENT_TIMING_PREFIX = 'element-timing-';

/**
 * Collect every `performance.measure()` whose name starts with
 * `element-timing-` out of Lighthouse's `user-timings` audit. Unlike the fixed
 * sentry-sdk-* measures, this is a dynamic set (one per timed element), so we
 * return an array of `{element, ms}` rather than a single scalar. `element` is
 * the measure name with the `element-timing-` prefix stripped (e.g.
 * 'element-timing-hero-image' → 'hero-image'); `ms` is the rounded duration.
 *
 * Only `timingType: 'Measure'` entries carry a duration — marks are ignored.
 * Returns `[]` when no matching measures are present.
 */
function elementTimingMeasures(lhr) {
  const items = lhr?.audits?.['user-timings']?.details?.items ?? [];
  const out = [];
  for (const item of items) {
    if (item.timingType !== 'Measure') continue;
    if (typeof item.name !== 'string' || !item.name.startsWith(ELEMENT_TIMING_PREFIX)) continue;
    if (item.duration == null) continue;
    out.push({
      element: item.name.slice(ELEMENT_TIMING_PREFIX.length),
      ms: Math.round(item.duration),
    });
  }
  return out;
}

/**
 * Pull a single `performance.measure()` duration (ms) out of Lighthouse's
 * `user-timings` audit by name. Returns null if the measure isn't present —
 * which happens for no-sentry cells, or if the measure fired after the trace
 * window closed. Only `timingType: 'Measure'` entries carry a duration; marks
 * are ignored.
 */
function userTimingMeasure(lhr, name) {
  const items = lhr?.audits?.['user-timings']?.details?.items ?? [];
  const measure = items.find(i => i.name === name && i.timingType === 'Measure');
  return measure?.duration ?? null;
}

/**
 * CSS selector of the element Lighthouse picked as the Largest Contentful
 * Paint. In Lighthouse 12 the `largest-contentful-paint-element` audit's
 * details is a `list` of two tables — the first holds the element node, the
 * second the LCP phase breakdown — so the node lives at items[0].items[0].node.
 * Returns null when the audit is not-applicable (no LCP element detected).
 */
function lcpElementSelector(lhr) {
  const tables = lhr?.audits?.['largest-contentful-paint-element']?.details?.items ?? [];
  return tables[0]?.items?.[0]?.node?.selector ?? null;
}
