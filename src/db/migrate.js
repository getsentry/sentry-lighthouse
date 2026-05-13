// Minimal SQL migration runner.
//
// Migrations live in `src/db/migrations/NNN_<slug>.sql`. We track which ones
// have been applied in a `_migrations` table by filename. To roll out a schema
// change: add a new numbered file. Never edit an applied migration.
//
// Called automatically at server boot (no separate `db migrate` step in
// production) and also exposed as a CLI for local use:
//
//     pnpm migrate
//     node src/db/migrate.js

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb } from './index.js';
import { logger } from '../lib/logger.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function runMigrations() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name),
  );

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic == numeric ordering when we prefix with NNN_

  const insertApplied = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  let applyCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    logger.info({ file }, 'applying migration');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(file, new Date().toISOString());
    });
    tx();
    applyCount++;
  }

  logger.info({ applied: applyCount, total: files.length }, 'migrations done');
  return applyCount;
}

// CLI entrypoint: `node src/db/migrate.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
    closeDb();
  } catch (err) {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  }
}
