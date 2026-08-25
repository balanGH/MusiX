/**
 * MusiX domain model.
 *
 * These types are the contract between the storage layer, the scanner, the
 * audio engine and the UI. They deliberately contain no DOM or React types:
 * all of `src/core` must stay portable to a native shell (docs/ARCHITECTURE.md).
 *
 * Design note — denormalisation. The spec (§7) describes a relational schema.
 * IndexedDB has no joins, so `favorite`, `rating`, `playCount` and the album /
 * artist display names live directly on `Track`, and `Album` / `Artist` are
 * maintained as derived aggregate records. Every list view then reads one store
 * through one index instead of fanning out N lookups, which is what keeps a
 * 100k-track library responsive (§35).
 */

/** Container formats MusiX can index and play (spec §8). */
export type AudioFormat =
  | 'mp3'
  | 'flac'
  | 'wav'
  | 'm4a'
  | 'aac'
  | 'alac'
  | 'ogg'
  | 'opus'
  | 'aiff'
  | 'unknown';

export type TagCompleteness = 'complete' | 'partial' | 'missing';

export interface ReplayGain {
  trackGainDb: number | null;
  trackPeak: number | null;
  albumGainDb: number | null;
  albumPeak: number | null;
}

export interface MusicBrainzIds {
  recordingId?: string;
  releaseId?: string;
  releaseGroupId?: string;
  artistId?: string;
  albumArtistId?: string;
}

export interface Track {
  /** Stable id derived from `sourceId` + relative path, so rescans re-identify. */
  id: string;
  sourceId: string;
  /** Path relative to the source root, POSIX separators, e.g. Artist/Album/01.flac */
  path: string;
  filename: string;
  folderId: string;

  // ---- Technical properties, read from the file itself (spec §8) ----
  format: AudioFormat;
  codec: string;
  durationMs: number;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  sizeBytes: number;
  lossless: boolean;

  // ---- Tags ----
  title: string;
  artist: string;
  /** Split on the usual multi-artist separators; `artist` is the display form. */
  artists: string[];
  albumArtist: string;
  album: string;
  albumId: string;
  artistIds: string[];
  genres: string[];
  year: number | null;
  /** Full release date when the tag carried one, ISO-ish YYYY-MM-DD. */
  date: string | null;
  trackNo: number | null;
  trackTotal: number | null;
  discNo: number | null;
  discTotal: number | null;
  composer: string | null;
  conductor: string | null;
  comment: string | null;
  bpm: number | null;
  isrc: string | null;
  copyright: string | null;
  musicbrainz: MusicBrainzIds | null;
  replayGain: ReplayGain | null;

  artworkId: string | null;
  /** Set when the file carried embedded lyrics; the text lives in `lyrics`. */
  hasLyrics: boolean;

  // ---- User data (spec §7 Favorite / Rating / PlaybackHistory) ----
  favorite: boolean;
  favoritedAt: number | null;
  /** 0 = unrated, 1-5 stars. */
  rating: number;
  playCount: number;
  skipCount: number;
  lastPlayedAt: number | null;
  addedAt: number;

  // ---- Scan bookkeeping ----
  /** File mtime in ms; half of the incremental-scan fingerprint (spec §4). */
  fileModifiedAt: number;
  scannedAt: number;
  /** Set when tag parsing failed; the file is still listed and playable. */
  tagError: string | null;
  tagState: TagCompleteness;

  // ---- Precomputed keys (avoid per-render work in virtualised lists) ----
  /** Lowercase, article-stripped title used for ordering. */
  sortTitle: string;
  sortArtist: string;
  /** Lowercase haystack for offline search (spec §23). */
  searchText: string;
}

export interface Album {
  id: string;
  name: string;
  sortName: string;
  albumArtist: string;
  albumArtistId: string;
  year: number | null;
  genres: string[];
  trackCount: number;
  discCount: number;
  durationMs: number;
  artworkId: string | null;
  formats: AudioFormat[];
  lossless: boolean;
  addedAt: number;
  searchText: string;
}

export interface Artist {
  id: string;
  name: string;
  sortName: string;
  albumCount: number;
  trackCount: number;
  durationMs: number;
  genres: string[];
  artworkId: string | null;
  searchText: string;
}

export interface Folder {
  id: string;
  sourceId: string;
  /** Relative path; empty string for the source root. */
  path: string;
  name: string;
  parentId: string | null;
  depth: number;
  /** Tracks directly inside this folder, not counting subfolders. */
  trackCount: number;
}

/**
 * A music source the user granted access to.
 *
 * `directory` - a real folder held as a FileSystemDirectoryHandle; files are
 * never copied or moved (spec §9). Desktop Chromium only.
 * `imported`  - individually picked files copied into the origin-private file
 * system, which is the only way mobile browsers can offer persistence.
 */
