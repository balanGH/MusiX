/**
 * ID3v2.2 / v2.3 / v2.4 and ID3v1 parsing.
 *
 * MP3 is the format most libraries are mostly made of, and its tags are the
 * least well-behaved thing MusiX has to read, so this parser is deliberately
 * forgiving: a malformed frame stops that frame, never the file (spec §34).
 *
 * The three quirks that actually bite in real collections, all handled below:
 *  - v2.4 says frame sizes are synchsafe, but a lot of taggers wrote plain
 *    32-bit sizes anyway. Both are accepted, choosing per frame.
 *  - unsynchronisation can be set at tag level (v2.3) or frame level (v2.4).
 *  - TCON genres may be numeric references into the ID3v1 genre table,
 *    sometimes as "(17)", sometimes as "17", sometimes as "(17)Rock".
 */

import {
  ByteReader,
  decodeLatin1,
  decodeText,
  findTerminator,
  tidy,
  type ByteSource,
  type TextEncodingId,
} from './reader';
import { applyTag, parseIntLoose, type RawTags } from './types';

/** ID3v1 genre table; TCON numeric references index into it. */
const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
  'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock',
  'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
  'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic',
  'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native US', 'Cabaret', 'New Wave',
  'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk',
  'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk',
  'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival',
  'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock',
  'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus',
  'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera',
  'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad',
  'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella',
  'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror',
  'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap',
  'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock',
  'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'Jpop', 'Synthpop',
] as const;

/** Frame id -> canonical key, for v2.3 / v2.4. */
const FRAMES_V23: Record<string, string> = {
  TIT2: 'title',
  TPE1: 'artist',
  TPE2: 'albumartist',
  TPE3: 'conductor',
  TALB: 'album',
  TCON: 'genre',
  TYER: 'year',
  TDRC: 'date',
  TDRL: 'date',
  TDAT: 'date',
  TDOR: 'originaldate',
  TORY: 'originaldate',
  TRCK: 'tracknumber',
  TPOS: 'discnumber',
  TCOM: 'composer',
  TBPM: 'bpm',
  TSRC: 'isrc',
  TCOP: 'copyright',
};

/** Frame id -> canonical key, for the three-character v2.2 ids. */
const FRAMES_V22: Record<string, string> = {
  TT2: 'title',
  TP1: 'artist',
  TP2: 'albumartist',
  TP3: 'conductor',
  TAL: 'album',
  TCO: 'genre',
  TYE: 'year',
  TRK: 'tracknumber',
  TPA: 'discnumber',
  TCM: 'composer',
  TBP: 'bpm',
  TRC: 'isrc',
  TCR: 'copyright',
};

/** TXXX descriptions MusiX understands, lowercased. */
const TXXX_KEYS: Record<string, string> = {
  albumartist: 'albumartist',
  album_artist: 'albumartist',
  tracktotal: 'tracktotal',
  totaltracks: 'tracktotal',
  disctotal: 'disctotal',
  totaldiscs: 'disctotal',
  isrc: 'isrc',
  bpm: 'bpm',
  'musicbrainz album id': 'musicbrainz_albumid',
  'musicbrainz release group id': 'musicbrainz_releasegroupid',
  'musicbrainz artist id': 'musicbrainz_artistid',
  'musicbrainz album artist id': 'musicbrainz_albumartistid',
  musicbrainz_albumid: 'musicbrainz_albumid',
  musicbrainz_releasegroupid: 'musicbrainz_releasegroupid',
  musicbrainz_artistid: 'musicbrainz_artistid',
  musicbrainz_albumartistid: 'musicbrainz_albumartistid',
  replaygain_track_gain: 'replaygain_track_gain',
  replaygain_track_peak: 'replaygain_track_peak',
  replaygain_album_gain: 'replaygain_album_gain',
  replaygain_album_peak: 'replaygain_album_peak',
};

export interface Id3v2Result {
  tags: RawTags;
  /** Byte length of the whole tag, i.e. where audio data begins. */
  tagSize: number;
  warnings: string[];
}

