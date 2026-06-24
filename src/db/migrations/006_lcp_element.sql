-- CSS selector of the element Lighthouse determined to be the Largest
-- Contentful Paint, sourced from the `largest-contentful-paint-element` audit.
--
-- Denormalised here (like the other per-run scalars) so the publisher can ship
-- it to Sentry as an attribute on the `lighthouse.lcp` metric — letting
-- dashboards answer "which element is driving LCP for this app/mode".
--
-- NULL when the audit was not-applicable (Lighthouse couldn't determine an LCP
-- element for the run).

ALTER TABLE runs ADD COLUMN lcp_element TEXT;
