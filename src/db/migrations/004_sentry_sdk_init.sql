-- Sentry SDK init duration, sourced from the test app's User Timing API.
--
-- The instrumented apps emit a `performance.measure('sentry-sdk-init-duration')`
-- spanning SDK initialisation. Lighthouse surfaces it in the `user-timings`
-- audit, and the worker denormalises the measure's duration here (like the
-- other scalar metrics) so the publisher can ship it to Sentry.
--
-- NULL means the measure was absent from the run (e.g. no-sentry cells, or the
-- mark fired after Lighthouse's trace window closed).

ALTER TABLE runs ADD COLUMN sentry_sdk_init_ms INTEGER;
