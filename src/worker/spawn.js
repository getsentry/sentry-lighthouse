// Shared child-process helper used by the worker for both `lhci collect` and
// the per-cell `installCmd`.
//
// Streams stdout/stderr line-by-line into a pino child logger, enforces a
// wall-clock kill timeout, captures the tail of stderr for the error
// message on non-zero exit. Resolves on exit code 0; rejects on anything
// else (non-zero exit, signal, spawn error, timeout).

import { spawn } from 'node:child_process';

/**
 * @param {string} bin   Binary to spawn (absolute path or PATH-resolvable name).
 * @param {string[]} args
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {Record<string,string>} [opts.env]
 * @param {object} opts.log     pino-like logger
 * @param {number} opts.timeoutMs
 * @param {string} [opts.label] Tag used on log lines (defaults to the bin basename).
 * @param {boolean} [opts.shell] Pass `shell: true` to child_process.spawn (lets you pass a shell command string).
 */
export function spawnAndLog(bin, args, { cwd, env, log, timeoutMs, label, shell = false }) {
  const tag = label ?? bin.split('/').pop();
  return new Promise((resolveOk, rejectErr) => {
    const proc = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });

    let stderrTail = '';

    const onLine = (level, source) => buf => {
      const text = buf.toString();
      if (source === 'stderr') stderrTail = (stderrTail + text).slice(-2048);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) log[level]({ src: source, line: trimmed }, tag);
      }
    };

    proc.stdout.on('data', onLine('info', 'stdout'));
    proc.stderr.on('data', onLine('warn', 'stderr'));

    const killTimer = setTimeout(() => {
      log.error({ tag, timeoutMs }, 'child exceeded timeout; killing');
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('error', err => {
      clearTimeout(killTimer);
      rejectErr(err);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) return resolveOk();
      const sigPart = signal ? ` (signal=${signal})` : '';
      const tailPart = stderrTail ? `\nstderr tail:\n${stderrTail}` : '';
      rejectErr(new Error(`${tag} exited with code=${code}${sigPart}${tailPart}`));
    });
  });
}
