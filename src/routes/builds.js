// Build upload + read routes.
//
// POST /api/builds — multipart: one `metadata` JSON field + N tarball file
//                    fields named per `cells[].bundleField`. Validates,
//                    stores tarballs under /data/builds/<buildId>/, inserts
//                    builds + cells (status='queued'), returns 202.
//
// GET  /api/builds         — paginated list (newest first).
// GET  /api/builds/:buildId — single build + cells + median run per cell.
//
// The worker (Phase 3) picks up queued cells; this file does not run
// Lighthouse, it only writes the queue.

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import Ajv from 'ajv';

import { getDb } from '../db/index.js';
import { config } from '../lib/config.js';
import { newId } from '../lib/ids.js';
import { buildDir, bundlePath } from '../lib/paths.js';

// Ajv instance shared across requests. Strict mode catches schema typos at
// startup rather than at runtime when a real upload hits.
const ajv = new Ajv.default({ allErrors: true, strict: true });

// --- JSON schemas ---------------------------------------------------------

// Lenient on the front (we don't want to reject CI on a typo) but strict on
// the structural bits we actually rely on downstream.
const CELL_SCHEMA = {
  type: 'object',
  required: ['app', 'mode', 'bundleField', 'serve'],
  additionalProperties: true,
  properties: {
    app: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' },
    mode: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' },
    bundleField: { type: 'string', minLength: 1, maxLength: 64 },
    serve: { type: 'string', enum: ['static', 'server'] },
    staticDir: { type: 'string', maxLength: 256 },
    startCmd: { type: 'string', maxLength: 1024 },
    readyPattern: { type: 'string', maxLength: 256 },
    url: { type: 'string', maxLength: 1024 },
  },
};

const METADATA_SCHEMA = {
  type: 'object',
  required: ['commit', 'branch', 'cells'],
  additionalProperties: true,
  properties: {
    commit: { type: 'string', minLength: 7, maxLength: 64 },
    branch: { type: 'string', minLength: 1, maxLength: 256 },
    triggeredBy: { type: 'string', maxLength: 64 },
    workflowRunUrl: { type: 'string', maxLength: 1024 },
    cells: { type: 'array', minItems: 1, maxItems: 64, items: CELL_SCHEMA },
  },
};

const validateMetadata = ajv.compile(METADATA_SCHEMA);

const LIST_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    before: { type: 'string', maxLength: 64 },
  },
};

const BUILD_ID_PARAM_SCHEMA = {
  type: 'object',
  required: ['buildId'],
  properties: { buildId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } },
};

// --- Helpers --------------------------------------------------------------

function validateCell(cell) {
  if (cell.serve === 'static' && !cell.staticDir) {
    throw new Error(`cell ${cell.app}/${cell.mode}: serve='static' requires staticDir`);
  }
  if (cell.serve === 'server' && !cell.startCmd) {
    throw new Error(`cell ${cell.app}/${cell.mode}: serve='server' requires startCmd`);
  }
}

function defaultUrl(cell) {
  return cell.url || 'http://localhost:3000/';
}

function defaultReadyPattern(cell) {
  return cell.readyPattern || 'localhost';
}

// --- Plugin ---------------------------------------------------------------

