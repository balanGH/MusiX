/**
 * Synthetic audio files.
 *
 * The parsers are tested against bytes assembled here rather than against
 * checked-in binaries: the fixtures stay readable, the repository stays small,
 * and each test can construct exactly the edge case it is about (a UTF-16 tag,
 * an unsynchronised frame, a multi-disc track number).
 */

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

export function u24be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** The 28-bit "synchsafe" integer ID3v2 uses for sizes. */
export function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

export interface Id3Frame {
  id: string;
  /** Raw frame body, including any encoding byte. */
  body: Uint8Array;
}

/** A latin1 text frame: encoding byte 0x00 followed by the text. */
export function textFrame(id: string, text: string): Id3Frame {
  return { id, body: concat(new Uint8Array([0x00]), ascii(text)) };
}

/** A UTF-16 text frame with a byte-order mark, as iTunes writes. */
export function utf16Frame(id: string, text: string): Id3Frame {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return { id, body: concat(new Uint8Array([0x01]), bytes) };
}

/** A `TXXX` user-defined frame. */
export function txxxFrame(description: string, value: string): Id3Frame {
  return {
    id: 'TXXX',
    body: concat(new Uint8Array([0x00]), ascii(description), new Uint8Array([0x00]), ascii(value)),
  };
}

/** An `APIC` picture frame carrying a minimal PNG-like payload. */
export function apicFrame(mime: string, pictureType: number, size = 256): Id3Frame {
  const payload = new Uint8Array(size);
  // A real PNG signature, so anything sniffing the bytes sees an image.
  payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  payload.fill(0x7f, 8);
  return {
    id: 'APIC',
    body: concat(
      new Uint8Array([0x00]), // encoding
      ascii(mime),
      new Uint8Array([0x00]), // mime terminator
      new Uint8Array([pictureType]),
      ascii('cover'),
      new Uint8Array([0x00]), // description terminator
      payload,
    ),
  };
}

export interface Id3Options {
  version?: 3 | 4;
  /** Apply tag-level unsynchronisation. */
  unsynchronised?: boolean;
}

export function buildId3v2(frames: Id3Frame[], options: Id3Options = {}): Uint8Array {
  const version = options.version ?? 3;

  const encodedFrames = frames.map((frame) =>
    concat(
      ascii(frame.id.padEnd(4, ' ').slice(0, 4)),
      // v2.3 uses a plain 32-bit size; v2.4 uses synchsafe.
      version === 4 ? synchsafe(frame.body.length) : u32be(frame.body.length),
      new Uint8Array([0x00, 0x00]), // frame flags
      frame.body,
    ),
  );

  let body = concat(...encodedFrames);
  if (options.unsynchronised) body = applyUnsynchronisation(body);

  return concat(
    ascii('ID3'),
    new Uint8Array([version, 0x00]),
    new Uint8Array([options.unsynchronised ? 0x80 : 0x00]),
    synchsafe(body.length),
    body,
  );
}

/** Insert a 0x00 after every 0xFF, which is what encoders do. */
function applyUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const byte of bytes) {
    out.push(byte);
    if (byte === 0xff) out.push(0x00);
  }
  return new Uint8Array(out);
}

/** The 128-byte tag at the end of an older MP3. */
export function buildId3v1(fields: {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  track?: number;
  genre?: number;
}): Uint8Array {
  const tag = new Uint8Array(128);
  tag.set(ascii('TAG'), 0);
  tag.set(ascii((fields.title ?? '').slice(0, 30)), 3);
  tag.set(ascii((fields.artist ?? '').slice(0, 30)), 33);
  tag.set(ascii((fields.album ?? '').slice(0, 30)), 63);
  tag.set(ascii((fields.year ?? '').slice(0, 4)), 93);
  if (fields.track !== undefined) {
    // ID3v1.1 puts the track number in the last two comment bytes.
    tag[125] = 0;
    tag[126] = fields.track;
  }
  tag[127] = fields.genre ?? 255;
  return tag;
}

// ---------------------------------------------------------------------------
// MPEG audio
// ---------------------------------------------------------------------------

/**
 * MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo.
 *
 * Frame length works out at 417 bytes, which is what the parser must derive
 * for its own frame-chain validation to succeed.
 */
export const MP3_FRAME_HEADER = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
export const MP3_FRAME_LENGTH = 417;

