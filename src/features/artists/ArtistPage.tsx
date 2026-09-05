/**
 * Artist detail (spec §29).
 *
 * Shows the artist's albums, then every track they appear on — including guest
 * appearances, because the scanner indexes each credited artist separately
 * (see core/library/importer.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ImagePlus, ListPlus, Loader2, Play, Shuffle, Trash2, Users } from 'lucide-react';
import { albumsByArtist, getArtist } from '@core/db/repositories/library';
import {
  fetchAndStoreArtistPhoto,
  getCachedArtistPhoto,
  removeArtistPhoto,
} from '@core/artists/onlinePhoto';
import { tracksByArtist } from '@core/db/repositories/tracks';
import { formatCount, formatDurationLong } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import type { Album, Artist, Track } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, EmptyState, IconButton, SectionHeader, Spinner } from '@ui/primitives';
import { PageHeader, trackStats } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';
import { AlbumCard } from '../albums/AlbumsPage';

export function ArtistPage() {
  const { artistId } = useParams<{ artistId: string }>();
  const revision = useLibrary((state) => state.revision);
  const navigate = useNavigate();
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);
  const onlineArtworkEnabled = useSettings((state) => state.onlineArtwork);
  const toast = useUi((state) => state.toast);

  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [photoArtworkId, setPhotoArtworkId] = useState<string | null>(null);
  const [findingPhoto, setFindingPhoto] = useState(false);
  /** The remove button stays out of the way until the photo itself is tapped. */
  const [showRemove, setShowRemove] = useState(false);

  // The one load that actually gates the page. A cached photo lookup used to
  // ride along in this same Promise.all — if that lookup ever failed (a
  // missing store on a half-migrated database, for example), the whole
  // Promise.all rejected, nothing here ever ran, and the page spun forever.
  // It is deliberately not here any more; see the photo effect below.
  useEffect(() => {
    if (!artistId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([getArtist(artistId), albumsByArtist(artistId), tracksByArtist(artistId)])
      .then(([foundArtist, foundAlbums, foundTracks]) => {
        if (cancelled) return;
        setArtist(foundArtist ?? null);
        setAlbums(foundAlbums);
        setTracks(foundTracks);
      })
      .catch(() => {
        if (!cancelled) setArtist(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artistId, revision]);

  // A cached photo, if one has already been fetched. Kept in its own effect,
  // off the critical path above: this is a nice-to-have, and must never be
  // able to block the artist's own albums and tracks from showing up.
  useEffect(() => {
    setShowRemove(false);
    if (!artistId) {
      setPhotoArtworkId(null);
      return;
    }
    let cancelled = false;
    void getCachedArtistPhoto(artistId).then((found) => {
      if (!cancelled) setPhotoArtworkId(found);
    });
    return () => {
      cancelled = true;
    };
  }, [artistId, revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);

  /**
   * Look this artist up on Deezer.
   *
   * Only ever reached from a click, and only when "Online artwork" is on
   * (spec §32) — nothing here runs on its own (spec §4).
   */
  const findPhotoNow = useCallback(async () => {
    if (!artist) return;
    setFindingPhoto(true);
    try {
      const found = await fetchAndStoreArtistPhoto(artist);
      if (!found) {
        toast(`No photo found for ${artist.name}.`, { kind: 'warn' });
        return;
      }
      setPhotoArtworkId(found);
      toast(`Found a photo for ${artist.name}.`, { kind: 'success' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Photo lookup failed.', { kind: 'error' });
    } finally {
      setFindingPhoto(false);
    }
  }, [artist, toast]);

  /**
   * Undo a wrong match. Deezer's name matching is a best guess (see
   * core/artists/onlinePhoto.ts) and can pick the wrong person, especially
   * for two different real people who share a name — this reverts the
   * artist back to the honest placeholder rather than leaving a wrong photo
   * with no way out.
   */
  const removePhotoNow = useCallback(async () => {
    if (!artist) return;
    try {
      await removeArtistPhoto(artist.id);
      setPhotoArtworkId(null);
      setShowRemove(false);
      toast(`Removed the photo for ${artist.name}.`, { kind: 'success' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not remove the photo.', {
        kind: 'error',
      });
    }
  }, [artist, toast]);

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
          <div className="relative h-32 w-32 shrink-0 sm:h-44 sm:w-44">
            {/* `artist.artworkId` is really "one of their album covers" — see
                ArtistsPage.tsx's ArtistCard for why that never belongs here.
                `photoArtworkId` is a real photo, fetched below. Tapping the
                photo itself is what reveals the remove button below — it
                stays out of the way otherwise, since it's destructive and
                only relevant once a (possibly wrong) photo is already showing. */}
            <button
              type="button"
              onClick={() => photoArtworkId && setShowRemove((shown) => !shown)}
              className="block h-full w-full rounded-full focus-visible:outline-offset-4"
              aria-label={photoArtworkId ? `${artist.name} photo — tap for options` : artist.name}
            >
              <Artwork
                artworkId={photoArtworkId}
                name={artist.name}
                full
                rounded="full"
                className="h-full w-full shadow-card"
                decorative
              />
            </button>
            {onlineArtworkEnabled && (
              <IconButton
                label={photoArtworkId ? 'Look for a different photo' : 'Find a photo online'}
                size={32}
                className="absolute bottom-1 right-1 border border-line bg-surface shadow-card"
                disabled={findingPhoto}
                onClick={() => void findPhotoNow()}
              >
                {findingPhoto ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImagePlus className="h-4 w-4" />
                )}
              </IconButton>
            )}
            {onlineArtworkEnabled && photoArtworkId && showRemove && (
              <IconButton
                label="Remove this photo"
                size={32}
                className="absolute bottom-1 left-1 border border-line bg-surface text-danger shadow-card"
                disabled={findingPhoto}
                onClick={() => void removePhotoNow()}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </div>
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
