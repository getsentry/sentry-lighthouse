-- Optional install command run before lhci, per cell.
--
-- Set by the uploader for cells whose bundle was shipped without
-- node_modules (the default for SSR cells where the lab needs to populate
-- a runtime tree from package.json + lockfile). The worker shells this out
-- in the extracted bundle's directory and waits for it to exit zero before
-- proceeding to lhci collect.
--
-- NULL means "no install step needed" (e.g. static cells whose bundle is
-- just the pre-built `build/` directory).

ALTER TABLE cells ADD COLUMN install_cmd TEXT;
