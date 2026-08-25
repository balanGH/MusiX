/**
 * Scan records (spec §7 LibraryScan).
 *
 * Every scan writes one row: what it saw, what it changed, what failed. This is
 * what makes an incremental scan auditable — "why did 3 files not import?" has
 * an answer in the UI instead of only in the console.
 */

import { getDb } from '../database';
import { get as getOne, iterate, putMany, removeMany } from '../idb';
import { Idx, Stores } from '../schema';
import type { ScanRecord } from '../../types';

const KEEP_PER_SOURCE = 20;

export async function putScan(record: ScanRecord): Promise<void> {
  await putMany(await getDb(), Stores.scans, [record]);
}

export async function getScan(id: string): Promise<ScanRecord | undefined> {
  return getOne<ScanRecord>(await getDb(), Stores.scans, id);
}

export async function recentScans(limit = 10): Promise<ScanRecord[]> {
  const out: ScanRecord[] = [];
  await iterate<ScanRecord>(
    await getDb(),
    Stores.scans,
    { index: Idx.scans.startedAt, direction: 'prev' },
    (record) => {
      out.push(record);
      return out.length >= limit ? 'stop' : 'continue';
    },
  );
  return out;
}

export async function lastCompletedScan(sourceId: string): Promise<ScanRecord | undefined> {
  let found: ScanRecord | undefined;
  await iterate<ScanRecord>(
    await getDb(),
    Stores.scans,
    { index: Idx.scans.startedAt, direction: 'prev' },
    (record) => {
      if (record.sourceId === sourceId && record.status === 'complete') {
        found = record;
        return 'stop';
      }
      return 'continue';
    },
  );
  return found;
}

/** Keep the scan log bounded; called at the end of each scan. */
export async function trimScans(sourceId: string): Promise<void> {
  const db = await getDb();
  const forSource: ScanRecord[] = [];
  await iterate<ScanRecord>(
    db,
    Stores.scans,
    { index: Idx.scans.source, query: sourceId },
    (record) => {
      forSource.push(record);
      return 'continue';
    },
  );
  if (forSource.length <= KEEP_PER_SOURCE) return;
  forSource.sort((a, b) => b.startedAt - a.startedAt);
  await removeMany(
    db,
    Stores.scans,
    forSource.slice(KEEP_PER_SOURCE).map((record) => record.id),
  );
}
