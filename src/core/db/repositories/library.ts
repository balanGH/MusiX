/**
 * Albums, artists, folders and sources.
 *
 * Albums and artists are *derived* records: the scanner rebuilds them from the
 * tracks it just wrote (see library/importer.ts). Nothing else may write them,
 * which is what keeps `album.trackCount` from drifting out of agreement with
 * the tracks store.
 */

import { getDb } from '../database';
import {
  count as countRows,
  get as getOne,
  getAll,
  iterate,
  putMany,
  remove,
  removeMany,
  request,
  withTransaction,
} from '../idb';
import { Idx, Stores } from '../schema';
import type { Album, Artist, Folder, MusicSource } from '../../types';

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export type AlbumSort = 'name' | 'artist' | 'year' | 'addedAt';

export async function getAlbum(id: string): Promise<Album | undefined> {
  return getOne<Album>(await getDb(), Stores.albums, id);
}

export async function listAlbums(
  sort: AlbumSort = 'name',
  direction: 'asc' | 'desc' = 'asc',
): Promise<Album[]> {
  const db = await getDb();
  const index =
    sort === 'year'
      ? Idx.albums.year
      : sort === 'addedAt'
        ? Idx.albums.addedAt
        : Idx.albums.sortName;
  const albums = await getAll<Album>(db, Stores.albums, { index });
  // Albums number in the thousands, not the hundred-thousands, so a secondary
  // in-memory sort is cheaper than maintaining compound indexes for each order.
  if (sort === 'artist') albums.sort((a, b) => a.albumArtist.localeCompare(b.albumArtist));
  return direction === 'asc' ? albums : albums.reverse();
}

export async function albumsByArtist(artistId: string): Promise<Album[]> {
  const albums = await getAll<Album>(await getDb(), Stores.albums, {
    index: Idx.albums.albumArtist,
    query: artistId,
  });
  return albums.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sortName.localeCompare(b.sortName));
}

export async function countAlbums(): Promise<number> {
  return countRows(await getDb(), Stores.albums);
}

export async function recentAlbums(limit = 20): Promise<Album[]> {
  const out: Album[] = [];
  await iterate<Album>(
    await getDb(),
    Stores.albums,
    { index: Idx.albums.addedAt, direction: 'prev' },
    (album) => {
      out.push(album);
      return out.length >= limit ? 'stop' : 'continue';
    },
  );
  return out;
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

export async function getArtist(id: string): Promise<Artist | undefined> {
  return getOne<Artist>(await getDb(), Stores.artists, id);
}

export async function listArtists(
  sort: 'name' | 'trackCount' = 'name',
  direction: 'asc' | 'desc' = 'asc',
): Promise<Artist[]> {
  const artists = await getAll<Artist>(await getDb(), Stores.artists, {
    index: sort === 'trackCount' ? Idx.artists.trackCount : Idx.artists.sortName,
  });
  return direction === 'asc' ? artists : artists.reverse();
}

export async function countArtists(): Promise<number> {
  return countRows(await getDb(), Stores.artists);
}

// ---------------------------------------------------------------------------
// Folders (spec §31)
// ---------------------------------------------------------------------------

export async function getFolder(id: string): Promise<Folder | undefined> {
  return getOne<Folder>(await getDb(), Stores.folders, id);
}

/** Direct children of a folder, or the source roots when `parentId` is null. */
export async function childFolders(parentId: string | null): Promise<Folder[]> {
  const db = await getDb();
  if (parentId === null) {
    const all = await getAll<Folder>(db, Stores.folders);
    return all
      .filter((folder) => folder.parentId === null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const folders = await getAll<Folder>(db, Stores.folders, {
    index: Idx.folders.parent,
    query: parentId,
  });
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

export async function countFolders(): Promise<number> {
  return countRows(await getDb(), Stores.folders);
}

/** Root-to-leaf chain, for the folder-view breadcrumb. */
export async function folderPath(folderId: string): Promise<Folder[]> {
  const db = await getDb();
  const chain: Folder[] = [];
  let current = await getOne<Folder>(db, Stores.folders, folderId);
  while (current) {
    chain.unshift(current);
    if (!current.parentId) break;
    current = await getOne<Folder>(db, Stores.folders, current.parentId);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function listSources(): Promise<MusicSource[]> {
  const sources = await getAll<MusicSource>(await getDb(), Stores.sources);
  return sources.sort((a, b) => a.addedAt - b.addedAt);
}

export async function getSource(id: string): Promise<MusicSource | undefined> {
  return getOne<MusicSource>(await getDb(), Stores.sources, id);
}

export async function putSource(source: MusicSource): Promise<void> {
  await putMany(await getDb(), Stores.sources, [source]);
}

/**
 * Forget a source and everything derived from it.
 *
 * Files on disk are never touched — a `directory` source was only ever a
 * reference (spec §7). `imported` sources additionally need their OPFS copies
 * removed, which the platform layer does after this returns.
 */
export async function removeSource(sourceId: string): Promise<{ removedTracks: number }> {
  const db = await getDb();

  const trackIds = (await withTransaction(db, Stores.tracks, 'readonly', (tx) =>
    request(tx.objectStore(Stores.tracks).index(Idx.tracks.source).getAllKeys(sourceId)),
  )) as string[];

  const folderIds = (await withTransaction(db, Stores.folders, 'readonly', (tx) =>
    request(tx.objectStore(Stores.folders).index(Idx.folders.source).getAllKeys(sourceId)),
  )) as string[];

  await removeMany(db, Stores.tracks, trackIds);
  await removeMany(db, Stores.folders, folderIds);
  await remove(db, Stores.sources, sourceId);

  return { removedTracks: trackIds.length };
}

// ---------------------------------------------------------------------------
// Bulk replace, used by the importer
// ---------------------------------------------------------------------------

export async function replaceAggregates(albums: Album[], artists: Artist[]): Promise<void> {
  const db = await getDb();
  // Aggregates are fully recomputed, so stale rows are cleared in the same
  // transaction as the new ones: no window where a deleted album is visible.
  await withTransaction(db, [Stores.albums, Stores.artists], 'readwrite', (tx) => {
    const albumStore = tx.objectStore(Stores.albums);
    const artistStore = tx.objectStore(Stores.artists);
    albumStore.clear();
    artistStore.clear();
    for (const album of albums) albumStore.put(album);
    for (const artist of artists) artistStore.put(artist);
  });
}

export async function putFolders(folders: readonly Folder[]): Promise<void> {
  await putMany(await getDb(), Stores.folders, folders);
}

export async function listFolders(sourceId?: string): Promise<Folder[]> {
  const db = await getDb();
  return sourceId
    ? getAll<Folder>(db, Stores.folders, { index: Idx.folders.source, query: sourceId })
    : getAll<Folder>(db, Stores.folders);
}

export async function deleteFolders(ids: readonly string[]): Promise<void> {
  await removeMany(await getDb(), Stores.folders, ids);
}
