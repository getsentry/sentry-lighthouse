-- Two more denormalised per-run scalars the publisher ships to Sentry.
--
-- run_duration_ms: total wall-clock time Lighthouse spent on a single run,
-- taken from the LHR's own `timing.total`. Always present for a successful run.
--
-- sentry_sdk_pre_init_ms: a `performance.measure('sentry-sdk-pre-init-duration')`
-- the instrumented apps now emit alongside `sentry-sdk-init-duration`, surfaced
-- by Lighthouse's `user-timings` audit. NULL when the measure is absent (e.g.
-- no-sentry cells, or the mark fired after Lighthouse's trace window closed).

ALTER TABLE runs ADD COLUMN run_duration_ms INTEGER;
ALTER TABLE runs ADD COLUMN sentry_sdk_pre_init_ms INTEGER;
