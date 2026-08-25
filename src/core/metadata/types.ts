/**
 * The shared shape every tag format is normalised into.
 *
 * ID3 frames, Vorbis comments and MP4 atoms all name the same fields
 * differently. Rather than three parsers each building a `Track`, each one maps
 * its keys to the canonical names below and calls `applyTag`. Quirk handling
 * ("3/12" track numbers, repeated genre frames, ReplayGain written as
 * "-7.15 dB") then lives in exactly one place.
 */

import type { AudioFormat } from '../types';

export interface RawPicture {
  mime: string;
  /** ID3 APIC / FLAC PICTURE type; 3 is the front cover. */
  pictureType: number;
  description: string;
  data: Uint8Array;
}

export interface RawTags {
  title?: string;
  artist?: string;
  artists?: string[];
  albumArtist?: string;
  album?: string;
  genre?: string[];
  year?: number;
  date?: string;
  trackNo?: number;
  trackTotal?: number;
  discNo?: number;
  discTotal?: number;
  composer?: string;
  conductor?: string;
  comment?: string;
  bpm?: number;
  isrc?: string;
  copyright?: string;
  lyrics?: string;
  /** True when the lyrics came from a synchronised frame (SYLT / TTML-ish). */
  lyricsSynced?: boolean;
  mbRecordingId?: string;
  mbReleaseId?: string;
  mbReleaseGroupId?: string;
  mbArtistId?: string;
  mbAlbumArtistId?: string;
  replayGainTrackDb?: number;
  replayGainTrackPeak?: number;
  replayGainAlbumDb?: number;
  replayGainAlbumPeak?: number;
  pictures: RawPicture[];
}

export interface StreamInfo {
  format: AudioFormat;
  codec: string;
  durationMs: number;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  lossless: boolean;
}

export interface ParsedAudio {
  tags: RawTags;
  stream: StreamInfo;
  /** Non-fatal problems worth surfacing in Library Health (spec §24). */
  warnings: string[];
}

export function emptyTags(): RawTags {
  return { pictures: [] };
}

/** Canonical tag keys. Every format maps onto these. */
export type CanonicalKey =
  | 'title'
  | 'artist'
  | 'albumartist'
  | 'album'
  | 'genre'
  | 'date'
  | 'year'
  | 'originaldate'
  | 'tracknumber'
  | 'tracktotal'
  | 'discnumber'
  | 'disctotal'
  | 'composer'
  | 'conductor'
  | 'comment'
  | 'bpm'
  | 'isrc'
  | 'copyright'
  | 'lyrics'
  | 'musicbrainz_trackid'
  | 'musicbrainz_albumid'
  | 'musicbrainz_releasegroupid'
  | 'musicbrainz_artistid'
  | 'musicbrainz_albumartistid'
  | 'replaygain_track_gain'
  | 'replaygain_track_peak'
  | 'replaygain_album_gain'
  | 'replaygain_album_peak';

const NUMERIC = /^-?\d+(?:\.\d+)?/;

