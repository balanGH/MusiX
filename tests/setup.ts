/**
 * Test environment.
 *
 * `fake-indexeddb/auto` installs a real, spec-compliant IndexedDB into the Node
 * global scope, so the repository tests exercise the actual database layer —
 * cursors, compound indexes, transactions and all — rather than a mock that
 * would agree with whatever the code happens to do.
 */

import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { closeDb, deleteDatabase } from '@core/db/database';

// Each test file gets a clean database. Without this, a store written by one
// test would silently satisfy the next one's assertions.
afterEach(async () => {
  await closeDb();
  await deleteDatabase();
});
