/**
 * Internal key/value state that is too large or too structured for
 * localStorage.
 *
 * User *preferences* deliberately live in localStorage (see state/settingsStore)
 * because index.html has to read the theme synchronously before first paint.
 * This store is for the rest: the persisted play queue, which can hold
 * thousands of ids, and the shuffle seed that makes a restored shuffle order
 * identical to the one the user left.
 */

import { getDb } from '../database';
import { get as getOne, putMany, remove } from '../idb';
import { Stores } from '../schema';
import type { QueueItem, RepeatMode } from '../../types';

interface SettingRow<T> {
  key: string;
  value: T;
  updatedAt: number;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await getOne<SettingRow<T>>(await getDb(), Stores.settings, key);
  return row?.value;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await putMany(await getDb(), Stores.settings, [
    { key, value, updatedAt: Date.now() } satisfies SettingRow<T>,
  ]);
}

export async function deleteSetting(key: string): Promise<void> {
  await remove(await getDb(), Stores.settings, key);
}

// ---------------------------------------------------------------------------
// Playback session (spec §27 "Continue Listening")
// ---------------------------------------------------------------------------

const SESSION_KEY = 'playback.session';

export interface PersistedSession {
  queue: QueueItem[];
  /**
   * Playback order as indices into `queue`.
   *
   * Stored separately from the items because a shuffled queue's *visible* order
   * and its *play* order are different things, and restoring only the items
   * would silently un-shuffle what the user left playing.
   */
  order: number[];
  /** Cursor into `order`. */
  index: number;
  /** Seconds into the current track. */
  positionSec: number;
  shuffle: boolean;
  /** Seed for the shuffle order, so a restored queue keeps its order. */
  shuffleSeed: number;
  repeat: RepeatMode;
  savedAt: number;
}

export async function loadSession(): Promise<PersistedSession | undefined> {
  return getSetting<PersistedSession>(SESSION_KEY);
}

export async function saveSession(session: PersistedSession): Promise<void> {
  await setSetting(SESSION_KEY, session);
}

export async function clearSession(): Promise<void> {
  await deleteSetting(SESSION_KEY);
}
