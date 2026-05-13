// Run-level routes. Currently just the HTML report viewer — the JSON details
// of a run are reachable via its parent build's detail endpoint.
//
// GET /api/runs/:runId/report.html — serves the Lighthouse HTML report saved
//                                    by the worker (Phase 3) for the
//                                    representative run.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { getDb } from '../db/index.js';

const RUN_ID_PARAM_SCHEMA = {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } },
};

export async function runsRoutes(fastify) {
  fastify.get('/api/runs/:runId/report.html', {
    schema: { params: RUN_ID_PARAM_SCHEMA },
    handler: async (req, reply) => {
      const { runId } = req.params;
      const row = getDb().prepare(`
        SELECT report_html_path FROM runs WHERE run_id = ?
      `).get(runId);

      if (!row) {
        reply.code(404);
        return { error: 'not_found', message: `run ${runId} does not exist` };
      }
      if (!row.report_html_path) {
        reply.code(404);
        return { error: 'no_html_report', message: `run ${runId} has no HTML report on disk` };
      }

      // Confirm the file is still there. A volume corruption or manual rm
      // shouldn't 500 — give a clean 410.
      try {
        await stat(row.report_html_path);
      } catch {
        reply.code(410);
        return { error: 'report_gone', message: 'HTML report file was deleted from disk' };
      }

      reply.type('text/html; charset=utf-8');
      // Inline the report — Lighthouse HTML is self-contained.
      return createReadStream(row.report_html_path);
    },
  });
}
