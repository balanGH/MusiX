/**
 * LRC parsing and lookup.
 */

import { describe, expect, it } from 'vitest';
import { activeLyricIndex, formatLrc, looksLikeLrc, lyricsFromTag, parseLrc } from '@core/lyrics/lrc';

const SAMPLE = `[ar: Some Artist]
[ti: Some Song]
[offset:-500]
[00:12.50]First line
[00:15.00]Second line
[01:03.25]Third line
[02:00]No fraction`;

describe('detection', () => {
  it('needs two timestamps before treating text as LRC', () => {
    expect(looksLikeLrc(SAMPLE)).toBe(true);
    // A single bracketed number in plain lyrics is not a timed file.
    expect(looksLikeLrc('Just some words\n[00:12.50] a stray marker')).toBe(false);
    expect(looksLikeLrc('Plain lyrics\nwith no timing at all')).toBe(false);
  });
});

describe('parsing', () => {
  it('reads timestamps, metadata and the global offset', () => {
    const parsed = parseLrc(SAMPLE);

    expect(parsed.metadata.ar).toBe('Some Artist');
    expect(parsed.metadata.ti).toBe('Some Song');
    // The offset tag is "shift earlier by N ms", so it is negated then applied.
    expect(parsed.offsetMs).toBe(500);

    expect(parsed.lines).toHaveLength(4);
    expect(parsed.lines[0]).toEqual({ timeMs: 12_500 + 500, text: 'First line' });
    expect(parsed.lines[1]!.timeMs).toBe(15_000 + 500);
    expect(parsed.lines[2]!.timeMs).toBe(63_250 + 500);
    expect(parsed.lines[3]!.timeMs).toBe(120_000 + 500);
  });

  it('treats two fraction digits as centiseconds and three as milliseconds', () => {
    const parsed = parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.125]c');
    expect(parsed.lines[0]!.timeMs).toBe(1500);
    expect(parsed.lines[1]!.timeMs).toBe(2050);
    expect(parsed.lines[2]!.timeMs).toBe(3125);
  });

  it('expands a line carrying several timestamps', () => {
    // A repeated chorus is written once with several stamps.
    const parsed = parseLrc('[00:10.00][01:10.00][02:10.00]Chorus');
    expect(parsed.lines.map((line) => line.timeMs)).toEqual([10_000, 70_000, 130_000]);
    expect(parsed.lines.every((line) => line.text === 'Chorus')).toBe(true);
  });

  it('sorts out-of-order lines', () => {
    const parsed = parseLrc('[00:30.00]later\n[00:10.00]earlier');
    expect(parsed.lines.map((line) => line.text)).toEqual(['earlier', 'later']);
  });

  it('produces plain text with the timestamps stripped', () => {
    const parsed = parseLrc('[00:01.00]one\n[00:02.00]two');
    expect(parsed.plain).toBe('one\ntwo');
  });
});

describe('formatting', () => {
  it('round-trips', () => {
    const lines = [
      { timeMs: 12_500, text: 'First line' },
      { timeMs: 63_250, text: 'Second line' },
      { timeMs: 3_723_000, text: 'Over an hour in' },
    ];
    const reparsed = parseLrc(formatLrc(lines));
    expect(reparsed.lines).toEqual(lines);
  });
});

describe('active line lookup', () => {
  const lines = [
    { timeMs: 0, text: 'zero' },
    { timeMs: 1000, text: 'one' },
    { timeMs: 2000, text: 'two' },
    { timeMs: 3000, text: 'three' },
  ];

  it('finds the line that is current at a position', () => {
    expect(activeLyricIndex(lines, 0)).toBe(0);
    expect(activeLyricIndex(lines, 999)).toBe(0);
    expect(activeLyricIndex(lines, 1000)).toBe(1);
    expect(activeLyricIndex(lines, 2500)).toBe(2);
    expect(activeLyricIndex(lines, 99_999)).toBe(3);
  });

  it('returns -1 before the first line and for empty lyrics', () => {
    expect(activeLyricIndex([{ timeMs: 500, text: 'late' }], 100)).toBe(-1);
    expect(activeLyricIndex([], 1000)).toBe(-1);
  });
});

describe('building the stored record', () => {
  it('keeps timing when an embedded tag turns out to be LRC', () => {
    const lyrics = lyricsFromTag('track-1', SAMPLE);
    expect(lyrics.kind).toBe('lrc');
    expect(lyrics.lines).not.toBeNull();
    expect(lyrics.source).toBe('embedded');
    expect(lyrics.trackId).toBe('track-1');
  });

  it('stores untimed lyrics as plain text', () => {
    const lyrics = lyricsFromTag('track-2', 'Just\nsome\nwords');
    expect(lyrics.kind).toBe('plain');
    expect(lyrics.lines).toBeNull();
    expect(lyrics.text).toBe('Just\nsome\nwords');
  });
});
