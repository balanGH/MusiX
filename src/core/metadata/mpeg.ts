/**
 * MPEG audio (MP3) stream properties.
 *
 * MP3 carries no duration field, so it has to be derived. In order of accuracy:
 *
 *  1. A Xing/Info or VBRI header in the first frame gives the exact frame
 *     count — the only correct answer for a VBR file.
 *  2. Otherwise the file is assumed CBR and duration comes from
 *     `audio bytes / bitrate`, which is exact for true CBR and a good estimate
 *     for the rest.
 *
 * Decoding the whole file to count frames would be exact in every case and is
 * what some players do; at 100k tracks that is hours of CPU for a number the
 * user will not notice being 0.3% off (spec §4).
 */

import { ByteReader, type ByteSource } from './reader';
import type { StreamInfo } from './types';

const BITRATES_V1 = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer II
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer III
] as const;

const BITRATES_V2 = [
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer I
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer II & III
] as const;

const SAMPLE_RATES = {
  1: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  2.5: [11025, 12000, 8000], // MPEG 2.5
} as const;

interface FrameHeader {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  padding: boolean;
  /** Whole frame length in bytes, including this header. */
  frameLength: number;
  samplesPerFrame: number;
  /** Bytes of side information between the header and the audio payload. */
  sideInfoSize: number;
}

/** Decode a 4-byte frame header, or null if these bytes are not one. */
export function parseFrameHeader(bytes: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;

  // 11-bit frame sync.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  if (versionBits === 1) return null; // reserved
  const version: 1 | 2 | 2.5 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;

  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null; // reserved
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null; // free / invalid
  const bitrateKbps =
    version === 1
      ? BITRATES_V1[layer - 1]![bitrateIndex]!
      : BITRATES_V2[layer === 1 ? 0 : 1]![bitrateIndex]!;
  if (!bitrateKbps) return null;

  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (sampleRateIndex === 3) return null; // reserved
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex]!;

  const padding = ((b2 >> 1) & 0x01) === 1;
  const channelMode = (b3 >> 6) & 0x03;
  const channels = channelMode === 3 ? 1 : 2;

  const samplesPerFrame =
    layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;

  const frameLength =
    layer === 1
      ? Math.floor(((12 * bitrateKbps * 1000) / sampleRate + (padding ? 1 : 0)) * 4)
      : Math.floor(
          ((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate + (padding ? 1 : 0),
        );

  if (frameLength < 24) return null;

  const sideInfoSize =
    layer !== 3 ? 0 : version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;

  return {
    version,
    layer,
    bitrateKbps,
    sampleRate,
    channels,
    padding,
    frameLength,
    samplesPerFrame,
    sideInfoSize,
  };
}

/**
 * Find the first valid frame.
 *
 * Requires the *next* frame to be where this one says it will be, because a
 * lone 0xFFE byte pair happens by chance inside album art and lyrics often
 * enough to matter.
 */
function findFirstFrame(bytes: Uint8Array, from: number): { offset: number; header: FrameHeader } | null {
  const limit = Math.min(bytes.length - 4, from + 256 * 1024);
  for (let offset = from; offset < limit; offset++) {
    if (bytes[offset] !== 0xff) continue;
    const header = parseFrameHeader(bytes, offset);
    if (!header) continue;
    const nextOffset = offset + header.frameLength;
    if (nextOffset + 4 <= bytes.length) {
      const next = parseFrameHeader(bytes, nextOffset);
      if (!next || next.sampleRate !== header.sampleRate) continue;
    }
    return { offset, header };
  }
  return null;
}

interface VbrInfo {
  frames: number | null;
  bytes: number | null;
}

/** Look for a Xing/Info or VBRI header inside the first frame. */
function readVbrHeader(bytes: Uint8Array, frameOffset: number, header: FrameHeader): VbrInfo {
  const result: VbrInfo = { frames: null, bytes: null };

  // Xing / Info sits directly after the side information.
  const xingOffset = frameOffset + 4 + header.sideInfoSize;
  if (xingOffset + 12 <= bytes.length) {
    const tag = String.fromCharCode(
      bytes[xingOffset]!,
      bytes[xingOffset + 1]!,
      bytes[xingOffset + 2]!,
      bytes[xingOffset + 3]!,
    );
    if (tag === 'Xing' || tag === 'Info') {
      const reader = new ByteReader(bytes).seek(xingOffset + 4);
      const flags = reader.u32be();
      if ((flags & 0x01) !== 0 && reader.remaining >= 4) result.frames = reader.u32be();
      if ((flags & 0x02) !== 0 && reader.remaining >= 4) result.bytes = reader.u32be();
      return result;
    }
  }

  // VBRI (Fraunhofer) is always 32 bytes past the header.
  const vbriOffset = frameOffset + 36;
  if (vbriOffset + 26 <= bytes.length) {
    const tag = String.fromCharCode(
      bytes[vbriOffset]!,
      bytes[vbriOffset + 1]!,
      bytes[vbriOffset + 2]!,
      bytes[vbriOffset + 3]!,
    );
    if (tag === 'VBRI') {
      const reader = new ByteReader(bytes).seek(vbriOffset + 10);
      result.bytes = reader.u32be();
      result.frames = reader.u32be();
    }
  }

  return result;
}

/**
 * @param audioStart byte offset where audio begins (after any ID3v2 tag)
 * @param audioEnd   byte offset where audio ends (before any ID3v1 tag)
 */
export async function readMpegStreamInfo(
  source: ByteSource,
  audioStart: number,
  audioEnd: number,
): Promise<StreamInfo> {
  const unknown: StreamInfo = {
    format: 'mp3',
    codec: 'MPEG Audio',
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: false,
  };

  // 32 KiB is enough for the first frame plus its VBR header in every real file.
  const window = await source.read(audioStart, 32 * 1024);
  if (window.length < 4) return unknown;

  const found = findFirstFrame(window, 0);
  if (!found) return unknown;

  const { header } = found;
  const frameOffset = found.offset;
  const vbr = readVbrHeader(window, frameOffset, header);
  const audioBytes = vbr.bytes ?? Math.max(0, audioEnd - (audioStart + frameOffset));

  let durationMs: number;
  let bitrateKbps: number;

  if (vbr.frames && vbr.frames > 0) {
    durationMs = (vbr.frames * header.samplesPerFrame * 1000) / header.sampleRate;
    bitrateKbps = durationMs > 0 ? (audioBytes * 8) / durationMs : header.bitrateKbps;
  } else {
    // Assume CBR at the first frame's bitrate.
    bitrateKbps = header.bitrateKbps;
    durationMs = (audioBytes * 8) / bitrateKbps;
  }

  return {
    format: 'mp3',
    codec: `MPEG ${header.version} Layer ${'I'.repeat(header.layer)}`,
    durationMs: Math.max(0, Math.round(durationMs)),
    bitrateKbps: Math.round(bitrateKbps),
    sampleRate: header.sampleRate,
    bitDepth: null, // Not meaningful for a lossy codec.
    channels: header.channels,
    lossless: false,
  };
}
