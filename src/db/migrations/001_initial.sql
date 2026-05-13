-- Initial schema. Three tables: builds → cells → runs.
-- See PLAN.md "Storage schema" for the rationale.

CREATE TABLE IF NOT EXISTS builds (
  build_id          TEXT PRIMARY KEY,            -- ULID
  commit_sha        TEXT NOT NULL,
  branch            TEXT NOT NULL,
  triggered_by      TEXT,                        -- 'github-actions' | 'manual'
  workflow_run_url  TEXT,                        -- nullable
  created_at        TEXT NOT NULL,               -- ISO 8601
  completed_at      TEXT,                        -- ISO 8601, NULL while running
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS builds_created_at ON builds(created_at DESC);

CREATE TABLE IF NOT EXISTS cells (
  cell_id           TEXT PRIMARY KEY,            -- ULID
  build_id          TEXT NOT NULL REFERENCES builds(build_id) ON DELETE CASCADE,
  app               TEXT NOT NULL,
  mode              TEXT NOT NULL,               -- 'no-sentry' | 'init-only' | 'tracing-replay'
  serve_mode        TEXT NOT NULL,               -- 'static' | 'server'
  static_dir        TEXT,                        -- relative path inside the bundle (static)
  start_cmd         TEXT,                        -- shell command (server)
  ready_pattern     TEXT,                        -- regex/substring to await on stdout (server)
  url               TEXT NOT NULL,               -- audited URL (default http://localhost:3000/)
  bundle_path       TEXT NOT NULL,               -- absolute path under /data/builds/<buildId>/
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error             TEXT,                        -- failure message, nullable
  queued_at         TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS cells_build_id ON cells(build_id);
CREATE INDEX IF NOT EXISTS cells_status_queued_at ON cells(status, queued_at);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,            -- ULID
  cell_id           TEXT NOT NULL REFERENCES cells(cell_id) ON DELETE CASCADE,
  run_index         INTEGER NOT NULL,            -- 1..N (typically 5)
  is_representative INTEGER NOT NULL DEFAULT 0,  -- the LHCI median-run pick
  -- Denormalised metrics for fast dashboard queries; full LHR JSON on disk.
  performance_score REAL,                        -- 0..1
  lcp_ms            INTEGER,
  fcp_ms            INTEGER,
  tbt_ms            INTEGER,
  cls               REAL,
  total_bytes       INTEGER,
  lhr_json_path     TEXT NOT NULL,               -- absolute path under /data/reports/<runId>/
  report_html_path  TEXT,                        -- absolute path to .html report, nullable
  collected_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_cell_id ON runs(cell_id);
CREATE INDEX IF NOT EXISTS runs_cell_id_representative ON runs(cell_id, is_representative);
