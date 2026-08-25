/**
 * MP4 / M4A / ALAC (ISO base media file format).
 *
 * A tree of length-prefixed "atoms". Tags live at
 * `moov.udta.meta.ilst`, timing at `moov.trak.mdia.mdhd`, and the codec at
 * `moov.trak.mdia.minf.stbl.stsd`.
 *
 * The atom sizes make this cheap to read even when `moov` is at the *end* of
 * the file — which is where a file written by a streaming muxer puts it. The
 * walker seeks by size rather than scanning, so a 200 MB ALAC costs a handful
 * of small reads either way.
 */

import { ByteReader, decodeUtf8, type ByteSource } from './reader';
import { applyTag, type RawTags, type StreamInfo } from './types';
import { genreByIndex } from './id3';

interface Atom {
  type: string;
  /** Offset of the atom's payload. */
  bodyAt: number;
  bodySize: number;
  /** Offset just past the whole atom. */
  end: number;
}

/** Atoms whose payload is itself a list of atoms. */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'udta',
  'ilst',
  'moof',
  'traf',
  'edts',
  'mvex',
]);

/** ilst atom -> canonical key. */
const ILST_KEYS: Record<string, string> = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumartist',
  '©alb': 'album',
  '©gen': 'genre',
  gnre: 'genre',
  '©day': 'date',
  '©wrt': 'composer',
  '©con': 'conductor',
  '©cmt': 'comment',
  '©lyr': 'lyrics',
  cprt: 'copyright',
  tmpo: 'bpm',
};

/** `----` freeform atom names, as `com.apple.iTunes:NAME` lowercased. */
const FREEFORM_KEYS: Record<string, string> = {
  isrc: 'isrc',
  musicbrainz_trackid: 'musicbrainz_trackid',
  'musicbrainz track id': 'musicbrainz_trackid',
  'musicbrainz album id': 'musicbrainz_albumid',
  'musicbrainz release group id': 'musicbrainz_releasegroupid',
  'musicbrainz artist id': 'musicbrainz_artistid',
  'musicbrainz album artist id': 'musicbrainz_albumartistid',
  replaygain_track_gain: 'replaygain_track_gain',
  replaygain_track_peak: 'replaygain_track_peak',
  replaygain_album_gain: 'replaygain_album_gain',
  replaygain_album_peak: 'replaygain_album_peak',
};

async function readAtom(source: ByteSource, at: number, limit: number): Promise<Atom | null> {
  if (at + 8 > limit) return null;
  const header = await source.read(at, 16);
  if (header.length < 8) return null;

  const reader = new ByteReader(header);
  let size = reader.u32be();
  const type = reader.ascii(4);
  let bodyAt = at + 8;

  if (size === 1) {
    // 64-bit extended size follows the type.
    if (header.length < 16) return null;
    size = reader.u64be();
    bodyAt = at + 16;
  } else if (size === 0) {
    // "to end of file"
    size = limit - at;
  }

  if (size < 8 || at + size > limit) return null;
  return { type, bodyAt, bodySize: at + size - bodyAt, end: at + size };
}

/** Depth-first walk. `visit` returning false skips descending into that atom. */
async function walk(
  source: ByteSource,
  from: number,
  to: number,
  depth: number,
  visit: (atom: Atom, depth: number) => Promise<boolean> | boolean,
): Promise<void> {
  let cursor = from;
  // Guard against a malformed file producing an unbounded walk.
  if (depth > 8) return;
  for (let guard = 0; guard < 512; guard++) {
    const atom = await readAtom(source, cursor, to);
    if (!atom) return;
    const descend = await visit(atom, depth);
    if (descend && CONTAINERS.has(atom.type)) {
      await walk(source, atom.bodyAt, atom.end, depth + 1, visit);
    }
    if (atom.end <= cursor) return; // no forward progress: bail out
    cursor = atom.end;
  }
}

export interface Mp4Result {
  stream: StreamInfo;
  warnings: string[];
}

export async function isMp4(source: ByteSource): Promise<boolean> {
  const head = await source.read(4, 4);
  return head.length === 4 && String.fromCharCode(...head) === 'ftyp';
}

