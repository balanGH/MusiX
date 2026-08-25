/**
 * Byte plumbing for the tag parsers.
 *
 * The important idea here is `ByteSource`: parsers pull the ranges they need
 * instead of being handed the whole file. A 60 MB FLAC has its tags in the
 * first few kilobytes, and an M4A keeps `moov` at either end — reading whole
 * files to find that out would make scanning a large library both slow and
 * memory-hungry (spec §4, §35).
 *
 * `ByteReader` is the synchronous cursor used once a range is in hand.
 */

/** Random-access, read-only view over a file. */
export interface ByteSource {
  readonly size: number;
  /** Returns at most `length` bytes; short reads at EOF are not an error. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * `ByteSource` over a Blob/File.
 *
 * Keeps one cached window because parsers overwhelmingly read forwards in small
 * steps: without it, walking 40 MP4 atoms would mean 40 separate slice reads.
 */
export class BlobByteSource implements ByteSource {
  readonly size: number;
  private cacheStart = -1;
  private cache: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly blob: Blob,
    private readonly windowSize = 128 * 1024,
  ) {
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length <= 0 || offset >= this.size) return new Uint8Array(0);
    const end = Math.min(offset + length, this.size);

    if (this.cacheStart >= 0 && offset >= this.cacheStart) {
      const cacheEnd = this.cacheStart + this.cache.length;
      if (end <= cacheEnd) {
        return this.cache.subarray(offset - this.cacheStart, end - this.cacheStart);
      }
    }

    // Requests larger than the window bypass the cache entirely (embedded
    // artwork, typically), so one huge cover cannot evict everything useful.
    if (end - offset > this.windowSize) {
      return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
    }

    const windowEnd = Math.min(offset + this.windowSize, this.size);
    this.cache = new Uint8Array(await this.blob.slice(offset, windowEnd).arrayBuffer());
    this.cacheStart = offset;
    return this.cache.subarray(0, end - offset);
  }
}

/** In-memory `ByteSource`, used by the tests and by the OPFS import path. */
export class BufferByteSource implements ByteSource {
  readonly size: number;
  constructor(private readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset >= this.size) return new Uint8Array(0);
    return this.bytes.subarray(offset, Math.min(offset + length, this.size));
  }
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: false });
const utf16le = new TextDecoder('utf-16le', { fatal: false });
const utf16be = new TextDecoder('utf-16be', { fatal: false });

/** Synchronous big/little-endian cursor over a fetched range. */
export class ByteReader {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  get exhausted(): boolean {
    return this.offset >= this.bytes.length;
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    this.offset += count;
    return this;
  }

