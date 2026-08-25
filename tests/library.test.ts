/**
 * The library layer, end to end: build tracks, write them, read them back
 * through the real indexes, and evaluate smart-playlist rules over them.
 *
 * Runs against `fake-indexeddb`, which is a real implementation — so the
 * compound indexes, the sparse-index trick behind favourites, and the ordering
 * guarantees are all genuinely exercised.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  countTracks,
  favorites,
  getTrack,
  mostPlayed,
  putTracks,
  recentlyAdded,
  recordPlay,
  setFavorite,
  setRating,
  trackIdsSorted,
  tracksByAlbum,
  tracksByArtist,
} from '@core/db/repositories/tracks';
import { rebuildAggregates, rebuildFolders } from '@core/library/importer';
import { childFolders, listAlbums, listArtists } from '@core/db/repositories/library';
import { buildTrack, albumIdFor, artistIdFor, trackIdFor } from '@core/library/trackBuilder';
import { matchesRuleSet, materialiseSmartPlaylist } from '@core/playlists/smart';
import { computeLibraryHealth } from '@core/library/health';
import type { ParsedAudio } from '@core/metadata';
import type { SmartRuleSet, Track } from '@core/types';

const SOURCE = 'src-1';

function parsed(overrides: Partial<ParsedAudio['tags']> = {}, durationMs = 180_000): ParsedAudio {
  return {
    tags: { pictures: [], ...overrides },
    stream: {
      format: 'flac',
      codec: 'FLAC',
      durationMs,
      bitrateKbps: 900,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      lossless: true,
    },
    warnings: [],
  };
}

function makeTrack(
  path: string,
  tags: Partial<ParsedAudio['tags']> = {},
  options: { existing?: Track; durationMs?: number; artworkId?: string | null } = {},
): Track {
  return buildTrack({
    sourceId: SOURCE,
    entry: { path, name: path.split('/').pop()!, sizeBytes: 5_000_000, lastModified: 1_700_000_000_000 },
    parsed: parsed(tags, options.durationMs ?? 180_000),
    artworkId: options.artworkId ?? null,
    hasLyrics: false,
    ...(options.existing ? { existing: options.existing } : {}),
    now: 1_700_000_000_000,
  });
}

/** A small but realistic library: two albums, a guest appearance, an untagged file. */
async function seedLibrary(): Promise<Track[]> {
  const tracks = [
    makeTrack('Radiohead/Kid A/01 Everything.flac', {
      title: 'Everything In Its Right Place',
      artist: 'Radiohead',
      album: 'Kid A',
      trackNo: 1,
      year: 2000,
      genre: ['Electronic'],
    }),
    makeTrack('Radiohead/Kid A/02 Kid A.flac', {
      title: 'Kid A',
      artist: 'Radiohead',
      album: 'Kid A',
      trackNo: 2,
      year: 2000,
      genre: ['Electronic'],
    }),
    makeTrack('Radiohead/Kid A/03 National Anthem.flac', {
      title: 'The National Anthem',
      artist: 'Radiohead',
      album: 'Kid A',
      trackNo: 3,
      year: 2000,
      genre: ['Electronic', 'Rock'],
    }),
    makeTrack('Burial/Untrue/01 Archangel.flac', {
      title: 'Archangel',
      artist: 'Burial',
      album: 'Untrue',
      trackNo: 1,
      year: 2007,
      genre: ['Electronic'],
    }),
    makeTrack('Burial/Untrue/02 Near Dark.flac', {
      title: 'Near Dark',
      // A collaboration: both artists must get the track.
      artist: 'Burial feat. Thom Yorke',
      albumArtist: 'Burial',
      album: 'Untrue',
      trackNo: 2,
      year: 2007,
    }),
    // No tags at all — falls back to the filename and the folder.
    makeTrack('Unsorted/some-bootleg-recording.flac'),
  ];

  await putTracks(tracks);
  return tracks;
}

