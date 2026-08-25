/**
 * Shared helpers.
 *
 * Small functions, but several of them decide how the whole library is
 * organised — `hashId` must be stable forever, and `splitArtists` decides who
 * gets an artist page.
 */

import { describe, expect, it } from 'vitest';
import {
  chunk,
  dbToGain,
  formatBytes,
  formatDuration,
  formatDurationLong,
  formatQuality,
  gainToDb,
  hashBytes,
  hashId,
  mapLimit,
  seededRandom,
  shuffle,
  sliderToGain,
  sortKey,
  splitArtists,
  splitGenres,
  throttle,
  titleFromFilename,
} from '@core/utils';

describe('hashing', () => {
  it('is stable, which track ids depend on forever', () => {
    // If this ever changes, every user's library re-imports as new tracks and
    // loses its play counts. It is effectively a storage format.
    expect(hashId('track:src-1:Artist/Album/01.flac')).toBe(
      hashId('track:src-1:Artist/Album/01.flac'),
    );
    expect(hashId('a')).not.toBe(hashId('b'));
    expect(hashId('')).toHaveLength(16);
  });

  it('does not collide across a realistic library', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      ids.add(hashId(`track:source:Artist ${i % 900}/Album ${i % 90}/${i} title.flac`));
    }
    expect(ids.size).toBe(50_000);
  });

  it('hashes bytes so identical artwork is stored once', () => {
    const a = new Uint8Array(2048).fill(7);
    const b = new Uint8Array(2048).fill(7);
    const c = new Uint8Array(2048).fill(8);

    expect(hashBytes(a)).toBe(hashBytes(b));
    expect(hashBytes(a)).not.toBe(hashBytes(c));
    // Length is part of the key, so a truncated copy is a different image.
    expect(hashBytes(a)).not.toBe(hashBytes(a.slice(0, 1024)));
  });
});

describe('sorting keys', () => {
  it('drops a leading article', () => {
    expect(sortKey('The Beatles')).toBe('beatles');
    expect(sortKey('A Love Supreme')).toBe('love supreme');
    // Not an article — a word that merely starts with one.
    expect(sortKey('Theatre of Tragedy')).toBe('theatre of tragedy');
  });

  it('folds accents so search and sorting agree', () => {
    expect(sortKey('Björk')).toBe('bjork');
    expect(sortKey('Sigur Rós')).toBe('sigur ros');
  });
});

describe('splitting credits', () => {
  it('separates featured artists', () => {
    expect(splitArtists('Burial feat. Thom Yorke')).toEqual(['Burial', 'Thom Yorke']);
    expect(splitArtists('Artist A ft Artist B')).toEqual(['Artist A', 'Artist B']);
    expect(splitArtists('Someone featuring Another')).toEqual(['Someone', 'Another']);
    expect(splitArtists('Artist A; Artist B')).toEqual(['Artist A', 'Artist B']);
    expect(splitArtists('Artist A / Artist B')).toEqual(['Artist A', 'Artist B']);
  });

  it('leaves ampersands and commas alone, because acts contain them', () => {
    // Splitting these would invent artists like "the Machine" and "Nash".
    expect(splitArtists('Simon & Garfunkel')).toEqual(['Simon & Garfunkel']);
    expect(splitArtists('Florence and the Machine')).toEqual(['Florence and the Machine']);
    expect(splitArtists('Crosby, Stills & Nash')).toEqual(['Crosby, Stills & Nash']);
  });

  it('does not split a slash that is part of a number', () => {
    expect(splitArtists('Foo 1/2 Bar')).toEqual(['Foo 1/2 Bar']);
  });

  it('always returns something for a non-empty credit', () => {
    expect(splitArtists('Someone')).toEqual(['Someone']);
    expect(splitArtists('')).toEqual([]);
  });

  it('splits genres on the separators tags actually use', () => {
    expect(splitGenres('Rock; Alternative')).toEqual(['Rock', 'Alternative']);
    expect(splitGenres('Rock/Pop')).toEqual(['Rock', 'Pop']);
    // A two-word genre stays whole.
    expect(splitGenres('Hip Hop')).toEqual(['Hip Hop']);
    expect(splitGenres('Unknown')).toEqual([]);
  });
});

describe('titles from filenames', () => {
  it('strips a leading track number and tidies separators', () => {
    expect(titleFromFilename('04 - Paranoid Android.flac')).toBe('Paranoid Android');
    expect(titleFromFilename('01. Intro.mp3')).toBe('Intro');
    expect(titleFromFilename('my_song_here.wav')).toBe('my song here');
  });

  it('never returns an empty string', () => {
    expect(titleFromFilename('01.mp3')).toBe('01');
    expect(titleFromFilename('.flac')).not.toBe('');
  });
});

describe('formatting', () => {
  it('formats durations the way a player should', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(187_000)).toBe('3:07');
    expect(formatDuration(3_753_000)).toBe('1:02:33');
    expect(formatDuration(Number.NaN)).toBe('--:--');
    expect(formatDuration(-1)).toBe('--:--');
  });

  it('formats aggregate durations in words', () => {
    expect(formatDurationLong(120_000)).toBe('2 min');
    expect(formatDurationLong(3_600_000)).toBe('1 hr');
    expect(formatDurationLong(15_120_000)).toBe('4 hr 12 min');
    expect(formatDurationLong(200_000_000)).toContain('d');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('describes audio quality', () => {
    expect(
      formatQuality({ format: 'flac', bitrateKbps: 1411, sampleRate: 44100, bitDepth: 16 }),
    ).toBe('FLAC · 1411 kbps · 44.1 kHz · 16-bit');
    // A lossy file has no meaningful bit depth, and says nothing rather than lying.
    expect(formatQuality({ format: 'mp3', bitrateKbps: 320, sampleRate: 44100, bitDepth: null })).toBe(
      'MP3 · 320 kbps · 44.1 kHz',
    );
  });
});

describe('gain maths', () => {
  it('converts between decibels and linear gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(gainToDb(dbToGain(-7.15))).toBeCloseTo(-7.15, 4);
  });

  it('uses a perceptual volume curve', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(1)).toBe(1);
    // Half-way on the slider is much quieter than half the amplitude, which is
    // what makes a volume control feel linear to the ear.
    expect(sliderToGain(0.5)).toBeLessThan(0.2);
  });
});

describe('collections and scheduling', () => {
  it('chunks arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it('shuffles reproducibly from a seed', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom(42));
    const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom(42));
    expect(a).toEqual(b);
    expect(a.slice().sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('bounds concurrency while preserving order', async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async (value) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return value * 2;
    });

    // This is what stops a 100k-file scan from opening 100k files at once.
    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it('throttles, and flushes the pending call', async () => {
    const seen: number[] = [];
    const throttled = throttle((value: number) => seen.push(value), 50);

    throttled(1);
    throttled(2);
    throttled(3);
    // The leading call goes through immediately.
    expect(seen).toEqual([1]);

    throttled.flush();
    // The most recent pending value is not lost — which is why a scan's final
    // progress update always arrives.
    expect(seen).toEqual([1, 3]);
  });
});
