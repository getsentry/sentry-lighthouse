// Two-process supervisor. Starts `src/server.js` and `src/publisher.js` as
// children of this Node process, forwards SIGTERM/SIGINT to both, and exits
// when either child exits. Northflank then restarts the whole container.
//
// Why a Node supervisor instead of a shell script?
//   - Single-source-of-truth for signal handling that already works on
//     macOS + Linux with no quoting surprises.
//   - We can interleave stdout from both children via stdio: 'inherit' and
//     still get clean per-process logs (each child runs pino itself).
//   - No reliance on `dumb-init` or PID 1 quirks; the supervisor *is* PID 1
//     in the container.
//
// Local dev:  `pnpm dev`         (watches both)
//             `pnpm dev:server`  (just the server, useful when iterating
//                                 on the HTTP/worker side)
//             `pnpm dev:publisher` (just the publisher, against an
//                                 already-populated DB)

// Init Sentry so child-died-unexpectedly events flow to the same project.
// The children initialise their own Sentry instances and capture their own
// crashes before exit; this layer catches the cases where a child died
// without getting that chance (SIGKILL, OOM, segfault).
import { Sentry, setProcessRole } from './lib/sentry.js';
setProcessRole('supervisor');

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, 'server.js');
const publisherEntry = resolve(here, 'publisher.js');

// `--env-file-if-exists` propagates the .env into both children when present
// (Northflank-deployed environments inject env vars directly so the file
// won't exist there — hence `-if-exists`).
const nodeArgs = ['--env-file-if-exists=.env'];

const children = [
  { name: 'server', proc: spawn('node', [...nodeArgs, serverEntry], { stdio: 'inherit', cwd: process.cwd() }) },
  { name: 'publisher', proc: spawn('node', [...nodeArgs, publisherEntry], { stdio: 'inherit', cwd: process.cwd() }) },
];

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.proc.killed) c.proc.kill(signal);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

for (const c of children) {
  c.proc.on('exit', (code, signal) => {
    console.error(`[supervisor] child '${c.name}' exited code=${code} signal=${signal}`);
    // Anything that isn't a clean code=0 (us shutting down) or signal=SIGTERM
    // (us being asked to shut down) is a crash we want to know about. SIGKILL
    // / OOM bypasses the child's own Sentry; the supervisor is the only
    // place that sees it.
    if (!shuttingDown && code !== 0 && signal !== 'SIGTERM') {
      Sentry.captureMessage(`child '${c.name}' exited unexpectedly code=${code} signal=${signal}`, {
        level: 'fatal',
        tags: { kind: 'child_died', child: c.name, exit_code: String(code), exit_signal: signal ?? '' },
      });
      Sentry.flush(2000).finally(() => {
        shutdown('SIGTERM');
        process.exit(code ?? 1);
      });
      return;
    }
    shutdown('SIGTERM');
    // Mirror the child's exit code so Northflank's restart policy treats a
    // crash as a crash.
    process.exit(code ?? 1);
  });
  c.proc.on('error', err => {
    console.error(`[supervisor] child '${c.name}' error:`, err);
    Sentry.captureException(err, {
      tags: { kind: 'child_spawn_error', child: c.name },
    });
    Sentry.flush(2000).finally(() => {
      shutdown('SIGTERM');
      process.exit(1);
    });
  });
}
