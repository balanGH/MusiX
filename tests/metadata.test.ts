/**
 * Tag and stream-property parsing.
 *
 * These are the tests that matter most: if the parsers are wrong, every album,
 * artist and duration in the library is wrong, and the user has no way to tell
 * which part of the app is at fault.
 */

import { describe, expect, it } from 'vitest';
import { parseAudioFile, isSupportedAudioFile } from '@core/metadata';
import { parseFrameHeader } from '@core/metadata/mpeg';
import {
  MP3_FRAME_LENGTH,
  apicFrame,
  buildFlac,
  buildId3v1,
  buildId3v2,
  buildWav,
  concat,
  mp3Frames,
  textFrame,
  toBlob,
  txxxFrame,
  utf16Frame,
} from './fixtures';

describe('format detection', () => {
  it('accepts the formats the spec lists and ignores everything else', () => {
    for (const name of ['a.mp3', 'b.FLAC', 'c.m4a', 'd.opus', 'e.aiff', 'f.wav']) {
      expect(isSupportedAudioFile(name)).toBe(true);
    }
    for (const name of ['cover.jpg', 'album.cue', 'notes.txt', 'noextension']) {
      expect(isSupportedAudioFile(name)).toBe(false);
    }
  });

  it('trusts magic bytes over a wrong extension', async () => {
    // A FLAC that somebody named ".mp3" — common after a careless conversion.
    const flac = buildFlac(
      { sampleRate: 44100, channels: 2, bitDepth: 16, totalSamples: 441000 },
      ['TITLE=Mislabelled'],
    );
    const parsed = await parseAudioFile(toBlob(flac), 'actually-a-flac.mp3');

    expect(parsed.stream.format).toBe('flac');
    expect(parsed.tags.title).toBe('Mislabelled');
  });
});

describe('MPEG frame header', () => {
  it('decodes bitrate, sample rate and frame length', () => {
    const header = parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0);
    expect(header).not.toBeNull();
    expect(header!.bitrateKbps).toBe(128);
    expect(header!.sampleRate).toBe(44100);
    expect(header!.channels).toBe(2);
    expect(header!.frameLength).toBe(MP3_FRAME_LENGTH);
  });

  it('rejects a false sync word', () => {
    // Valid sync bits but a reserved bitrate index (15) — not a real frame.
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeNull();
    // Reserved MPEG version.
    expect(parseFrameHeader(new Uint8Array([0xff, 0xeb, 0x90, 0x00]), 0)).toBeNull();
  });
});