describe('building a track', () => {
  it('is stable across rescans', () => {
    expect(trackIdFor(SOURCE, 'a/b.flac')).toBe(trackIdFor(SOURCE, 'a/b.flac'));
    expect(trackIdFor(SOURCE, 'a/b.flac')).not.toBe(trackIdFor('other', 'a/b.flac'));
  });

  it('falls back to the filename and folder when there are no tags', () => {
    const track = makeTrack('Soundtracks/Dune/04 - Paul Atreides.flac');

    // The leading track number is stripped from the derived title.
    expect(track.title).toBe('Paul Atreides');
    expect(track.artist).toBe('Unknown Artist');
    // Grouped by folder, not lumped into one global "Unknown Album".
    expect(track.album).toBe('Dune');
    expect(track.tagState).toBe('missing');
  });

  it('keeps two different albums with the same name apart', () => {
    const a = albumIdFor('Greatest Hits', 'Queen', { sourceId: SOURCE, directory: 'x' });
    const b = albumIdFor('Greatest Hits', 'ABBA', { sourceId: SOURCE, directory: 'y' });
    expect(a).not.toBe(b);
  });

  it('groups untagged files by their folder rather than merging them all', () => {
    const a = makeTrack('Bootlegs/Show A/01.flac');
    const b = makeTrack('Bootlegs/Show A/02.flac');
    const c = makeTrack('Bootlegs/Show B/01.flac');

    expect(a.albumId).toBe(b.albumId);
    expect(a.albumId).not.toBe(c.albumId);
  });

  it('credits every artist on a collaboration', () => {
    const track = makeTrack('x/y.flac', {
      title: 'Near Dark',
      artist: 'Burial feat. Thom Yorke',
      albumArtist: 'Burial',
      album: 'Untrue',
    });

    expect(track.artistIds).toContain(artistIdFor('Burial'));
    expect(track.artistIds).toContain(artistIdFor('Thom Yorke'));
    // The display string is never mangled by the split.
    expect(track.artist).toBe('Burial feat. Thom Yorke');
  });

  it('never loses the user’s data on a rescan', () => {
    const original = makeTrack('a/b.flac', { title: 'Old Title', artist: 'A' });
    const played: Track = {
      ...original,
      favorite: true,
      favoritedAt: 111,
      rating: 5,
      playCount: 42,
      skipCount: 3,
      lastPlayedAt: 999,
      addedAt: 555,
    };

    // The file was re-tagged on disk and rescanned.
    const rescanned = makeTrack('a/b.flac', { title: 'New Title', artist: 'A' }, { existing: played });

    expect(rescanned.title).toBe('New Title'); // tags come from the file
    expect(rescanned.favorite).toBe(true); // user data is carried over
    expect(rescanned.rating).toBe(5);
    expect(rescanned.playCount).toBe(42);
    expect(rescanned.skipCount).toBe(3);
    expect(rescanned.lastPlayedAt).toBe(999);
    expect(rescanned.addedAt).toBe(555); // not "added" again
  });

  it('indexes folder names for search, which no tag contains', () => {
    const track = makeTrack('Soundtracks/Blade Runner 2049/01 Flight.flac', { title: 'Flight' });
    expect(track.searchText).toContain('blade');
    expect(track.searchText).toContain('runner');
    expect(track.searchText).toContain('2049');
  });
});

