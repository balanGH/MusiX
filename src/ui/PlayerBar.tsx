/**
 * The persistent player bar.
 *
 * Rendered once, outside the router, so navigating never interrupts playback or
 * remounts the audio graph.
 *
 * The seek bar and the time readout are separate components that subscribe to
 * `usePlayerPosition`. Everything else here subscribes to `usePlayer`. That
 * split means the four-times-a-second position updates re-render two small
 * components instead of the whole bar.
 */

import { useEffect, useState } from 'react';
import {
  Heart,
  ListMusic,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { setFavorite } from '@core/db/repositories/tracks';
import { formatDuration } from '@core/utils';
import { playerActions, usePlayer, usePlayerPosition } from '@state/playerStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import { Artwork } from './Artwork';
import { IconButton, Slider, cx } from './primitives';

export function PlayerBar() {
  const track = usePlayer((state) => state.track);
  const status = usePlayer((state) => state.status);
  const shuffle = usePlayer((state) => state.queue.shuffle);
  const repeat = usePlayer((state) => state.queue.repeat);
  const setNowPlaying = useUi((state) => state.setNowPlaying);
  const setQueueOpen = useUi((state) => state.setQueueOpen);
  const queueOpen = useUi((state) => state.queueOpen);

  const playing = status === 'playing';
  const loading = status === 'loading';

  return (
    <div
      className="relative z-30 flex shrink-0 items-center gap-3 border-t border-line bg-bg-elevated px-3 sm:px-4"
      style={{ height: 'var(--mx-player-height)' }}
    >
      {/* ---- Now playing ---- */}
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:w-[30%] sm:flex-none">
        {track ? (
          <>
            <button
              type="button"
              onClick={() => setNowPlaying(true)}
              aria-label="Open now playing"
              className="group relative shrink-0 rounded-lg"
            >
              <Artwork artworkId={track.artworkId} name={track.album} size={48} rounded="md" decorative />
              <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/45 opacity-0 transition group-hover:opacity-100 sm:flex">
                <Maximize2 className="h-4 w-4 text-white" />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setNowPlaying(true)}
                className="block max-w-full truncate text-left text-sm font-medium text-text hover:underline"
              >
                {track.title}
              </button>
              <div className="truncate text-xs text-muted">{track.artist}</div>
            </div>
            <FavoriteButton trackId={track.id} favorite={track.favorite} />
          </>
        ) : (
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 shrink-0 rounded-lg bg-surface-hover" />
            <span className="truncate text-sm text-subtle">Nothing playing</span>
          </div>
        )}
      </div>

      {/* ---- Transport ---- */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          <IconButton
            label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}
            size={32}
            active={shuffle}
            onClick={playerActions.toggleShuffle}
            className="hidden sm:inline-flex"
          >
            <Shuffle className="h-4 w-4" />
          </IconButton>

          <IconButton label="Previous track" size={34} onClick={() => void playerActions.previous()}>
            <SkipBack className="h-[18px] w-[18px] fill-current" />
          </IconButton>

          <IconButton
            label={playing ? 'Pause' : 'Play'}
            size={38}
            variant="accent"
            disabled={!track}
            onClick={() => void playerActions.toggle()}
          >
            {playing ? (
              <Pause className="h-[18px] w-[18px] fill-current" />
            ) : (
              <Play className="ml-0.5 h-[18px] w-[18px] fill-current" />
            )}
          </IconButton>

          <IconButton label="Next track" size={34} onClick={() => void playerActions.next()}>
            <SkipForward className="h-[18px] w-[18px] fill-current" />
          </IconButton>

          <IconButton
            label={
              repeat === 'off'
                ? 'Turn repeat on'
                : repeat === 'all'
                  ? 'Repeat this track only'
                  : 'Turn repeat off'
            }
            size={32}
            active={repeat !== 'off'}
            onClick={playerActions.cycleRepeat}
            className="hidden sm:inline-flex"
          >
            {repeat === 'one' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
          </IconButton>
        </div>

        <SeekBar disabled={!track} loading={loading} />
      </div>

      {/* ---- Right-hand controls ---- */}
      <div className="hidden w-[30%] items-center justify-end gap-1 sm:flex">
        <IconButton
          label={queueOpen ? 'Hide the queue' : 'Show the queue'}
          size={32}
          active={queueOpen}
          onClick={() => setQueueOpen(!queueOpen)}
        >
          <ListMusic className="h-4 w-4" />
        </IconButton>
        <VolumeControl />
      </div>
    </div>
  );
}

/**
 * Seek bar.
 *
 * While the user is dragging, the thumb follows the pointer rather than the
 * engine — otherwise every position update yanks it back mid-gesture.
 */
function SeekBar({ disabled, loading }: { disabled: boolean; loading: boolean }) {
  const positionSec = usePlayerPosition((state) => state.positionSec);
  const durationSec = usePlayerPosition((state) => state.durationSec);
  const [dragging, setDragging] = useState<number | null>(null);

  const shown = dragging ?? positionSec;

  return (
    <div className="flex w-full max-w-xl items-center gap-2">
      <span className="w-10 shrink-0 text-right text-2xs tabular-nums text-subtle">
        {formatDuration(shown * 1000)}
      </span>
      <Slider
        label="Seek"
        ghost
        disabled={disabled}
        value={shown}
        min={0}
        max={durationSec > 0 ? durationSec : 1}
        step={0.5}
        onValueChange={setDragging}
        onCommit={(value) => {
          playerActions.seek(value);
          setDragging(null);
        }}
        className={cx('flex-1', loading && 'opacity-60')}
      />
      <span className="w-10 shrink-0 text-2xs tabular-nums text-subtle">
        {durationSec > 0 ? formatDuration(durationSec * 1000) : '--:--'}
      </span>
    </div>
  );
}

function VolumeControl() {
  const volume = useSettings((state) => state.volume);
  const muted = useSettings((state) => state.muted);
  const effective = muted ? 0 : volume;

  const Icon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2;

  return (
    <div className="flex items-center gap-1.5">
      <IconButton
        label={muted ? 'Unmute' : 'Mute'}
        size={32}
        onClick={playerActions.toggleMute}
      >
        <Icon className="h-4 w-4" />
      </IconButton>
      <Slider
        label="Volume"
        value={effective}
        min={0}
        max={1}
        step={0.01}
        onValueChange={playerActions.setVolume}
        className="w-24"
      />
    </div>
  );
}

/**
 * Favourite toggle for the currently playing track.
 *
 * Holds its own optimistic copy so the heart fills instantly; the controller's
 * next state push corrects it if the write failed.
 */
function FavoriteButton({ trackId, favorite }: { trackId: string; favorite: boolean }) {
  const [optimistic, setOptimistic] = useState(favorite);
  useEffect(() => setOptimistic(favorite), [favorite, trackId]);

  return (
    <IconButton
      label={optimistic ? 'Remove from favourites' : 'Add to favourites'}
      size={32}
      className={cx('hidden shrink-0 sm:inline-flex', optimistic && 'text-accent')}
      onClick={() => {
        const next = !optimistic;
        setOptimistic(next);
        void setFavorite(trackId, next).catch(() => setOptimistic(!next));
      }}
    >
      <Heart className={cx('h-4 w-4', optimistic && 'fill-current')} />
    </IconButton>
  );
}
