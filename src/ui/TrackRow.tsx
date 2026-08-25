/**
 * One row in a track list.
 *
 * This component is rendered thirty times on screen and re-rendered on scroll,
 * so it does no work: every string it shows was precomputed at scan time, and
 * it is memoised on the fields it actually reads.
 */

import { memo } from 'react';
import { Heart, ListPlus, MoreHorizontal, Music4, Play, Trash2 } from 'lucide-react';
import { formatDuration, formatQuality } from '@core/utils';
import type { Track } from '@core/types';
import { Chip, IconButton, Menu, cx, type MenuItem } from './primitives';
import { Artwork } from './Artwork';

export interface TrackRowProps {
  track: Track | undefined;
  /** 1-based number shown in the leading column. */
  index?: number;
  /** Show the track's own number rather than its position in the list. */
  useTrackNumber?: boolean;
  isCurrent: boolean;
  isPlaying: boolean;
  showArtwork?: boolean;
  showAlbum?: boolean;
  compact?: boolean;
  onPlay(): void;
  onToggleFavorite(): void;
  menuItems?: MenuItem[];
  className?: string;
}

export const ROW_HEIGHT_COMFORTABLE = 56;
export const ROW_HEIGHT_COMPACT = 44;

/** Placeholder for a row whose record has not arrived yet. */
function LoadingRow({ compact }: { compact?: boolean }) {
  return (
    <div className={cx('flex h-full items-center gap-3 px-3', compact && 'gap-2.5')}>
      <div className="h-4 w-6 animate-pulse rounded bg-surface-hover" />
      <div className="h-3 w-48 animate-pulse rounded bg-surface-hover" />
    </div>
  );
}

export const TrackRow = memo(function TrackRow({
  track,
  index,
  useTrackNumber,
  isCurrent,
  isPlaying,
  showArtwork = true,
  showAlbum = true,
  compact = false,
  onPlay,
  onToggleFavorite,
  menuItems = [],
  className,
}: TrackRowProps) {
  if (!track) return <LoadingRow compact={compact} />;

  const number = useTrackNumber ? track.trackNo : index;

  return (
    <div
      className={cx(
        'group/row flex h-full items-center gap-3 rounded-lg px-2 transition-colors',
        isCurrent ? 'bg-accent/10' : 'hover:bg-surface-hover',
        className,
      )}
      // Double-click plays, matching every desktop music app.
      onDoubleClick={onPlay}
    >
      {/* Number, replaced by a play button on hover and by bars when current. */}
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        {isCurrent && isPlaying ? (
          <div className="mx-bars flex h-3.5 items-end gap-[3px]" aria-hidden="true">
            <span className="h-full" />
            <span className="h-full" />
            <span className="h-full" />
          </div>
        ) : (
          <span
            className={cx(
              'text-xs tabular-nums transition-opacity group-hover/row:opacity-0',
              isCurrent ? 'text-accent' : 'text-subtle',
            )}
          >
            {number ?? '–'}
          </span>
        )}
        <button
          type="button"
          onClick={onPlay}
          aria-label={`Play ${track.title}`}
          className={cx(
            'absolute inset-0 flex items-center justify-center rounded-md opacity-0 transition',
            'hover:bg-surface-active focus-visible:opacity-100 group-hover/row:opacity-100',
          )}
        >
          <Play className="h-3.5 w-3.5 fill-current text-text" />
        </button>
      </div>

      {showArtwork && (
        <Artwork
          artworkId={track.artworkId}
          name={track.album}
          size={compact ? 32 : 38}
          rounded="sm"
          decorative
        />
      )}

      {/* Title and artist */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cx(
              'truncate text-sm font-medium',
              isCurrent ? 'text-accent' : 'text-text',
            )}
          >
            {track.title}
          </span>
          {track.lossless && (
            <Chip tone="neutral" className="hidden shrink-0 sm:inline-flex">
              {track.format}
            </Chip>
          )}
          {track.tagState === 'missing' && (
            <Chip tone="warn" className="hidden shrink-0 md:inline-flex">
              untagged
            </Chip>
          )}
        </div>
        {!compact && (
          <div className="truncate text-xs text-muted">
            {track.artist}
            {showAlbum && track.album ? ` — ${track.album}` : ''}
          </div>
        )}
      </div>

      {/* Album column on wide screens only */}
      {showAlbum && compact && (
        <div className="hidden min-w-0 flex-1 truncate text-xs text-muted lg:block">
          {track.album}
        </div>
      )}

      {/* Quality, on very wide screens */}
      <div className="hidden w-40 shrink-0 truncate text-2xs text-subtle xl:block">
        {formatQuality(track)}
      </div>

      {/* Favourite */}
      <IconButton
        label={track.favorite ? `Remove ${track.title} from favourites` : `Add ${track.title} to favourites`}
        size={30}
        onClick={onToggleFavorite}
        className={cx(
          'transition-opacity',
          track.favorite ? 'text-accent opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Heart className={cx('h-4 w-4', track.favorite && 'fill-current')} />
      </IconButton>

      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted">
        {formatDuration(track.durationMs)}
      </span>

      {menuItems.length > 0 && (
        <Menu
          items={menuItems}
          trigger={({ toggle, ref }) => (
            <IconButton
              ref={ref}
              label={`More actions for ${track.title}`}
              size={30}
              onClick={toggle}
              className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          )}
        />
      )}
    </div>
  );
});

/** Standard context-menu items for a track, shared by every list. */
export function trackMenuItems(options: {
  onPlayNext(): void;
  onAddToQueue(): void;
  onAddToPlaylist(): void;
  onGoToAlbum?(): void;
  onGoToArtist?(): void;
  onRemove?: { label: string; run(): void };
}): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Play next', icon: <Play className="h-3.5 w-3.5" />, onSelect: options.onPlayNext },
    { label: 'Add to queue', icon: <ListPlus className="h-3.5 w-3.5" />, onSelect: options.onAddToQueue },
    {
      label: 'Add to playlist…',
      icon: <Music4 className="h-3.5 w-3.5" />,
      onSelect: options.onAddToPlaylist,
    },
  ];

  if (options.onGoToAlbum) {
    items.push({ label: 'Go to album', onSelect: options.onGoToAlbum, separated: true });
  }
  if (options.onGoToArtist) {
    items.push({ label: 'Go to artist', onSelect: options.onGoToArtist });
  }
  if (options.onRemove) {
    items.push({
      label: options.onRemove.label,
      icon: <Trash2 className="h-3.5 w-3.5" />,
      onSelect: options.onRemove.run,
      destructive: true,
      separated: true,
    });
  }

  return items;
}
