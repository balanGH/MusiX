/**
 * Playback history (spec §7, §27).
 *
 * Kept as an append-only log rather than folded into the track record, because
 * "Continue Listening" and "Recently Played" need the sequence, not just the
 * latest timestamp. The log is trimmed rather than allowed to grow unbounded —
 * a heavy listener would otherwise accumulate hundreds of thousands of rows
 * that nothing reads.
 */

import { getDb } from '../database';
import { clearStore, count as countRows, iterate, putMany, removeMany } from '../idb';
import { Idx, Stores } from '../schema';
import type { HistoryEntry } from '../../types';

const MAX_ENTRIES = 20_000;

export async function recentHistory(limit = 100): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  await iterate<HistoryEntry>(
    await getDb(),
    Stores.history,
    { index: Idx.history.playedAt, direction: 'prev' },
    (entry) => {
      out.push(entry);
      return out.length >= limit ? 'stop' : 'continue';
    },
  );
  return out;
}

/**
 * Distinct track ids, most recent first.
 *
 * Reads more entries than `limit` because a listener who replayed one track
 * twenty times would otherwise fill the whole row.
 */
export async function recentTrackIds(limit = 20): Promise<string[]> {
  const seen = new Set<string>();
  await iterate<HistoryEntry>(
    await getDb(),
    Stores.history,
    { index: Idx.history.playedAt, direction: 'prev' },
    (entry) => {
      seen.add(entry.trackId);
      return seen.size >= limit ? 'stop' : 'continue';
    },
  );
  return [...seen];
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  await putMany(await getDb(), Stores.history, [entry]);
}

export async function countHistory(): Promise<number> {
  return countRows(await getDb(), Stores.history);
}

export async function clearHistory(): Promise<void> {
  await clearStore(await getDb(), Stores.history);
}

/**
 * Drop the oldest entries once the log exceeds its cap.
 *
 * Called after a scan (a natural, already-expensive moment) rather than on
 * every play, so playback never pays for maintenance.
 */
export async function trimHistory(max = MAX_ENTRIES): Promise<number> {
  const db = await getDb();
  const total = await countRows(db, Stores.history);
  if (total <= max) return 0;

  const excess = total - max;
  const doomed: string[] = [];
  await iterate<HistoryEntry>(
    db,
    Stores.history,
    { index: Idx.history.playedAt, direction: 'next' },
    (entry) => {
      doomed.push(entry.id);
      return doomed.length >= excess ? 'stop' : 'continue';
    },
  );
  await removeMany(db, Stores.history, doomed);
  return doomed.length;
}
