-- Optional install command run before lhci, per cell.
--
-- Set by the uploader for cells whose bundle was shipped without
-- node_modules (the new default — see PLAN.md "Bundle format" once it's
-- updated). The worker shells this out in the extracted bundle's directory
-- and waits for it to exit zero before proceeding to lhci collect.
--
-- NULL means "no install step needed" (e.g. static cells whose bundle is
-- just the pre-built `build/` directory).

ALTER TABLE cells ADD COLUMN install_cmd TEXT;