export async function parseMp4(source: ByteSource, tags: RawTags): Promise<Mp4Result> {
  const warnings: string[] = [];
  const stream: StreamInfo = {
    format: 'm4a',
    codec: 'AAC',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: false,
  };

  // ftyp brand distinguishes an Apple Lossless container from an AAC one.
  const ftypBrand = await source.read(8, 4);
  const brand = ftypBrand.length === 4 ? String.fromCharCode(...ftypBrand) : '';

  let timescale = 0;
  let durationUnits = 0;

  await walk(source, 0, source.size, 0, async (atom) => {
    switch (atom.type) {
      case 'mdhd': {
        const body = await source.read(atom.bodyAt, Math.min(atom.bodySize, 32));
        if (body.length < 24) return false;
        const reader = new ByteReader(body);
        const version = reader.u8();
        reader.skip(3); // flags
        if (version === 1) {
          reader.skip(16); // 64-bit creation + modification times
          timescale = reader.u32be();
          durationUnits = reader.u64be();
        } else {
          reader.skip(8); // 32-bit creation + modification times
          timescale = reader.u32be();
          durationUnits = reader.u32be();
        }
        return false;
      }
      case 'stsd': {
        const body = await source.read(atom.bodyAt, Math.min(atom.bodySize, 512));
        readSampleDescription(body, stream);
        return false;
      }
      case 'ilst':
        // Descend; children are handled below.
        return true;
      case 'meta':
        // `meta` has a 4-byte version/flags prefix before its child atoms, so
        // it cannot be walked as a plain container.
        await walk(source, atom.bodyAt + 4, atom.end, 1, async (child) => {
          if (child.type === 'ilst') {
            await walkIlst(source, child, tags, warnings);
          }
          return false;
        });
        return false;
      default:
        return true;
    }
  });

  if (timescale > 0 && durationUnits > 0) {
    stream.durationMs = Math.round((durationUnits / timescale) * 1000);
    stream.bitrateKbps = Math.round((source.size * 8) / stream.durationMs);
  } else {
    warnings.push('MP4 duration could not be determined');
  }

  if (stream.codec === 'ALAC' || brand === 'alac') {
    stream.format = 'alac';
    stream.lossless = true;
  } else if (brand === 'M4A ' || brand === 'mp42' || brand === 'isom' || brand === 'M4B ') {
    stream.format = 'm4a';
  }

  return { stream, warnings };
}

/** `stsd` names the codec and, for ALAC, its real bit depth. */
function readSampleDescription(body: Uint8Array, stream: StreamInfo): void {
  try {
    const reader = new ByteReader(body);
    reader.skip(4); // version + flags
    const entries = reader.u32be();
    if (entries === 0) return;
    reader.skip(4); // entry size
    const format = reader.ascii(4);

    // AudioSampleEntry: 6 reserved bytes, 2 data-reference index, 8 reserved,
    // 2 channel count, 2 sample size, 4 pre-defined/reserved, 4 sample rate
    // as 16.16 fixed point.
    reader.skip(6 + 2 + 8);
    const channels = reader.u16be();
    const sampleSize = reader.u16be();
    reader.skip(4);
    const sampleRate = reader.u32be() >> 16;

    if (channels > 0 && channels <= 32) stream.channels = channels;
    if (sampleRate > 0) stream.sampleRate = sampleRate;

    switch (format) {
      case 'alac':
        stream.codec = 'ALAC';
        stream.lossless = true;
        stream.bitDepth = sampleSize > 0 ? sampleSize : 16;
        break;
      case 'mp4a':
        stream.codec = 'AAC';
        break;
      default:
        stream.codec = format.trim().toUpperCase() || 'AAC';
    }
  } catch {
    // Leave the defaults in place; duration and tags are unaffected.
  }
}

