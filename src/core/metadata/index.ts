/**
 * Format detection and dispatch.
 *
 * Detection is by magic bytes first and file extension only as a fallback,
 * because a mis-named file is common in real collections and a `.mp3` that is
 * really a FLAC should still import correctly (spec §34: never fail hard).
 */

import { extensionOf } from '../utils';
import { parseId3v1, parseId3v2, readId3v2Header } from './id3';
import { parseFlac } from './flac';
import { parseMp4 } from './mp4';
import { parseOgg } from './ogg';
import { readMpegStreamInfo } from './mpeg';
import { detectRiff, parseAiff, parseWav } from './riff';
import { BlobByteSource, decodeIdentifier, type ByteSource } from './reader';
import { emptyTags, type ParsedAudio, type RawTags, type StreamInfo } from './types';
import type { AudioFormat } from '../types';

/**
 * Extensions the scanner will consider.
 *
 * Kept in step with spec §8. Anything else in a music folder is skipped
 * silently — cue sheets, logs and cover images are not errors.
 */
export const SUPPORTED_EXTENSIONS = new Set([
  'mp3',
  'flac',
  'wav',
  'wave',
  'm4a',
  'm4b',
  'mp4',
  'aac',
  'ogg',
  'oga',
  'opus',
  'aif',
  'aiff',
  'aifc',
]);

export function isSupportedAudioFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extensionOf(filename));
}

type Container = 'mp3' | 'flac' | 'ogg' | 'mp4' | 'wav' | 'aiff' | 'aac-adts' | 'unknown';

/**
 * Identify the container.
 *
 * `id3Size` is returned when an ID3v2 tag sits in front of the real signature,
 * which is legal for MP3 and happens in the wild for FLAC and AAC too.
 */
async function detect(
  source: ByteSource,
  filename: string,
): Promise<{ container: Container; audioStart: number }> {
  const id3 = await readId3v2Header(source);
  const audioStart = id3?.size ?? 0;

  const magic = await source.read(audioStart, 12);
  const four = magic.length >= 4 ? decodeIdentifier(magic.subarray(0, 4)) : '';

  if (four === 'fLaC') return { container: 'flac', audioStart };
  if (four === 'OggS') return { container: 'ogg', audioStart };
  if (magic.length >= 8 && decodeIdentifier(magic.subarray(4, 8)) === 'ftyp') {
    return { container: 'mp4', audioStart };
  }
  if (four === 'RIFF' || four === 'FORM') {
    const riff = await detectRiff(source);
    if (riff) return { container: riff, audioStart: 0 };
  }
  // MPEG frame sync, or an ADTS AAC sync (layer bits zero).
  if (magic.length >= 2 && magic[0] === 0xff && (magic[1]! & 0xe0) === 0xe0) {
    const layerBits = (magic[1]! >> 1) & 0x03;
    return { container: layerBits === 0 ? 'aac-adts' : 'mp3', audioStart };
  }
  // An ID3 tag with no recognisable signature after it is almost always MP3
  // with a little junk in between.
  if (id3) return { container: 'mp3', audioStart };

  // Last resort: trust the extension.
  const extension = extensionOf(filename);
  if (extension === 'mp3') return { container: 'mp3', audioStart };
  if (extension === 'flac') return { container: 'flac', audioStart };
  if (extension === 'ogg' || extension === 'oga' || extension === 'opus') {
    return { container: 'ogg', audioStart };
  }
  if (extension === 'm4a' || extension === 'm4b' || extension === 'mp4' || extension === 'aac') {
    return { container: extension === 'aac' ? 'aac-adts' : 'mp4', audioStart };
  }
  if (extension === 'wav' || extension === 'wave') return { container: 'wav', audioStart: 0 };
  if (extension === 'aif' || extension === 'aiff' || extension === 'aifc') {
    return { container: 'aiff', audioStart: 0 };
  }
  return { container: 'unknown', audioStart };
}

function unknownStream(format: AudioFormat): StreamInfo {
  return {
    format,
    codec: format.toUpperCase(),
    durationMs: 0,
    bitrateKbps: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    lossless: format === 'flac' || format === 'wav' || format === 'aiff' || format === 'alac',
  };
}

