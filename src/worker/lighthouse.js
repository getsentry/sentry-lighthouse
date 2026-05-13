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

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../lib/config.js';

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
  const cliArgs = [
    'collect',
    `--numberOfRuns=${config.numRuns}`,
    '--settings.onlyCategories=performance',
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

  log.info({ args: cliArgs }, 'lhci collect: starting');
  await spawnAndLog(lhciBin, cliArgs, {
    cwd: extractDir,
    env: { ...process.env, NODE_ENV: 'production' },
    log,
    timeoutMs: config.cellTimeoutMs,
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
 * Spawn a child, stream its stdio into the logger, enforce a wall-clock
 * timeout. Resolves on exit 0, rejects on non-zero exit, signal, or timeout.
 */
function spawnAndLog(bin, args, { cwd, env, log, timeoutMs }) {
  return new Promise((resolveOk, rejectErr) => {
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';

    const onLine = (level, source) => buf => {
      const text = buf.toString();
      // Keep the tail of stderr so we have something useful to put in the
      // error message if lhci exits non-zero.
      if (source === 'stderr') stderrTail = (stderrTail + text).slice(-2048);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) log[level]({ src: source, line: trimmed }, 'lhci');
      }
    };

    proc.stdout.on('data', onLine('info', 'stdout'));
    proc.stderr.on('data', onLine('warn', 'stderr'));

    const killTimer = setTimeout(() => {
      log.error({ timeoutMs }, 'lhci collect exceeded timeout; killing');
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('error', err => {
      clearTimeout(killTimer);
      rejectErr(err);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) return resolveOk();
      const sigPart = signal ? ` (signal=${signal})` : '';
      const tailPart = stderrTail ? `\nstderr tail:\n${stderrTail}` : '';
      rejectErr(new Error(`lhci collect exited with code=${code}${sigPart}${tailPart}`));
    });
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
    fcpMs: round(audit('first-contentful-paint')),
    tbtMs: round(audit('total-blocking-time')),
    cls: audit('cumulative-layout-shift'),
    bytes: round(audit('total-byte-weight')),
  };
}