async function walkIlst(
  source: ByteSource,
  ilst: Atom,
  tags: RawTags,
  warnings: string[],
): Promise<void> {
  await walk(source, ilst.bodyAt, ilst.end, 1, async (item) => {
    // Each item holds one `data` atom (sometimes preceded by `mean`/`name`).
    const raw = await source.read(item.bodyAt, Math.min(item.bodySize, 8 * 1024 * 1024));
    if (raw.length < 8) return false;

    if (item.type === '----') {
      handleFreeform(raw, tags);
      return false;
    }

    // trkn / disk are binary and map to a key that depends on the atom, so they
    // are not in ILST_KEYS.
    if (item.type === 'trkn' || item.type === 'disk') {
      const pair = findDataAtom(raw);
      if (pair && pair.payload.length >= 6) {
        // 2 reserved bytes, 2-byte number, 2-byte total.
        const number = (pair.payload[2]! << 8) | pair.payload[3]!;
        const total = (pair.payload[4]! << 8) | pair.payload[5]!;
        const key = item.type === 'trkn' ? 'tracknumber' : 'discnumber';
        if (number > 0) applyTag(tags, key, total > 0 ? `${number}/${total}` : String(number));
      }
      return false;
    }

    const canonical = ILST_KEYS[item.type];
    if (!canonical) return false;

    const data = findDataAtom(raw);
    if (!data) return false;

    if (canonical === 'genre' && item.type === 'gnre') {
      // Numeric genre, one-based index into the ID3v1 table.
      const index = data.payload.length >= 2 ? (data.payload[0]! << 8) | data.payload[1]! : 0;
      const name = genreByIndex(String(index - 1));
      if (name) applyTag(tags, 'genre', name);
      return false;
    }

    if (item.type === 'covr') {
      const mime = data.dataType === 14 ? 'image/png' : 'image/jpeg';
      if (data.payload.length >= 64) {
        tags.pictures.push({
          mime,
          pictureType: 3, // ilst artwork is always the front cover
          description: '',
          data: data.payload,
        });
      } else {
        warnings.push('MP4 cover atom too small to be an image');
      }
      return false;
    }

    if (data.dataType === 1) {
      applyTag(tags, canonical, decodeUtf8(data.payload));
    } else if (data.dataType === 0 || data.dataType === 21) {
      // Big-endian signed integer of 1, 2, 4 or 8 bytes.
      let value = 0;
      for (const byte of data.payload) value = value * 256 + byte;
      applyTag(tags, canonical, String(value));
    }
    return false;
  });

}

interface DataAtom {
  dataType: number;
  payload: Uint8Array;
}

/** Locate the `data` child inside an ilst item payload. */
function findDataAtom(raw: Uint8Array): DataAtom | null {
  let cursor = 0;
  while (cursor + 8 <= raw.length) {
    const size =
      ((raw[cursor]! << 24) | (raw[cursor + 1]! << 16) | (raw[cursor + 2]! << 8) | raw[cursor + 3]!) >>>
      0;
    const type = String.fromCharCode(
      raw[cursor + 4]!,
      raw[cursor + 5]!,
      raw[cursor + 6]!,
      raw[cursor + 7]!,
    );
    if (size < 8 || cursor + size > raw.length) return null;
    if (type === 'data') {
      // 1 byte reserved, 3 bytes type, 4 bytes locale, then the value.
      if (size < 16) return null;
      const dataType =
        (raw[cursor + 9]! << 16) | (raw[cursor + 10]! << 8) | raw[cursor + 11]!;
      return { dataType, payload: raw.subarray(cursor + 16, cursor + size) };
    }
    cursor += size;
  }
  return null;
}

/** `----` items carry `mean` (namespace), `name` (key) and `data` (value). */
function handleFreeform(raw: Uint8Array, tags: RawTags): void {
  let cursor = 0;
  let name = '';
  while (cursor + 8 <= raw.length) {
    const size =
      ((raw[cursor]! << 24) | (raw[cursor + 1]! << 16) | (raw[cursor + 2]! << 8) | raw[cursor + 3]!) >>>
      0;
    const type = String.fromCharCode(
      raw[cursor + 4]!,
      raw[cursor + 5]!,
      raw[cursor + 6]!,
      raw[cursor + 7]!,
    );
    if (size < 8 || cursor + size > raw.length) return;

    if (type === 'name' && size > 12) {
      name = decodeUtf8(raw.subarray(cursor + 12, cursor + size)).toLowerCase();
    } else if (type === 'data' && size > 16) {
      const canonical = FREEFORM_KEYS[name];
      if (canonical) {
        applyTag(tags, canonical, decodeUtf8(raw.subarray(cursor + 16, cursor + size)));
      }
      return;
    }
    cursor += size;
  }
}
