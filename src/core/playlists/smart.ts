/**
 * Smart playlists (spec §22).
 *
 * A rule set is evaluated in JavaScript over a cursor pass, not translated into
 * index queries. That is a deliberate choice: rules combine fields no single
 * IndexedDB index can cover (`genre = Rock AND year > 2020 AND rating >= 4`),
 * and a smart playlist is only evaluated when the user opens it, so one pass
 * over the tracks store is the right cost — the alternative would be
 * maintaining materialised membership on every scan, which is exactly the
 * background work spec §4 forbids.
 *
 * The thirteen built-ins are seeded once and marked `builtin`, so they cannot be
 * deleted but their rules can be inspected — they are ordinary rule sets, not
 * hard-coded queries.
 */

import { createPlaylist, listPlaylists, updatePlaylist } from '../db/repositories/playlists';
import { scanAllTracks } from '../db/repositories/tracks';
import { collator, seededRandom, shuffle } from '../utils';
import type { Playlist, SmartRule, SmartRuleSet, Track } from '../types';

const DAY_MS = 86_400_000;

/** Read the field a rule addresses, normalised for comparison. */
function fieldValue(track: Track, field: SmartRule['field']): string | number | boolean | null {
  switch (field) {
    case 'title':
      return track.title;
    case 'artist':
      return track.artist;
    case 'albumArtist':
      return track.albumArtist;
    case 'album':
      return track.album;
    case 'genre':
      return track.genres.join(' | ');
    case 'composer':
      return track.composer;
    case 'year':
      return track.year;
    case 'rating':
      return track.rating;
    case 'playCount':
      return track.playCount;
    case 'favorite':
      return track.favorite;
    case 'durationMs':
      return track.durationMs;
    case 'bitrateKbps':
      return track.bitrateKbps;
    case 'sampleRate':
      return track.sampleRate;
    case 'format':
      return track.format;
    case 'lossless':
      return track.lossless;
    case 'addedAt':
      return track.addedAt;
    case 'lastPlayedAt':
      return track.lastPlayedAt;
    case 'hasLyrics':
      return track.hasLyrics;
    case 'hasArtwork':
      return track.artworkId !== null;
    case 'tagState':
      return track.tagState;
    case 'path':
      return track.path;
    default:
      return null;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function matchesRule(track: Track, rule: SmartRule): boolean {
  const actual = fieldValue(track, rule.field);

  switch (rule.operator) {
    case 'isTrue':
      return actual === true;
    case 'isFalse':
      return actual === false;
    case 'isEmpty':
      return actual === null || actual === undefined || actual === '' || actual === 0;
    case 'isNotEmpty':
      return !(actual === null || actual === undefined || actual === '');
    case 'inLastDays': {
      const days = asNumber(rule.value);
      const timestamp = asNumber(actual);
      if (days === null || timestamp === null || timestamp === 0) return false;
      return Date.now() - timestamp <= days * DAY_MS;
    }
    default:
      break;
  }

  // Comparisons against a missing value are false rather than throwing — an
  // untagged track simply does not match "year > 2020".
  if (actual === null || actual === undefined) return false;

  const expectedNumber = asNumber(rule.value);
  const actualNumber = asNumber(actual);

  switch (rule.operator) {
    case 'gt':
      return actualNumber !== null && expectedNumber !== null && actualNumber > expectedNumber;
    case 'gte':
      return actualNumber !== null && expectedNumber !== null && actualNumber >= expectedNumber;
    case 'lt':
      return actualNumber !== null && expectedNumber !== null && actualNumber < expectedNumber;
    case 'lte':
      return actualNumber !== null && expectedNumber !== null && actualNumber <= expectedNumber;
    case 'between': {
      const upper = asNumber(rule.value2);
      return (
        actualNumber !== null &&
        expectedNumber !== null &&
        upper !== null &&
        actualNumber >= Math.min(expectedNumber, upper) &&
        actualNumber <= Math.max(expectedNumber, upper)
      );
    }
    default:
      break;
  }

  // String comparisons are case-insensitive, which is the only behaviour that
  // makes a hand-typed rule usable.
  const actualText = String(actual).toLowerCase();
  const expectedText = String(rule.value ?? '').toLowerCase();

  switch (rule.operator) {
    case 'is':
      return actualText === expectedText;
    case 'isNot':
      return actualText !== expectedText;
    case 'contains':
      return actualText.includes(expectedText);
    case 'notContains':
      return !actualText.includes(expectedText);
    case 'startsWith':
      return actualText.startsWith(expectedText);
    case 'endsWith':
      return actualText.endsWith(expectedText);
    default:
      return false;
  }
}

export function matchesRuleSet(track: Track, ruleSet: SmartRuleSet): boolean {
  if (ruleSet.rules.length === 0) return true;
  return ruleSet.match === 'all'
    ? ruleSet.rules.every((rule) => matchesRule(track, rule))
    : ruleSet.rules.some((rule) => matchesRule(track, rule));
}

function compare(a: Track, b: Track, ruleSet: SmartRuleSet): number {
  switch (ruleSet.sort) {
    case 'title':
      return collator.compare(a.sortTitle, b.sortTitle);
    case 'artist':
      return collator.compare(a.sortArtist, b.sortArtist) || collator.compare(a.album, b.album);
    case 'album':
      return (
        collator.compare(a.album, b.album) ||
        (a.discNo ?? 1) - (b.discNo ?? 1) ||
        (a.trackNo ?? 0) - (b.trackNo ?? 0)
      );
    case 'addedAt':
      return a.addedAt - b.addedAt;
    case 'lastPlayedAt':
      return (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0);
    case 'playCount':
      return a.playCount - b.playCount;
    case 'rating':
      return a.rating - b.rating;
    case 'durationMs':
      return a.durationMs - b.durationMs;
    case 'path':
      return collator.compare(a.path, b.path);
    default:
      return 0;
  }
}

/**
 * Evaluate a rule set against the library.
 *
 * One cursor pass; matches are kept, everything else is discarded immediately,
 * so peak memory is the size of the result rather than the library.
 */
export async function materialiseSmartPlaylist(ruleSet: SmartRuleSet): Promise<Track[]> {
  const matched: Track[] = [];
  await scanAllTracks((track) => {
    if (matchesRuleSet(track, ruleSet)) matched.push(track);
    return 'continue';
  });

  if (ruleSet.sort === 'random') {
    // Seeded by the day, so a "random" playlist is stable while the user is
    // looking at it but different tomorrow.
    shuffle(matched, seededRandom(Math.floor(Date.now() / DAY_MS) + 1));
  } else {
    matched.sort((a, b) => compare(a, b, ruleSet));
    if (ruleSet.direction === 'desc') matched.reverse();
  }

  return ruleSet.limit === null ? matched : matched.slice(0, ruleSet.limit);
}

// ---------------------------------------------------------------------------
// Built-ins (spec §22)
// ---------------------------------------------------------------------------

interface BuiltinDefinition {
  id: string;
  name: string;
  description: string;
  rules: SmartRuleSet;
}

const rules = (
  match: 'all' | 'any',
  list: SmartRule[],
  sort: SmartRuleSet['sort'],
  direction: SmartRuleSet['direction'] = 'desc',
  limit: number | null = null,
): SmartRuleSet => ({ match, rules: list, sort, direction, limit });

export const BUILTIN_SMART_PLAYLISTS: readonly BuiltinDefinition[] = [
  {
    id: 'smart:recently-added',
    name: 'Recently Added',
    description: 'Everything that arrived in the last 30 days',
    rules: rules('all', [{ field: 'addedAt', operator: 'inLastDays', value: 30 }], 'addedAt', 'desc', 200),
  },
  {
    id: 'smart:recently-played',
    name: 'Recently Played',
    description: 'What you have been listening to',
    rules: rules(
      'all',
      [{ field: 'lastPlayedAt', operator: 'inLastDays', value: 30 }],
      'lastPlayedAt',
      'desc',
      200,
    ),
  },
  {
    id: 'smart:most-played',
    name: 'Most Played',
    description: 'Your most-played tracks',
    rules: rules('all', [{ field: 'playCount', operator: 'gte', value: 1 }], 'playCount', 'desc', 100),
  },
  {
    id: 'smart:favorites',
    name: 'Favourites',
    description: 'Everything you have hearted',
    rules: rules('all', [{ field: 'favorite', operator: 'isTrue' }], 'addedAt', 'desc'),
  },
  {
    id: 'smart:never-played',
    name: 'Never Played',
    description: 'Waiting to be discovered',
    rules: rules('all', [{ field: 'playCount', operator: 'isEmpty' }], 'random', 'asc', 200),
  },
  {
    id: 'smart:flac',
    name: 'FLAC',
    description: 'Lossless FLAC files',
    rules: rules('all', [{ field: 'format', operator: 'is', value: 'flac' }], 'artist', 'asc'),
  },
  {
    id: 'smart:high-quality',
    name: 'High Quality',
    description: 'Lossless, or above 24-bit / high sample rate',
    rules: rules('all', [{ field: 'lossless', operator: 'isTrue' }], 'artist', 'asc'),
  },
  {
    id: 'smart:instrumentals',
    name: 'Instrumentals',
    description: 'Tracks marked or titled as instrumental',
    rules: rules('any', [{ field: 'title', operator: 'contains', value: 'instrumental' }], 'title', 'asc'),
  },
  {
    id: 'smart:with-lyrics',
    name: 'Songs With Lyrics',
    description: 'Tracks that carry lyrics',
    rules: rules('all', [{ field: 'hasLyrics', operator: 'isTrue' }], 'artist', 'asc'),
  },
  {
    id: 'smart:missing-lyrics',
    name: 'Missing Lyrics',
    description: 'Tracks with no lyrics stored',
    rules: rules('all', [{ field: 'hasLyrics', operator: 'isFalse' }], 'artist', 'asc'),
  },
  {
    id: 'smart:missing-artwork',
    name: 'Missing Artwork',
    description: 'Tracks with no cover image',
    rules: rules('all', [{ field: 'hasArtwork', operator: 'isFalse' }], 'album', 'asc'),
  },
  {
    id: 'smart:missing-metadata',
    name: 'Missing Metadata',
    description: 'Tracks whose tags are incomplete',
    rules: rules('any', [{ field: 'tagState', operator: 'isNot', value: 'complete' }], 'path', 'asc'),
  },
  {
    id: 'smart:top-rated',
    name: 'Top Rated',
    description: 'Four stars and above',
    rules: rules('all', [{ field: 'rating', operator: 'gte', value: 4 }], 'rating', 'desc'),
  },
];

/**
 * Create any built-in that is missing, and refresh the rules of ones that exist.
 *
 * Refreshing matters across releases: if a built-in's definition improves, the
 * user should get the improvement without losing the playlist.
 */
export async function ensureBuiltinPlaylists(): Promise<void> {
  const existing = new Map((await listPlaylists()).map((playlist) => [playlist.id, playlist]));

  for (const definition of BUILTIN_SMART_PLAYLISTS) {
    const current = existing.get(definition.id);
    if (!current) {
      await createPlaylist({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        rules: definition.rules,
        builtin: true,
      });
      continue;
    }
    if (JSON.stringify(current.rules) !== JSON.stringify(definition.rules)) {
      await updatePlaylist(definition.id, {
        rules: definition.rules,
        description: definition.description,
      });
    }
  }
}

/** A blank rule set, for the "new smart playlist" form. */
export function newRuleSet(): SmartRuleSet {
  return {
    match: 'all',
    rules: [{ field: 'genre', operator: 'contains', value: '' }],
    sort: 'title',
    direction: 'asc',
    limit: null,
  };
}

export function isSmart(playlist: Playlist): boolean {
  return playlist.kind === 'smart' && playlist.rules !== null;
}