describe('the tracks store', () => {
  beforeEach(async () => {
    await seedLibrary();
  });

  it('stores and counts every track', async () => {
    expect(await countTracks()).toBe(6);
  });

  it('sorts by title through the index, ignoring a leading article', async () => {
    const ids = await trackIdsSorted('title', 'asc');
    const titles = await Promise.all(ids.map(async (id) => (await getTrack(id))!.title));

    // "The National Anthem" sorts under N, not T.
    expect(titles.indexOf('The National Anthem')).toBeLessThan(titles.indexOf('Near Dark'));
    expect(titles).toHaveLength(6);
  });

  it('returns an album in disc and track order', async () => {
    const kidA = await tracksByAlbum(
      albumIdFor('Kid A', 'Radiohead', { sourceId: SOURCE, directory: '' }),
    );
    expect(kidA.map((track) => track.trackNo)).toEqual([1, 2, 3]);
  });

  it('finds a guest appearance on the guest’s own page', async () => {
    const thom = await tracksByArtist(artistIdFor('Thom Yorke'));
    expect(thom.map((track) => track.title)).toEqual(['Near Dark']);
  });

  it('keeps favourites in a sparse index, newest first', async () => {
    const ids = await trackIdsSorted('title');
    await setFavorite(ids[0]!, true);
    await setFavorite(ids[1]!, true);

    const faves = await favorites();
    expect(faves).toHaveLength(2);
    expect(faves.every((track) => track.favorite)).toBe(true);

    // Un-favouriting must remove it from the index, not leave a zero behind.
    await setFavorite(ids[0]!, false);
    expect(await favorites()).toHaveLength(1);
  });

  it('records plays and ratings', async () => {
    const ids = await trackIdsSorted('title');
    await recordPlay(ids[0]!, 120_000, true);
    await recordPlay(ids[0]!, 120_000, true);
    await recordPlay(ids[1]!, 120_000, true);
    await setRating(ids[2]!, 4);

    const top = await mostPlayed(10);
    expect(top[0]!.id).toBe(ids[0]);
    expect(top[0]!.playCount).toBe(2);
    expect((await getTrack(ids[2]!))!.rating).toBe(4);
  });

  it('clamps a rating to the 0–5 range', async () => {
    const ids = await trackIdsSorted('title');
    await setRating(ids[0]!, 99);
    expect((await getTrack(ids[0]!))!.rating).toBe(5);
    await setRating(ids[0]!, -3);
    expect((await getTrack(ids[0]!))!.rating).toBe(0);
  });

  it('lists recently added newest first', async () => {
    const recent = await recentlyAdded(3);
    expect(recent).toHaveLength(3);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1]!.addedAt).toBeGreaterThanOrEqual(recent[i]!.addedAt);
    }
  });
});

