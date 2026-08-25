/**
 * Turning a parsed file into a `Track` record.
 *
 * Two rules govern everything here:
 *
 *  1. **Never lose user data.** A rescan re-reads tags from disk, but favourite,
 *     rating, play count, skip count and the original `addedAt` belong to the
 *     user, not the file, and are carried over from the existing row.
 *
 *  2. **Always produce something playable.** A file with no tags at all still
 *     becomes a track, titled from its filename and grouped by its folder, with
 *     `tagState: 'missing'` so Library Health can offer to fix it (§24). Import
 *     never rejects a file for having bad metadata.
 */

import { hashId, basename, dirname, fold, sortKey, splitArtists, titleFromFilename } from '../utils';
import type { FileEntry } from '../platform/fs';
import type { ParsedAudio } from '../metadata';
import type { Track } from '../types';

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';

export function artistIdFor(name: string): string {
  return hashId(`artist:${fold(name)}`);
}

/**
 * Album identity.
 *
 * Keyed on album artist *and* album name, so two different "Greatest Hits" do
 * not merge. Untagged files instead group by their containing folder, which is
 * how an un-tagged album rip is actually organised on disk — grouping them all
 * under one global "Unknown Album" would produce a single unusable 4,000-track
 * album.
 */
export function albumIdFor(
  albumName: string,
  albumArtist: string,
  fallback: { sourceId: string; directory: string },
): string {
  if (!albumName) {
    return hashId(`album:folder:${fallback.sourceId}:${fold(fallback.directory)}`);
  }
  return hashId(`album:${fold(albumArtist)}:${fold(albumName)}`);
}

function completeness(hasTitle: boolean, hasArtist: boolean, hasAlbum: boolean): Track['tagState'] {
  if (hasTitle && hasArtist && hasAlbum) return 'complete';
  if (!hasTitle && !hasArtist && !hasAlbum) return 'missing';
  return 'partial';
}

export interface BuildTrackInput {
  sourceId: string;
  entry: FileEntry;
  parsed: ParsedAudio;
  /** Artwork id, once the image has been stored. */
  artworkId: string | null;
  hasLyrics: boolean;
  /** The row this replaces, when rescanning a changed file. */
  existing?: Track;
  now?: number;
}

