// ULIDs everywhere. Lexicographically sortable, 26 chars, no dashes.
// Default monotonic factory so two IDs minted in the same ms still sort.

import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

export function newId() {
  return next();
}
