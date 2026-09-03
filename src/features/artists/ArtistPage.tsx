/**
 * Artist detail (spec §29).
 *
 * Shows the artist's albums, then every track they appear on — including guest
 * appearances, because the scanner indexes each credited artist separately
 * (see core/library/importer.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ListPlus, Play, Shuffle, Users } from 'lucide-react';
import { albumsByArtist, getArtist } from '@core/db/repositories/library';
import { tracksByArtist } from '@core/db/repositories/tracks';
import { formatCount, formatDurationLong } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Album, Artist, Track } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, EmptyState, SectionHeader, Spinner } from '@ui/primitives';
import { PageHeader, trackStats } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';
import { AlbumCard } from '../albums/AlbumsPage';

export function ArtistPage() {
  const { artistId } = useParams<{ artistId: string }>();
  const revision = useLibrary((state) => state.revision);
  const navigate = useNavigate();
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);

  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!artistId) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      getArtist(artistId),
      albumsByArtist(artistId),
      tracksByArtist(artistId),
    ]).then(([foundArtist, foundAlbums, foundTracks]) => {
      if (cancelled) return;
      setArtist(foundArtist ?? null);
      setAlbums(foundAlbums);
      setTracks(foundTracks);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [artistId, revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (!artist) {
    return (
      <EmptyState
        icon={<Users className="h-8 w-8" />}
        title="Artist not found"
        body="They may have been removed by a rescan."
        action={<Button onClick={() => navigate('/artists')}>Back to artists</Button>}
      />
    );
  }

  const header = (
    <div>
      <PageHeader
        eyebrow="Artist"
        title={artist.name}
        artwork={
          // `artist.artworkId` is really "one of their album covers" — see
          // ArtistsPage.tsx's ArtistCard for why that never belongs here.
          <Artwork
            artworkId={null}
            name={artist.name}
            full
            rounded="full"
            className="h-32 w-32 shadow-card sm:h-44 sm:w-44"
          />
        }
        stats={
          <span className="flex flex-wrap gap-x-2">
            <span>
              {formatCount(artist.albumCount)} album{artist.albumCount === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>{trackStats(artist.trackCount, artist.durationMs)}</span>
            {artist.genres.length > 0 && (
              <>
                <span>·</span>
                <span className="truncate">{artist.genres.slice(0, 3).join(', ')}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => void playerActions.playTracks(ids, 0, false)}
              disabled={ids.length === 0}
            >
              <Play className="h-4 w-4 fill-current" />
              Play
            </Button>
            <Button
              variant="secondary"
              onClick={() => void playerActions.playTracks(ids, 0, true)}
              disabled={ids.length === 0}
            >
              <Shuffle className="h-4 w-4" />
              Shuffle
            </Button>
            <Button variant="ghost" onClick={() => playerActions.addToQueue(ids)}>
              <ListPlus className="h-4 w-4" />
              Add to queue
            </Button>
            <Button variant="ghost" onClick={() => openAddToPlaylist(ids)}>
              Add to playlist
            </Button>
          </>
        }
      />

      {albums.length > 0 && (
        <section className="px-4 pb-2 sm:px-6">
          <SectionHeader
            title="Albums"
            subtitle={`${formatCount(albums.length)} · ${formatDurationLong(
              albums.reduce((sum, album) => sum + album.durationMs, 0),
            )}`}
          />
          {/* A horizontal strip rather than a grid: an artist page is about the
              track list, and albums here are a shortcut, not the main content. */}
          <div className="mx-scroll -mx-1 mt-3 flex gap-4 overflow-x-auto px-1 pb-2">
            {albums.map((album) => (
              <div key={album.id} className="w-36 shrink-0">
                <AlbumCard album={album} />
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="px-4 pt-4 sm:px-6">
        <SectionHeader title="Tracks" subtitle={trackStats(tracks.length, artist.durationMs)} />
      </div>
    </div>
  );

  return (
    <TrackList
      ids={ids}
      ariaLabel={`Tracks by ${artist.name}`}
      header={header}
      showAlbum
      emptyState={<EmptyState title="No tracks" body="This artist has no playable tracks." />}
    />
  );
}
