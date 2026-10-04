/**
 * Single shared connection to the MusiX database.
 *
 * Both the main thread and the scan worker call `getDb()`. Each gets its own
 * connection to the same database, which is exactly how IndexedDB is meant to
 * be used — transactions, not connections, provide the isolation.
 */

import { createLogger } from '../logger';
import { openDatabase, request } from './idb';
import { DB_NAME, DB_VERSION, MIGRATIONS, Stores } from './schema';

const log = createLogger('db');

let connection: Promise<IDBDatabase> | null = null;

function openConnection(): Promise<IDBDatabase> {
  return openDatabase({
    name: DB_NAME,
    version: DB_VERSION,
    migrations: MIGRATIONS,
    onVersionChange: () => {
      // Drop the memo so the next caller opens a fresh connection against the
      // upgraded schema instead of using a closed handle.
      connection = null;
    },
  }).catch((error) => {
    connection = null;
    throw error;
  });
}

/**
 * A page loaded before a schema change shipped can be left holding a
 * connection whose `objectStoreNames` predates a store this code now expects
 * — a long-lived tab across a deploy, or a dev server hot-reloading modules
 * without a full page reload. Every subsequent call would otherwise fail with
 * IndexedDB's "object store not found" forever, for no reason a reload
 * wouldn't already fix — so `getDb()` checks for exactly that and reopens
 * once on its own rather than requiring the user to notice and refresh.
 */
function isMissingAStore(db: IDBDatabase): boolean {
  return Object.values(Stores).some((name) => !db.objectStoreNames.contains(name));
}

export async function getDb(): Promise<IDBDatabase> {
  if (!connection) connection = openConnection();

  const db = await connection;
  if (isMissingAStore(db)) {
    log.warn('connection predates a store this schema expects; reopening');
    db.close();
    connection = openConnection();
    return connection;
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (!connection) return;
  const db = await connection.catch(() => null);
  connection = null;
  db?.close();
}

/**
 * Wipe the library.
 *
 * Only ever called from Settings behind an explicit confirmation. Audio files
 * themselves are untouched for `directory` sources — MusiX only ever held
 * references to them (spec §7).
 */
export async function deleteDatabase(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      log.warn('database delete blocked by another tab; it will complete when that tab closes');
      resolve();
    };
  });
}

/**
 * Ask the browser not to evict us.
 *
 * Without this the whole library — including artwork and any OPFS-imported
 * audio — is "best effort" storage the browser may clear under pressure, which
 * would break the offline-first guarantee (spec §2). Chromium grants this
 * silently for installed PWAs and frequently-visited origins.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    const granted = await navigator.storage.persist();
    log.info(granted ? 'storage marked persistent' : 'persistent storage not granted');
    return granted;
  } catch {
    return false;
  }
}

export interface StorageReport {
  usedBytes: number;
  quotaBytes: number;
  persisted: boolean;
}

export async function storageReport(): Promise<StorageReport> {
  const estimate = (await navigator.storage?.estimate?.()) ?? {};
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
  return {
    usedBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
    persisted,
  };
}

/** Row counts per store, for the diagnostics panel. */
export async function storeCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const names = Array.from(db.objectStoreNames);
  const tx = db.transaction(names, 'readonly');
  const entries = await Promise.all(
    names.map(async (name) => [name, await request(tx.objectStore(name).count())] as const),
  );
  return Object.fromEntries(entries);
}
