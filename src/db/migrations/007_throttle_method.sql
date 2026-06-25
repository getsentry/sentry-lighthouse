-- Throttle method: the new test-method dimension. Each (app, mode) scenario now
-- runs twice, once per Lighthouse throttlingMethod:
--   'simulate' = Lantern, math-modeled Slow 4G (the historical default)
--   'devtools' = real browser-applied Slow 4G (network + CPU throttling via CDP)
--
-- Existing rows predate the dimension and were all collected under Lantern, so
-- the 'simulate' default backfills them truthfully. NOT NULL + DEFAULT keeps the
-- worker/publisher reads total.

ALTER TABLE cells ADD COLUMN throttle_method TEXT NOT NULL DEFAULT 'simulate';
