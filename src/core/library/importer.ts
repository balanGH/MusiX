/**
 * Deriving albums, artists and folders from the tracks store.
 *
 * These are caches, not sources of truth. Rebuilding them from scratch at the
 * end of a scan is both simpler and safer than trying to patch counts
 * incrementally — an incremental update that goes wrong leaves an album showing
 * "13 tracks" forever, and there is no way for a user to notice why. A full
 * rebuild is one cursor pass over the tracks store, which at the end of an
 * already-expensive scan costs nothing worth optimising.
 */

import { collator, fold, sortKey, splitArtists } from '../utils';
import { replaceAggregates, deleteFolders, listFolders, putFolders } from '../db/repositories/library';
import { scanAllTracks } from '../db/repositories/tracks';
import { artistIdFor, folderIdFor } from './trackBuilder';
import type { Album, Artist, AudioFormat, Folder, Track } from '../types';

/** Internal accumulator; not persisted. */
interface AlbumAcc {
  id: string;
  name: string;
  albumArtist: string;
  albumArtistId: string;
  year: number | null;
  genres: Set<string>;
  trackCount: number;
  discs: Set<number>;
  durationMs: number;
  artworkId: string | null;
  formats: Set<AudioFormat>;
  lossless: boolean;
  addedAt: number;
}

interface ArtistAcc {
  id: string;
  name: string;
  albums: Set<string>;
  trackCount: number;
  durationMs: number;
  genres: Set<string>;
  artworkId: string | null;
}

export interface AggregateResult {
  albums: number;
  artists: number;
}

export async function rebuildAggregates(): Promise<AggregateResult> {
  const albums = new Map<string, AlbumAcc>();
  const artists = new Map<string, ArtistAcc>();

  await scanAllTracks((track) => {
    accumulateAlbum(albums, track);
    accumulateArtists(artists, track);
    return 'continue';
  });

  const albumRows: Album[] = [...albums.values()].map((acc) => ({
    id: acc.id,
    name: acc.name,
    sortName: sortKey(acc.name),
    albumArtist: acc.albumArtist,
    albumArtistId: acc.albumArtistId,
    year: acc.year,
    genres: [...acc.genres].slice(0, 8),
    trackCount: acc.trackCount,
    discCount: Math.max(1, acc.discs.size),
    durationMs: acc.durationMs,
    artworkId: acc.artworkId,
    formats: [...acc.formats],
    lossless: acc.lossless,
    addedAt: acc.addedAt,
    searchText: fold(`${acc.name} ${acc.albumArtist}`),
  }));

  const artistRows: Artist[] = [...artists.values()].map((acc) => ({
    id: acc.id,
    name: acc.name,
    sortName: sortKey(acc.name),
    albumCount: acc.albums.size,
    trackCount: acc.trackCount,
    durationMs: acc.durationMs,
    genres: [...acc.genres].slice(0, 8),
    artworkId: acc.artworkId,
    searchText: fold(acc.name),
  }));

  albumRows.sort((a, b) => collator.compare(a.sortName, b.sortName));
  artistRows.sort((a, b) => collator.compare(a.sortName, b.sortName));

  await replaceAggregates(albumRows, artistRows);
  return { albums: albumRows.length, artists: artistRows.length };
}

function accumulateAlbum(albums: Map<string, AlbumAcc>, track: Track): void {
  const existing = albums.get(track.albumId);
  if (!existing) {
    albums.set(track.albumId, {
      id: track.albumId,
      name: track.album,
      albumArtist: track.albumArtist,
      albumArtistId: track.artistIds[0] ?? '',
      year: track.year,
      genres: new Set(track.genres),
      trackCount: 1,
      discs: new Set(track.discNo === null ? [1] : [track.discNo]),
      durationMs: track.durationMs,
      artworkId: track.artworkId,
      formats: new Set([track.format]),
      lossless: track.lossless,
      addedAt: track.addedAt,
    });
    return;
  }

  existing.trackCount++;
  existing.durationMs += track.durationMs;
  existing.discs.add(track.discNo ?? 1);
  existing.formats.add(track.format);
  for (const genre of track.genres) existing.genres.add(genre);
  existing.artworkId ??= track.artworkId;
  // The earliest year on the album is the release year; a compilation with
  // per-track years should not show the latest one.
  if (track.year !== null && (existing.year === null || track.year < existing.year)) {
    existing.year = track.year;
  }
  // "Recently Added" should surface an album as soon as any of it arrives.
  if (track.addedAt > existing.addedAt) existing.addedAt = track.addedAt;
  // One lossy track makes the album not losslessly complete.
  if (!track.lossless) existing.lossless = false;
}

function accumulateArtists(artists: Map<string, ArtistAcc>, track: Track): void {
  // Every credited artist gets the track, which is what makes a featured
  // appearance show up on the guest artist's page too (spec §29).
  //
  // Each split name is paired with its *own* id via `artistIdFor`, the same
  // function `trackBuilder.ts` used to build `track.artistIds` in the first
  // place — rather than zipping `track.artistIds[i]` against a separately
  // built `names[i]` by position. The previous version did the latter,
  // pairing split artists with an *unsplit* `track.albumArtist` string: a
  // track whose album-artist credit itself named more than one person
  // produced fewer names than ids, and every id past that point silently
  // took `track.artist` — the whole track's artist string — as its name,
  // mislabelling that artist's own page.
  const idToName = new Map<string, string>();
  for (const name of [...track.artists, ...splitArtists(track.albumArtist)]) {
    idToName.set(artistIdFor(name), name);
  }

  for (const id of track.artistIds) {
    const name = idToName.get(id) ?? track.artist;
    const existing = artists.get(id);
    if (!existing) {
      artists.set(id, {
        id,
        name,
        albums: new Set([track.albumId]),
        trackCount: 1,
        durationMs: track.durationMs,
        genres: new Set(track.genres),
        artworkId: track.artworkId,
      });
      continue;
    }
    existing.trackCount++;
    existing.durationMs += track.durationMs;
    existing.albums.add(track.albumId);
    for (const genre of track.genres) existing.genres.add(genre);
    existing.artworkId ??= track.artworkId;
  }
}

/**
 * Rebuild the folder tree for one source.
 *
 * @param directories every directory that currently contains at least one
 *   indexed track, as source-relative paths ('' for the root).
 */
export async function rebuildFolders(
  sourceId: string,
  sourceName: string,
  directories: Map<string, number>,
): Promise<number> {
  const folders = new Map<string, Folder>();

  const ensure = (path: string): Folder => {
    const existing = folders.get(path);
    if (existing) return existing;

    const segments = path === '' ? [] : path.split('/');
    const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : path === '' ? null : '';
    // Parent chain first, so `depth` and `parentId` are always consistent.
    const parent = parentPath === null ? null : ensure(parentPath);

    const folder: Folder = {
      id: folderIdFor(sourceId, path),
      sourceId,
      path,
      name: segments.length > 0 ? segments[segments.length - 1]! : sourceName,
      parentId: parent ? parent.id : null,
      depth: segments.length,
      trackCount: 0,
    };
    folders.set(path, folder);
    return folder;
  };

  for (const [path, count] of directories) {
    ensure(path).trackCount = count;
  }

  // Remove folders that no longer contain anything, then write the new tree.
  const previous = await listFolders(sourceId);
  const stale = previous.filter((folder) => !folders.has(folder.path)).map((folder) => folder.id);
  if (stale.length > 0) await deleteFolders(stale);
  await putFolders([...folders.values()]);

  return folders.size;
}
