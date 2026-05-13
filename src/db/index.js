// SQLite handle. Better-sqlite3 is synchronous which is fine here — every query
// is a single-digit milliseconds and the whole worker is single-threaded anyway.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

let db = null;

/**
 * Open (and cache) the SQLite handle. Configures WAL + foreign keys.
 *
 * Idempotent: subsequent calls return the existing handle. Tests/scripts that
 * need a fresh connection can call `closeDb()` first.
 */
export function getDb() {
  if (db) return db;

  mkdirSync(dirname(config.dbPath), { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');           // concurrent readers + 1 writer
  db.pragma('foreign_keys = ON');             // enforce ON DELETE CASCADE
  db.pragma('synchronous = NORMAL');          // safe on WAL; faster than FULL
  db.pragma('busy_timeout = 5000');           // retry locked transactions for 5s

  logger.debug({ dbPath: config.dbPath }, 'sqlite opened');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
