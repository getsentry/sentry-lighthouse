#!/usr/bin/env node
// Fixture uploader. Tars up `fixtures/example/build/` and posts it as a 1-cell
// build to a running lab. Useful for proving the pipeline end-to-end without
// touching `sentry-javascript`.
//
//   node scripts/upload-fixture.js
//
// Honours the same env vars as the server (UPLOAD_TOKEN, PORT, etc.) so
// running it with `--env-file=.env` keeps everything in sync.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create as tarCreate } from 'tar';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const fixtureRoot = join(projectRoot, 'fixtures', 'example');
const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const baseUrl = process.env.LAB_URL ?? `http://localhost:${port}`;
const token = process.env.UPLOAD_TOKEN;

if (!token) {
  console.error('UPLOAD_TOKEN must be set (try `node --env-file=.env scripts/upload-fixture.js`)');
  process.exit(1);
}

try {
  await stat(join(fixtureRoot, 'build', 'index.html'));
} catch {
  console.error(`fixture missing: expected ${fixtureRoot}/build/index.html`);
  process.exit(1);
}

// 1. Tar the fixture into a temp file.
const tarDir = join(tmpdir(), `lhci-fixture-${Date.now()}`);
await mkdir(tarDir, { recursive: true });
const tarPath = join(tarDir, 'fixture.tar.gz');
try {
  await tarCreate(
    { gzip: true, file: tarPath, cwd: fixtureRoot },
    ['build'],
  );
  const { size } = await stat(tarPath);
  console.log(`tarball: ${tarPath} (${size} bytes)`);

  // 2. Build the multipart body manually. Native fetch + FormData handles
  //    file uploads cleanly without a heavy dep like `form-data`.
  const metadata = {
    commit: 'fixture00000000',
    branch: 'fixture',
    triggeredBy: 'manual',
    cells: [
      {
        app: 'fixture-static',
        mode: 'no-sentry',
        bundleField: 'bundle-0',
        serve: 'static',
        staticDir: 'build',
        url: 'http://localhost:3000/',
      },
    ],
  };

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  const buf = await streamToBuffer(createReadStream(tarPath));
  form.append('bundle-0', new Blob([buf], { type: 'application/gzip' }), 'fixture.tar.gz');

  const res = await fetch(`${baseUrl}/api/builds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const responseText = await res.text();
  console.log(`response: ${res.status} ${res.statusText}`);
  console.log(responseText);

  if (!res.ok) {
    process.exit(1);
  }
} finally {
  await rm(tarDir, { recursive: true, force: true });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
