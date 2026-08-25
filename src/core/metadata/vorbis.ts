/**
 * Vorbis comments — the tag format shared by FLAC, Ogg Vorbis and Opus.
 *
 * Pleasantly regular compared with ID3: a count, then that many
 * little-endian-length-prefixed `KEY=value` UTF-8 strings. Keys are
 * case-insensitive and may repeat, which is how multi-artist and multi-genre
 * tags are expressed.
 */

import { ByteReader, decodeUtf8 } from './reader';
import { applyTag, type RawPicture, type RawTags } from './types';
import { genreByIndex } from './id3';

/** Vorbis key -> canonical key. Keys not listed here are ignored. */
const VORBIS_KEYS: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  albumartist: 'albumartist',
  album_artist: 'albumartist',
  album: 'album',
  genre: 'genre',
  date: 'date',
  originaldate: 'originaldate',
  year: 'year',
  tracknumber: 'tracknumber',
  track: 'tracknumber',
  tracktotal: 'tracktotal',
  totaltracks: 'tracktotal',
  discnumber: 'discnumber',
  disc: 'discnumber',
  disctotal: 'disctotal',
  totaldiscs: 'disctotal',
  composer: 'composer',
  conductor: 'conductor',
  comment: 'comment',
  description: 'comment',
  bpm: 'bpm',
  isrc: 'isrc',
  copyright: 'copyright',
  lyrics: 'lyrics',
  unsyncedlyrics: 'lyrics',
  musicbrainz_trackid: 'musicbrainz_trackid',
  musicbrainz_releasetrackid: 'musicbrainz_trackid',
  musicbrainz_albumid: 'musicbrainz_albumid',
  musicbrainz_releasegroupid: 'musicbrainz_releasegroupid',
  musicbrainz_artistid: 'musicbrainz_artistid',
  musicbrainz_albumartistid: 'musicbrainz_albumartistid',
  replaygain_track_gain: 'replaygain_track_gain',
  replaygain_track_peak: 'replaygain_track_peak',
  replaygain_album_gain: 'replaygain_album_gain',
  replaygain_album_peak: 'replaygain_album_peak',
};

/**
 * Parse a comment block.
 *
 * @param includeVendor whether the block starts with the vendor string, which
 *   it does in every container MusiX reads.
 */
export function parseVorbisComments(
  bytes: Uint8Array,
  tags: RawTags,
  warnings: string[],
): void {
  const reader = new ByteReader(bytes);
  try {
    const vendorLength = reader.u32le();
    reader.skip(vendorLength);

    const count = reader.u32le();
    // A corrupt length here would otherwise spin for billions of iterations.
    if (count > 10_000) {
      warnings.push('implausible Vorbis comment count; block ignored');
      return;
    }

    for (let i = 0; i < count; i++) {
      if (reader.remaining < 4) break;
      const length = reader.u32le();
      if (length > reader.remaining) break;
      const entry = decodeUtf8(reader.bytesOf(length));
      const equals = entry.indexOf('=');
      if (equals <= 0) continue;

      const rawKey = entry.slice(0, equals).toLowerCase();
      const value = entry.slice(equals + 1);
      if (!value) continue;

      // METADATA_BLOCK_PICTURE carries a base64 FLAC PICTURE block.
      if (rawKey === 'metadata_block_picture') {
        const picture = decodeBase64Picture(value);
        if (picture) tags.pictures.push(picture);
        continue;
      }

      const canonical = VORBIS_KEYS[rawKey];
      if (!canonical) continue;

      if (canonical === 'genre' && /^\d{1,3}$/.test(value)) {
        // Rare, but some converters carry ID3v1 genre numbers across.
        const named = genreByIndex(value);
        applyTag(tags, 'genre', named ?? value);
        continue;
      }
      applyTag(tags, canonical, value);
    }
  } catch {
    warnings.push('truncated Vorbis comment block');
  }
}

/**
 * FLAC METADATA_BLOCK_PICTURE payload.
 *
 * Shared with the FLAC PICTURE metadata block, which has the identical body.
 */
export function parsePictureBlock(bytes: Uint8Array): RawPicture | null {
  try {
    const reader = new ByteReader(bytes);
    const pictureType = reader.u32be();
    const mimeLength = reader.u32be();
    if (mimeLength > 255) return null;
    const mime = decodeUtf8(reader.bytesOf(mimeLength)).toLowerCase() || 'image/jpeg';
    const descLength = reader.u32be();
    if (descLength > 4096) return null;
    const description = decodeUtf8(reader.bytesOf(descLength));
    reader.skip(4 * 4); // width, height, colour depth, indexed colours
    const dataLength = reader.u32be();
    if (dataLength < 64 || dataLength > reader.remaining) return null;
    return { mime, pictureType, description, data: reader.bytesOf(dataLength) };
  } catch {
    return null;
  }
}

function decodeBase64Picture(value: string): RawPicture | null {
  try {
    // atob exists in both window and worker scopes.
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return parsePictureBlock(bytes);
  } catch {
    return null;
  }
}
