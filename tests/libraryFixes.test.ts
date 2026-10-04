/**
 * Regression tests for the database fixes in docs/REVIEW.md ("Library,
 * database, metadata" items 1–5, 13): forgetting a source, sparse-index sorts,
 * artwork pruning, lyrics surviving a rescan, and the album-artist link.
 */

import { describe, expect, it, vi } from 'vitest';
import { getTrack, putTracks, recordPlay, trackIdsSorted } from '@core/db/repositories/tracks';
import { getAlbum, listAlbums, listArtists, putSource } from '@core/db/repositories/library';
import { putArtistPhoto } from '@core/db/repositories/artistPhotos';
import { getArtwork, pruneOrphanArtwork, putArtworkBatch } from '@core/db/repositories/artwork';
import { addTracksToPlaylist, createPlaylist, playlistTrackIds } from '@core/db/repositories/playlists';
import { putLyrics, getLyrics } from '@core/db/repositories/lyrics';
import { getDb } from '@core/db/database';
import { withTransaction } from '@core/db/idb';
import { Stores } from '@core/db/schema';
import { rebuildAggregates } from '@core/library/importer';
import { scanSource } from '@core/library/scanner';
import { artistIdFor, buildTrack, VARIOUS_ARTISTS } from '@core/library/trackBuilder';
import { registerProvider } from '@core/platform';
import type { SourceProvider } from '@core/platform/fs';
import { useLibrary } from '@state/libraryStore';
import type { ParsedAudio } from '@core/metadata';
import type { Artwork, MusicSource, Track } from '@core/types';
import { buildFlac, toBlob } from './fixtures';

function parsed(tags: Partial<ParsedAudio['tags']> = {}): ParsedAudio {
  return {
    tags: { pictures: [], ...tags },
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
}

function makeTrack(
  sourceId: string,
  path: string,
  tags: Partial<ParsedAudio['tags']> = {},
  artworkId: string | null = null,
): Track {
  return buildTrack({
    sourceId,
    entry: { path, name: path.split('/').pop()!, sizeBytes: 1000, lastModified: 1 },
    parsed: parsed(tags),
    artworkId,
    hasLyrics: false,
    now: 1_700_000_000_000,
  });
}

function artwork(id: string): Artwork {
  return { id, sizeBytes: 10 } as unknown as Artwork;
}

describe('sparse-index sorts', () => {
  it('"Recently played" keeps never-played tracks, after the played ones', async () => {
    const tracks = ['a', 'b', 'c', 'd'].map((name) => makeTrack('s', `${name}.flac`, { title: name }));
    await putTracks(tracks);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_800_000_000_000);
    await recordPlay(tracks[2]!.id, 1000, true);
    now.mockReturnValue(1_800_000_100_000);
    await recordPlay(tracks[0]!.id, 1000, true);
    now.mockRestore();

    const desc = await trackIdsSorted('lastPlayedAt', 'desc');
    expect(desc).toHaveLength(4);
    expect(desc.slice(0, 2)).toEqual([tracks[0]!.id, tracks[2]!.id]);
    expect(new Set(desc.slice(2))).toEqual(new Set([tracks[1]!.id, tracks[3]!.id]));

    const asc = await trackIdsSorted('lastPlayedAt', 'asc');
    expect(asc.slice(0, 2)).toEqual([tracks[2]!.id, tracks[0]!.id]);
    expect(asc).toHaveLength(4);
  });

  it('"Year" keeps albums without a year, last in either direction', async () => {
    await putTracks([
      makeTrack('s', 'x/1.flac', { album: 'Old', artist: 'A', year: 1990 }),
      makeTrack('s', 'y/1.flac', { album: 'Undated', artist: 'A' }),
      makeTrack('s', 'z/1.flac', { album: 'New', artist: 'A', year: 2020 }),
    ]);
    await rebuildAggregates();

    expect((await listAlbums('year', 'asc')).map((album) => album.name)).toEqual(['Old', 'New', 'Undated']);
    expect((await listAlbums('year', 'desc')).map((album) => album.name)).toEqual(['New', 'Old', 'Undated']);
  });
});

describe('pruning orphan artwork', () => {
  it('keeps artwork referenced by a track or by an artist photo', async () => {
    await putArtworkBatch([artwork('track-art'), artwork('photo-art'), artwork('orphan')]);
    await putTracks([makeTrack('s', 'a.flac', { title: 'a' }, 'track-art')]);
    await putArtistPhoto({ id: artistIdFor('Someone'), artworkId: 'photo-art', source: 'deezer', updatedAt: 1 });

    const result = await pruneOrphanArtwork();
    expect(result.deleted).toBe(1);
    expect(await getArtwork('track-art')).toBeDefined();
    expect(await getArtwork('photo-art')).toBeDefined();
    expect(await getArtwork('orphan')).toBeUndefined();
  });
});