export async function buildsRoutes(fastify) {
  // ----- POST /api/builds ----------------------------------------------
  fastify.post('/api/builds', {
    onRequest: fastify.requireUploadToken,
    handler: async (req, reply) => {
      if (!req.isMultipart()) {
        reply.code(415);
        return { error: 'unsupported_media_type', message: 'expected multipart/form-data' };
      }

      // Stream every file part to a per-upload temp dir first. We don't know
      // the final tarball location until we've parsed `metadata`, and metadata
      // is itself a part — order is not guaranteed.
      const tempDir = await mkdtemp(join(tmpdir(), 'lhci-upload-'));
      const tempFiles = new Map(); // fieldname → temp absolute path
      let metadataRaw = null;
      let anyTruncated = false;

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            const dest = join(tempDir, `${part.fieldname}.tar.gz`);
            await pipeline(part.file, createWriteStream(dest));
            // @fastify/multipart sets `file.truncated` if the size limit was hit.
            if (part.file.truncated) {
              anyTruncated = true;
              req.log.warn({ field: part.fieldname }, 'upload truncated by size limit');
            }
            tempFiles.set(part.fieldname, dest);
          } else if (part.fieldname === 'metadata') {
            metadataRaw = part.value;
          } else {
            // ignore unknown text fields rather than reject — keeps the contract
            // additive for CI evolution.
            req.log.debug({ field: part.fieldname }, 'ignoring unexpected field');
          }
        }

        if (anyTruncated) {
          reply.code(413);
          return { error: 'payload_too_large', message: `file exceeded MAX_UPLOAD_BYTES (${config.maxUploadBytes})` };
        }
        if (!metadataRaw) {
          reply.code(400);
          return { error: 'missing_metadata', message: 'multipart must include a `metadata` JSON field' };
        }

        let metadata;
        try {
          metadata = JSON.parse(metadataRaw);
        } catch {
          reply.code(400);
          return { error: 'invalid_metadata', message: 'metadata is not valid JSON' };
        }

        if (!validateMetadata(metadata)) {
          reply.code(400);
          return { error: 'invalid_metadata', message: 'metadata failed schema validation', details: validateMetadata.errors };
        }

        // Per-cell business rules + bundle field linkage.
        const seenBundleFields = new Set();
        const seenAppMode = new Set();
        for (const cell of metadata.cells) {
          try {
            validateCell(cell);
          } catch (err) {
            reply.code(400);
            return { error: 'invalid_cell', message: err.message };
          }
          if (!tempFiles.has(cell.bundleField)) {
            reply.code(400);
            return {
              error: 'missing_bundle',
              message: `cell ${cell.app}/${cell.mode} references bundleField=${cell.bundleField} but no such file part was uploaded`,
            };
          }
          if (seenBundleFields.has(cell.bundleField)) {
            reply.code(400);
            return { error: 'duplicate_bundle', message: `bundleField ${cell.bundleField} is referenced by more than one cell` };
          }
          seenBundleFields.add(cell.bundleField);

          const appMode = `${cell.app}/${cell.mode}`;
          if (seenAppMode.has(appMode)) {
            reply.code(400);
            return { error: 'duplicate_cell', message: `cell ${appMode} appears more than once` };
          }
          seenAppMode.add(appMode);
        }

        // All good — mint IDs, move files, insert rows.
        const buildId = newId();
        const targetDir = buildDir(buildId);
        await mkdir(targetDir, { recursive: true });

        const cellRows = [];
        for (const cell of metadata.cells) {
          const src = tempFiles.get(cell.bundleField);
          const dst = bundlePath(buildId, cell.app, cell.mode);
          await rename(src, dst);
          cellRows.push({
            cellId: newId(),
            app: cell.app,
            mode: cell.mode,
            serveMode: cell.serve,
            staticDir: cell.staticDir ?? null,
            startCmd: cell.startCmd ?? null,
            readyPattern: defaultReadyPattern(cell),
            url: defaultUrl(cell),
            bundlePath: dst,
          });
        }

        const db = getDb();
        const insertBuild = db.prepare(`
          INSERT INTO builds (build_id, commit_sha, branch, triggered_by, workflow_run_url, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'queued')
        `);
        const insertCell = db.prepare(`
          INSERT INTO cells (
            cell_id, build_id, app, mode, serve_mode, static_dir, start_cmd,
            ready_pattern, url, bundle_path, status, queued_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        `);
        const nowIso = new Date().toISOString();
        const tx = db.transaction(() => {
          insertBuild.run(
            buildId,
            metadata.commit,
            metadata.branch,
            metadata.triggeredBy ?? null,
            metadata.workflowRunUrl ?? null,
            nowIso,
          );
          for (const c of cellRows) {
            insertCell.run(
              c.cellId, buildId, c.app, c.mode, c.serveMode,
              c.staticDir, c.startCmd, c.readyPattern, c.url, c.bundlePath,
              nowIso,
            );
          }
        });
        tx();

        req.log.info({ buildId, cells: cellRows.length }, 'build accepted');

        reply.code(202);
        return {
          buildId,
          status: 'queued',
          cells: cellRows.length,
          buildUrl: `/api/builds/${buildId}`,
          dashboardUrl: `/builds/${buildId}`,
        };
      } finally {
        // Best-effort cleanup. If `rename` succeeded the file is already gone;
        // if it failed the partial upload sits here and `rm -rf` reclaims it.
        await rm(tempDir, { recursive: true, force: true }).catch(err => {
          req.log.warn({ err, tempDir }, 'temp upload cleanup failed');
        });
      }
    },
  });

  // ----- GET /api/builds ------------------------------------------------
  fastify.get('/api/builds', {
    schema: { querystring: LIST_QUERY_SCHEMA },
    handler: async req => {
      const db = getDb();
      const { limit, before } = req.query;
      const rows = before
        ? db.prepare(`
            SELECT b.build_id, b.commit_sha, b.branch, b.created_at, b.completed_at, b.status,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id) AS cells_total,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'completed') AS cells_completed,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'failed') AS cells_failed
            FROM builds b
            WHERE b.created_at < (SELECT created_at FROM builds WHERE build_id = ?)
            ORDER BY b.created_at DESC
            LIMIT ?
          `).all(before, limit)
        : db.prepare(`
            SELECT b.build_id, b.commit_sha, b.branch, b.created_at, b.completed_at, b.status,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id) AS cells_total,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'completed') AS cells_completed,
                   (SELECT COUNT(*) FROM cells WHERE build_id = b.build_id AND status = 'failed') AS cells_failed
            FROM builds b
            ORDER BY b.created_at DESC
            LIMIT ?
          `).all(limit);

      return { builds: rows.map(serializeBuildListRow) };
    },
  });

  // ----- GET /api/builds/:buildId --------------------------------------
  fastify.get('/api/builds/:buildId', {
    schema: { params: BUILD_ID_PARAM_SCHEMA },
    handler: async (req, reply) => {
      const db = getDb();
      const { buildId } = req.params;

      const build = db.prepare(`
        SELECT build_id, commit_sha, branch, triggered_by, workflow_run_url,
               created_at, completed_at, status
        FROM builds WHERE build_id = ?
      `).get(buildId);

      if (!build) {
        reply.code(404);
        return { error: 'not_found', message: `build ${buildId} does not exist` };
      }

      // For each cell include the representative run if one exists. There's at
      // most one representative per cell (Phase 3 enforces this).
      const cells = db.prepare(`
        SELECT c.cell_id, c.app, c.mode, c.serve_mode, c.status, c.error,
               c.queued_at, c.started_at, c.completed_at,
               r.run_id AS rep_run_id,
               r.performance_score, r.lcp_ms, r.fcp_ms, r.tbt_ms, r.cls, r.total_bytes,
               (SELECT COUNT(*) FROM runs WHERE cell_id = c.cell_id) AS runs_count
        FROM cells c
        LEFT JOIN runs r ON r.cell_id = c.cell_id AND r.is_representative = 1
        WHERE c.build_id = ?
        ORDER BY c.app, c.mode
      `).all(buildId);

      return {
        buildId: build.build_id,
        commit: build.commit_sha,
        branch: build.branch,
        triggeredBy: build.triggered_by,
        workflowRunUrl: build.workflow_run_url,
        createdAt: build.created_at,
        completedAt: build.completed_at,
        status: build.status,
        cells: cells.map(serializeCellDetailRow),
      };
    },
  });
}

function serializeBuildListRow(r) {
  return {
    buildId: r.build_id,
    commit: r.commit_sha,
    branch: r.branch,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    status: r.status,
    cellsTotal: r.cells_total,
    cellsCompleted: r.cells_completed,
    cellsFailed: r.cells_failed,
  };
}

function serializeCellDetailRow(r) {
  return {
    cellId: r.cell_id,
    app: r.app,
    mode: r.mode,
    serveMode: r.serve_mode,
    status: r.status,
    error: r.error,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    runs: r.runs_count,
    medianRun: r.rep_run_id
      ? {
          runId: r.rep_run_id,
          performanceScore: r.performance_score,
          lcpMs: r.lcp_ms,
          fcpMs: r.fcp_ms,
          tbtMs: r.tbt_ms,
          cls: r.cls,
          totalBytes: r.total_bytes,
          reportUrl: `/api/runs/${r.rep_run_id}/report.html`,
        }
      : null,
  };
}