describe('ID3v2', () => {
  it('reads a v2.3 tag and derives duration from the frames after it', async () => {
    const frameCount = 100;
    const bytes = concat(
      buildId3v2([
        textFrame('TIT2', 'Blue Monday'),
        textFrame('TPE1', 'New Order'),
        textFrame('TALB', 'Power, Corruption & Lies'),
        textFrame('TRCK', '4/8'),
        textFrame('TPOS', '1/2'),
        textFrame('TYER', '1983'),
        textFrame('TCON', 'Synth-pop'),
      ]),
      mp3Frames(frameCount),
    );

    const parsed = await parseAudioFile(toBlob(bytes), 'track.mp3');

    expect(parsed.stream.format).toBe('mp3');
    expect(parsed.tags.title).toBe('Blue Monday');
    expect(parsed.tags.artist).toBe('New Order');
    expect(parsed.tags.album).toBe('Power, Corruption & Lies');
    expect(parsed.tags.trackNo).toBe(4);
    expect(parsed.tags.trackTotal).toBe(8);
    expect(parsed.tags.discNo).toBe(1);
    expect(parsed.tags.discTotal).toBe(2);
    expect(parsed.tags.year).toBe(1983);
    expect(parsed.tags.genre).toContain('Synth-pop');

    // 100 frames at 1152 samples / 44100 Hz ≈ 2.61 s. CBR estimation from the
    // byte count lands in the same place.
    expect(parsed.stream.durationMs).toBeGreaterThan(2400);
    expect(parsed.stream.durationMs).toBeLessThan(2800);
    expect(parsed.stream.bitrateKbps).toBe(128);
    expect(parsed.stream.sampleRate).toBe(44100);
  });

  it('resolves a numeric TCON genre reference', async () => {
    const bytes = concat(buildId3v2([textFrame('TCON', '(17)')]), mp3Frames(4));
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');
    // 17 is Rock in the ID3v1 genre table.
    expect(parsed.tags.genre).toEqual(['Rock']);
  });

  it('handles "(17)Hard Rock", which means both', async () => {
    const bytes = concat(buildId3v2([textFrame('TCON', '(17)Hard Rock')]), mp3Frames(4));
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');
    expect(parsed.tags.genre).toEqual(['Rock', 'Hard Rock']);
  });

  it('decodes UTF-16 text with a byte-order mark', async () => {
    const bytes = concat(buildId3v2([utf16Frame('TIT2', 'Björk — Jóga')]), mp3Frames(4));
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');
    expect(parsed.tags.title).toBe('Björk — Jóga');
  });

  it('reads ReplayGain and MusicBrainz ids out of TXXX frames', async () => {
    const bytes = concat(
      buildId3v2([
        txxxFrame('replaygain_track_gain', '-7.15 dB'),
        txxxFrame('replaygain_track_peak', '0.988'),
        txxxFrame('MusicBrainz Album Id', 'abc-123'),
      ]),
      mp3Frames(4),
    );
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');

    expect(parsed.tags.replayGainTrackDb).toBeCloseTo(-7.15, 2);
    expect(parsed.tags.replayGainTrackPeak).toBeCloseTo(0.988, 3);
    expect(parsed.tags.mbReleaseId).toBe('abc-123');
  });

  it('extracts embedded artwork', async () => {
    const bytes = concat(buildId3v2([apicFrame('image/png', 3, 512)]), mp3Frames(4));
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');

    expect(parsed.tags.pictures).toHaveLength(1);
    expect(parsed.tags.pictures[0]!.mime).toBe('image/png');
    expect(parsed.tags.pictures[0]!.pictureType).toBe(3);
    expect(parsed.tags.pictures[0]!.data.length).toBe(512);
  });

  it('reverses tag-level unsynchronisation', async () => {
    // The picture payload is full of 0xFF bytes, which is exactly what
    // unsynchronisation exists to escape.
    const bytes = concat(
      buildId3v2([textFrame('TIT2', 'Unsynchronised'), apicFrame('image/png', 3, 300)], {
        unsynchronised: true,
      }),
      mp3Frames(4),
    );
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');

    expect(parsed.tags.title).toBe('Unsynchronised');
    expect(parsed.tags.pictures).toHaveLength(1);
  });

  it('accepts a v2.4 tag whose frame sizes were written non-synchsafe', async () => {
    // A very common tagger bug: version says 2.4, sizes are plain 32-bit.
    const frames = [textFrame('TIT2', 'Sloppy Tagger'), textFrame('TPE1', 'Some Artist')];
    const tag = buildId3v2(frames, { version: 4 });
    // Overwrite the first frame's size with the plain form.
    const bodyStart = 10;
    const size = frames[0]!.body.length;
    tag[bodyStart + 4] = (size >>> 24) & 0xff;
    tag[bodyStart + 5] = (size >>> 16) & 0xff;
    tag[bodyStart + 6] = (size >>> 8) & 0xff;
    tag[bodyStart + 7] = size & 0xff;

    const parsed = await parseAudioFile(toBlob(concat(tag, mp3Frames(4))), 'x.mp3');
    expect(parsed.tags.title).toBe('Sloppy Tagger');
  });
});

describe('ID3v1', () => {
  it('fills in fields the v2 tag did not provide', async () => {
    const bytes = concat(
      buildId3v2([textFrame('TIT2', 'From v2')]),
      mp3Frames(10),
      buildId3v1({ title: 'From v1', artist: 'Old Artist', year: '1994', track: 7, genre: 17 }),
    );
    const parsed = await parseAudioFile(toBlob(bytes), 'x.mp3');

    // v2 wins where both exist.
    expect(parsed.tags.title).toBe('From v2');
    // v1 fills the gaps.
    expect(parsed.tags.artist).toBe('Old Artist');
    expect(parsed.tags.year).toBe(1994);
    expect(parsed.tags.trackNo).toBe(7);
    expect(parsed.tags.genre).toContain('Rock');
  });

  it('excludes the 128-byte v1 tag from the audio length', async () => {
    const withoutV1 = concat(buildId3v2([]), mp3Frames(50));
    const withV1 = concat(withoutV1, buildId3v1({ title: 'x' }));

    const a = await parseAudioFile(toBlob(withoutV1), 'a.mp3');
    const b = await parseAudioFile(toBlob(withV1), 'b.mp3');

    // Same audio, so the same duration — the trailing tag must not inflate it.
    expect(b.stream.durationMs).toBe(a.stream.durationMs);
  });
});

