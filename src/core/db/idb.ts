/**
 * A thin, fully-typed IndexedDB wrapper.
 *
 * Written by hand rather than pulled from npm for three reasons:
 *  - the schema needs explicit, ordered migrations (see schema.ts) so that a
 *    library built on v1 upgrades cleanly instead of being rebuilt;
 *  - cursor-based, index-driven paging is the only way list views stay fast at
 *    100k tracks (spec §35), and most wrappers hide the cursor;
 *  - it must run unchanged inside the scan worker.
 *
 * Nothing above this file touches a raw IDBRequest.
 */

import { createLogger, describeError } from '../logger';

const log = createLogger('idb');

export interface IndexDefinition {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  /** Index each element of an array value (used for genres, artistIds). */
  multiEntry?: boolean;
}

export interface StoreDefinition {
  name: string;
  keyPath: string;
  indexes?: IndexDefinition[];
}

export interface Migration {
  /** Database version this migration brings the schema *to*. */
  version: number;
  /** Runs inside the `versionchange` transaction. Must stay synchronous. */
  up(db: IDBDatabase, tx: IDBTransaction): void;
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** Promise wrapper for a single request. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new DatabaseError(describeError(req.error), req.error));
  });
}

/** Resolves when the transaction commits — the only safe "it is durable" signal. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new DatabaseError(describeError(tx.error), tx.error));
    tx.onabort = () =>
      reject(new DatabaseError(tx.error ? describeError(tx.error) : 'Transaction aborted'));
  });
}

export interface OpenOptions {
  name: string;
  version: number;
  migrations: Migration[];
  /** Called when another tab wants to upgrade and this connection is in the way. */
  onVersionChange?: () => void;
}

export async function openDatabase(options: OpenOptions): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new DatabaseError('IndexedDB is unavailable — MusiX cannot store a library here.');
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(options.name, options.version);

    open.onupgradeneeded = (event) => {
      const db = open.result;
      const tx = open.transaction!;
      const from = event.oldVersion;
      log.info(`upgrading schema v${from} -> v${options.version}`);
      for (const migration of options.migrations) {
        if (migration.version <= from) continue;
        try {
          migration.up(db, tx);
        } catch (error) {
          // Aborting leaves the on-disk schema at the previous version rather
          // than half-migrated, which is the recoverable outcome.
          log.error(`migration to v${migration.version} failed`, error);
          tx.abort();
          reject(new DatabaseError(`Schema migration to v${migration.version} failed`, error));
          return;
        }
      }
    };

    open.onblocked = () => {
      log.warn('upgrade blocked by another MusiX tab');
    };

    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        // Close immediately: holding the old version open would block the other
        // tab's upgrade forever.
        log.warn('another tab is upgrading the database; closing this connection');
        db.close();
        options.onVersionChange?.();
      };
      resolve(db);
    };

    open.onerror = () =>
      reject(new DatabaseError(describeError(open.error) || 'Could not open database', open.error));
  });
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Run `body` inside a transaction and resolve only once it has committed.
 *
 * Callers must not `await` anything unrelated inside `body`: IndexedDB
 * auto-commits a transaction as soon as its microtask queue drains, so an
 * unrelated await silently ends the transaction. Every write path here batches
 * its work up front for exactly this reason.
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = transactionDone(tx);
  let result: T;
  try {
    result = await body(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished; nothing to abort.
    }
    throw error;
  }
  await done;
  return result;
}

export function store(tx: IDBTransaction, name: string): IDBObjectStore {
  return tx.objectStore(name);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function get<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  return request<T | undefined>(tx.objectStore(storeName).get(key));
}

export async function getMany<T>(
  db: IDBDatabase,
  storeName: string,
  keys: readonly IDBValidKey[],
): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const tx = db.transaction(storeName, 'readonly');
  const objectStore = tx.objectStore(storeName);
  // Issuing all requests before awaiting keeps them in one transaction and lets
  // the engine pipeline them; awaiting in a loop would be an order of magnitude
  // slower for a 500-row page.
  const requests = keys.map((key) => objectStore.get(key));
  return Promise.all(requests.map((req) => request<T | undefined>(req)));
}

