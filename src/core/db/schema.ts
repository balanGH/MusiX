/**
 * The MusiX local database.
 *
 * IndexedDB stands in for the SQLite database the spec describes (§7). The
 * mapping is direct — one object store per entity, one index per query the UI
 * actually issues — with two deliberate differences:
 *
 *  1. No joins exist, so `Track` carries denormalised album / artist names and
 *     the user's favourite, rating and play-count fields (see types.ts).
 *  2. IndexedDB cannot index a boolean. Flags that need an index are stored as
 *     nullable timestamps instead (`favoritedAt`, `lastPlayedAt`): records with
 *     a null value are simply absent from the index, which turns "list the
 *     favourites" into an index scan over exactly the favourites.
 *
 * Adding a store or index means appending a migration, never editing v1 — a
 * user's library must upgrade, not be rebuilt.
 */

import type { Migration, StoreDefinition } from './idb';

export const DB_NAME = 'musix';
export const DB_VERSION = 2;

export const Stores = {
  tracks: 'tracks',
  albums: 'albums',
  artists: 'artists',
  folders: 'folders',
  sources: 'sources',
  /** FileSystemDirectoryHandle objects, kept out of `sources` so those stay cloneable data. */
  handles: 'handles',
  artwork: 'artwork',
  /** Online-fetched artist photos, keyed by artist id — see `ArtistPhoto`. */
  artistPhotos: 'artistPhotos',
  lyrics: 'lyrics',
  playlists: 'playlists',
  playlistEntries: 'playlistEntries',
  history: 'history',
  scans: 'scans',
  settings: 'settings',
} as const;

export type StoreName = (typeof Stores)[keyof typeof Stores];

/**
 * Index names are referenced from repositories; keeping them in one object
 * means a typo is a type error rather than a silent full-store scan.
 */
export const Idx = {
  tracks: {
    sortTitle: 'by_sortTitle',
    sortArtist: 'by_sortArtist',
    album: 'by_albumId',
    artists: 'by_artistIds',
    genres: 'by_genres',
    folder: 'by_folderId',
    source: 'by_sourceId',
    sourcePath: 'by_source_path',
    fingerprint: 'by_source_fingerprint',
    addedAt: 'by_addedAt',
    lastPlayedAt: 'by_lastPlayedAt',
    playCount: 'by_playCount',
    favoritedAt: 'by_favoritedAt',
    rating: 'by_rating',
    format: 'by_format',
  },
  albums: {
    sortName: 'by_sortName',
    albumArtist: 'by_albumArtistId',
    year: 'by_year',
    addedAt: 'by_addedAt',
  },
  artists: {
    sortName: 'by_sortName',
    trackCount: 'by_trackCount',
  },
  folders: {
    source: 'by_sourceId',
    parent: 'by_parentId',
    sourcePath: 'by_source_path',
  },
  playlists: {
    updatedAt: 'by_updatedAt',
    name: 'by_name',
  },
  playlistEntries: {
    playlist: 'by_playlistId',
    position: 'by_playlist_position',
    track: 'by_trackId',
  },
  history: {
    playedAt: 'by_playedAt',
    track: 'by_trackId',
  },
  scans: {
    source: 'by_sourceId',
    startedAt: 'by_startedAt',
  },
  lyrics: {
    track: 'by_trackId',
  },
} as const;

