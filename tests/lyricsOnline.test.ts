/**
 * Choosing which lyrics belong to a recording.
 *
 * The lookup itself is a fetch; what needs testing is the judgement around it.
 * A search hit with the same title and artist is very often a *different*
 * recording — a remaster, a live take, an edit — and synced timings from the
 * wrong one drift within seconds. Showing those is worse than showing nothing,
 * so the tolerance rules are the thing worth pinning down.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLyrics } from '@core/lyrics/online';
import type { Track } from '@core/types';

/** A 200-second track, the length everything below is measured against. */
function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 't1',
    title: 'Some Song',
    artist: 'Some Artist',
    artists: ['Some Artist'],
    album: 'Some Album',
    durationMs: 200_000,
    ...overrides,
  } as Track;
}

interface Record {
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/**
 * Stub the network.
 *
 * `get` is the exact-match endpoint, `search` the fallback list — the two the
 * lookup actually calls, in that order.
 */
function stubApi(options: { get?: Record | null; search?: Record[] }) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const body = url.includes('/api/get') ? (options.get ?? null) : (options.search ?? []);
    if (body === null) {
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const SYNCED = '[00:10.00]a line\n[00:20.00]another line';
const PLAIN = 'a line\nanother line';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('matching a recording', () => {
  it('accepts synced lyrics when the length is close', async () => {
    stubApi({ get: { duration: 203, syncedLyrics: SYNCED, plainLyrics: PLAIN } });

    const found = await findLyrics(track());
    expect(found?.synced).toBe(true);
    expect(found?.deltaSec).toBe(3);
  });

  it('refuses synced lyrics from a different recording, but keeps the words', async () => {
    // 25s out: same song, different cut. Timings would visibly drift, so the
    // synced version is dropped and the plain text used instead.
    stubApi({ get: { duration: 225, syncedLyrics: SYNCED, plainLyrics: PLAIN } });

    const found = await findLyrics(track());
    expect(found?.synced).toBe(false);
    expect(found?.text).toBe(PLAIN);
  });

  it('rejects a match that is wildly the wrong length', async () => {
    // A 6-minute extended mix is not the 200s track in the library.
    stubApi({ get: { duration: 380, syncedLyrics: SYNCED, plainLyrics: PLAIN }, search: [] });

    expect(await findLyrics(track())).toBeNull();
  });

  it('ignores instrumental entries', async () => {
    stubApi({ get: { duration: 200, instrumental: true, plainLyrics: '' }, search: [] });

    expect(await findLyrics(track())).toBeNull();
  });

  it('keeps searching when the exact match has no timings', async () => {
    // The bug worth guarding: returning the first exact hit meant settling for
    // plain text while a synced version of the same recording existed.
    stubApi({
      get: { duration: 200, plainLyrics: PLAIN, syncedLyrics: null },
      search: [{ duration: 201, syncedLyrics: SYNCED, plainLyrics: PLAIN }],
    });

    const found = await findLyrics(track());
    expect(found?.synced).toBe(true);
  });

  it('picks the closest length among several search hits', async () => {
    stubApi({
      get: null,
      search: [
        { duration: 230, syncedLyrics: SYNCED, plainLyrics: PLAIN },
        { duration: 201, syncedLyrics: SYNCED, plainLyrics: PLAIN },
        { duration: 215, syncedLyrics: SYNCED, plainLyrics: PLAIN },
      ],
    });

    const found = await findLyrics(track());
    expect(found?.deltaSec).toBe(1);
  });

  it('falls back to plain text when the length is unknown', async () => {
    stubApi({ get: { plainLyrics: PLAIN, syncedLyrics: SYNCED }, search: [] });

    const found = await findLyrics(track());
    // Nothing to justify trusting the timings against.
    expect(found?.synced).toBe(false);
  });

  it('gives up quietly on a track with no title or artist', async () => {
    const fetchMock = stubApi({ get: null });

    expect(await findLyrics(track({ title: '', artist: '', artists: [] }))).toBeNull();
    // And does not waste a request finding that out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives the service being unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    // Offline is the normal state for this app; it must not throw.
    expect(await findLyrics(track())).toBeNull();
  });
});
