/**
 * Track queries.
 *
 * The paging strategy matters more than any single query here, so it is worth
 * stating once:
 *
 *   A sorted *view* is an array of track ids, obtained with a single
 *   `index.getAllKeys()` call. IndexedDB returns primary keys already ordered by
 *   the index key, so "all 100k songs, title A→Z" costs one request and about
 *   2 MB of strings — no records are decoded. The virtualised list then asks for
 *   the ~60 records it can actually show, by id.
 *
 * This is why the UI stays responsive on a 100k-track library (spec §35): the
 * expensive part (deserialising records with embedded metadata) only ever runs
 * for rows on screen.
 */

import { collator } from '../../utils';
import { getDb } from '../database';
import {
  count as countRows,
  get as getOne,
  getAll,
  getMany,
  iterate,
  putMany,
  removeMany,
  request,
  withTransaction,
} from '../idb';
import { Idx, Stores } from '../schema';
import type { HistoryEntry, Track } from '../../types';
import { uid } from '../../utils';

export type TrackSort =
  | 'title'
  | 'artist'
  | 'album'
  | 'addedAt'
  | 'lastPlayedAt'
  | 'playCount'
  | 'rating'
  | 'duration';

const SORT_INDEX: Record<Exclude<TrackSort, 'duration' | 'album'>, string> = {
  title: Idx.tracks.sortTitle,
  artist: Idx.tracks.sortArtist,
  addedAt: Idx.tracks.addedAt,
  lastPlayedAt: Idx.tracks.lastPlayedAt,
  playCount: Idx.tracks.playCount,
  rating: Idx.tracks.rating,
};

export async function getTrack(id: string): Promise<Track | undefined> {
  return getOne<Track>(await getDb(), Stores.tracks, id);
}

/**
 * Fetch many tracks, preserving the requested order and dropping ids that no
 * longer exist (a queue can outlive a rescan that removed a file).
 */
export async function getTracks(ids: readonly string[]): Promise<Track[]> {
  if (ids.length === 0) return [];
  const rows = await getMany<Track>(await getDb(), Stores.tracks, ids);
  return rows.filter((row): row is Track => row !== undefined);
}

/** Same as `getTracks` but keyed, for callers that need to detect the gaps. */
export async function getTrackMap(ids: readonly string[]): Promise<Map<string, Track>> {
  const tracks = await getTracks(ids);
  return new Map(tracks.map((track) => [track.id, track]));
}

export async function countTracks(): Promise<number> {
  return countRows(await getDb(), Stores.tracks);
}

/**
 * Ordered ids for a sorted view. See the file header for why this is keys-only.
 *
 * `album` sorts by album then disc then track number, which no single index can
 * express, so it is the one sort that reads records. It is also the one sort
 * users rarely apply to the whole library, and it is still a single pass.
 */
