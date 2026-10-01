/**
 * Regression tests for the tag-parser fixes in docs/REVIEW.md ("Library,
 * database, metadata" items 8–11): large Ogg comment packets, chaptered MP4s,
 * ID3v2.4 tag-level unsynchronisation, and cross-format tag precedence.
 */

import { describe, expect, it } from 'vitest';
import { parseAudioFile } from '@core/metadata';
import {
  ascii,
  buildFlac,
  buildId3v1,
  buildId3v2,
  buildWav,
  concat,
  mp3Frames,
  synchsafe,
  textFrame,
  toBlob,
  u32be,
  u32le,
  vorbisComments,
  type Id3Frame,
} from './fixtures';

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

function oggPage(headerType: number, granule: number, segments: number[], body: Uint8Array): Uint8Array {
  return concat(
    ascii('OggS'),
    new Uint8Array([0, headerType]),
    u32le(granule),
    u32le(0),
    u32le(1), // serial
    u32le(0), // sequence (not checked)
    u32le(0), // CRC (not checked)
    new Uint8Array([segments.length]),
    new Uint8Array(segments),
    body,
  );
}

/** Split one packet across as many pages as its lacing needs. */
function oggPacketPages(packet: Uint8Array, granule = 0): Uint8Array[] {
  const lacing: number[] = [];
  for (let left = packet.length; ; left -= 255) {
    if (left >= 255) lacing.push(255);
    else {
      lacing.push(left);
      break;
    }
  }
  const pages: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < lacing.length; i += 255) {
    const segments = lacing.slice(i, i + 255);
    const size = segments.reduce((sum, value) => sum + value, 0);
    pages.push(oggPage(i === 0 ? 0 : 0x01, granule, segments, packet.subarray(offset, offset + size)));
    offset += size;
  }
  return pages;
}

function buildOpus(comments: string[]): Uint8Array {
  const head = concat(
    ascii('OpusHead'),
    new Uint8Array([1, 2]), // version, channels
    new Uint8Array([0x38, 0x01]), // pre-skip 312
    u32le(48000),
    new Uint8Array([0, 0, 0]),
  );
  const tags = concat(ascii('OpusTags'), vorbisComments(comments));
  return concat(
    ...oggPacketPages(head),
    ...oggPacketPages(tags),
    // One audio page whose granule gives 10 s after pre-skip.
    oggPage(0x04, 48000 * 10 + 312, [100], new Uint8Array(100)),
  );
}

/** A base64 METADATA_BLOCK_PICTURE of `size` image bytes. */
function pictureComment(size: number): string {
  const image = new Uint8Array(size).fill(0x7f);
  image.set([0x89, 0x50, 0x4e, 0x47], 0);
  const block = concat(
    u32be(3),
    u32be(9),
    ascii('image/png'),
    u32be(0),
    new Uint8Array(16),
    u32be(image.length),
    image,
  );
  let binary = '';
  for (const byte of block) binary += String.fromCharCode(byte);
  return `METADATA_BLOCK_PICTURE=${btoa(binary)}`;
}