export async function getAll<T>(
  db: IDBDatabase,
  storeName: string,
  options: { index?: string; query?: IDBKeyRange | IDBValidKey | null; count?: number } = {},
): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const src: IDBObjectStore | IDBIndex = options.index
    ? tx.objectStore(storeName).index(options.index)
    : tx.objectStore(storeName);
  return request<T[]>(src.getAll(options.query ?? null, options.count));
}

export async function count(
  db: IDBDatabase,
  storeName: string,
  options: { index?: string; query?: IDBKeyRange | IDBValidKey | null } = {},
): Promise<number> {
  const tx = db.transaction(storeName, 'readonly');
  const src: IDBObjectStore | IDBIndex = options.index
    ? tx.objectStore(storeName).index(options.index)
    : tx.objectStore(storeName);
  return request<number>(src.count(options.query ?? undefined));
}

export type CursorVisitor<T> = (value: T, key: IDBValidKey) => 'continue' | 'stop';

/**
 * Walk a store or index with a cursor.
 *
 * This is how "top 50 most played" and "500 newest" are answered without
 * materialising the whole library: the cursor stops as soon as enough rows have
 * been seen (spec §35).
 */
export async function iterate<T>(
  db: IDBDatabase,
  storeName: string,
  options: {
    index?: string;
    query?: IDBKeyRange | IDBValidKey | null;
    direction?: IDBCursorDirection;
  },
  visit: CursorVisitor<T>,
): Promise<void> {
  const tx = db.transaction(storeName, 'readonly');
  const src: IDBObjectStore | IDBIndex = options.index
    ? tx.objectStore(storeName).index(options.index)
    : tx.objectStore(storeName);
  const req = src.openCursor(options.query ?? null, options.direction ?? 'next');

  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      let verdict: 'continue' | 'stop';
      try {
        verdict = visit(cursor.value as T, cursor.key);
      } catch (error) {
        reject(error);
        return;
      }
      if (verdict === 'stop') {
        resolve();
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(new DatabaseError(describeError(req.error), req.error));
  });
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export async function put<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  await withTransaction(db, storeName, 'readwrite', (tx) =>
    request(tx.objectStore(storeName).put(value)),
  );
}

/**
 * Write many records in one transaction.
 *
 * The scanner calls this with batches of a few hundred: one transaction per
 * file would fsync thousands of times, and one transaction for 100k files
 * would hold a write lock long enough to freeze every reader.
 */
export async function putMany<T>(
  db: IDBDatabase,
  storeName: string,
  values: readonly T[],
): Promise<void> {
  if (values.length === 0) return;
  await withTransaction(db, storeName, 'readwrite', (tx) => {
    const objectStore = tx.objectStore(storeName);
    for (const value of values) objectStore.put(value);
  });
}

export async function remove(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  await withTransaction(db, storeName, 'readwrite', (tx) =>
    request(tx.objectStore(storeName).delete(key)),
  );
}

export async function removeMany(
  db: IDBDatabase,
  storeName: string,
  keys: readonly IDBValidKey[],
): Promise<void> {
  if (keys.length === 0) return;
  await withTransaction(db, storeName, 'readwrite', (tx) => {
    const objectStore = tx.objectStore(storeName);
    for (const key of keys) objectStore.delete(key);
  });
}

export async function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
  await withTransaction(db, storeName, 'readwrite', (tx) =>
    request(tx.objectStore(storeName).clear()),
  );
}

/** Read-modify-write within a single transaction, so concurrent updates can't tear. */
export async function update<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  mutate: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  return withTransaction(db, storeName, 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(storeName);
    const current = await request<T | undefined>(objectStore.get(key));
    const next = mutate(current);
    if (next === undefined) {
      if (current !== undefined) await request(objectStore.delete(key));
      return undefined;
    }
    await request(objectStore.put(next));
    return next;
  });
}