  /** Throws only on a programming error; callers guard with `remaining`. */
  private require(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new RangeError(
        `read past end: need ${count} at ${this.offset} of ${this.bytes.length}`,
      );
    }
  }

  u8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  u16be(): number {
    this.require(2);
    const value = (this.bytes[this.offset]! << 8) | this.bytes[this.offset + 1]!;
    this.offset += 2;
    return value;
  }

  u16le(): number {
    this.require(2);
    const value = this.bytes[this.offset]! | (this.bytes[this.offset + 1]! << 8);
    this.offset += 2;
    return value;
  }

  u24be(): number {
    this.require(3);
    const value =
      (this.bytes[this.offset]! << 16) |
      (this.bytes[this.offset + 1]! << 8) |
      this.bytes[this.offset + 2]!;
    this.offset += 3;
    return value;
  }

  /** Unsigned: `>>> 0` matters, sizes above 2 GiB would otherwise go negative. */
  u32be(): number {
    this.require(4);
    const value =
      ((this.bytes[this.offset]! << 24) |
        (this.bytes[this.offset + 1]! << 16) |
        (this.bytes[this.offset + 2]! << 8) |
        this.bytes[this.offset + 3]!) >>>
      0;
    this.offset += 4;
    return value;
  }

  u32le(): number {
    this.require(4);
    const value =
      (this.bytes[this.offset]! |
        (this.bytes[this.offset + 1]! << 8) |
        (this.bytes[this.offset + 2]! << 16) |
        (this.bytes[this.offset + 3]! << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  /** 64-bit as a JS number. Safe: file offsets never approach 2^53. */
  u64be(): number {
    const high = this.u32be();
    const low = this.u32be();
    return high * 0x100000000 + low;
  }

  bytesOf(count: number): Uint8Array {
    const clamped = Math.max(0, Math.min(count, this.remaining));
    const slice = this.bytes.subarray(this.offset, this.offset + clamped);
    this.offset += clamped;
    return slice;
  }

  /** Fixed-length ASCII, e.g. a four-character chunk id. */
  ascii(count: number): string {
    return latin1.decode(this.bytesOf(count));
  }

  peekAscii(count: number): string {
    return latin1.decode(this.bytes.subarray(this.offset, this.offset + count));
  }

  /**
   * ID3v2.4 and friends store an "extended-format" 28-bit integer with the top
   * bit of each byte cleared, so that a size can never be mistaken for a frame
   * sync pattern.
   */
  synchsafe32(): number {
    this.require(4);
    const b = this.bytes;
    const o = this.offset;
    this.offset += 4;
    return ((b[o]! & 0x7f) << 21) | ((b[o + 1]! & 0x7f) << 14) | ((b[o + 2]! & 0x7f) << 7) | (b[o + 3]! & 0x7f);
  }
}

/** Trailing NULs are padding, not content. */
// eslint-disable-next-line no-control-regex
const TRAILING_NULS = /\u0000+$/g;

/** Control characters no tag value should carry. Tab, CR and LF survive, for lyrics. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip padding and control characters that tag writers leave behind. */
export function tidy(value: string): string {
  return value.replace(TRAILING_NULS, '').replace(CONTROL_CHARS, '').trim();
}

export type TextEncodingId = 0 | 1 | 2 | 3;

/**
 * Decode an ID3v2 text value.
 *
 * Encoding 0 is nominally ISO-8859-1, but a great many taggers wrote UTF-8
 * bytes there anyway. If the bytes are valid UTF-8 *and* contain a multi-byte
 * sequence, UTF-8 is the better guess; otherwise latin1 round-trips safely.
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncodingId): string {
  switch (encoding) {
    case 1: {
      // UTF-16 with a byte-order mark.
      if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return tidy(utf16le.decode(bytes.subarray(2)));
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return tidy(utf16be.decode(bytes.subarray(2)));
      }
      return tidy(utf16le.decode(bytes));
    }
    case 2:
      return tidy(utf16be.decode(bytes));
    case 3:
      return tidy(utf8.decode(bytes));
    case 0:
    default: {
      if (looksLikeUtf8(bytes)) return tidy(utf8.decode(bytes));
      return tidy(latin1.decode(bytes));
    }
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return tidy(utf8.decode(bytes));
}

export function decodeLatin1(bytes: Uint8Array): string {
  return tidy(latin1.decode(bytes));
}

/**
 * Decode without tidying.
 *
 * Chunk and atom identifiers are fixed-width and significant to the last byte —
 * `"fmt "` in a WAV file is four characters, and trimming it to `"fmt"` makes
 * the chunk unrecognisable. Use this for identifiers, `decodeLatin1` for text.
 */
export function decodeIdentifier(bytes: Uint8Array): string {
  return latin1.decode(bytes);
}

/** True only if there is at least one valid multi-byte sequence and no invalid one. */
function looksLikeUtf8(bytes: Uint8Array): boolean {
  let multiByte = false;
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    if (byte < 0x80) {
      i++;
      continue;
    }
    let extra: number;
    if (byte >= 0xc2 && byte <= 0xdf) extra = 1;
    else if (byte >= 0xe0 && byte <= 0xef) extra = 2;
    else if (byte >= 0xf0 && byte <= 0xf4) extra = 3;
    else return false;
    if (i + extra >= bytes.length) return false;
    for (let k = 1; k <= extra; k++) {
      const cont = bytes[i + k]!;
      if (cont < 0x80 || cont > 0xbf) return false;
    }
    multiByte = true;
    i += extra + 1;
  }
  return multiByte;
}

/** Index of the terminator for a string in the given encoding, or -1. */
export function findTerminator(bytes: Uint8Array, from: number, encoding: TextEncodingId): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
    return -1;
  }
  for (let i = from; i < bytes.length; i++) if (bytes[i] === 0) return i;
  return -1;
}

export function bytesStartWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return false;
  return true;
}
