// Disk usage helper. Used by the upload route to short-circuit before we
// stream MBs of tarballs to a full volume.

import { statfs } from 'node:fs/promises';

/**
 * Return the fraction of the filesystem at `path` that's in use, 0..1.
 * Uses statfs which is available on Linux + macOS in Node 18+.
 */
export async function diskUsageRatio(path) {
  const s = await statfs(path);
  if (!s.blocks) return 0;
  return (s.blocks - s.bfree) / s.blocks;
}

export async function diskFreeBytes(path) {
  const s = await statfs(path);
  return Number(s.bsize) * Number(s.bfree);
}
