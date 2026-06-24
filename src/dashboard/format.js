// Pure formatting + small stats helpers shared by the dashboard views.
// No I/O, no DB, no Fastify — keeps this trivially unit-testable and safe to
// import from anywhere.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for safe interpolation into HTML text/attribute context. */
export function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// --- Stats (null-tolerant; ignore null/undefined entries) ----------------

function numeric(values) {
  return values.filter(v => v != null && Number.isFinite(v));
}

export function median(values) {
  const xs = numeric(values).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function minOf(values) {
  const xs = numeric(values);
  return xs.length ? Math.min(...xs) : null;
}

export function maxOf(values) {
  const xs = numeric(values);
  return xs.length ? Math.max(...xs) : null;
}

// --- Value formatting -----------------------------------------------------

/** Milliseconds → "812 ms" / "2.4 s" the way Lighthouse renders timings. */
export function fmtMs(v) {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s`;
  return `${Math.round(v)} ms`;
}

export function fmtBytes(v) {
  if (v == null) return '—';
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

export function fmtCls(v) {
  return v == null ? '—' : v.toFixed(3);
}

/** LHR score is a 0..1 float; Lighthouse's own UI shows it 0..100. */
export function fmtScore(v) {
  return v == null ? '—' : String(Math.round(v * 100));
}

export function fmtInt(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-US');
}

export function shortSha(sha) {
  if (!sha) return '—';
  const s = String(sha);
  // Real git SHAs → 7 chars. Non-hex placeholders (e.g. "fixture00…") stay short too.
  return /^[0-9a-f]{7,}$/i.test(s) ? s.slice(0, 7) : s.slice(0, 12);
}

// --- Time -----------------------------------------------------------------

const REL_UNITS = [
  ['y', 31536000],
  ['mo', 2592000],
  ['d', 86400],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];

/** Compact relative time, e.g. "3m ago", "2h ago", "in 4s". */
export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  let secs = Math.round((now - t) / 1000);
  if (Math.abs(secs) < 1) return 'just now';
  const future = secs < 0;
  secs = Math.abs(secs);
  for (const [label, span] of REL_UNITS) {
    if (secs >= span || label === 's') {
      const n = Math.floor(secs / span);
      return future ? `in ${n}${label}` : `${n}${label} ago`;
    }
  }
  return 'just now';
}

/** Human absolute timestamp (UTC) for tooltips/title attributes. */
export function absTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Duration between two ISO timestamps, e.g. "1m 12s". null-safe. */
export function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtPct(ratio) {
  return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
}
