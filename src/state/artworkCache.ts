/**
 * Artwork object-URL cache.
 *
 * Blobs cannot go straight into `src`, and `URL.createObjectURL` leaks until it
 * is revoked. A grid of 300 albums scrolled a few times would otherwise pin
 * hundreds of megabytes of images that are no longer on screen.
 *
 * So: one URL per artwork id, reference-counted by mounted components, with a
 * bounded LRU of *unreferenced* URLs kept around because scrolling back up is
 * the common case. Anything evicted from that is revoked properly.
 */

import { useEffect, useState } from 'react';
import { getArtwork } from '@core/db/repositories/artwork';
import { createLogger } from '@core/logger';

const log = createLogger('artwork.cache');

/** How many unreferenced URLs to keep before revoking the oldest. */
const IDLE_LIMIT = 240;

interface Entry {
  url: string;
  /** Dominant colour as `r g b`, for the dynamic accent. */
  dominant: string | null;
  refs: number;
  /** Bumped whenever the entry is used, for LRU ordering. */
  touchedAt: number;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry | null>>();
/** Ids known to have no artwork, so we stop asking the database. */
const misses = new Set<string>();

async function loadEntry(artworkId: string, wantFullSize: boolean): Promise<Entry | null> {
  const key = cacheKey(artworkId, wantFullSize);
  const existing = cache.get(key);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  if (misses.has(key)) return null;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const artwork = await getArtwork(artworkId);
      if (!artwork) {
        misses.add(key);
        return null;
      }
      // Lists get the thumbnail; Now Playing and the album header get the
      // original. Falling back to `data` matters for covers too small to have
      // been worth thumbnailing.
      const blob = wantFullSize ? artwork.data : (artwork.thumb ?? artwork.data);
      const entry: Entry = {
        url: URL.createObjectURL(blob),
        dominant: artwork.dominant,
        refs: 0,
        touchedAt: Date.now(),
      };
      cache.set(key, entry);
      return entry;
    } catch (error) {
      log.warn(`could not load artwork ${artworkId}`, error);
      misses.add(key);
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

function cacheKey(artworkId: string, wantFullSize: boolean): string {
  return wantFullSize ? `${artworkId}:full` : artworkId;
}

/** Revoke the least-recently-used unreferenced URLs. */
function evict(): void {
  const idle = [...cache.entries()].filter(([, entry]) => entry.refs === 0);
  if (idle.length <= IDLE_LIMIT) return;

  idle.sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key, entry] of idle.slice(0, idle.length - IDLE_LIMIT)) {
    URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
}

export interface ArtworkResult {
  url: string | null;
  dominant: string | null;
  loading: boolean;
}

/**
 * Resolve artwork for a component's lifetime.
 *
 * Holds a reference while mounted and releases it on unmount, which is what
 * makes the LRU safe: a URL still on screen is never revoked.
 */
export function useArtwork(artworkId: string | null, fullSize = false): ArtworkResult {
  const [result, setResult] = useState<ArtworkResult>({
    url: null,
    dominant: null,
    loading: artworkId !== null,
  });

  useEffect(() => {
    if (!artworkId) {
      setResult({ url: null, dominant: null, loading: false });
      return;
    }

    let cancelled = false;
    let held: Entry | null = null;
    setResult((current) => (current.loading ? current : { ...current, loading: true }));

    void loadEntry(artworkId, fullSize).then((entry) => {
      if (cancelled) return;
      if (!entry) {
        setResult({ url: null, dominant: null, loading: false });
        return;
      }
      entry.refs++;
      entry.touchedAt = Date.now();
      held = entry;
      setResult({ url: entry.url, dominant: entry.dominant, loading: false });
    });

    return () => {
      cancelled = true;
      if (held) {
        held.refs = Math.max(0, held.refs - 1);
        held.touchedAt = Date.now();
        evict();
      }
    };
  }, [artworkId, fullSize]);

  return result;
}

/** One-shot read, for the media session and the dynamic accent. */
export async function artworkDominant(artworkId: string | null): Promise<string | null> {
  if (!artworkId) return null;
  const entry = await loadEntry(artworkId, false);
  return entry?.dominant ?? null;
}

/** Drop everything; used after the library is reset. */
export function clearArtworkCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  misses.clear();
}
