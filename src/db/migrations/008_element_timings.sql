-- Element-timing measures, sourced from the test app's User Timing API.
--
-- The instrumented apps emit one `performance.measure('element-timing-<label>')`
-- per timed element (e.g. 'element-timing-hero-image'). Unlike the fixed
-- sentry-sdk-* measures, this is a dynamic, unbounded set — one entry per timed
-- element — so we can't give each its own column. Instead the worker collects
-- every matching measure from Lighthouse's `user-timings` audit and stores them
-- here as a JSON array of {element, ms} objects (element = the name with the
-- 'element-timing-' prefix stripped). The publisher fans this out into one
-- `lighthouse.element_timing` distribution data point per element.
--
-- NULL means no element-timing measures were present in the run (e.g. no-sentry
-- cells, apps without the instrumentation, or measures that fired after
-- Lighthouse's trace window closed).

ALTER TABLE runs ADD COLUMN element_timings_json TEXT;
