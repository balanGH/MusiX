/**
 * Playlists.
 *
 * Ordering is held as dense integer `position` values on `playlistEntries`,
 * read through the compound `[playlistId, position]` index. Entry ids are
 * opaque so that reordering rewrites positions rather than deleting and
 * recreating rows — which matters because an entry id is what a drag-and-drop
 * gesture in the UI holds onto mid-drag.
 *
 * Smart playlists (spec §22) live in the same store but carry `rules` and no
 * entries; they are materialised on demand by core/playlists/smart.ts.
 */

import { getDb } from '../database';
import { get as getOne, getAll, putMany, request, withTransaction } from '../idb';
import { Idx, Stores } from '../schema';
import type { Playlist, PlaylistEntry, SmartRuleSet, Track } from '../../types';
import { hashId, uid } from '../../utils';

export async function listPlaylists(): Promise<Playlist[]> {
  const playlists = await getAll<Playlist>(await getDb(), Stores.playlists);
  return playlists.sort(
    (a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name),
  );
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  return getOne<Playlist>(await getDb(), Stores.playlists, id);
}

export interface CreatePlaylistInput {
  name: string;
  description?: string;
  rules?: SmartRuleSet | null;
  builtin?: boolean;
  /** Supply for built-ins so their ids stay stable across releases. */
  id?: string;
}

export async function createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
  const now = Date.now();
  const playlist: Playlist = {
    id: input.id ?? hashId(`playlist:${input.name}:${now}:${uid()}`),
    name: input.name.trim() || 'Untitled playlist',
    description: input.description?.trim() ?? '',
    kind: input.rules ? 'smart' : 'manual',
    createdAt: now,
    updatedAt: now,
    trackCount: 0,
    durationMs: 0,
    rules: input.rules ?? null,
    builtin: input.builtin ?? false,
    coverTrackId: null,
  };
  await putMany(await getDb(), Stores.playlists, [playlist]);
  return playlist;
}

export async function updatePlaylist(
  id: string,
  patch: Partial<Pick<Playlist, 'name' | 'description' | 'rules' | 'coverTrackId'>>,
): Promise<Playlist | undefined> {
  const db = await getDb();
  return withTransaction(db, Stores.playlists, 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(Stores.playlists);
    const current = await request<Playlist | undefined>(objectStore.get(id));
    if (!current) return undefined;
    const next: Playlist = {
      ...current,
      ...patch,
      // A built-in's name is part of its identity; ignore attempts to change it.
      name: current.builtin ? current.name : (patch.name?.trim() || current.name),
      updatedAt: Date.now(),
    };
    objectStore.put(next);
    return next;
  });
}

export async function deletePlaylist(id: string): Promise<boolean> {
  const db = await getDb();
  const playlist = await getOne<Playlist>(db, Stores.playlists, id);
  if (!playlist || playlist.builtin) return false;

  const entryIds = (await withTransaction(db, Stores.playlistEntries, 'readonly', (tx) =>
    request(
      tx.objectStore(Stores.playlistEntries).index(Idx.playlistEntries.playlist).getAllKeys(id),
    ),
  )) as string[];

  await withTransaction(db, [Stores.playlists, Stores.playlistEntries], 'readwrite', (tx) => {
    const entries = tx.objectStore(Stores.playlistEntries);
    for (const entryId of entryIds) entries.delete(entryId);
    tx.objectStore(Stores.playlists).delete(id);
  });
  return true;
}

/** Entries in playlist order. */
export async function playlistEntries(playlistId: string): Promise<PlaylistEntry[]> {
  const entries = await getAll<PlaylistEntry>(await getDb(), Stores.playlistEntries, {
    index: Idx.playlistEntries.position,
    query: IDBKeyRange.bound([playlistId, -Infinity], [playlistId, Infinity]),
  });
  return entries;
}

export async function playlistTrackIds(playlistId: string): Promise<string[]> {
  return (await playlistEntries(playlistId)).map((entry) => entry.trackId);
}

/**
 * Append tracks.
 *
 * Duplicates are allowed on purpose — a playlist is an ordered sequence, and
 * users do deliberately repeat a track.
 */
export async function addTracksToPlaylist(
  playlistId: string,
  trackIds: readonly string[],
): Promise<number> {
  if (trackIds.length === 0) return 0;
  const db = await getDb();
  const existing = await playlistEntries(playlistId);
  const startAt = existing.length;
  const now = Date.now();

  const entries: PlaylistEntry[] = trackIds.map((trackId, offset) => ({
    id: uid('pe'),
    playlistId,
    trackId,
    position: startAt + offset,
    addedAt: now,
  }));

  await putMany(db, Stores.playlistEntries, entries);
  await refreshPlaylistStats(playlistId);
  return entries.length;
}