describe('derived albums, artists and folders', () => {
  beforeEach(async () => {
    await seedLibrary();
    await rebuildAggregates();
  });

  it('builds one album per release', async () => {
    const albums = await listAlbums();
    const names = albums.map((album) => album.name).sort();
    // Kid A, Untrue, and the folder-grouped "Unsorted".
    expect(names).toEqual(['Kid A', 'Unsorted', 'Untrue']);

    const kidA = albums.find((album) => album.name === 'Kid A')!;
    expect(kidA.trackCount).toBe(3);
    expect(kidA.year).toBe(2000);
    expect(kidA.durationMs).toBe(3 * 180_000);
    expect(kidA.lossless).toBe(true);
  });

  it('counts an artist’s albums and tracks, guests included', async () => {
    const artists = await listArtists();
    const burial = artists.find((artist) => artist.name === 'Burial')!;
    const thom = artists.find((artist) => artist.name === 'Thom Yorke')!;

    expect(burial.trackCount).toBe(2);
    expect(burial.albumCount).toBe(1);
    // A guest appearance counts for the guest too, but does not invent an album.
    expect(thom.trackCount).toBe(1);
  });

  it('builds the folder tree with the parent chain intact', async () => {
    const directories = new Map([
      ['Radiohead/Kid A', 3],
      ['Burial/Untrue', 2],
      ['Unsorted', 1],
    ]);
    await rebuildFolders(SOURCE, 'My Music', directories);

    const roots = await childFolders(null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('My Music');

    const top = await childFolders(roots[0]!.id);
    expect(top.map((folder) => folder.name).sort()).toEqual(['Burial', 'Radiohead', 'Unsorted']);

    const radiohead = top.find((folder) => folder.name === 'Radiohead')!;
    const kidA = await childFolders(radiohead.id);
    expect(kidA[0]!.name).toBe('Kid A');
    expect(kidA[0]!.trackCount).toBe(3);
  });
});

describe('smart playlist rules', () => {
  const track = (overrides: Partial<Track>): Track => ({
    ...makeTrack('a/b.flac', { title: 'T', artist: 'A', album: 'B' }),
    ...overrides,
  });

  it('matches numeric comparisons and ignores missing values', () => {
    const rules: SmartRuleSet = {
      match: 'all',
      rules: [{ field: 'year', operator: 'gt', value: 2020 }],
      sort: 'title',
      direction: 'asc',
      limit: null,
    };

    expect(matchesRuleSet(track({ year: 2024 }), rules)).toBe(true);
    expect(matchesRuleSet(track({ year: 1999 }), rules)).toBe(false);
    // An untagged track does not match "year > 2020" — and does not throw.
    expect(matchesRuleSet(track({ year: null }), rules)).toBe(false);
  });

  it('combines rules with all and any', () => {
    const all: SmartRuleSet = {
      match: 'all',
      rules: [
        { field: 'genre', operator: 'contains', value: 'rock' },
        { field: 'rating', operator: 'gte', value: 4 },
      ],
      sort: 'title',
      direction: 'asc',
      limit: null,
    };
    const any: SmartRuleSet = { ...all, match: 'any' };

    const rockUnrated = track({ genres: ['Rock'], rating: 0 });
    expect(matchesRuleSet(rockUnrated, all)).toBe(false);
    expect(matchesRuleSet(rockUnrated, any)).toBe(true);
    expect(matchesRuleSet(track({ genres: ['Rock'], rating: 5 }), all)).toBe(true);
  });

  it('matches boolean and emptiness operators', () => {
    const favourite: SmartRuleSet = {
      match: 'all',
      rules: [{ field: 'favorite', operator: 'isTrue' }],
      sort: 'title',
      direction: 'asc',
      limit: null,
    };
    expect(matchesRuleSet(track({ favorite: true }), favourite)).toBe(true);
    expect(matchesRuleSet(track({ favorite: false }), favourite)).toBe(false);

    const neverPlayed: SmartRuleSet = { ...favourite, rules: [{ field: 'playCount', operator: 'isEmpty' }] };
    expect(matchesRuleSet(track({ playCount: 0 }), neverPlayed)).toBe(true);
    expect(matchesRuleSet(track({ playCount: 7 }), neverPlayed)).toBe(false);
  });

  it('matches a relative date window', () => {
    const recent: SmartRuleSet = {
      match: 'all',
      rules: [{ field: 'addedAt', operator: 'inLastDays', value: 30 }],
      sort: 'addedAt',
      direction: 'desc',
      limit: null,
    };

    expect(matchesRuleSet(track({ addedAt: Date.now() - 5 * 86_400_000 }), recent)).toBe(true);
    expect(matchesRuleSet(track({ addedAt: Date.now() - 90 * 86_400_000 }), recent)).toBe(false);
  });

  it('materialises against the real store, sorted and limited', async () => {
    await seedLibrary();

    const electronic: SmartRuleSet = {
      match: 'all',
      rules: [{ field: 'genre', operator: 'contains', value: 'electronic' }],
      sort: 'title',
      direction: 'asc',
      limit: 2,
    };

    const result = await materialiseSmartPlaylist(electronic);
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.genres.some((genre) => /electronic/i.test(genre)))).toBe(true);
  });
});

describe('library health', () => {
  it('reports completeness and finds duplicates', async () => {
    await seedLibrary();

    // The same song, once as FLAC and once as a lower-bitrate copy.
    const flac = makeTrack('Dupes/song.flac', { title: 'Twice Over', artist: 'Someone' });
    const mp3: Track = {
      ...makeTrack('Dupes/song.mp3', { title: 'Twice Over', artist: 'Someone' }),
      format: 'mp3',
      lossless: false,
      bitrateKbps: 192,
      // A second of difference must still be recognised as the same recording.
      durationMs: 181_000,
    };
    await putTracks([flac, mp3]);

    const { health } = await computeLibraryHealth();

    expect(health.trackCount).toBe(8);
    // One track in the seed has no tags at all.
    expect(health.missingMetadata).toBeGreaterThan(0);
    expect(health.withArtwork).toBe(0);
    expect(health.missingArtwork).toBe(8);

    const duplicates = health.duplicateGroups;
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.title).toBe('Twice Over');
    expect(duplicates[0]!.trackIds).toHaveLength(2);
  });

  it('does not flag a live version as a duplicate of the studio one', async () => {
    const studio = makeTrack('a/studio.flac', { title: 'Song', artist: 'Band' }, { durationMs: 180_000 });
    const live = makeTrack('b/live.flac', { title: 'Song', artist: 'Band' }, { durationMs: 320_000 });
    await putTracks([studio, live]);

    const { health } = await computeLibraryHealth();
    expect(health.duplicateGroups).toHaveLength(0);
  });
});