/** Reads the 10-byte header; returns null when there is no ID3v2 tag. */
export async function readId3v2Header(
  source: ByteSource,
): Promise<{ version: number; flags: number; size: number } | null> {
  const head = await source.read(0, 10);
  if (head.length < 10) return null;
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"
  const version = head[3]!;
  if (version < 2 || version > 4) return null;
  const reader = new ByteReader(head).seek(5);
  const flags = reader.u8();
  const size = reader.synchsafe32();
  const footer = (flags & 0x10) !== 0 ? 10 : 0;
  return { version, flags, size: 10 + size + footer };
}

/**
 * Parse the ID3v2 tag at the start of the file.
 *
 * `maxRead` caps how much is pulled in one go. Embedded artwork routinely makes
 * a tag several megabytes; reading it is worth it once (the cover is the single
 * most visible piece of metadata) but it should not be unbounded.
 */
export async function parseId3v2(
  source: ByteSource,
  tags: RawTags,
  maxRead = 8 * 1024 * 1024,
): Promise<Id3v2Result | null> {
  const header = await readId3v2Header(source);
  if (!header) return null;

  const warnings: string[] = [];
  const readLength = Math.min(header.size, maxRead);
  if (header.size > maxRead) warnings.push('ID3v2 tag truncated while reading');

  const raw = await source.read(0, readLength);
  if (raw.length < 11) return { tags, tagSize: header.size, warnings };

  const version = header.version;
  const tagUnsync = (header.flags & 0x80) !== 0;

  let body = raw.subarray(10, raw.length);
  if (tagUnsync) body = unsynchronise(body);

  const reader = new ByteReader(body);

  // Extended header, if present.
  if ((header.flags & 0x40) !== 0) {
    try {
      if (version === 4) {
        // v2.4: synchsafe size that includes the four size bytes themselves.
        const extSize = reader.synchsafe32();
        reader.skip(Math.max(0, extSize - 4));
      } else {
        const extSize = reader.u32be();
        reader.skip(extSize);
      }
    } catch {
      warnings.push('malformed ID3v2 extended header');
      return { tags, tagSize: header.size, warnings };
    }
  }

  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;

  while (reader.remaining > headerLength) {
    const id = reader.peekAscii(idLength);
    // Padding: the rest of the tag is zeroes.
    if (id.charCodeAt(0) === 0) break;
    if (!/^[A-Z0-9]+$/.test(id)) {
      warnings.push(`skipped unreadable frame id at offset ${reader.offset}`);
      break;
    }
    reader.skip(idLength);

    let size: number;
    let frameFlags = 0;
    if (version === 2) {
      size = reader.u24be();
    } else if (version === 3) {
      size = reader.u32be();
      frameFlags = reader.u16be();
    } else {
      const at = reader.offset;
      size = reader.synchsafe32();
      frameFlags = reader.u16be();
      // Taggers that wrote a plain 32-bit size produce a value that overruns
      // the tag; re-read it as plain when synchsafe cannot be right.
      if (size > reader.remaining) {
        const retry = new ByteReader(body).seek(at).u32be();
        if (retry <= reader.remaining) size = retry;
      }
    }

    if (size <= 0 || size > reader.remaining) {
      if (size > reader.remaining) warnings.push(`frame ${id} declares more data than remains`);
      break;
    }

    let data = reader.bytesOf(size);

    if (version === 4) {
      // Frame-level unsynchronisation, and a data-length indicator that
      // precedes the payload when the frame is compressed or encrypted.
      if ((frameFlags & 0x0002) !== 0) data = unsynchronise(data);
      if ((frameFlags & 0x0001) !== 0) data = data.subarray(4);
      if ((frameFlags & 0x000c) !== 0) {
        // Compressed or encrypted frames are not supported; skipping one is far
        // better than emitting garbage into the library.
        warnings.push(`frame ${id} is compressed or encrypted; skipped`);
        continue;
      }
    }

    try {
      handleFrame(id, data, version, tags, warnings);
    } catch {
      warnings.push(`frame ${id} could not be decoded`);
    }
  }

  return { tags, tagSize: header.size, warnings };
}