describe('FLAC', () => {
  it('reads exact stream properties from STREAMINFO', async () => {
    const bytes = buildFlac(
      { sampleRate: 96000, channels: 2, bitDepth: 24, totalSamples: 96000 * 185 },
      ['TITLE=High Res', 'ARTIST=Someone', 'ALBUM=Studio Master'],
    );
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/flac'), 'track.flac');

    expect(parsed.stream.format).toBe('flac');
    expect(parsed.stream.lossless).toBe(true);
    expect(parsed.stream.sampleRate).toBe(96000);
    expect(parsed.stream.channels).toBe(2);
    expect(parsed.stream.bitDepth).toBe(24);
    // Exactly 185 seconds — no estimation involved.
    expect(parsed.stream.durationMs).toBe(185_000);
  });

  it('reads Vorbis comments, including repeated and multi-value fields', async () => {
    const bytes = buildFlac({ sampleRate: 44100, channels: 2, bitDepth: 16, totalSamples: 44100 }, [
      'TITLE=Everything In Its Right Place',
      'ARTIST=Radiohead',
      'ALBUM=Kid A',
      'DATE=2000-10-02',
      'TRACKNUMBER=1',
      'TOTALTRACKS=10',
      'GENRE=Electronic',
      'GENRE=Alternative',
      'REPLAYGAIN_ALBUM_GAIN=-6.42 dB',
    ]);
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/flac'), 'track.flac');

    expect(parsed.tags.title).toBe('Everything In Its Right Place');
    expect(parsed.tags.artist).toBe('Radiohead');
    expect(parsed.tags.date).toBe('2000-10-02');
    expect(parsed.tags.year).toBe(2000);
    expect(parsed.tags.trackNo).toBe(1);
    expect(parsed.tags.trackTotal).toBe(10);
    expect(parsed.tags.genre).toEqual(['Electronic', 'Alternative']);
    expect(parsed.tags.replayGainAlbumDb).toBeCloseTo(-6.42, 2);
  });
});

describe('WAV', () => {
  it('derives duration from the data chunk and the byte rate', async () => {
    const sampleRate = 44100;
    const channels = 2;
    const bitDepth = 16;
    const seconds = 3;
    const dataBytes = sampleRate * channels * (bitDepth / 8) * seconds;

    const bytes = buildWav({ sampleRate, channels, bitDepth, dataBytes, title: 'Test Tone' });
    const parsed = await parseAudioFile(toBlob(bytes, 'audio/wav'), 'tone.wav');

    expect(parsed.stream.format).toBe('wav');
    expect(parsed.stream.lossless).toBe(true);
    expect(parsed.stream.sampleRate).toBe(sampleRate);
    expect(parsed.stream.bitDepth).toBe(bitDepth);
    expect(parsed.stream.durationMs).toBe(seconds * 1000);
    expect(parsed.tags.title).toBe('Test Tone');
  });
});

describe('resilience', () => {
  it('never throws on garbage, and still returns something usable', async () => {
    const garbage = new Uint8Array(4096);
    garbage.fill(0xab);

    const parsed = await parseAudioFile(toBlob(garbage), 'mystery.mp3');

    expect(parsed.stream.durationMs).toBe(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    // The scanner can still import this as a playable-but-untagged track.
    expect(parsed.tags.pictures).toEqual([]);
  });

  it('survives a truncated file', async () => {
    const full = buildFlac({ sampleRate: 44100, channels: 2, bitDepth: 16, totalSamples: 44100 }, [
      'TITLE=Cut Short',
    ]);
    const truncated = full.slice(0, 20);

    const parsed = await parseAudioFile(toBlob(truncated, 'audio/flac'), 'broken.flac');
    expect(parsed.stream.format).toBe('flac');
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});
