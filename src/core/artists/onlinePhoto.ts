/**
 * Fetching a real artist photo online (spec §29, §32).
 *
 * Nothing in a local audio file is a photo of the artist — only of an album,
 * arbitrarily — so `Artist.artworkId` was never usable for this (see
 * `artists/ArtistsPage.tsx`). This is the online source that can actually
 * supply one: the Deezer catalogue's `search/artist` endpoint, keyed by
 * nothing but the artist's name, so it needs no API key or account.
 *
 * Deezer's JSON API does not send `Access-Control-Allow-Origin`, so a plain
 * `fetch()` to it is blocked by the browser. Its `output=jsonp` mode is the
 * documented workaround — a `<script>` tag is not subject to CORS — and is
 * used here only for that one metadata lookup. The photo itself is then
 * fetched normally: Deezer's image CDN *does* send an open CORS header, so
 * the bytes can be read, hashed and stored exactly like an embedded cover.
 *
 * Only ever called from a click, and only when the user has left "Online
 * artwork" on in Settings (§32). Nothing here runs speculatively (§4).
 *
 * Every failure here — a bad match, a network error, a decode failure — is
 * this module's problem alone: it must never be allowed to block or hang the
 * artist page itself, which is why callers keep it in its own effect rather
 * than in the critical Promise.all that loads the artist's albums and tracks.
 */

import { putArtwork } from '../db/repositories/artwork';
import {
  deleteArtistPhoto,
  getArtistPhoto,
  listArtistPhotos,
  putArtistPhoto,
} from '../db/repositories/artistPhotos';
import { createLogger } from '../logger';
import { processArtwork } from '../library/artworkProcessor';
import type { Artist, ArtistPhoto } from '../types';

const log = createLogger('artists.onlinePhoto');
const JSONP_TIMEOUT_MS = 8000;

interface DeezerArtist {
  id: number;
  name: string;
  picture_big?: string;
  picture_medium?: string;
  nb_fan?: number;
}

let jsonpCounter = 0;

/** One JSONP round trip: inject a `<script>`, resolve when its callback fires. */
function jsonp<T>(url: URL): Promise<T> {
  return new Promise((resolve, reject) => {
    const callbackName = `musixDeezerCb${Date.now()}_${jsonpCounter++}`;
    url.searchParams.set('output', 'jsonp');
    url.searchParams.set('callback', callbackName);

    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      script.remove();
      clearTimeout(timer);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    (window as unknown as Record<string, unknown>)[callbackName] = (payload: T) =>
      finish(() => resolve(payload));
    script.onerror = () => finish(() => reject(new Error('Deezer request failed to load')));
    const timer = setTimeout(
      () => finish(() => reject(new Error('Deezer request timed out'))),
      JSONP_TIMEOUT_MS,
    );

    script.src = url.toString();
    document.head.append(script);
  });
}

/**
 * Deezer artists for a name, best match first: exact (normalised) name
 * matches before the rest, and the most-followed first within each group.
 * The ranked list, not just the winner, is what lets "Look for a different
 * photo" move on to the next candidate.
 */
export async function searchDeezerArtists(name: string): Promise<DeezerArtist[]> {
  const url = new URL('https://api.deezer.com/search/artist');
  url.searchParams.set('q', name);
  url.searchParams.set('limit', '10');

  const result = await jsonp<{ data?: DeezerArtist[]; error?: unknown }>(url);
  return rankDeezerArtists(name, result.data ?? []);
}

/** Pure ranking half of `searchDeezerArtists`, exported for tests. */
export function rankDeezerArtists<T extends { name: string; nb_fan?: number }>(
  name: string,
  candidates: readonly T[],
): T[] {
  if (candidates.length === 0) return [];

  // Deezer's own catalogue is inconsistent in two ways that matter here:
  // a name can carry stray whitespace ("Dhanush " for the real match on a
  // search for "Dhanush"), and — especially for artists credited only as
  // lyricists or composers rather than performers, common in Tamil film
  // music — the *same* real person often has several separate profiles that
  // differ only in punctuation ("Na. Muthukumar", "Na.Muthukumar",
  // "Na Muthukumar", all the same lyricist). Comparing names raw missed the
  // real match entirely in the first case, and in the second, matched only
  // one arbitrary punctuation variant instead of all of them. Stripping
  // everything but letters and digits before comparing folds all of the
  // above into the same key, so every duplicate profile for the same person
  // is considered together.
  //
  // The tracks and albums Deezer has on file for the matched artist would be
  // a stronger signal than fan count to disambiguate *which* profile is the
  // right one when several remain — but for exactly the artists this
  // duplicate-profile problem affects (secondary credits, not performers),
  // Deezer's `/artist/{id}/albums` and `/artist/{id}/top` both come back
  // empty (verified against the live API for this exact case), so there is
  // nothing there to cross-reference. Fan count is the only signal Deezer
  // actually populates for these profiles, so it stays the tiebreaker.
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const target = normalize(name);
  const byFans = (a: T, b: T) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0);
  const exact = candidates.filter((candidate) => normalize(candidate.name) === target);
  const rest = candidates.filter((candidate) => normalize(candidate.name) !== target);
  return [...exact.sort(byFans), ...rest.sort(byFans)];
}

