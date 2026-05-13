// Filesystem helpers that work in Docker too.
//
// In a Docker container, /tmp (container-local) and /data (mounted volume)
// are different filesystems. `fs.rename` returns EXDEV when crossing
// filesystems, so we need a small wrapper that falls back to copy+unlink in
// that case. Same-filesystem moves still use the fast rename(2) path.

import { copyFile, rename, unlink } from 'node:fs/promises';

/**
 * Move a file from src to dst. Identical to fs.rename when both paths are on
 * the same filesystem; falls back to copyFile + unlink across filesystems.
 *
 * Not atomic in the cross-device case, but that's the best we can do without
 * a snapshot capability. Callers that care can wrap with a tx or use a
 * staging area on the destination filesystem.
 */
export async function moveFile(src, dst) {
  try {
    await rename(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(src, dst);
    await unlink(src);
  }
}
