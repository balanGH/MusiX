/**
 * The Up Next panel (spec §15).
 *
 * A side panel on desktop, a sheet on mobile. Reordering is plain HTML5 drag
 * and drop — no library — because the queue is one flat list and the browser's
 * own drag events cover it.
 */

import { useCallback, useEffect, useState } from 'react';
import { GripVertical, ListX, Trash2, X } from 'lucide-react';
import { getTracks } from '@core/db/repositories/tracks';
import { formatDuration } from '@core/utils';
import { playerActions, usePlayer } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { QueueItem, Track } from '@core/types';
import { Artwork } from './Artwork';
import { Button, EmptyState, IconButton, cx } from './primitives';

export function QueuePanel() {
  const open = useUi((state) => state.queueOpen);
  const setOpen = useUi((state) => state.setQueueOpen);
  const queue = usePlayer((state) => state.queue);
  const currentTrackId = usePlayer((state) => state.track?.id ?? null);

  const [tracks, setTracks] = useState<Map<string, Track>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // The queue is bounded by what the user queued, so fetching all of it is fine
  // — unlike the library lists, which are virtualised.
  useEffect(() => {
    if (!open || queue.items.length === 0) {
      setTracks(new Map());
      return;
    }
    let cancelled = false;
    void getTracks(queue.items.map((item) => item.trackId)).then((rows) => {
      if (!cancelled) setTracks(new Map(rows.map((row) => [row.id, row])));
    });
    return () => {
      cancelled = true;
    };
  }, [open, queue.items]);

  const onDrop = useCallback(
    (target: number) => {
      if (dragIndex !== null && dragIndex !== target) {
        playerActions.moveInQueue(dragIndex, target);
      }
      setDragIndex(null);
      setDropIndex(null);
    },
    [dragIndex],
  );

  if (!open) return null;

  return (
    <aside
      aria-label="Play queue"
      className={cx(
        'z-40 flex w-full flex-col border-l border-line bg-bg-elevated',
        'absolute inset-0 md:static md:w-80 md:shrink-0',
      )}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <div>
          <h2 className="text-sm font-semibold">Up next</h2>
          <p className="text-2xs text-subtle">
            {queue.items.length === 0
              ? 'Queue is empty'
              : `${queue.items.length} track${queue.items.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <IconButton label="Close the queue" size={30} onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </IconButton>
      </header>

      {queue.items.length === 0 ? (
        <EmptyState
          icon={<ListX className="h-8 w-8" />}
          title="Nothing queued"
          body="Play an album or add tracks to the queue and they will appear here."
        />
      ) : (
        <>
          <div className="mx-scroll flex-1 p-2">
            <ol>
              {queue.items.map((item, index) => (
                <QueueRow
                  key={item.uid}
                  item={item}
                  track={tracks.get(item.trackId)}
                  index={index}
                  isCurrent={item.trackId === currentTrackId && queue.order[queue.cursor] === index}
                  isDropTarget={dropIndex === index}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={() => setDropIndex(index)}
                  onDrop={() => onDrop(index)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDropIndex(null);
                  }}
                />
              ))}
            </ol>
          </div>

          <footer className="flex shrink-0 gap-2 border-t border-line p-3">
            <Button
              size="sm"
              variant="ghost"
              className="flex-1"
              onClick={playerActions.clearUpcoming}
            >
              Clear up next
            </Button>
            <Button size="sm" variant="ghost" className="flex-1" onClick={playerActions.clearQueue}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </Button>
          </footer>
        </>
      )}
    </aside>
  );
}

interface QueueRowProps {
  item: QueueItem;
  track: Track | undefined;
  index: number;
  isCurrent: boolean;
  isDropTarget: boolean;
  onDragStart(): void;
  onDragOver(): void;
  onDrop(): void;
  onDragEnd(): void;
}

function QueueRow({
  item,
  track,
  isCurrent,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: QueueRowProps) {
  return (
    <li
      draggable
      onDragStart={(event) => {
        // Firefox will not start a drag without data set on the transfer.
        event.dataTransfer.setData('text/plain', item.uid);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        'group/queue flex items-center gap-2 rounded-lg px-2 py-1.5 transition',
        isCurrent ? 'bg-accent/10' : 'hover:bg-surface-hover',
        isDropTarget && 'ring-1 ring-accent',
      )}
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-subtle opacity-0 group-hover/queue:opacity-100" />

      <button
        type="button"
        onClick={() => void playerActions.jumpToQueueItem(item.uid)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <Artwork
          artworkId={track?.artworkId ?? null}
          name={track?.album ?? ''}
          size={34}
          rounded="sm"
          decorative
        />
        <span className="min-w-0 flex-1">
          <span
            className={cx(
              'block truncate text-xs font-medium',
              isCurrent ? 'text-accent' : 'text-text',
            )}
          >
            {track?.title ?? '…'}
          </span>
          <span className="block truncate text-2xs text-muted">{track?.artist ?? ''}</span>
        </span>
      </button>

      <span className="shrink-0 text-2xs tabular-nums text-subtle">
        {track ? formatDuration(track.durationMs) : ''}
      </span>

      <IconButton
        label={`Remove ${track?.title ?? 'track'} from the queue`}
        size={24}
        onClick={() => playerActions.removeFromQueue(item.uid)}
        className="shrink-0 opacity-0 group-hover/queue:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3 w-3" />
      </IconButton>
    </li>
  );
}