export async function trackIdsSorted(
  sort: TrackSort,
  direction: 'asc' | 'desc' = 'asc',
): Promise<string[]> {
  const db = await getDb();

  if (sort === 'album' || sort === 'duration') {
    const tracks = await getAll<Track>(db, Stores.tracks);
    tracks.sort(
      sort === 'album'
        ? (a, b) =>
            collator.compare(a.album, b.album) ||
            (a.discNo ?? 1) - (b.discNo ?? 1) ||
            (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
            collator.compare(a.title, b.title)
        : (a, b) => a.durationMs - b.durationMs,
    );
    const ids = tracks.map((track) => track.id);
    return direction === 'asc' ? ids : ids.reverse();
  }

  const index = SORT_INDEX[sort];
  const tx = db.transaction(Stores.tracks, 'readonly');
  const keys = (await request(
    tx.objectStore(Stores.tracks).index(index).getAllKeys(),
  )) as string[];
  return direction === 'asc' ? keys : keys.reverse();
}

/** All tracks of one album, in disc/track order — the album page's only query. */
export async function tracksByAlbum(albumId: string): Promise<Track[]> {
  const tracks = await getAll<Track>(await getDb(), Stores.tracks, {
    index: Idx.tracks.album,
    query: albumId,
  });
  return tracks.sort(
    (a, b) =>
      (a.discNo ?? 1) - (b.discNo ?? 1) ||
      (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
      collator.compare(a.title, b.title),
  );
}

export async function tracksByArtist(artistId: string): Promise<Track[]> {
  const tracks = await getAll<Track>(await getDb(), Stores.tracks, {
    index: Idx.tracks.artists,
    query: artistId,
  });
  return tracks.sort(
    (a, b) =>
      (b.year ?? 0) - (a.year ?? 0) ||
      collator.compare(a.album, b.album) ||
      (a.discNo ?? 1) - (b.discNo ?? 1) ||
      (a.trackNo ?? 0) - (b.trackNo ?? 0),
  );
}

export async function tracksByFolder(folderId: string): Promise<Track[]> {
  const tracks = await getAll<Track>(await getDb(), Stores.tracks, {
    index: Idx.tracks.folder,
    query: folderId,
  });
  return tracks.sort(
    (a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0) || collator.compare(a.filename, b.filename),
  );
}

export async function tracksByGenre(genre: string): Promise<Track[]> {
  return getAll<Track>(await getDb(), Stores.tracks, {
    index: Idx.tracks.genres,
    query: genre,
  });
}

export async function trackIdsBySource(sourceId: string): Promise<string[]> {
  const db = await getDb();
  const tx = db.transaction(Stores.tracks, 'readonly');
  return (await request(
    tx.objectStore(Stores.tracks).index(Idx.tracks.source).getAllKeys(sourceId),
  )) as string[];
}

// ---------------------------------------------------------------------------
// Curated views (Home screen, spec §27; smart playlists, spec §22)
// ---------------------------------------------------------------------------

/**
 * Newest first, capped.
 *
 * The cursor runs in reverse over `addedAt` and stops at `limit`, so this costs
 * `limit` record reads regardless of library size.
 */
export async function recentlyAdded(limit = 40): Promise<Track[]> {
  return topByIndex(Idx.tracks.addedAt, limit, 'prev');
}

/** Most recently played. Sparse index: never-played tracks aren't visited. */
export async function recentlyPlayed(limit = 40): Promise<Track[]> {
  return topByIndex(Idx.tracks.lastPlayedAt, limit, 'prev');
}

export async function mostPlayed(limit = 40): Promise<Track[]> {
  const tracks = await topByIndex(Idx.tracks.playCount, limit, 'prev');
  return tracks.filter((track) => track.playCount > 0);
}

/** Favourites, most recently favourited first. Sparse index. */
export async function favorites(limit?: number): Promise<Track[]> {
  return topByIndex(Idx.tracks.favoritedAt, limit ?? Infinity, 'prev');
}

export async function favoriteCount(): Promise<number> {
  // Counting the sparse index counts exactly the favourites.
  return countRows(await getDb(), Stores.tracks, { index: Idx.tracks.favoritedAt });
}

/**
 * Tracks that have never been played.
 *
 * There is no "index of absent keys", so this walks the store — but it only
 * keeps `limit` rows and stops early, and it is only reached from an explicitly
 * opened smart playlist (spec §4: no speculative work).
 */
export async function neverPlayed(limit = 200): Promise<Track[]> {
  const out: Track[] = [];
  await iterate<Track>(await getDb(), Stores.tracks, {}, (track) => {
    if (track.playCount === 0 && track.lastPlayedAt === null) out.push(track);
    return out.length >= limit ? 'stop' : 'continue';
  });
  return out;
}

async function topByIndex(
  index: string,
  limit: number,
  direction: IDBCursorDirection,
): Promise<Track[]> {
  const out: Track[] = [];
  await iterate<Track>(await getDb(), Stores.tracks, { index, direction }, (track) => {
    out.push(track);
    return out.length >= limit ? 'stop' : 'continue';
  });
  return out;
}

/**
 * Stream every track through `visit`.
 *
 * Used by library health (§24) and by smart-playlist evaluation, both of which
 * are user-initiated. Cursor-based so peak memory stays at one record.
 */
export async function scanAllTracks(
  visit: (track: Track) => 'continue' | 'stop',
): Promise<void> {
  await iterate<Track>(await getDb(), Stores.tracks, {}, visit);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function putTracks(tracks: readonly Track[]): Promise<void> {
  await putMany(await getDb(), Stores.tracks, tracks);
}

export async function deleteTracks(ids: readonly string[]): Promise<void> {
  await removeMany(await getDb(), Stores.tracks, ids);
}

export async function setFavorite(trackId: string, favorite: boolean): Promise<Track | undefined> {
  return patchTrack(trackId, (track) => ({
    ...track,
    favorite,
    // Null (not 0) so the sparse `favoritedAt` index drops un-favourited rows.
    favoritedAt: favorite ? Date.now() : null,
  }));
}

export async function setRating(trackId: string, rating: number): Promise<Track | undefined> {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)));
  return patchTrack(trackId, (track) => ({ ...track, rating: clamped }));
}

/**
 * Record a completed (or near-completed) play.
 *
 * The track counters and the history row are written in one transaction across
 * both stores, so "Most Played" can never disagree with "Recently Played".
 */
export async function recordPlay(
  trackId: string,
  msPlayed: number,
  completed: boolean,
): Promise<void> {
  const db = await getDb();
  const playedAt = Date.now();
  await withTransaction(db, [Stores.tracks, Stores.history], 'readwrite', async (tx) => {
    const trackStore = tx.objectStore(Stores.tracks);
    const track = await request<Track | undefined>(trackStore.get(trackId));
    if (!track) return;
    trackStore.put({
      ...track,
      playCount: track.playCount + 1,
      lastPlayedAt: playedAt,
    } satisfies Track);
    const entry: HistoryEntry = {
      id: uid('h'),
      trackId,
      playedAt,
      msPlayed: Math.round(msPlayed),
      completed,
    };
    tx.objectStore(Stores.history).put(entry);
  });
}

/**
 * Record that a track now has lyrics stored against it.
 *
 * Kept separate from the lyrics store itself so the flag a list row reads is a
 * field on the track, not a second lookup per row.
 */
export async function setHasLyrics(trackId: string, hasLyrics: boolean): Promise<Track | undefined> {
  return patchTrack(trackId, (track) => ({ ...track, hasLyrics }));
}

/** A skip is worth knowing about but is not a play. */
export async function recordSkip(trackId: string): Promise<void> {
  await patchTrack(trackId, (track) => ({ ...track, skipCount: track.skipCount + 1 }));
}

async function patchTrack(
  trackId: string,
  patch: (track: Track) => Track,
): Promise<Track | undefined> {
  const db = await getDb();
  return withTransaction(db, Stores.tracks, 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(Stores.tracks);
    const current = await request<Track | undefined>(objectStore.get(trackId));
    if (!current) return undefined;
    const next = patch(current);
    objectStore.put(next);
    return next;
  });
}
