/**
 * Ogg containers: Vorbis and Opus.
 *
 * Duration is not stored as a field — it is the granule position of the last
 * page, which is a sample counter. So the head of the file gives the codec and
 * the tags, and the *tail* gives the length. Both ends are small reads; the
 * megabytes in between are never touched.
 */

import { ByteReader, type ByteSource } from './reader';
import { parseVorbisComments } from './vorbis';
import type { RawTags, StreamInfo } from './types';

const OGG_MAGIC = 0x4f676753; // "OggS"

interface OggPage {
  headerType: number;
  granulePosition: number;
  serial: number;
  /** Concatenated packet data for this page. */
  payload: Uint8Array;
  /** Offset just past this page. */
  end: number;
}

function readPage(bytes: Uint8Array, at: number): OggPage | null {
  if (at + 27 > bytes.length) return null;
  const reader = new ByteReader(bytes).seek(at);
  if (reader.u32be() !== OGG_MAGIC) return null;
  reader.skip(1); // stream structure version
  const headerType = reader.u8();
  // Granule position is 64-bit little-endian.
  const granuleLow = reader.u32le();
  const granuleHigh = reader.u32le();
  const granulePosition = granuleHigh * 0x100000000 + granuleLow;
  const serial = reader.u32le();
  reader.skip(4 + 4); // page sequence, CRC
  const segmentCount = reader.u8();
  if (reader.remaining < segmentCount) return null;

  let payloadLength = 0;
  for (let i = 0; i < segmentCount; i++) payloadLength += reader.u8();
  if (reader.remaining < payloadLength) return null;

  return {
    headerType,
    granulePosition,
    serial,
    payload: reader.bytesOf(payloadLength),
    end: reader.offset,
  };
}

export async function isOgg(source: ByteSource): Promise<boolean> {
  const head = await source.read(0, 4);
  return head.length === 4 && new ByteReader(head).u32be() === OGG_MAGIC;
}

export interface OggResult {
  stream: StreamInfo;
  warnings: string[];
}

export async function parseOgg(source: ByteSource, tags: RawTags): Promise<OggResult> {
  const warnings: string[] = [];
  const stream: StreamInfo = {
    format: 'ogg',
    codec: 'Vorbis',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: false,
  };

  // The identification and comment headers are always within the first pages.
  const head = await source.read(0, 128 * 1024);
  if (head.length < 27) {
    warnings.push('file too short to be an Ogg stream');
    return { stream, warnings };
  }

  let cursor = 0;
  let isOpus = false;
  let nominalBitrate = 0;
  let preSkip = 0;
  /** Comment packets can span pages, so payloads are accumulated. */
  let commentBuffer: Uint8Array | null = null;

  for (let page = 0; page < 64; page++) {
    const parsed = readPage(head, cursor);
    if (!parsed) break;
    const payload = parsed.payload;

    if (page === 0) {
      if (startsWith(payload, 'OpusHead')) {
        isOpus = true;
        stream.format = 'opus';
        stream.codec = 'Opus';
        const reader = new ByteReader(payload).seek(9);
        stream.channels = reader.u8();
        preSkip = reader.u16le();
        // OpusHead also stores the *original* input sample rate, but Opus always
        // decodes at 48 kHz, so that is the rate playback and duration use.
        stream.sampleRate = 48000;
      } else if (payload[0] === 0x01 && startsWith(payload.subarray(1), 'vorbis')) {
        const reader = new ByteReader(payload).seek(7);
        reader.skip(4); // vorbis version
        stream.channels = reader.u8();
        stream.sampleRate = reader.u32le();
        reader.skip(4); // maximum bitrate
        nominalBitrate = reader.u32le();
      } else {
        warnings.push('unrecognised Ogg codec');
        break;
      }
    } else if (startsWith(payload, 'OpusTags')) {
      commentBuffer = payload.subarray(8);
    } else if (payload[0] === 0x03 && startsWith(payload.subarray(1), 'vorbis')) {
      commentBuffer = payload.subarray(7);
    } else if (commentBuffer && (parsed.headerType & 0x01) !== 0) {
      // Continuation of the comment packet.
      const merged: Uint8Array = new Uint8Array(commentBuffer.length + payload.length);
      merged.set(commentBuffer);
      merged.set(payload, commentBuffer.length);
      commentBuffer = merged;
    } else if (commentBuffer) {
      break; // Comments complete; the rest is audio.
    }

    cursor = parsed.end;
    if (cursor >= head.length) break;
  }

  if (commentBuffer) parseVorbisComments(commentBuffer, tags, warnings);
  else warnings.push('no Vorbis comment header found');

  // Duration: granule position of the final page.
  const granule = await lastGranulePosition(source);
  const rate = isOpus ? 48000 : (stream.sampleRate ?? 0);
  if (granule > 0 && rate > 0) {
    const samples = isOpus ? Math.max(0, granule - preSkip) : granule;
    stream.durationMs = Math.round((samples / rate) * 1000);
    stream.bitrateKbps = Math.round((source.size * 8) / stream.durationMs);
  } else if (nominalBitrate > 0) {
    stream.bitrateKbps = Math.round(nominalBitrate / 1000);
    stream.durationMs = Math.round((source.size * 8) / (nominalBitrate / 1000));
    warnings.push('Ogg duration estimated from nominal bitrate');
  } else {
    warnings.push('Ogg duration could not be determined');
  }

  return { stream, warnings };
}

/**
 * Scan backwards from the end of the file for the last page header.
 *
 * 64 KiB covers the maximum Ogg page size with room to spare, so one read is
 * enough for any well-formed stream.
 */
async function lastGranulePosition(source: ByteSource): Promise<number> {
  const windowSize = Math.min(64 * 1024, source.size);
  const start = source.size - windowSize;
  const tail = await source.read(start, windowSize);

  for (let at = tail.length - 27; at >= 0; at--) {
    if (
      tail[at] === 0x4f &&
      tail[at + 1] === 0x67 &&
      tail[at + 2] === 0x67 &&
      tail[at + 3] === 0x53
    ) {
      const page = readPage(tail, at);
      if (page && page.granulePosition > 0) return page.granulePosition;
    }
  }
  return 0;
}

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