function handleFrame(
  id: string,
  data: Uint8Array,
  version: number,
  tags: RawTags,
  warnings: string[],
): void {
  if (data.length === 0) return;

  // ---- Pictures ----
  if (id === 'APIC' || id === 'PIC') {
    const picture = parsePicture(id, data);
    if (picture) tags.pictures.push(picture);
    else warnings.push('unreadable embedded picture');
    return;
  }

  // ---- Comments and lyrics: encoding, 3-byte language, description, text ----
  if (id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') {
    const encoding = data[0] as TextEncodingId;
    const afterLang = 4;
    const end = findTerminator(data, afterLang, encoding);
    const textStart =
      end === -1 ? afterLang : end + (encoding === 1 || encoding === 2 ? 2 : 1);
    const text = decodeText(data.subarray(textStart), encoding);
    if (!text) return;
    // iTunes writes its own "iTunNORM"/"iTunSMPB" values as comments; they are
    // not user-facing text and would otherwise show up as a track comment.
    const description = end === -1 ? '' : decodeText(data.subarray(afterLang, end), encoding);
    if (/^itun/i.test(description)) return;
    applyTag(tags, id.startsWith('COM') ? 'comment' : 'lyrics', text);
    return;
  }

  // ---- User-defined text: encoding, description, value ----
  if (id === 'TXXX' || id === 'TXX') {
    const encoding = data[0] as TextEncodingId;
    const end = findTerminator(data, 1, encoding);
    if (end === -1) return;
    const description = decodeText(data.subarray(1, end), encoding).toLowerCase();
    const step = encoding === 1 || encoding === 2 ? 2 : 1;
    const value = decodeText(data.subarray(end + step), encoding);
    const canonical = TXXX_KEYS[description];
    if (canonical && value) applyTag(tags, canonical, value);
    return;
  }

  // ---- MusicBrainz recording id ----
  if (id === 'UFID' || id === 'UFI') {
    const end = findTerminator(data, 0, 0);
    if (end === -1) return;
    const owner = decodeLatin1(data.subarray(0, end));
    if (!/musicbrainz/i.test(owner)) return;
    const value = decodeLatin1(data.subarray(end + 1));
    if (value) applyTag(tags, 'musicbrainz_trackid', value);
    return;
  }

  const canonical = version === 2 ? FRAMES_V22[id] : FRAMES_V23[id];
  if (!canonical) return;

  // ---- Plain text frames ----
  const encoding = data[0] as TextEncodingId;
  const payload = data.subarray(1);
  // v2.4 permits several NUL-separated values in one frame.
  const values =
    version === 4 ? splitTextValues(payload, encoding) : [decodeText(payload, encoding)];

  for (const value of values) {
    if (!value) continue;
    if (canonical === 'genre') {
      for (const genre of expandGenre(value)) applyTag(tags, 'genre', genre);
    } else {
      applyTag(tags, canonical, value);
    }
  }
}

function splitTextValues(payload: Uint8Array, encoding: TextEncodingId): string[] {
  const out: string[] = [];
  const step = encoding === 1 || encoding === 2 ? 2 : 1;
  let start = 0;
  for (;;) {
    const end = findTerminator(payload, start, encoding);
    if (end === -1) {
      out.push(decodeText(payload.subarray(start), encoding));
      break;
    }
    out.push(decodeText(payload.subarray(start, end), encoding));
    start = end + step;
    if (start >= payload.length) break;
  }
  return out.filter(Boolean);
}

/**
 * Expand a TCON value.
 *
 * "(17)" and "17" both mean Rock; "(17)Hard Rock" means both. Values that are
 * already plain text pass through untouched.
 */
function expandGenre(value: string): string[] {
  const out: string[] = [];
  const numericRefs = value.matchAll(/\((\d{1,3})\)/g);
  let residue = value;
  for (const match of numericRefs) {
    const index = Number.parseInt(match[1]!, 10);
    const name = ID3V1_GENRES[index];
    if (name) out.push(name);
    residue = residue.replace(match[0], ' ');
  }
  residue = residue.trim();
  if (residue) {
    // A bare number is also a reference.
    if (/^\d{1,3}$/.test(residue)) {
      const name = ID3V1_GENRES[Number.parseInt(residue, 10)];
      if (name) out.push(name);
    } else {
      out.push(residue);
    }
  }
  return out.length > 0 ? out : [value];
}

