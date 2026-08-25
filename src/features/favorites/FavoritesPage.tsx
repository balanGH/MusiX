/**
 * Favourites (spec §22).
 *
 * Backed by the sparse `favoritedAt` index, so this is an index scan over
 * exactly the favourites rather than a filter over the library — see the note
 * in core/db/schema.ts about why booleans became nullable timestamps.
 */

import { useEffect, useMemo, useState } from 'react';
import { Heart } from 'lucide-react';
import { favorites } from '@core/db/repositories/tracks';
import { formatDurationLong } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useUi } from '@state/uiStore';
import { playerActions } from '@state/playerStore';
import type { Track } from '@core/types';
import { Button, EmptyState, Spinner } from '@ui/primitives';
import { PageHeader, PlayActions, trackStats } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';

export function FavoritesPage() {
  const revision = useLibrary((state) => state.revision);
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void favorites().then((result) => {
      if (cancelled) return;
      setTracks(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);
  const totalDuration = useMemo(
    () => tracks.reduce((sum, track) => sum + track.durationMs, 0),
    [tracks],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const header = (
    <PageHeader
      eyebrow="Collection"
      title="Favourites"
      stats={trackStats(tracks.length, totalDuration)}
      subtitle={
        tracks.length > 0
          ? `${formatDurationLong(totalDuration)} of music you marked as a favourite`
          : undefined
      }
      actions={
        <>
          <PlayActions
            count={ids.length}
            onPlay={() => void playerActions.playTracks(ids, 0, false)}
            onShuffle={() => void playerActions.playTracks(ids, 0, true)}
            onAddToQueue={() => playerActions.addToQueue(ids)}
          />
          {ids.length > 0 && (
            <Button variant="ghost" onClick={() => openAddToPlaylist(ids)}>
              Save as playlist
            </Button>
          )}
        </>
      }
    />
  );

  return (
    <TrackList
      ids={ids}
      ariaLabel="Favourite tracks"
      header={header}
      emptyState={
        <EmptyState
          icon={<Heart className="h-8 w-8" />}
          title="No favourites yet"
          body="Tap the heart on any track — in a list, in the player bar, or in Now Playing — and it will show up here."
        />
      }
    />
  );
}