describe('Ogg / Opus', () => {
  it('keeps a >128 KB cover and every tag after it', async () => {
    const bytes = buildOpus([
      'TITLE=Before',
      pictureComment(300 * 1024),
      'ARTIST=After The Cover',
      'ALBUM=Still Here',
    ]);
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/ogg'), 'big.opus');

    expect(parsed.stream.codec).toBe('Opus');
    expect(parsed.tags.title).toBe('Before');
    expect(parsed.tags.artist).toBe('After The Cover');
    expect(parsed.tags.album).toBe('Still Here');
    expect(parsed.tags.pictures).toHaveLength(1);
    expect(parsed.tags.pictures[0]!.data.length).toBe(300 * 1024);
    expect(parsed.stream.durationMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------

function atom(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(...children);
  return concat(u32be(8 + body.length), ascii(type), body);
}

function trak(handler: string, format: string, timescale: number, duration: number): Uint8Array {
  const hdlr = atom('hdlr', new Uint8Array(8), ascii(handler), new Uint8Array(12), new Uint8Array([0]));
  const mdhd = atom('mdhd', new Uint8Array(4), new Uint8Array(8), u32be(timescale), u32be(duration), new Uint8Array(4));
  const entry = concat(
    new Uint8Array(6 + 2 + 8),
    new Uint8Array([0, 2]), // channels
    new Uint8Array([0, 16]), // sample size
    new Uint8Array(4),
    u32be(timescale << 16),
  );
  const stsd = atom('stsd', new Uint8Array(4), u32be(1), u32be(8 + 4 + entry.length), ascii(format), entry);
  return atom('trak', atom('mdia', mdhd, hdlr, atom('minf', atom('stbl', stsd))));
}

describe('MP4', () => {
  it('reads the sound trak, not the chapter trak that follows it', async () => {
    const bytes = concat(
      atom('ftyp', ascii('M4B '), u32be(0)),
      atom(
        'moov',
        trak('soun', 'mp4a', 44100, 44100 * 60),
        trak('text', 'text', 1000, 5_000),
      ),
    );
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/mp4'), 'book.m4b');

    expect(parsed.stream.codec).toBe('AAC');
    expect(parsed.stream.durationMs).toBe(60_000);
    expect(parsed.stream.sampleRate).toBe(44100);
  });
});

// ---------------------------------------------------------------------------
// ID3v2.4 unsynchronisation
// ---------------------------------------------------------------------------

function unsync(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const byte of bytes) {
    out.push(byte);
    if (byte === 0xff) out.push(0x00);
  }
  return new Uint8Array(out);
}

describe('ID3v2.4', () => {
  it('undoes tag-level unsynchronisation exactly once', async () => {
    // A JPEG-ish payload containing FF 00: decoded twice it would lose the 00.
    const image = new Uint8Array(128).fill(0x11);
    image.set([0xff, 0xd8, 0xff, 0x00, 0x00, 0xff, 0x00], 0);
    const apic: Id3Frame = {
      id: 'APIC',
      body: concat(
        new Uint8Array([0x00]),
        ascii('image/jpeg'),
        new Uint8Array([0x00, 0x03]),
        new Uint8Array([0x00]), // empty description
        image,
      ),
    };
    // v2.4 unsynchronises per frame: each frame carries flag 0x0002 and its
    // on-disk (post-unsync) size, and the header flag says "all frames".
    const frame = (f: Id3Frame) => {
      const body = unsync(f.body);
      return concat(ascii(f.id), synchsafe(body.length), new Uint8Array([0x00, 0x02]), body);
    };
    const frames = concat(frame(textFrame('TIT2', 'Unsynced')), frame(apic));
    const bytes = concat(
      ascii('ID3'),
      new Uint8Array([4, 0, 0x80]),
      synchsafe(frames.length),
      frames,
      mp3Frames(10),
    );
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');

    expect(parsed.tags.title).toBe('Unsynced');
    expect(parsed.tags.pictures).toHaveLength(1);
    expect([...parsed.tags.pictures[0]!.data]).toEqual([...image]);
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('tag precedence', () => {
  it('MP3: the ID3v2 genre wins; ID3v1 does not append its own', async () => {
    const bytes = concat(
      buildId3v2([textFrame('TIT2', 'x'), textFrame('TCON', 'Shoegaze')]),
      mp3Frames(10),
      buildId3v1({ title: 'x', genre: 17 }), // Rock
    );
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');
    expect(parsed.tags.genre).toEqual(['Shoegaze']);
  });

  it('FLAC: Vorbis comments beat a leading ID3 tag, which only fills gaps', async () => {
    const bytes = concat(
      buildId3v2([textFrame('TIT2', 'ID3 Title'), textFrame('TCON', 'Pop'), textFrame('TALB', 'ID3 Album')]),
      buildFlac({ sampleRate: 44100, channels: 2, bitDepth: 16, totalSamples: 44100 }, [
        'TITLE=Vorbis Title',
        'GENRE=Ambient',
      ]),
    );
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/flac'), 'x.flac');
    expect(parsed.tags.title).toBe('Vorbis Title');
    expect(parsed.tags.genre).toEqual(['Ambient']);
    expect(parsed.tags.album).toBe('ID3 Album');
  });

  it('WAV: an ID3 chunk beats LIST/INFO', async () => {
    const wav = buildWav({ sampleRate: 8000, channels: 1, bitDepth: 8, dataBytes: 800, title: 'Info Title' });
    const id3 = buildId3v2([textFrame('TIT2', 'ID3 Title'), textFrame('TPE1', 'ID3 Artist')]);
    const chunk = concat(ascii('id3 '), u32le(id3.length), id3, ...(id3.length % 2 ? [new Uint8Array(1)] : []));
    const body = concat(wav.subarray(8), chunk);
    const bytes = concat(ascii('RIFF'), u32le(body.length), body);

    const parsed = await parseAudioFile(toBlob(bytes, 'audio/wav'), 'x.wav');
    expect(parsed.tags.title).toBe('ID3 Title');
    expect(parsed.tags.artist).toBe('ID3 Artist');
  });

  it('reads the compilation flag', async () => {
    const bytes = concat(buildId3v2([textFrame('TIT2', 'x'), textFrame('TCMP', '1')]), mp3Frames(10));
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');
    expect(parsed.tags.compilation).toBe(true);
  });
});
