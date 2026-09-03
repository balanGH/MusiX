/**
 * Album detail (spec §30).
 *
 * Multi-disc albums get disc headings; single-disc ones do not, because a
 * "Disc 1" heading on an album that has only one disc is noise.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Disc3, ListPlus, Play, Shuffle } from 'lucide-react';
import { getAlbum } from '@core/db/repositories/library';
import { tracksByAlbum } from '@core/db/repositories/tracks';
import { formatDurationLong } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions, usePlayer } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Album, Track } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, Chip, EmptyState, Spinner, cx } from '@ui/primitives';
import { PageHeader, trackStats } from '@ui/PageHeader';
import { TrackRow, trackMenuItems } from '@ui/TrackRow';

export function AlbumPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const revision = useLibrary((state) => state.revision);
  const navigate = useNavigate();
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);
  const currentTrackId = usePlayer((state) => state.track?.id ?? null);
  const isPlaying = usePlayer((state) => state.status === 'playing');

  const [album, setAlbum] = useState<Album | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!albumId) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([getAlbum(albumId), tracksByAlbum(albumId)]).then(([found, rows]) => {
      if (cancelled) return;
      setAlbum(found ?? null);
      setTracks(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [albumId, revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);

  /** Group by disc, but only when there is more than one. */
  const discs = useMemo(() => {
    const map = new Map<number, Track[]>();
    for (const track of tracks) {
      const disc = track.discNo ?? 1;
      const bucket = map.get(disc);
      if (bucket) bucket.push(track);
      else map.set(disc, [track]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [tracks]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (!album) {
    return (
      <EmptyState
        icon={<Disc3 className="h-8 w-8" />}
        title="Album not found"
        body="It may have been removed by a rescan."
        action={<Button onClick={() => navigate('/albums')}>Back to albums</Button>}
      />
    );
  }

  const totalDuration = tracks.reduce((sum, track) => sum + track.durationMs, 0);
  const showDiscHeadings = discs.length > 1;

  return (
    <div className="mx-scroll flex-1">
      <PageHeader
        eyebrow="Album"
        title={album.name}
        artwork={
          <Artwork
            artworkId={album.artworkId}
            name={album.name}
            full
            rounded="lg"
            className="h-40 w-40 shadow-card sm:h-52 sm:w-52"
          />
        }
        subtitle={
          <Link
            to={`/artists/${album.albumArtistId}`}
            className="font-medium text-text hover:underline"
          >
            {album.albumArtist}
          </Link>
        }
        stats={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {album.year && <span>{album.year}</span>}
            <span>·</span>
            <span>{trackStats(tracks.length, totalDuration)}</span>
            {album.genres.length > 0 && (
              <>
                <span>·</span>
                <span className="truncate">{album.genres.slice(0, 3).join(', ')}</span>
              </>
            )}
            <span className="flex gap-1">
              {album.formats.map((format) => (
                <Chip key={format} tone={album.lossless ? 'accent' : 'neutral'}>
                  {format}
                </Chip>
              ))}
            </span>
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

      <div className="px-2 pb-8 sm:px-4">
        {discs.map(([discNumber, discTracks]) => (
          <section key={discNumber}>
            {showDiscHeadings && (
              <h2 className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wider text-subtle">
                Disc {discNumber}
              </h2>
            )}
            <ul>
              {discTracks.map((track) => {
                const index = ids.indexOf(track.id);
                return (
                  <li key={track.id} style={{ height: 52 }}>
                    <TrackRow
                      track={track}
                      useTrackNumber
                      isCurrent={track.id === currentTrackId}
                      isPlaying={isPlaying}
                      showArtwork={false}
                      showAlbum={false}
                      onPlay={() => void playerActions.playTracks(ids, index)}
                      onToggleFavorite={() => {
                        // Update local state immediately; the write is the
                        // slower half and the row should not wait for it.
                        setTracks((current) =>
                          current.map((row) =>
                            row.id === track.id ? { ...row, favorite: !row.favorite } : row,
                          ),
                        );
                        // Through the player, not the repository directly: if
                        // this row happens to be the currently-playing track,
                        // the player bar and Now Playing need to hear about it
                        // too, or their heart silently stops reflecting reality.
                        void playerActions.setFavorite(track.id, !track.favorite);
                      }}
                      menuItems={trackMenuItems({
                        onPlayNext: () => playerActions.playNext([track.id]),
                        onAddToQueue: () => playerActions.addToQueue([track.id]),
                        onAddToPlaylist: () => openAddToPlaylist([track.id]),
                        onGoToArtist: track.artistIds[0]
                          ? () => navigate(`/artists/${track.artistIds[0]}`)
                          : undefined,
                      })}
                      className={cx('h-[52px]')}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {tracks.length === 0 && (
          <EmptyState title="This album has no playable tracks" body="They may have been removed." />
        )}

        <p className="px-3 pt-4 text-2xs text-subtle">
          {tracks.length} track{tracks.length === 1 ? '' : 's'} ·{' '}
          {formatDurationLong(totalDuration)}
        </p>
      </div>
    </div>
  );
}
