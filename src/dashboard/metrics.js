// The catalog of denormalised per-run metrics the dashboard knows how to
// render, plus helpers to format + threshold-rate a value.
//
// `key` is the column name in the `runs` table. The display order below is the
// order metrics appear in the UI. We intersect this catalog with the columns
// that actually exist (PRAGMA table_info) so the dashboard tolerates a DB that
// is a migration ahead of or behind this file.

import { fmtMs, fmtBytes, fmtCls, fmtScore, fmtInt } from './format.js';
import { getDb } from '../db/index.js';

// Thresholds for the Core-Web-Vitals-ish metrics mirror Lighthouse's own
// good/needs-improvement/poor cutoffs (mobile). Metrics without good/poor are
// shown without a colour judgement (neutral).
export const RUN_METRICS = [
  { key: 'performance_score', label: 'Performance', short: 'Perf', kind: 'score', headline: true },
  { key: 'lcp_ms', label: 'Largest Contentful Paint', short: 'LCP', kind: 'ms', headline: true, good: 2500, poor: 4000 },
  { key: 'fcp_ms', label: 'First Contentful Paint', short: 'FCP', kind: 'ms', headline: true, good: 1800, poor: 3000 },
  { key: 'tbt_ms', label: 'Total Blocking Time', short: 'TBT', kind: 'ms', headline: true, good: 200, poor: 600 },
  { key: 'cls', label: 'Cumulative Layout Shift', short: 'CLS', kind: 'cls', headline: true, good: 0.1, poor: 0.25 },
  { key: 'total_bytes', label: 'Total Byte Weight', short: 'Weight', kind: 'bytes', headline: true },
  { key: 'run_duration_ms', label: 'LH Run Duration', short: 'Run', kind: 'ms' },
  { key: 'sentry_sdk_pre_init_ms', label: 'Sentry SDK Pre-init', short: 'Pre-init', kind: 'ms', sentry: true },
  { key: 'sentry_sdk_init_ms', label: 'Sentry SDK Init', short: 'SDK init', kind: 'ms', sentry: true },
];

let _cols = null;

/** Set of column names present on the `runs` table (cached per process). */
export function availableRunColumns() {
  if (_cols) return _cols;
  const rows = getDb().prepare('PRAGMA table_info(runs)').all();
  _cols = new Set(rows.map(r => r.name));
  return _cols;
}

/** Catalog entries whose column exists in this DB, in display order. */
export function activeMetrics() {
  const cols = availableRunColumns();
  return RUN_METRICS.filter(m => cols.has(m.key));
}

export function headlineMetrics() {
  return activeMetrics().filter(m => m.headline);
}

/** Format a raw column value per its metric kind. */
export function formatMetric(metric, value) {
  if (value == null) return '—';
  switch (metric.kind) {
    case 'score': return fmtScore(value);
    case 'ms': return fmtMs(value);
    case 'cls': return fmtCls(value);
    case 'bytes': return fmtBytes(value);
    default: return fmtInt(value);
  }
}

/**
 * Rate a value against the metric's thresholds.
 * @returns {'good'|'ni'|'poor'|'none'}
 */
export function rateMetric(metric, value) {
  if (value == null) return 'none';
  if (metric.kind === 'score') {
    if (value >= 0.9) return 'good';
    if (value >= 0.5) return 'ni';
    return 'poor';
  }
  if (metric.good != null && metric.poor != null) {
    if (value <= metric.good) return 'good';
    if (value <= metric.poor) return 'ni';
    return 'poor';
  }
  return 'none';
}
