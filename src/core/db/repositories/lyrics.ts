/**
 * Lyrics storage (spec §14).
 *
 * Phase 1 only ever writes lyrics that were embedded in the audio file itself,
 * so this is entirely offline. The `kind` / `lines` shape is already the one a
 * synchronised LRC or TTML import will use, so Phase 3 adds parsers and an
 * editor above this store without a migration.
 */

import { getDb } from '../database';
import { get as getOne, putMany, remove } from '../idb';
import { Stores } from '../schema';
import type { Lyrics } from '../../types';

export async function getLyrics(trackId: string): Promise<Lyrics | undefined> {
  return getOne<Lyrics>(await getDb(), Stores.lyrics, trackId);
}

export async function putLyrics(lyrics: Lyrics): Promise<void> {
  await putMany(await getDb(), Stores.lyrics, [lyrics]);
}

export async function putLyricsBatch(items: readonly Lyrics[]): Promise<void> {
  await putMany(await getDb(), Stores.lyrics, items);
}

export async function deleteLyrics(trackId: string): Promise<void> {
  await remove(await getDb(), Stores.lyrics, trackId);
}
