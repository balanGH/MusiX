/**
 * Looking lyrics up for a track already in the library (spec §14).
 *
 * Downloaded songs get lyrics embedded at download time, but that leaves every
 * other track — anything ripped, imported, or downloaded before the feature
 * existed — with no way to get them. This is that way.
 *
 * The request goes straight from the browser to LRCLIB, which sends
 * `access-control-allow-origin: *`. That matters: it means finding lyrics works
 * whether or not the optional studio service is running, and MusiX keeps its
 * "the app is the whole app" property.
 *
 * Nothing here runs on its own. It is called only when the user asks for
 * lyrics, and only when they have left the online-lyrics setting on (§32).
 */

import { putLyrics } from '../db/repositories/lyrics';
import { setHasLyrics } from '../db/repositories/tracks';
import { createLogger } from '../logger';
import type { Lyrics, Track } from '../types';
import { looksLikeLrc, parseLrc } from './lrc';

const log = createLogger('lyrics.online');

const API_ROOT = 'https://lrclib.net/api/';

/**
 * How close the matched recording's length has to be.
 *
 * A hit with the same title and artist is very often a *different* recording —
 * a remaster, a live take, a radio edit. Synced timings from the wrong one
 * drift within seconds and are worse than showing nothing, so they need a tight
 * match. Plain text has nothing timed to it, so it can be far more forgiving.
 */
const SYNCED_TOLERANCE_SEC = 8;
const PLAIN_TOLERANCE_SEC = 45;

interface LrcLibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface OnlineLyrics {
  text: string;
  /** True when the text carries timestamps and will scroll with playback. */
  synced: boolean;
  /** How far the matched recording's length was from ours, in seconds. */
  deltaSec: number | null;
}

async function request(path: string, params: Record<string, string>): Promise<unknown> {
  const url = `${API_ROOT}${path}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, {
    headers: {
      // LRCLIB asks clients to identify themselves.
      'Lrclib-Client': 'MusiX (offline-first local music player)',
    },
  });

  // 404 is an answer — "nothing indexed for this" — not a failure.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Lyrics service returned ${response.status}`);
  return response.json();
}

/** Turn one record into a result, if it is a close enough match. */
function evaluate(record: LrcLibRecord, durationSec: number): OnlineLyrics | null {
  if (record.instrumental) return null;

  const synced = (record.syncedLyrics ?? '').trim();
  const plain = (record.plainLyrics ?? '').trim();
  if (!synced && !plain) return null;

  const delta =
    durationSec > 0 && record.duration ? Math.abs(record.duration - durationSec) : null;

  // Without a duration to compare there is nothing justifying the timings.
  if (delta === null) return plain ? { text: plain, synced: false, deltaSec: null } : null;

  if (synced && delta <= SYNCED_TOLERANCE_SEC) {
    return { text: synced, synced: true, deltaSec: delta };
  }
  if (plain && delta <= PLAIN_TOLERANCE_SEC) {
    return { text: plain, synced: false, deltaSec: delta };
  }
  return null;
}

/**
 * Find lyrics for a track.
 *
 * Tries the exact endpoint first — one indexed lookup — then falls back to a
 * search. An exact hit that only has plain text does *not* end the search:
 * another entry for the same recording often has a synced version, and
 * scrolling lyrics are the point of the feature.
 */
export async function findLyrics(track: Track): Promise<OnlineLyrics | null> {
  const title = track.title?.trim();
  const artist = track.artists[0]?.trim() || track.artist?.trim();
  if (!title || !artist) return null;

  const durationSec = track.durationMs / 1000;
  const candidates: OnlineLyrics[] = [];

  const exactQueries: Record<string, string>[] = [
    {
      track_name: title,
      artist_name: artist,
      album_name: track.album ?? '',
      duration: String(Math.round(durationSec)),
    },
    { track_name: title, artist_name: artist },
  ];

  for (const params of exactQueries) {
    try {
      const found = await request('get', params);
      if (found && typeof found === 'object') {
        const picked = evaluate(found as LrcLibRecord, durationSec);
        if (picked) {
          candidates.push(picked);
          // Synced, from an exact match, is the best answer available.
          if (picked.synced) return picked;
        }
      }
    } catch (error) {
      log.debug('exact lyrics lookup failed', error);
    }
  }

  try {
    const results = await request('search', { q: `${title} ${artist}` });
    if (Array.isArray(results)) {
      for (const record of results.slice(0, 20) as LrcLibRecord[]) {
        const picked = evaluate(record, durationSec);
        if (picked) candidates.push(picked);
      }
    }
  } catch (error) {
    log.debug('lyrics search failed', error);
  }

  if (candidates.length === 0) return null;

  // Prefer synced, then the closest duration.
  candidates.sort(
    (a, b) =>
      Number(b.synced) - Number(a.synced) ||
      (a.deltaSec ?? Number.POSITIVE_INFINITY) - (b.deltaSec ?? Number.POSITIVE_INFINITY),
  );
  return candidates[0]!;
}

/**
 * Find lyrics and store them against the track.
 *
 * Stored in MusiX's own database rather than written into the file, for a
 * reason worth stating: MusiX asks for read-only access to your music folders,
 * so it cannot modify your files — and for a track imported into private
 * storage there is no original file to modify. The lyrics store is where the
 * player reads from anyway, so the result is identical at playback.
 */
export async function fetchAndStoreLyrics(track: Track): Promise<Lyrics | null> {
  const found = await findLyrics(track);
  if (!found) return null;

  // Timestamps are detected rather than assumed: LRCLIB's "synced" field and
  // the actual text can disagree, and the parser is the authority.
  const synced = looksLikeLrc(found.text) ? parseLrc(found.text) : null;

  const lyrics: Lyrics = {
    id: track.id,
    trackId: track.id,
    kind: synced && synced.lines.length > 0 ? 'lrc' : 'plain',
    text: found.text,
    lines: synced && synced.lines.length > 0 ? synced.lines : null,
    language: null,
    source: 'online',
    updatedAt: Date.now(),
  };

  await putLyrics(lyrics);
  await setHasLyrics(track.id, true);

  log.info(`stored ${lyrics.kind} lyrics for ${track.title}`);
  return lyrics;
}