/**
 * Read tags and stream properties from an audio file.
 *
 * Never throws: a file that cannot be parsed comes back with empty tags, a zero
 * duration and a warning, so the scanner can still add it to the library as a
 * playable-but-untagged track. The player derives real duration from the
 * decoder at playback time, so even a zero here is recoverable.
 */
export async function parseAudioFile(blob: Blob, filename: string): Promise<ParsedAudio> {
  const source = new BlobByteSource(blob);
  const tags: RawTags = emptyTags();
  const warnings: string[] = [];

  let container: Container = 'unknown';
  let audioStart = 0;
  try {
    const detected = await detect(source, filename);
    container = detected.container;
    audioStart = detected.audioStart;
  } catch (error) {
    warnings.push(`format detection failed: ${String(error)}`);
  }

  try {
    switch (container) {
      case 'mp3': {
        const id3v2 = await parseId3v2(source, tags);
        if (id3v2) warnings.push(...id3v2.warnings);

        // ID3v1 lives in the last 128 bytes and must be excluded from the audio
        // byte count, or every duration would be very slightly long.
        const hadId3v1 = await parseId3v1(source, tags);
        const audioEnd = source.size - (hadId3v1 ? 128 : 0);

        const stream = await readMpegStreamInfo(source, audioStart, audioEnd);
        if (stream.durationMs === 0) warnings.push('no readable MPEG frame found');
        return { tags, stream, warnings };
      }

      case 'flac': {
        // A FLAC may carry an ID3v2 tag in front; read it, but Vorbis comments win.
        if (audioStart > 0) await parseId3v2(source, tags);
        const { stream, warnings: flacWarnings } = await parseFlac(source, tags, audioStart);
        warnings.push(...flacWarnings);
        return { tags, stream, warnings };
      }

      case 'ogg': {
        const { stream, warnings: oggWarnings } = await parseOgg(source, tags);
        warnings.push(...oggWarnings);
        return { tags, stream, warnings };
      }

      case 'mp4': {
        const { stream, warnings: mp4Warnings } = await parseMp4(source, tags);
        warnings.push(...mp4Warnings);
        return { tags, stream, warnings };
      }

      case 'wav': {
        const result = await parseWav(source, tags);
        warnings.push(...result.warnings);
        // Prefer a proper ID3 chunk over the sparse LIST/INFO tags.
        if (result.id3Chunk) {
          await parseId3v2(new OffsetSource(source, result.id3Chunk.at), tags);
        }
        return { tags, stream: result.stream, warnings };
      }

      case 'aiff': {
        const result = await parseAiff(source, tags);
        warnings.push(...result.warnings);
        if (result.id3Chunk) {
          await parseId3v2(new OffsetSource(source, result.id3Chunk.at), tags);
        }
        return { tags, stream: result.stream, warnings };
      }

      case 'aac-adts': {
        // Raw ADTS has no duration field and no tag chain. The browser's decoder
        // will report the real duration on first play; until then the track is
        // listed with what the filename tells us, which is honest.
        await parseId3v2(source, tags);
        await parseId3v1(source, tags);
        warnings.push('raw AAC stream: duration is determined at playback');
        return { tags, stream: unknownStream('aac'), warnings };
      }

      default: {
        warnings.push('unrecognised audio format');
        return { tags, stream: unknownStream('unknown'), warnings };
      }
    }
  } catch (error) {
    // A parser bug or a truncated file must not lose the track.
    warnings.push(`metadata parse failed: ${String(error)}`);
    return { tags, stream: unknownStream(containerToFormat(container)), warnings };
  }
}

function containerToFormat(container: Container): AudioFormat {
  switch (container) {
    case 'mp3':
      return 'mp3';
    case 'flac':
      return 'flac';
    case 'ogg':
      return 'ogg';
    case 'mp4':
      return 'm4a';
    case 'wav':
      return 'wav';
    case 'aiff':
      return 'aiff';
    case 'aac-adts':
      return 'aac';
    default:
      return 'unknown';
  }
}

/** Shifts a `ByteSource` so a nested chunk can be parsed as if it were a file. */
class OffsetSource implements ByteSource {
  readonly size: number;
  constructor(
    private readonly inner: ByteSource,
    private readonly offset: number,
  ) {
    this.size = Math.max(0, inner.size - offset);
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(this.offset + offset, length);
  }
}

export type { ParsedAudio, RawPicture, RawTags, StreamInfo } from './types';