const SCHEMA_V1: StoreDefinition[] = [
  {
    name: Stores.tracks,
    keyPath: 'id',
    indexes: [
      { name: Idx.tracks.sortTitle, keyPath: 'sortTitle' },
      { name: Idx.tracks.sortArtist, keyPath: 'sortArtist' },
      { name: Idx.tracks.album, keyPath: 'albumId' },
      { name: Idx.tracks.artists, keyPath: 'artistIds', multiEntry: true },
      { name: Idx.tracks.genres, keyPath: 'genres', multiEntry: true },
      { name: Idx.tracks.folder, keyPath: 'folderId' },
      { name: Idx.tracks.source, keyPath: 'sourceId' },
      // Unique: one row per file. The scanner relies on this to detect renames
      // and to refuse to index the same path twice.
      { name: Idx.tracks.sourcePath, keyPath: ['sourceId', 'path'], unique: true },
      // The incremental scanner walks this index with a *key* cursor: the whole
      // fingerprint is in the key, so deciding "has this file changed?" for
      // 100k files reads zero records (spec §4).
      {
        name: Idx.tracks.fingerprint,
        keyPath: ['sourceId', 'path', 'fileModifiedAt', 'sizeBytes'],
      },
      { name: Idx.tracks.addedAt, keyPath: 'addedAt' },
      // Sparse by design — only played tracks carry a timestamp.
      { name: Idx.tracks.lastPlayedAt, keyPath: 'lastPlayedAt' },
      { name: Idx.tracks.playCount, keyPath: 'playCount' },
      // Sparse by design — only favourites carry a timestamp.
      { name: Idx.tracks.favoritedAt, keyPath: 'favoritedAt' },
      { name: Idx.tracks.rating, keyPath: 'rating' },
      { name: Idx.tracks.format, keyPath: 'format' },
    ],
  },
  {
    name: Stores.albums,
    keyPath: 'id',
    indexes: [
      { name: Idx.albums.sortName, keyPath: 'sortName' },
      { name: Idx.albums.albumArtist, keyPath: 'albumArtistId' },
      { name: Idx.albums.year, keyPath: 'year' },
      { name: Idx.albums.addedAt, keyPath: 'addedAt' },
    ],
  },
  {
    name: Stores.artists,
    keyPath: 'id',
    indexes: [
      { name: Idx.artists.sortName, keyPath: 'sortName' },
      { name: Idx.artists.trackCount, keyPath: 'trackCount' },
    ],
  },
  {
    name: Stores.folders,
    keyPath: 'id',
    indexes: [
      { name: Idx.folders.source, keyPath: 'sourceId' },
      { name: Idx.folders.parent, keyPath: 'parentId' },
      { name: Idx.folders.sourcePath, keyPath: ['sourceId', 'path'], unique: true },
    ],
  },
  { name: Stores.sources, keyPath: 'id' },
  { name: Stores.handles, keyPath: 'key' },
  { name: Stores.artwork, keyPath: 'id' },
  {
    name: Stores.lyrics,
    keyPath: 'id',
    indexes: [{ name: Idx.lyrics.track, keyPath: 'trackId' }],
  },
  {
    name: Stores.playlists,
    keyPath: 'id',
    indexes: [
      { name: Idx.playlists.updatedAt, keyPath: 'updatedAt' },
      { name: Idx.playlists.name, keyPath: 'name' },
    ],
  },
  {
    name: Stores.playlistEntries,
    keyPath: 'id',
    indexes: [
      { name: Idx.playlistEntries.playlist, keyPath: 'playlistId' },
      { name: Idx.playlistEntries.position, keyPath: ['playlistId', 'position'] },
      { name: Idx.playlistEntries.track, keyPath: 'trackId' },
    ],
  },
  {
    name: Stores.history,
    keyPath: 'id',
    indexes: [
      { name: Idx.history.playedAt, keyPath: 'playedAt' },
      { name: Idx.history.track, keyPath: 'trackId' },
    ],
  },
  {
    name: Stores.scans,
    keyPath: 'id',
    indexes: [
      { name: Idx.scans.source, keyPath: 'sourceId' },
      { name: Idx.scans.startedAt, keyPath: 'startedAt' },
    ],
  },
  { name: Stores.settings, keyPath: 'key' },
];

const SCHEMA_V2: StoreDefinition[] = [{ name: Stores.artistPhotos, keyPath: 'id' }];

function createStores(db: IDBDatabase, definitions: StoreDefinition[]): void {
  for (const definition of definitions) {
    if (db.objectStoreNames.contains(definition.name)) continue;
    const objectStore = db.createObjectStore(definition.name, { keyPath: definition.keyPath });
    for (const index of definition.indexes ?? []) {
      objectStore.createIndex(index.name, index.keyPath, {
        unique: index.unique ?? false,
        multiEntry: index.multiEntry ?? false,
      });
    }
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => createStores(db, SCHEMA_V1),
  },
  {
    version: 2,
    up: (db) => createStores(db, SCHEMA_V2),
  },
];