export async function removePlaylistEntries(
  playlistId: string,
  entryIds: readonly string[],
): Promise<void> {
  if (entryIds.length === 0) return;
  const db = await getDb();
  const doomed = new Set(entryIds);
  const remaining = (await playlistEntries(playlistId)).filter((entry) => !doomed.has(entry.id));

  await withTransaction(db, Stores.playlistEntries, 'readwrite', (tx) => {
    const objectStore = tx.objectStore(Stores.playlistEntries);
    for (const entryId of entryIds) objectStore.delete(entryId);
    // Re-densify so `position` stays a usable array index.
    remaining.forEach((entry, index) => {
      if (entry.position !== index) objectStore.put({ ...entry, position: index });
    });
  });
  await refreshPlaylistStats(playlistId);
}

/** Move one entry to a new index, shifting the rest. */
export async function movePlaylistEntry(
  playlistId: string,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  const entries = await playlistEntries(playlistId);
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex >= entries.length
  ) {
    return;
  }
  const [moved] = entries.splice(fromIndex, 1);
  entries.splice(toIndex, 0, moved!);

  const db = await getDb();
  await withTransaction(db, Stores.playlistEntries, 'readwrite', (tx) => {
    const objectStore = tx.objectStore(Stores.playlistEntries);
    // Only the span between the two indices actually changed.
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    for (let index = lo; index <= hi; index++) {
      objectStore.put({ ...entries[index]!, position: index });
    }
  });
  await touchPlaylist(playlistId);
}

/**
 * Recompute `trackCount` / `durationMs` / cover.
 *
 * Called after every mutation so playlist rows never have to fan out to the
 * tracks store just to render a subtitle.
 */
export async function refreshPlaylistStats(playlistId: string): Promise<void> {
  const db = await getDb();
  const entries = await playlistEntries(playlistId);
  const trackIds = entries.map((entry) => entry.trackId);

  let durationMs = 0;
  let coverTrackId: string | null = null;
  if (trackIds.length > 0) {
    await withTransaction(db, Stores.tracks, 'readonly', async (tx) => {
      const objectStore = tx.objectStore(Stores.tracks);
      const rows = await Promise.all(
        trackIds.map((id) => request<Track | undefined>(objectStore.get(id))),
      );
      for (const row of rows) {
        if (!row) continue;
        durationMs += row.durationMs;
        if (!coverTrackId && row.artworkId) coverTrackId = row.id;
      }
    });
  }

  await withTransaction(db, Stores.playlists, 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(Stores.playlists);
    const playlist = await request<Playlist | undefined>(objectStore.get(playlistId));
    if (!playlist) return;
    objectStore.put({
      ...playlist,
      trackCount: entries.length,
      durationMs,
      coverTrackId,
      updatedAt: Date.now(),
    } satisfies Playlist);
  });
}

async function touchPlaylist(playlistId: string): Promise<void> {
  const db = await getDb();
  await withTransaction(db, Stores.playlists, 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(Stores.playlists);
    const playlist = await request<Playlist | undefined>(objectStore.get(playlistId));
    if (playlist) objectStore.put({ ...playlist, updatedAt: Date.now() });
  });
}

/**
 * Drop entries whose track no longer exists.
 *
 * Run once after a scan removes files, rather than filtering on every read.
 */
export async function pruneMissingEntries(removedTrackIds: readonly string[]): Promise<number> {
  if (removedTrackIds.length === 0) return 0;
  const db = await getDb();
  /** playlistId -> entry ids to drop from that playlist. */
  const doomedByPlaylist = new Map<string, string[]>();
  let total = 0;

  await withTransaction(db, Stores.playlistEntries, 'readonly', async (tx) => {
    const index = tx.objectStore(Stores.playlistEntries).index(Idx.playlistEntries.track);
    const found = await Promise.all(
      removedTrackIds.map((trackId) => request<PlaylistEntry[]>(index.getAll(trackId))),
    );
    for (const entries of found) {
      for (const entry of entries) {
        const bucket = doomedByPlaylist.get(entry.playlistId);
        if (bucket) bucket.push(entry.id);
        else doomedByPlaylist.set(entry.playlistId, [entry.id]);
        total++;
      }
    }
  });

  for (const [playlistId, entryIds] of doomedByPlaylist) {
    await removePlaylistEntries(playlistId, entryIds);
  }
  return total;
}

export async function clearPlaylist(playlistId: string): Promise<void> {
  const entries = await playlistEntries(playlistId);
  await removePlaylistEntries(
    playlistId,
    entries.map((entry) => entry.id),
  );
}
