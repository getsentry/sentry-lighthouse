-- Track which cells have been published to Sentry by the publisher process.
-- NULL = not published yet. ISO 8601 timestamp = published at that instant.
--
-- The publisher polls `WHERE status = 'completed' AND published_at IS NULL`
-- and updates this column after a successful `Sentry.flush()`.

ALTER TABLE cells ADD COLUMN published_at TEXT;
CREATE INDEX IF NOT EXISTS cells_unpublished
  ON cells(status, published_at)
  WHERE status = 'completed' AND published_at IS NULL;