export function buildTrack(input: BuildTrackInput): Track {
  const { sourceId, entry, parsed, existing } = input;
  const now = input.now ?? Date.now();
  const tags = parsed.tags;
  const stream = parsed.stream;

  const directory = dirname(entry.path);
  const folderId = folderIdFor(sourceId, directory);

  const taggedTitle = tags.title?.trim() ?? '';
  const taggedArtist = tags.artist?.trim() ?? '';
  const taggedAlbum = tags.album?.trim() ?? '';

  const title = taggedTitle || titleFromFilename(entry.name);
  const artist = taggedArtist || UNKNOWN_ARTIST;
  // Album artist falls back to the track artist, which is right for the great
  // majority of albums and is what every other player does.
  const albumArtist = tags.albumArtist?.trim() || artist;
  const album = taggedAlbum || (directory ? basename(directory) : UNKNOWN_ALBUM);

  const artists = taggedArtist ? splitArtists(taggedArtist) : [UNKNOWN_ARTIST];
  const albumArtistNames = tags.albumArtist ? splitArtists(tags.albumArtist) : [];
  const artistIds = [...new Set([...artists, ...albumArtistNames].map(artistIdFor))];

  const genres = tags.genre ? [...new Set(tags.genre.map((genre) => genre.trim()).filter(Boolean))] : [];

  const replayGain =
    tags.replayGainTrackDb !== undefined ||
    tags.replayGainAlbumDb !== undefined ||
    tags.replayGainTrackPeak !== undefined
      ? {
          trackGainDb: tags.replayGainTrackDb ?? null,
          trackPeak: tags.replayGainTrackPeak ?? null,
          albumGainDb: tags.replayGainAlbumDb ?? null,
          albumPeak: tags.replayGainAlbumPeak ?? null,
        }
      : null;

  const musicbrainz =
    tags.mbRecordingId || tags.mbReleaseId || tags.mbReleaseGroupId || tags.mbArtistId
      ? {
          ...(tags.mbRecordingId ? { recordingId: tags.mbRecordingId } : {}),
          ...(tags.mbReleaseId ? { releaseId: tags.mbReleaseId } : {}),
          ...(tags.mbReleaseGroupId ? { releaseGroupId: tags.mbReleaseGroupId } : {}),
          ...(tags.mbArtistId ? { artistId: tags.mbArtistId } : {}),
          ...(tags.mbAlbumArtistId ? { albumArtistId: tags.mbAlbumArtistId } : {}),
        }
      : null;

  const searchText = buildSearchText({
    title,
    artist,
    albumArtist,
    album,
    genres,
    composer: tags.composer ?? '',
    filename: entry.name,
    path: entry.path,
  });

  return {
    id: trackIdFor(sourceId, entry.path),
    sourceId,
    path: entry.path,
    filename: entry.name,
    folderId,

    format: stream.format,
    codec: stream.codec,
    durationMs: stream.durationMs,
    bitrateKbps: stream.bitrateKbps,
    sampleRate: stream.sampleRate,
    bitDepth: stream.bitDepth,
    channels: stream.channels,
    sizeBytes: entry.sizeBytes,
    lossless: stream.lossless,

    title,
    artist,
    artists,
    albumArtist,
    album,
    albumId: albumIdFor(taggedAlbum, albumArtist, { sourceId, directory }),
    artistIds,
    genres,
    year: tags.year ?? null,
    date: tags.date ?? null,
    trackNo: tags.trackNo ?? null,
    trackTotal: tags.trackTotal ?? null,
    discNo: tags.discNo ?? null,
    discTotal: tags.discTotal ?? null,
    composer: tags.composer ?? null,
    conductor: tags.conductor ?? null,
    comment: tags.comment ?? null,
    bpm: tags.bpm ?? null,
    isrc: tags.isrc ?? null,
    copyright: tags.copyright ?? null,
    musicbrainz,
    replayGain,

    artworkId: input.artworkId,
    hasLyrics: input.hasLyrics,

    // ---- Carried over from the previous row: this is the user's data ----
    favorite: existing?.favorite ?? false,
    favoritedAt: existing?.favoritedAt ?? null,
    rating: existing?.rating ?? 0,
    playCount: existing?.playCount ?? 0,
    skipCount: existing?.skipCount ?? 0,
    lastPlayedAt: existing?.lastPlayedAt ?? null,
    addedAt: existing?.addedAt ?? now,

    fileModifiedAt: entry.lastModified,
    scannedAt: now,
    tagError: parsed.warnings.length > 0 ? parsed.warnings.join('; ') : null,
    tagState: completeness(Boolean(taggedTitle), Boolean(taggedArtist), Boolean(taggedAlbum)),

    sortTitle: sortKey(title),
    sortArtist: sortKey(albumArtist || artist),
    searchText,
  };
}

/** Stable across rescans: the same file always gets the same id. */
export function trackIdFor(sourceId: string, path: string): string {
  return hashId(`track:${sourceId}:${path}`);
}

export function folderIdFor(sourceId: string, path: string): string {
  return hashId(`folder:${sourceId}:${path}`);
}

/**
 * The offline search haystack (spec §23).
 *
 * Precomputed at scan time so a keystroke never has to normalise 100k strings.
 * Folded to remove accents and case, and deduplicated so that a track whose
 * artist, album artist and folder all say the same thing does not store it
 * three times.
 */
function buildSearchText(parts: {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genres: string[];
  composer: string;
  filename: string;
  path: string;
}): string {
  const tokens = new Set<string>();
  const add = (value: string) => {
    for (const token of fold(value).split(/[^a-z0-9]+/)) {
      if (token.length > 0) tokens.add(token);
    }
  };
  add(parts.title);
  add(parts.artist);
  add(parts.albumArtist);
  add(parts.album);
  for (const genre of parts.genres) add(genre);
  add(parts.composer);
  add(parts.filename);
  // The directory often carries a soundtrack or compilation name that appears
  // in no tag, which is why spec §23 lists folder as a searchable field.
  add(dirname(parts.path).replace(/\//g, ' '));
  return [...tokens].join(' ');
}