describe('album artist', () => {
  it('links an album to its album-artist credit, not the first track artist', async () => {
    await putTracks([
      makeTrack('s', 'comp/1.flac', { album: 'Hits', artist: 'Guest One', albumArtist: VARIOUS_ARTISTS }),
      makeTrack('s', 'comp/2.flac', { album: 'Hits', artist: 'Guest Two', albumArtist: VARIOUS_ARTISTS }),
    ]);
    await rebuildAggregates();
    const albums = await listAlbums();
    expect(albums).toHaveLength(1);
    expect(albums[0]!.albumArtistId).toBe(artistIdFor(VARIOUS_ARTISTS));
    expect((await listArtists()).some((artist) => artist.id === artistIdFor(VARIOUS_ARTISTS))).toBe(true);
  });

  it('groups a compilation-flagged album with no album artist under Various Artists', async () => {
    const a = makeTrack('s', 'comp/1.flac', { album: 'Hits', artist: 'Guest One', compilation: true });
    const b = makeTrack('s', 'comp/2.flac', { album: 'Hits', artist: 'Guest Two', compilation: true });
    expect(a.albumId).toBe(b.albumId);
    await putTracks([a, b]);
    await rebuildAggregates();
    expect((await getAlbum(a.albumId))!.albumArtistId).toBe(artistIdFor(VARIOUS_ARTISTS));
  });

  it('falls back to the track artist without an album-artist tag', async () => {
    const track = makeTrack('s', 'x/1.flac', { album: 'Solo', artist: 'Main feat. Guest' });
    await putTracks([track]);
    await rebuildAggregates();
    expect((await getAlbum(track.albumId))!.albumArtistId).toBe(artistIdFor('Main'));
  });
});

describe('forgetting a source', () => {
  it('rebuilds albums/artists and prunes playlist entries', async () => {
    const keep = makeTrack('keep', 'k/1.flac', { album: 'Kept', artist: 'Stays' });
    const gone = makeTrack('gone', 'g/1.flac', { album: 'Gone', artist: 'Leaves' });
    await putTracks([keep, gone]);
    await rebuildAggregates();

    const source: MusicSource = {
      id: 'gone',
      kind: 'imported',
      name: 'Gone',
      addedAt: 1,
      lastScanAt: null,
      trackCount: 1,
      handleKey: null,
    };
    await putSource(source);
    registerProvider({
      sourceId: 'gone',
      kind: 'imported',
      name: 'Gone',
      dispose: async () => undefined,
    } as unknown as SourceProvider);

    const playlist = await createPlaylist({ name: 'Mix' });
    await addTracksToPlaylist(playlist.id, [keep.id, gone.id]);

    useLibrary.setState({ sources: [source] });
    await useLibrary.getState().forgetSource('gone');
    expect(useLibrary.getState().error).toBeNull();

    expect((await listAlbums()).map((album) => album.name)).toEqual(['Kept']);
    expect((await listArtists()).map((artist) => artist.name)).toEqual(['Stays']);
    expect(await playlistTrackIds(playlist.id)).toEqual([keep.id]);
  });
});

describe('rescanning a changed file', () => {
  it('keeps online lyrics and hasLyrics', async () => {
    let modified = 1;
    const file = () =>
      new File(
        [toBlob(buildFlac({ sampleRate: 44100, channels: 2, bitDepth: 16, totalSamples: 44100 }, ['TITLE=Song', 'LYRICS=embedded words']))],
        'song.flac',
        { lastModified: modified },
      );
    const provider = {
      sourceId: 'lyr',
      kind: 'imported',
      name: 'Lyr',
      async *list() {
        const f = file();
        yield { path: 'song.flac', name: 'song.flac', sizeBytes: f.size, lastModified: modified };
      },
      open: async () => file(),
      access: async () => 'granted',
      dispose: async () => undefined,
    } as unknown as SourceProvider;

    await scanSource(provider, { mode: 'full' });
    const [id] = await trackIdsSorted('title');
    expect((await getTrack(id!))!.hasLyrics).toBe(true);

    await putLyrics({
      id: id!,
      trackId: id!,
      kind: 'plain',
      text: 'online words',
      lines: null,
      language: null,
      source: 'online',
      updatedAt: 2,
    } as Parameters<typeof putLyrics>[0]);

    modified = 2;
    await scanSource(provider, { mode: 'incremental' });
    expect((await getLyrics(id!))!.text).toBe('online words');
    expect((await getTrack(id!))!.hasLyrics).toBe(true);
  });
});

describe('failed transactions', () => {
  it('reject once, without an unhandled rejection', async () => {
    const db = await getDb();
    await expect(
      withTransaction(db, Stores.settings, 'readwrite', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