function abortError(): Error {
  return new DOMException('Photo lookup was cancelled', 'AbortError');
}

export interface FetchArtistPhotoOptions {
  /**
   * Artwork ids not to settle on — the photo currently shown, plus any
   * already offered. Candidates whose image hashes to one of these are
   * skipped, so asking again yields a *different* photo when there is one.
   */
  excludeArtworkIds?: readonly string[];
  /** Aborting stops the lookup before anything is stored. */
  signal?: AbortSignal;
}

/**
 * Look up a stored photo without hitting the network.
 *
 * Wrapped so a broken `artistPhotos` store (a fresh browser mid-migration, a
 * corrupted database) can never surface as anything worse than "no photo
 * yet" to a caller — this is a nice-to-have lookup, not core data.
 */
export async function getCachedArtistPhoto(artistId: string): Promise<string | null> {
  try {
    const found = await getArtistPhoto(artistId);
    return found?.artworkId ?? null;
  } catch (error) {
    log.warn('could not read cached artist photo', error);
    return null;
  }
}

/** Every stored photo as an id → artworkId map, or an empty one on any failure. */
export async function getCachedArtistPhotoMap(): Promise<Map<string, string>> {
  try {
    const rows = await listArtistPhotos();
    return new Map(rows.map((row) => [row.id, row.artworkId]));
  } catch (error) {
    log.warn('could not read cached artist photos', error);
    return new Map();
  }
}

/**
 * Find, fetch and store a photo for one artist.
 *
 * Returns the `artworkId` to display, or null when Deezer has no match. The
 * stored `ArtistPhoto` row is what makes the result show up again on the next
 * visit without a repeat lookup.
 */
export async function fetchAndStoreArtistPhoto(
  artist: Artist,
  options: FetchArtistPhotoOptions = {},
): Promise<string | null> {
  const { signal } = options;
  const exclude = new Set(options.excludeArtworkIds ?? []);

  const candidates = await searchDeezerArtists(artist.name);
  if (signal?.aborted) throw abortError();

  // The same picture URL can appear on several duplicate profiles.
  const seenUrls = new Set<string>();
  let lastError: unknown = null;

  for (const candidate of candidates) {
    const pictureUrl = candidate.picture_big ?? candidate.picture_medium;
    if (!pictureUrl || seenUrls.has(pictureUrl)) continue;
    seenUrls.add(pictureUrl);

    try {
      const response = await fetch(pictureUrl, signal ? { signal } : undefined);
      if (!response.ok) throw new Error(`Photo download returned ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime = response.headers.get('content-type') || 'image/jpeg';

      const processed = await processArtwork({ mime, pictureType: 8, description: '', data: bytes });
      if (signal?.aborted) throw abortError();
      if (!processed) throw new Error('Downloaded photo could not be decoded');
      // Deezer serves one generic silhouette for every profile without a
      // photo, so hashing is also what skips a repeat of that placeholder.
      if (exclude.has(processed.artwork.id)) continue;

      await putArtwork(processed.artwork);
      if (signal?.aborted) throw abortError();

      const photo: ArtistPhoto = {
        id: artist.id,
        artworkId: processed.artwork.id,
        source: 'deezer',
        updatedAt: Date.now(),
      };
      await putArtistPhoto(photo);

      log.info(`stored a photo for ${artist.name}`);
      return photo.artworkId;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }
      // One bad candidate (a 404, an undecodable image) shouldn't end the
      // search while others remain.
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  log.info(`no ${exclude.size > 0 ? 'other ' : ''}Deezer photo found for ${artist.name}`);
  return null;
}

/**
 * Remove a fetched photo — the matcher is a best guess (see
 * `rankDeezerArtists` above) and sometimes picks the wrong person; this
 * undoes that, reverting the artist back to the honest placeholder.
 */
export async function removeArtistPhoto(artistId: string): Promise<void> {
  await deleteArtistPhoto(artistId);
}