/** First integer in a string, or undefined. Handles "04", "4/12", "Track 4". */
export function parseIntLoose(value: string): number | undefined {
  const match = value.match(/-?\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFloatLoose(value: string): number | undefined {
  const match = value.match(NUMERIC);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** "3/12" -> [3, 12]; "3" -> [3, undefined]. */
function parsePair(value: string): [number | undefined, number | undefined] {
  const [left, right] = value.split('/');
  return [left ? parseIntLoose(left) : undefined, right ? parseIntLoose(right) : undefined];
}

/**
 * A four-digit year out of anything a tagger might have written: "1997",
 * "1997-08-12", "12/08/1997", "1997-08-12T00:00:00Z".
 */
export function parseYear(value: string): number | undefined {
  const match = value.match(/(?:^|\D)(\d{4})(?:\D|$)/);
  if (!match) return undefined;
  const year = Number.parseInt(match[1]!, 10);
  // Reject nonsense so a bad tag cannot land in the year index.
  return year >= 1000 && year <= 2999 ? year : undefined;
}

/** Normalise a date-ish tag to `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
export function parseDate(value: string): string | undefined {
  const iso = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (iso) {
    return [iso[1], iso[2], iso[3]].filter(Boolean).join('-');
  }
  const year = parseYear(value);
  return year ? String(year) : undefined;
}

/**
 * Apply one raw key/value pair.
 *
 * Repeated keys append for multi-valued fields (genre, artist) and are ignored
 * for single-valued ones — first writer wins, which keeps a duplicated TIT2
 * frame from overwriting a good title with a worse one.
 */
export function applyTag(tags: RawTags, rawKey: string, rawValue: string): void {
  const value = rawValue.trim();
  if (!value) return;
  const key = rawKey.trim().toLowerCase() as CanonicalKey;

  switch (key) {
    case 'title':
      tags.title ??= value;
      return;
    case 'artist':
      tags.artist ??= value;
      (tags.artists ??= []).push(value);
      return;
    case 'albumartist':
      tags.albumArtist ??= value;
      return;
    case 'album':
      tags.album ??= value;
      return;
    case 'genre':
      (tags.genre ??= []).push(value);
      return;
    case 'date':
    case 'originaldate': {
      const date = parseDate(value);
      if (date) {
        tags.date ??= date;
        tags.year ??= parseYear(date);
      }
      return;
    }
    case 'year':
      tags.year ??= parseYear(value);
      return;
    case 'tracknumber': {
      const [no, total] = parsePair(value);
      if (no !== undefined) tags.trackNo ??= no;
      if (total !== undefined) tags.trackTotal ??= total;
      return;
    }
    case 'tracktotal':
      tags.trackTotal ??= parseIntLoose(value);
      return;
    case 'discnumber': {
      const [no, total] = parsePair(value);
      if (no !== undefined) tags.discNo ??= no;
      if (total !== undefined) tags.discTotal ??= total;
      return;
    }
    case 'disctotal':
      tags.discTotal ??= parseIntLoose(value);
      return;
    case 'composer':
      tags.composer ??= value;
      return;
    case 'conductor':
      tags.conductor ??= value;
      return;
    case 'comment':
      tags.comment ??= value;
      return;
    case 'bpm': {
      const bpm = parseFloatLoose(value);
      // A BPM of 0 means "not set" in practice, not "silent".
      if (bpm !== undefined && bpm > 0) tags.bpm ??= Math.round(bpm);
      return;
    }
    case 'isrc':
      tags.isrc ??= value.replace(/[\s-]/g, '').toUpperCase();
      return;
    case 'copyright':
      tags.copyright ??= value;
      return;
    case 'lyrics':
      tags.lyrics ??= value;
      return;
    case 'musicbrainz_trackid':
      tags.mbRecordingId ??= value;
      return;
    case 'musicbrainz_albumid':
      tags.mbReleaseId ??= value;
      return;
    case 'musicbrainz_releasegroupid':
      tags.mbReleaseGroupId ??= value;
      return;
    case 'musicbrainz_artistid':
      tags.mbArtistId ??= value;
      return;
    case 'musicbrainz_albumartistid':
      tags.mbAlbumArtistId ??= value;
      return;
    // ReplayGain is written as "-7.15 dB" or "0.978545"; both parse the same way.
    case 'replaygain_track_gain':
      tags.replayGainTrackDb ??= parseFloatLoose(value);
      return;
    case 'replaygain_track_peak':
      tags.replayGainTrackPeak ??= parseFloatLoose(value);
      return;
    case 'replaygain_album_gain':
      tags.replayGainAlbumDb ??= parseFloatLoose(value);
      return;
    case 'replaygain_album_peak':
      tags.replayGainAlbumPeak ??= parseFloatLoose(value);
      return;
    default:
      // Unknown keys are dropped rather than kept: an "extra tags" bag would be
      // written for every track and read by nothing (spec §41 — no dead weight).
      return;
  }
}
