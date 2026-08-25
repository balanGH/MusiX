/**
 * FLAC.
 *
 * The nicest format to read: STREAMINFO gives exact duration, sample rate, bit
 * depth and channel count with no estimation, and the metadata blocks are a
 * simple length-prefixed chain at the head of the file. A 60 MB FLAC is fully
 * described by its first few kilobytes plus whatever the cover weighs.
 */

import type { ByteSource } from './reader';
import { parsePictureBlock, parseVorbisComments } from './vorbis';
import type { RawTags, StreamInfo } from './types';

const BLOCK_STREAMINFO = 0;
const BLOCK_VORBIS_COMMENT = 4;
const BLOCK_PICTURE = 6;

export interface FlacResult {
  stream: StreamInfo;
  warnings: string[];
}

export async function isFlac(source: ByteSource): Promise<boolean> {
  const head = await source.read(0, 4);
  return head.length === 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43;
}

export async function parseFlac(
  source: ByteSource,
  tags: RawTags,
  offset = 0,
): Promise<FlacResult> {
  const warnings: string[] = [];
  const stream: StreamInfo = {
    format: 'flac',
    codec: 'FLAC',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: true,
  };

  let cursor = offset + 4; // past "fLaC"
  let totalSamples = 0;

  for (let block = 0; block < 128; block++) {
    const header = await source.read(cursor, 4);
    if (header.length < 4) break;

    const isLast = (header[0]! & 0x80) !== 0;
    const type = header[0]! & 0x7f;
    const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
    const bodyAt = cursor + 4;

    if (type === BLOCK_STREAMINFO && length >= 34) {
      const body = await source.read(bodyAt, 34);
      if (body.length >= 34) {
        // Bit-packed from byte 10: 20 bits sample rate, 3 bits channels-1,
        // 5 bits depth-1, 36 bits total samples — straddling byte boundaries
        // throughout, so this is done by hand rather than with ByteReader.
        const b = body;
        const sampleRate = (b[10]! << 12) | (b[11]! << 4) | (b[12]! >> 4);
        const channels = ((b[12]! >> 1) & 0x07) + 1;
        const bitDepth = (((b[12]! & 0x01) << 4) | (b[13]! >> 4)) + 1;
        const highNibble = b[13]! & 0x0f;
        const low32 = ((b[14]! << 24) | (b[15]! << 16) | (b[16]! << 8) | b[17]!) >>> 0;
        totalSamples = highNibble * 0x100000000 + low32;

        stream.sampleRate = sampleRate || null;
        stream.channels = channels;
        stream.bitDepth = bitDepth;
        if (sampleRate > 0 && totalSamples > 0) {
          stream.durationMs = Math.round((totalSamples / sampleRate) * 1000);
        }
      }
    } else if (type === BLOCK_VORBIS_COMMENT) {
      // Comment blocks are small; a corrupt length must not trigger a huge read.
      const body = await source.read(bodyAt, Math.min(length, 1024 * 1024));
      parseVorbisComments(body, tags, warnings);
    } else if (type === BLOCK_PICTURE) {
      const body = await source.read(bodyAt, Math.min(length, 8 * 1024 * 1024));
      const picture = parsePictureBlock(body);
      if (picture) tags.pictures.push(picture);
      else warnings.push('unreadable FLAC picture block');
    }

    cursor = bodyAt + length;
    if (isLast) break;
    if (cursor >= source.size) {
      warnings.push('FLAC metadata chain runs past end of file');
      break;
    }
  }

  if (stream.durationMs > 0) {
    // Frames start after the metadata chain, so this is the real audio size.
    const audioBytes = Math.max(0, source.size - cursor);
    stream.bitrateKbps = Math.round((audioBytes * 8) / stream.durationMs);
  }
  if (stream.sampleRate === null) warnings.push('FLAC STREAMINFO block missing');

  return { stream, warnings };
}
