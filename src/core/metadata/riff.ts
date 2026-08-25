/**
 * WAV (RIFF) and AIFF (FORM).
 *
 * Both are chunked containers, one little-endian and one big-endian. Neither
 * has a rich tag format, so MusiX reads what is there — LIST/INFO for WAV,
 * NAME/AUTH/ANNO for AIFF — and honours an embedded ID3 chunk when a tagger
 * wrote one, which is how most WAV files that *do* have proper tags carry them.
 */

import { ByteReader, decodeIdentifier, decodeUtf8, type ByteSource } from './reader';
import { applyTag, type RawTags, type StreamInfo } from './types';

/** LIST/INFO chunk id -> canonical key. */
const INFO_KEYS: Record<string, string> = {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  ICRD: 'date',
  IGNR: 'genre',
  ICMT: 'comment',
  ITRK: 'tracknumber',
  IPRT: 'tracknumber',
  ICOP: 'copyright',
  IMUS: 'composer',
  ICNM: 'conductor',
};

export interface RiffResult {
  stream: StreamInfo;
  warnings: string[];
  /** Offset and length of an embedded ID3 chunk, if the file has one. */
  id3Chunk: { at: number; size: number } | null;
}

export async function detectRiff(source: ByteSource): Promise<'wav' | 'aiff' | null> {
  const head = await source.read(0, 12);
  if (head.length < 12) return null;
  const container = decodeIdentifier(head.subarray(0, 4));
  const form = decodeIdentifier(head.subarray(8, 12));
  if (container === 'RIFF' && form === 'WAVE') return 'wav';
  if (container === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return 'aiff';
  return null;
}

export async function parseWav(source: ByteSource, tags: RawTags): Promise<RiffResult> {
  const warnings: string[] = [];
  const stream: StreamInfo = {
    format: 'wav',
    codec: 'PCM',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: true,
  };
  let id3Chunk: RiffResult['id3Chunk'] = null;

  let byteRate = 0;
  let dataSize = 0;
  let cursor = 12;

  for (let chunk = 0; chunk < 256 && cursor + 8 <= source.size; chunk++) {
    const header = await source.read(cursor, 8);
    if (header.length < 8) break;
    const id = decodeIdentifier(header.subarray(0, 4));
    const size = new ByteReader(header).seek(4).u32le();
    const bodyAt = cursor + 8;

    if (id === 'fmt ' && size >= 16) {
      const body = await source.read(bodyAt, Math.min(size, 40));
      const reader = new ByteReader(body);
      const audioFormat = reader.u16le();
      stream.channels = reader.u16le();
      stream.sampleRate = reader.u32le();
      byteRate = reader.u32le();
      reader.skip(2); // block align
      stream.bitDepth = reader.u16le();
      // 1 = PCM, 3 = IEEE float, 0xFFFE = extensible (still PCM in practice).
      if (audioFormat === 3) stream.codec = 'PCM (float)';
      else if (audioFormat !== 1 && audioFormat !== 0xfffe) {
        stream.codec = `WAV format 0x${audioFormat.toString(16)}`;
        stream.lossless = false;
        warnings.push('compressed WAV; duration may be approximate');
      }
    } else if (id === 'data') {
      dataSize = size;
    } else if (id === 'LIST') {
      const body = await source.read(bodyAt, Math.min(size, 64 * 1024));
      parseInfoList(body, tags);
    } else if (id === 'id3 ' || id === 'ID3 ') {
      id3Chunk = { at: bodyAt, size };
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = bodyAt + size + (size % 2);
  }

  if (byteRate > 0 && dataSize > 0) {
    stream.durationMs = Math.round((dataSize / byteRate) * 1000);
    stream.bitrateKbps = Math.round((byteRate * 8) / 1000);
  } else if (stream.sampleRate && stream.channels && stream.bitDepth && dataSize > 0) {
    const computed = (stream.sampleRate * stream.channels * stream.bitDepth) / 8;
    stream.durationMs = Math.round((dataSize / computed) * 1000);
    stream.bitrateKbps = Math.round((computed * 8) / 1000);
  } else {
    warnings.push('WAV duration could not be determined');
  }

  return { stream, warnings, id3Chunk };
}

function parseInfoList(body: Uint8Array, tags: RawTags): void {
  if (body.length < 4) return;
  if (decodeIdentifier(body.subarray(0, 4)) !== 'INFO') return;

  let cursor = 4;
  while (cursor + 8 <= body.length) {
    const id = decodeIdentifier(body.subarray(cursor, cursor + 4));
    const size = new ByteReader(body).seek(cursor + 4).u32le();
    const bodyAt = cursor + 8;
    if (size === 0 || bodyAt + size > body.length) break;

    const canonical = INFO_KEYS[id];
    if (canonical) {
      // INFO strings are nominally latin1 but are frequently UTF-8.
      applyTag(tags, canonical, decodeUtf8(body.subarray(bodyAt, bodyAt + size)));
    }
    cursor = bodyAt + size + (size % 2);
  }
}

export async function parseAiff(source: ByteSource, tags: RawTags): Promise<RiffResult> {
  const warnings: string[] = [];
  const stream: StreamInfo = {
    format: 'aiff',
    codec: 'PCM',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: true,
  };
  let id3Chunk: RiffResult['id3Chunk'] = null;
  let cursor = 12;

  for (let chunk = 0; chunk < 256 && cursor + 8 <= source.size; chunk++) {
    const header = await source.read(cursor, 8);
    if (header.length < 8) break;
    const id = decodeIdentifier(header.subarray(0, 4));
    const size = new ByteReader(header).seek(4).u32be();
    const bodyAt = cursor + 8;

    if (id === 'COMM' && size >= 18) {
      const body = await source.read(bodyAt, Math.min(size, 24));
      const reader = new ByteReader(body);
      stream.channels = reader.u16be();
      const frames = reader.u32be();
      stream.bitDepth = reader.u16be();
      const sampleRate = readExtendedFloat80(reader.bytesOf(10));
      stream.sampleRate = Math.round(sampleRate) || null;
      if (sampleRate > 0 && frames > 0) {
        stream.durationMs = Math.round((frames / sampleRate) * 1000);
        if (stream.channels && stream.bitDepth) {
          stream.bitrateKbps = Math.round(
            (sampleRate * stream.channels * stream.bitDepth) / 1000,
          );
        }
      }
    } else if (id === 'NAME' || id === 'AUTH' || id === 'ANNO' || id === '(c) ') {
      const body = await source.read(bodyAt, Math.min(size, 4096));
      const text = decodeUtf8(body);
      const canonical =
        id === 'NAME' ? 'title' : id === 'AUTH' ? 'artist' : id === '(c) ' ? 'copyright' : 'comment';
      applyTag(tags, canonical, text);
    } else if (id === 'ID3 ' || id === 'id3 ') {
      id3Chunk = { at: bodyAt, size };
    }

    cursor = bodyAt + size + (size % 2);
  }

  if (stream.durationMs === 0) warnings.push('AIFF duration could not be determined');
  return { stream, warnings, id3Chunk };
}

/**
 * IEEE 754 80-bit extended precision, which is how AIFF stores its sample rate.
 *
 * 1 sign bit, 15 exponent bits with a 16383 bias, then a 64-bit *explicit*
 * mantissa (no implied leading one, unlike 32/64-bit floats).
 */
function readExtendedFloat80(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  const sign = bytes[0]! & 0x80 ? -1 : 1;
  const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;
  if (exponent === 0) return 0;
  if (exponent === 0x7fff) return 0; // infinity or NaN — not a valid rate

  let mantissa = 0;
  for (let i = 2; i < 10; i++) mantissa = mantissa * 256 + bytes[i]!;

  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}
