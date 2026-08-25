/**
 * Offline library search (spec §23).
 *
 * **Why an in-memory index.** IndexedDB can only match on index *prefixes*, so
 * "find tracks containing 'blue'" cannot be answered by the database at all —
 * it would mean a full cursor pass and a string compare per record on every
 * keystroke. Instead one pass builds a compact index (id plus the precomputed
 * token haystack, roughly 100 bytes per track) and every subsequent keystroke
 * is pure in-memory work.
 *
 * The index is built on the first search, not at startup, and dropped when the
 * library changes — no speculative work (spec §4).
 *
 * **Matching.** Tokens are matched by prefix, which is what makes results
 * appear as the user types. A single-edit fuzzy pass runs only when prefix
 * matching found little and the token is long enough for a typo to be the
 * likely explanation, because Levenshtein over 100k entries per keystroke is
 * not free.
 */

import { listAlbums, listArtists } from '../db/repositories/library';
import { getTracks, scanAllTracks } from '../db/repositories/tracks';
import { createLogger } from '../logger';
import { fold } from '../utils';
import type { Album, Artist, Track } from '../types';

const log = createLogger('search');

interface IndexEntry {
  id: string;
  /** Space-separated folded tokens, precomputed at scan time. */
  haystack: string;
  /** Folded title, for the strong "title match" weighting. */
  title: string;
  artist: string;
}

interface SearchIndex {
  entries: IndexEntry[];
  builtAt: number;
}

let index: SearchIndex | null = null;
let building: Promise<SearchIndex> | null = null;

/** Called after any scan or metadata edit. */
export function invalidateSearchIndex(): void {
  index = null;
  building = null;
}

export function searchIndexReady(): boolean {
  return index !== null;
}

async function ensureIndex(): Promise<SearchIndex> {
  if (index) return index;
  if (building) return building;

  building = (async () => {
    const started = Date.now();
    const entries: IndexEntry[] = [];
    await scanAllTracks((track) => {
      entries.push({
        id: track.id,
        haystack: track.searchText,
        title: fold(track.title),
        artist: fold(track.artist),
      });
      return 'continue';
    });
    const built: SearchIndex = { entries, builtAt: Date.now() };
    index = built;
    building = null;
    log.debug(`search index built: ${entries.length} tracks in ${Date.now() - started}ms`);
    return built;
  })();

  return building;
}

export interface SearchResults {
  query: string;
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  genres: string[];
  /** True when results were capped. */
  truncated: boolean;
}

export const EMPTY_RESULTS: SearchResults = {
  query: '',
  tracks: [],
  albums: [],
  artists: [],
  genres: [],
  truncated: false,
};

interface Scored {
  id: string;
  score: number;
}

/**
 * Score one entry against the query tokens.
 *
 * Returns 0 when any token is unmatched: searching "beatles help" should find
 * only tracks matching *both*, which is what users expect from a search box.
 */
function scoreEntry(entry: IndexEntry, tokens: readonly string[], allowFuzzy: boolean): number {
  let total = 0;

  for (const token of tokens) {
    let best = 0;

    // Whole-haystack containment is the cheap common case.
    const at = entry.haystack.indexOf(token);
    if (at !== -1) {
      // A match at a token boundary beats a match inside a longer word.
      const atBoundary = at === 0 || entry.haystack[at - 1] === ' ';
      best = atBoundary ? 10 : 4;
      // Exact whole-token match is better still.
      const end = at + token.length;
      if (atBoundary && (end === entry.haystack.length || entry.haystack[end] === ' ')) best = 14;
    } else if (allowFuzzy && token.length >= 4) {
      if (fuzzyContains(entry.haystack, token)) best = 3;
    }

    if (best === 0) return 0;

    // Field weighting: the title is what people are usually looking for.
    if (entry.title.includes(token)) best += 8;
    if (entry.artist.includes(token)) best += 4;
    if (entry.title.startsWith(token)) best += 6;

    total += best;
  }

  return total;
}

/** True if any whitespace-delimited word in `haystack` is within one edit of `token`. */
function fuzzyContains(haystack: string, token: string): boolean {
  let start = 0;
  while (start < haystack.length) {
    let end = haystack.indexOf(' ', start);
    if (end === -1) end = haystack.length;
    const word = haystack.slice(start, end);
    // A one-edit difference cannot change the length by more than one.
    if (Math.abs(word.length - token.length) <= 1 && withinOneEdit(word, token)) return true;
    start = end + 1;
  }
  return false;
}

/** Levenshtein distance ≤ 1, without building a matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    // Same length means a substitution; different means a deletion.
    if (shorter.length === longer.length) i++;
    j++;
  }
  return true;
}

export interface SearchOptions {
  trackLimit?: number;
  albumLimit?: number;
  artistLimit?: number;
}

/**
 * Search the library.
 *
 * Works entirely offline against local data — there is no network path in this
 * module at all, which is the point of spec §23.
 */
export async function searchLibrary(
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length === 0) return { ...EMPTY_RESULTS };

  const tokens = fold(query)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { ...EMPTY_RESULTS, query };

  const trackLimit = options.trackLimit ?? 60;
  const { entries } = await ensureIndex();

  // First pass: exact/prefix only. Fast, and usually enough.
  let scored = collect(entries, tokens, false, trackLimit);
  // Second pass with single-edit tolerance, only if the first found little.
  if (scored.length < 5) {
    scored = collect(entries, tokens, true, trackLimit);
  }

  const tracks = await getTracks(scored.map((hit) => hit.id));
  // `getTracks` preserves the requested order, so ranking survives the fetch.

  const folded = fold(query);
  const [allAlbums, allArtists] = await Promise.all([listAlbums(), listArtists()]);

  const albums = allAlbums
    .filter((album) => album.searchText.includes(folded))
    .slice(0, options.albumLimit ?? 12);
  const artists = allArtists
    .filter((artist) => artist.searchText.includes(folded))
    .slice(0, options.artistLimit ?? 12);

  const genres = [
    ...new Set(
      allAlbums
        .flatMap((album) => album.genres)
        .filter((genre) => fold(genre).includes(folded)),
    ),
  ].slice(0, 8);

  return {
    query,
    tracks,
    albums,
    artists,
    genres,
    truncated: scored.length >= trackLimit,
  };
}

/**
 * Rank matches, keeping only the top `limit`.
 *
 * A bounded insertion into a small array beats scoring everything and sorting:
 * at 100k entries the sort would dominate, and only 60 rows are ever shown.
 */
function collect(
  entries: readonly IndexEntry[],
  tokens: readonly string[],
  allowFuzzy: boolean,
  limit: number,
): Scored[] {
  const top: Scored[] = [];
  let floor = 0;

  for (const entry of entries) {
    const score = scoreEntry(entry, tokens, allowFuzzy);
    if (score === 0 || (top.length >= limit && score <= floor)) continue;

    // Insert in descending score order.
    let position = top.length;
    while (position > 0 && top[position - 1]!.score < score) position--;
    top.splice(position, 0, { id: entry.id, score });
    if (top.length > limit) top.pop();
    floor = top[top.length - 1]?.score ?? 0;
  }

  return top;
}

/** Suggestions for an empty search box: the biggest artists in the library. */
export async function searchSuggestions(limit = 8): Promise<string[]> {
  const artists = await listArtists('trackCount', 'desc');
  return artists.slice(0, limit).map((artist) => artist.name);
}
