/**
 * The virtualised track list, used by Songs, Album, Artist, Folder, Playlist
 * and Search.
 *
 * It takes an *ordered list of ids* rather than records. That is the whole
 * performance story of the app: the ids come from one keys-only IndexedDB
 * request, and only the ~30 records on screen are ever fetched or rendered
 * (spec §35).
 */

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTracks } from '@core/db/repositories/tracks';
import { playerActions, usePlayer } from '@state/playerStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import type { Track } from '@core/types';
import { VirtualList, useWindowedRecords } from './VirtualList';
import {
  ROW_HEIGHT_COMFORTABLE,
  ROW_HEIGHT_COMPACT,
  TrackRow,
  trackMenuItems,
} from './TrackRow';

export interface TrackListProps {
  /** Ordered track ids. */
  ids: string[];
  ariaLabel: string;
  header?: React.ReactNode;
  emptyState?: React.ReactNode;
  showArtwork?: boolean;
  showAlbum?: boolean;
  /** Show each track's own number, as on an album page. */
  useTrackNumber?: boolean;
  /** Adds a "Remove from …" menu item. */
  onRemove?: { label: string; run(trackId: string, index: number): void };
  paddingBottom?: number;
  className?: string;
}

export function TrackList({
  ids,
  ariaLabel,
  header,
  emptyState,
  showArtwork = true,
  showAlbum = true,
  useTrackNumber = false,
  onRemove,
  paddingBottom = 24,
  className,
}: TrackListProps) {
  const navigate = useNavigate();
  const density = useSettings((state) => state.listDensity);
  const currentTrackId = usePlayer((state) => state.track?.id ?? null);
  const isPlaying = usePlayer((state) => state.status === 'playing');
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);

  const rowHeight = density === 'compact' ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_COMFORTABLE;

  const fetch = useCallback((wanted: string[]) => getTracks(wanted), []);
  const identify = useCallback((track: Track) => track.id, []);
  const { records, onRangeChange, refresh } = useWindowedRecords(ids, fetch, identify);

  // Favourite state lives on the record, so toggling has to update the copy
  // the list is holding as well as the database. Routed through the player
  // (not the repository directly) so that a row which happens to be the
  // currently-playing track keeps the player bar and Now Playing's hearts in
  // sync too, rather than leaving them stuck on the pre-toggle state.
  const toggleFavorite = useCallback(
    async (track: Track) => {
      await playerActions.setFavorite(track.id, !track.favorite);
      await refresh([track.id]);
    },
    [refresh],
  );

  const renderRow = useCallback(
    (index: number) => {
      const id = ids[index];
      const track = id ? records.get(id) : undefined;

      return (
        <TrackRow
          track={track}
          index={index + 1}
          useTrackNumber={useTrackNumber}
          isCurrent={track?.id === currentTrackId}
          isPlaying={isPlaying}
          showArtwork={showArtwork}
          showAlbum={showAlbum}
          compact={density === 'compact'}
          onPlay={() => void playerActions.playTracks(ids, index)}
          onToggleFavorite={() => {
            if (track) void toggleFavorite(track);
          }}
          menuItems={
            track
              ? trackMenuItems({
                  onPlayNext: () => playerActions.playNext([track.id]),
                  onAddToQueue: () => playerActions.addToQueue([track.id]),
                  onAddToPlaylist: () => openAddToPlaylist([track.id]),
                  onGoToAlbum: () => navigate(`/albums/${track.albumId}`),
                  onGoToArtist: track.artistIds[0]
                    ? () => navigate(`/artists/${track.artistIds[0]}`)
                    : undefined,
                  ...(onRemove
                    ? { onRemove: { label: onRemove.label, run: () => onRemove.run(track.id, index) } }
                    : {}),
                })
              : []
          }
        />
      );
    },
    [
      ids,
      records,
      useTrackNumber,
      currentTrackId,
      isPlaying,
      showArtwork,
      showAlbum,
      density,
      toggleFavorite,
      openAddToPlaylist,
      navigate,
      onRemove,
    ],
  );

  return (
    <VirtualList
      count={ids.length}
      rowHeight={rowHeight}
      renderRow={renderRow}
      header={header}
      emptyState={emptyState}
      onRangeChange={onRangeChange}
      paddingBottom={paddingBottom}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}

/**
 * Play/shuffle buttons shared by every list header.
 *
 * Kept here so "Play" and "Shuffle" behave identically on nine pages instead of
 * being reimplemented nine times.
 */
export function useListPlayback(ids: string[]) {
  return useMemo(
    () => ({
      play: () => void playerActions.playTracks(ids, 0, false),
      shuffle: () => void playerActions.playTracks(ids, 0, true),
      playNext: () => playerActions.playNext(ids),
      addToQueue: () => playerActions.addToQueue(ids),
      count: ids.length,
    }),
    [ids],
  );
}