function parsePicture(
  id: string,
  data: Uint8Array,
): { mime: string; pictureType: number; description: string; data: Uint8Array } | null {
  const encoding = data[0] as TextEncodingId;
  let cursor = 1;
  let mime: string;

  if (id === 'PIC') {
    // v2.2 uses a fixed three-character format code rather than a MIME type.
    const code = decodeLatin1(data.subarray(1, 4)).toUpperCase();
    mime = code === 'PNG' ? 'image/png' : code === 'GIF' ? 'image/gif' : 'image/jpeg';
    cursor = 4;
  } else {
    const mimeEnd = findTerminator(data, 1, 0);
    if (mimeEnd === -1) return null;
    mime = decodeLatin1(data.subarray(1, mimeEnd)).toLowerCase() || 'image/jpeg';
    // Some taggers write just "JPG" or "PNG" here.
    if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
    cursor = mimeEnd + 1;
  }

  if (cursor >= data.length) return null;
  const pictureType = data[cursor]!;
  cursor += 1;

  const descEnd = findTerminator(data, cursor, encoding);
  if (descEnd === -1) return null;
  const description = decodeText(data.subarray(cursor, descEnd), encoding);
  const step = encoding === 1 || encoding === 2 ? 2 : 1;
  const bytes = data.subarray(descEnd + step);
  if (bytes.length < 64) return null; // Too small to be a real image.

  return { mime, pictureType, description, data: bytes };
}

/**
 * Reverse unsynchronisation: every 0xFF 0x00 pair becomes a single 0xFF.
 *
 * Encoders insert the 0x00 so that tag bytes can never look like an MPEG frame
 * sync word to a decoder that does not understand ID3.
 */
export function unsynchronise(bytes: Uint8Array): Uint8Array {
  // Fast path: most tags are not unsynchronised at all.
  let needed = false;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) {
      needed = true;
      break;
    }
  }
  if (!needed) return bytes;

  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[length++] = bytes[i]!;
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, length);
}

// ---------------------------------------------------------------------------
// ID3v1
// ---------------------------------------------------------------------------

/**
 * Read the 128-byte ID3v1 tag at the end of the file.
 *
 * Only used to fill gaps an ID3v2 tag left, since v1 is fixed-width, latin1 and
 * lossy — but plenty of older rips have nothing else.
 */
export async function parseId3v1(source: ByteSource, tags: RawTags): Promise<boolean> {
  if (source.size < 128) return false;
  const bytes = await source.read(source.size - 128, 128);
  if (bytes.length < 128) return false;
  if (bytes[0] !== 0x54 || bytes[1] !== 0x41 || bytes[2] !== 0x47) return false; // "TAG"

  const field = (start: number, length: number) =>
    tidy(decodeLatin1(bytes.subarray(start, start + length)));

  const title = field(3, 30);
  const artist = field(33, 30);
  const album = field(63, 30);
  const year = field(93, 4);
  const comment = field(97, 30);
  const genreIndex = bytes[127]!;

  if (title) applyTag(tags, 'title', title);
  if (artist) applyTag(tags, 'artist', artist);
  if (album) applyTag(tags, 'album', album);
  if (year) applyTag(tags, 'year', year);

  // ID3v1.1 steals the last two comment bytes for a track number.
  if (bytes[125] === 0 && bytes[126] !== 0) {
    applyTag(tags, 'tracknumber', String(bytes[126]));
  } else if (comment) {
    applyTag(tags, 'comment', comment);
  }

  const genre = ID3V1_GENRES[genreIndex];
  if (genre) applyTag(tags, 'genre', genre);
  return true;
}

/** Exposed for the MP3 stream parser, which must skip a trailing v1 tag. */
export function id3v1Length(): number {
  return 128;
}

export { ID3V1_GENRES };

/** Exposed so callers can normalise a numeric genre from another format. */
export function genreByIndex(value: string): string | undefined {
  const index = parseIntLoose(value);
  return index === undefined ? undefined : ID3V1_GENRES[index];
}