export type SourceKind = 'directory' | 'imported';

export interface MusicSource {
  id: string;
  kind: SourceKind;
  name: string;
  addedAt: number;
  lastScanAt: number | null;
  trackCount: number;
  /** Key into the `handles` store; null for `imported` sources. */
  handleKey: string | null;
}

export type PlaylistKind = 'manual' | 'smart';

export interface Playlist {
  id: string;
  name: string;
  description: string;
  kind: PlaylistKind;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
  durationMs: number;
  /** Smart playlists store their rule set; manual ones store null. */
  rules: SmartRuleSet | null;
  /** Built-in smart playlists cannot be renamed or deleted (spec §22). */
  builtin: boolean;
  /** Track whose artwork represents the playlist. */
  coverTrackId: string | null;
}

export interface PlaylistEntry {
  /**
   * Opaque id, deliberately not derived from the position: reordering rewrites
   * positions, and a drag gesture in the UI holds onto the entry id while it
   * does so.
   */
  id: string;
  playlistId: string;
  trackId: string;
  position: number;
  addedAt: number;
}

export interface Artwork {
  /** Content hash, so identical covers are stored once (spec §13). */
  id: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** Full-size image bytes. */
  data: Blob;
  /** Pre-scaled square thumbnail for grids and lists. */
  thumb: Blob | null;
  /** Dominant colour as "r g b" — the CSS token format (spec §38). */
  dominant: string | null;
  createdAt: number;
}

export type LyricsKind = 'plain' | 'lrc' | 'ttml';

export interface LyricsLine {
  /** Milliseconds from track start. */
  timeMs: number;
  text: string;
}

export interface Lyrics {
  /** Same id as the track it belongs to. */
  id: string;
  trackId: string;
  kind: LyricsKind;
  text: string;
  /** Populated for synchronised formats only. */
  lines: LyricsLine[] | null;
  language: string | null;
  source: 'embedded' | 'sidecar' | 'manual' | 'online';
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  trackId: string;
  playedAt: number;
  /** How much of the track was actually heard. */
  msPlayed: number;
  completed: boolean;
}

export type ScanStatus = 'running' | 'complete' | 'cancelled' | 'failed';

export interface ScanError {
  path: string;
  reason: string;
}

export interface ScanRecord {
  id: string;
  sourceId: string;
  startedAt: number;
  finishedAt: number | null;
  status: ScanStatus;
  filesSeen: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  failed: number;
  errors: ScanError[];
  message: string | null;
}

// ---------------------------------------------------------------------------
// Smart playlists (spec §22)
// ---------------------------------------------------------------------------

export type SmartField =
  | 'title'
  | 'artist'
  | 'albumArtist'
  | 'album'
  | 'genre'
  | 'composer'
  | 'year'
  | 'rating'
  | 'playCount'
  | 'favorite'
  | 'durationMs'
  | 'bitrateKbps'
  | 'sampleRate'
  | 'format'
  | 'lossless'
  | 'addedAt'
  | 'lastPlayedAt'
  | 'hasLyrics'
  | 'hasArtwork'
  | 'tagState'
  | 'path';

export type SmartOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isTrue'
  | 'isFalse'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'inLastDays';

export interface SmartRule {
  field: SmartField;
  operator: SmartOperator;
  value?: string | number | boolean;
  /** Second operand, `between` only. */
  value2?: string | number;
}

export type SmartSort =
  | 'title'
  | 'artist'
  | 'album'
  | 'addedAt'
  | 'lastPlayedAt'
  | 'playCount'
  | 'rating'
  | 'durationMs'
  /** File path — the only useful order for a list of untagged files. */
  | 'path'
  | 'random';

export interface SmartRuleSet {
  match: 'all' | 'any';
  rules: SmartRule[];
  sort: SmartSort;
  direction: 'asc' | 'desc';
  /** null = unlimited. */
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueItem {
  /** Unique per queue slot - the same track may appear more than once. */
  uid: string;
  trackId: string;
}

export interface EqBand {
  frequency: number;
  gainDb: number;
}

export interface DuplicateGroup {
  key: string;
  title: string;
  artist: string;
  trackIds: string[];
}

export interface LibraryHealth {
  trackCount: number;
  withMetadata: number;
  withArtwork: number;
  withLyrics: number;
  missingMetadata: number;
  missingArtwork: number;
  missingLyrics: number;
  unreadable: number;
  duplicateGroups: DuplicateGroup[];
  totalBytes: number;
  totalDurationMs: number;
  computedAt: number;
}