export function mp3Frames(count: number): Uint8Array {
  const out = new Uint8Array(MP3_FRAME_LENGTH * count);
  for (let i = 0; i < count; i++) {
    out.set(MP3_FRAME_HEADER, i * MP3_FRAME_LENGTH);
    // Fill the payload with something that is not another sync word.
    out.fill(0x55, i * MP3_FRAME_LENGTH + 4, (i + 1) * MP3_FRAME_LENGTH);
  }
  return out;
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  totalSamples: number;
}

function flacStreamInfoBlock(info: FlacStreamInfo): Uint8Array {
  const block = new Uint8Array(34);
  // min/max block size, min/max frame size — not read by the parser.
  block.set([0x10, 0x00, 0x10, 0x00], 0);

  // Bit-packed from byte 10: 20 bits sample rate, 3 bits channels-1,
  // 5 bits depth-1, 36 bits total samples.
  const rate = info.sampleRate;
  block[10] = (rate >>> 12) & 0xff;
  block[11] = (rate >>> 4) & 0xff;
  block[12] = ((rate & 0x0f) << 4) | (((info.channels - 1) & 0x07) << 1) | (((info.bitDepth - 1) >> 4) & 0x01);
  block[13] = (((info.bitDepth - 1) & 0x0f) << 4) | ((info.totalSamples / 0x100000000) & 0x0f);

  const low = info.totalSamples % 0x100000000;
  block[14] = (low >>> 24) & 0xff;
  block[15] = (low >>> 16) & 0xff;
  block[16] = (low >>> 8) & 0xff;
  block[17] = low & 0xff;
  return block;
}

/** `KEY=value` entries, little-endian length-prefixed. */
export function vorbisComments(entries: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const vendor = encoder.encode('MusiX test fixture');
  const encoded = entries.map((entry) => {
    const bytes = encoder.encode(entry);
    return concat(u32le(bytes.length), bytes);
  });
  return concat(u32le(vendor.length), vendor, u32le(entries.length), ...encoded);
}

export function buildFlac(info: FlacStreamInfo, comments: string[], audioBytes = 4096): Uint8Array {
  const streamInfo = flacStreamInfoBlock(info);
  const commentBlock = vorbisComments(comments);

  return concat(
    ascii('fLaC'),
    // STREAMINFO — type 0, not last.
    new Uint8Array([0x00]),
    u24be(streamInfo.length),
    streamInfo,
    // VORBIS_COMMENT — type 4, last block (high bit set).
    new Uint8Array([0x84]),
    u24be(commentBlock.length),
    commentBlock,
    new Uint8Array(audioBytes),
  );
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

export function buildWav(options: {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  dataBytes: number;
  title?: string;
}): Uint8Array {
  const byteRate = (options.sampleRate * options.channels * options.bitDepth) / 8;

  const fmt = concat(
    ascii('fmt '),
    u32le(16),
    new Uint8Array([0x01, 0x00]), // PCM
    new Uint8Array([options.channels & 0xff, 0x00]),
    u32le(options.sampleRate),
    u32le(byteRate),
    new Uint8Array([((options.channels * options.bitDepth) / 8) & 0xff, 0x00]),
    new Uint8Array([options.bitDepth & 0xff, 0x00]),
  );

  const info = options.title
    ? concat(
        ascii('LIST'),
        u32le(4 + 8 + options.title.length + (options.title.length % 2)),
        ascii('INFO'),
        ascii('INAM'),
        u32le(options.title.length),
        ascii(options.title),
        ...(options.title.length % 2 ? [new Uint8Array([0])] : []),
      )
    : new Uint8Array(0);

  const data = concat(ascii('data'), u32le(options.dataBytes), new Uint8Array(options.dataBytes));
  const body = concat(ascii('WAVE'), fmt, info, data);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/**
 * Wrap bytes in a Blob, which is what the parsers actually take.
 *
 * `.slice()` rather than passing the view directly: a bare `Uint8Array` is
 * generic over `ArrayBufferLike`, which includes `SharedArrayBuffer` and so is
 * not a valid `BlobPart`. Slicing copies into a plain `ArrayBuffer`.
 */
export function toBlob(bytes: Uint8Array, type = 'audio/mpeg'): Blob {
  return new Blob([bytes.slice()], { type });
}
