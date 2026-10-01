/**
 * Smart-playlist rule edge cases: multi-valued genres and the emptiness
 * operators on numeric fields.
 */

import { describe, expect, it } from 'vitest';
import { buildTrack } from '@core/library/trackBuilder';
import { matchesRule } from '@core/playlists/smart';
import type { ParsedAudio } from '@core/metadata';
import type { SmartRule, Track } from '@core/types';

function base(): Track {
  const parsed: ParsedAudio = {
    tags: { pictures: [], title: 'T', artist: 'A', album: 'B' },
    stream: {
      format: 'flac',
      codec: 'FLAC',
      durationMs: 180_000,
      bitrateKbps: 900,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      lossless: true,
    },
    warnings: [],
  };
  return buildTrack({
    sourceId: 'src-1',
    entry: { path: 'a/b.flac', name: 'b.flac', sizeBytes: 1, lastModified: 1_700_000_000_000 },
    parsed,
    artworkId: null,
    hasLyrics: false,
    now: 1_700_000_000_000,
  });
}

const track = (overrides: Partial<Track>): Track => ({ ...base(), ...overrides });
const rule = (r: SmartRule): SmartRule => r;

describe('smart rules — multi-genre tracks', () => {
  const multi = track({ genres: ['Rock', 'Pop'] });

  it('`genre is X` matches any one of the genres', () => {
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'is', value: 'rock' }))).toBe(true);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'is', value: 'Pop' }))).toBe(true);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'is', value: 'Jazz' }))).toBe(false);
    // Not the joined text.
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'is', value: 'rock | pop' }))).toBe(false);
  });

  it('`genre is not X` excludes a track that has X among others', () => {
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'isNot', value: 'pop' }))).toBe(false);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'isNot', value: 'jazz' }))).toBe(true);
  });

  it('starts/ends with apply per genre; contains still works', () => {
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'startsWith', value: 'po' }))).toBe(true);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'endsWith', value: 'ock' }))).toBe(true);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'contains', value: 'op' }))).toBe(true);
    expect(matchesRule(multi, rule({ field: 'genre', operator: 'notContains', value: 'rock' }))).toBe(false);
  });

  it('a single-genre track behaves as before', () => {
    const single = track({ genres: ['Jazz'] });
    expect(matchesRule(single, rule({ field: 'genre', operator: 'is', value: 'jazz' }))).toBe(true);
  });
});

describe('smart rules — empty and not empty are complements', () => {
  const empty = rule({ field: 'rating', operator: 'isEmpty' });
  const notEmpty = rule({ field: 'rating', operator: 'isNotEmpty' });

  it('rating 0 (unrated) is empty and not "not empty"', () => {
    const unrated = track({ rating: 0 });
    expect(matchesRule(unrated, empty)).toBe(true);
    expect(matchesRule(unrated, notEmpty)).toBe(false);
  });

  it('a rated track is not empty', () => {
    const rated = track({ rating: 4 });
    expect(matchesRule(rated, empty)).toBe(false);
    expect(matchesRule(rated, notEmpty)).toBe(true);
  });

  it('null and empty strings are empty', () => {
    expect(matchesRule(track({ year: null }), rule({ field: 'year', operator: 'isNotEmpty' }))).toBe(false);
    expect(matchesRule(track({ composer: '' }), rule({ field: 'composer', operator: 'isEmpty' }))).toBe(true);
    expect(matchesRule(track({ genres: [] }), rule({ field: 'genre', operator: 'isEmpty' }))).toBe(true);
  });
});
