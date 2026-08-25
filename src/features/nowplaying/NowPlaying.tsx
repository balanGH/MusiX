/**
 * Now Playing (spec §28).
 *
 * A full-screen overlay rather than a route, so opening it never unmounts the
 * page underneath and closing it returns you exactly where you were.
 *
 * The background is derived from the artwork's dominant colour — sampled once
 * at scan time, so this costs a database read, not an image analysis.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  Heart,
  ListMusic,
  Mic2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
} from 'lucide-react';
import { getLyrics } from '@core/db/repositories/lyrics';
import { setFavorite } from '@core/db/repositories/tracks';
import { formatDuration, formatQuality } from '@core/utils';
import { useArtwork } from '@state/artworkCache';
import { playerActions, usePlayer, usePlayerPosition } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Lyrics } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Chip, IconButton, Slider, cx } from '@ui/primitives';
import { LyricsView } from './LyricsView';

export function NowPlaying() {
  const open = useUi((state) => state.nowPlayingOpen);
  const setOpen = useUi((state) => state.setNowPlaying);
  const setQueueOpen = useUi((state) => state.setQueueOpen);
  const track = usePlayer((state) => state.track);
  const status = usePlayer((state) => state.status);
  const shuffle = usePlayer((state) => state.queue.shuffle);
  const repeat = usePlayer((state) => state.queue.repeat);
  const navigate = useNavigate();

  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const { dominant } = useArtwork(track?.artworkId ?? null, false);

  // Lyrics are fetched only while the panel is open and only for tracks that
  // have them — no speculative reads (spec §4).
  useEffect(() => {
    if (!open || !track?.hasLyrics) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    void getLyrics(track.id).then((found) => {
      if (!cancelled) setLyrics(found ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, track?.id, track?.hasLyrics]);

  if (!open || !track) return null;

  const playing = status === 'playing';
  const backdrop = dominant ?? '90 90 110';

  return (
    <div
      className="fixed inset-0 z-[55] flex flex-col animate-fade-in"
      style={{
        // Two stops of the artwork colour over the app background: enough to
        // feel like the album, never enough to hurt text contrast.
        background: `linear-gradient(180deg, rgb(${backdrop} / 0.45), rgb(var(--mx-bg)) 55%)`,
        backgroundColor: 'rgb(var(--mx-bg))',
      }}
    >
      <header className="flex h-14 shrink-0 items-center justify-between px-4">
        <IconButton label="Close now playing" size={36} onClick={() => setOpen(false)}>
          <ChevronDown className="h-5 w-5" />
        </IconButton>
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted">
          Now playing
        </span>
        <IconButton
          label="Show the queue"
          size={36}
          onClick={() => {
            setOpen(false);
            setQueueOpen(true);
          }}
        >
          <ListMusic className="h-5 w-5" />
        </IconButton>
      </header>

      <div className="mx-scroll flex flex-1 flex-col items-center gap-6 px-6 pb-8 lg:flex-row lg:items-center lg:justify-center lg:gap-12">
        {/* Artwork */}
        <div className="flex w-full max-w-sm shrink-0 flex-col items-center lg:max-w-md">
          <Artwork
            artworkId={track.artworkId}
            name={track.album}
            full
            rounded="lg"
            className="aspect-square w-full shadow-pop"
          />
        </div>

        {/* Details and controls */}
        <div className="flex w-full max-w-lg flex-col">
          {showLyrics && lyrics ? (
            <LyricsView lyrics={lyrics} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold leading-tight tracking-tight text-text">
                {track.title}
              </h1>
              <button
                type="button"
                onClick={() => {
                  if (!track.artistIds[0]) return;
                  setOpen(false);
                  navigate(`/artists/${track.artistIds[0]}`);
                }}
                className="mt-1 self-start text-base text-muted hover:text-text hover:underline"
              >
                {track.artist}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate(`/albums/${track.albumId}`);
                }}
                className="mt-0.5 self-start text-sm text-subtle hover:text-text hover:underline"
              >
                {track.album}
                {track.year ? ` · ${track.year}` : ''}
              </button>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Chip tone={track.lossless ? 'accent' : 'neutral'}>{track.format}</Chip>
                <span className="text-2xs text-subtle">{formatQuality(track)}</span>
              </div>
            </>
          )}

          <NowPlayingSeek durationMs={track.durationMs} />

          {/* Transport */}
          <div className="mt-4 flex items-center justify-center gap-3">
            <IconButton
              label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}
              size={40}
              active={shuffle}
              onClick={playerActions.toggleShuffle}
            >
              <Shuffle className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Previous track" size={46} onClick={() => void playerActions.previous()}>
              <SkipBack className="h-6 w-6 fill-current" />
            </IconButton>
            <IconButton
              label={playing ? 'Pause' : 'Play'}
              size={62}
              variant="accent"
              onClick={() => void playerActions.toggle()}
            >
              {playing ? (
                <Pause className="h-7 w-7 fill-current" />
              ) : (
                <Play className="ml-1 h-7 w-7 fill-current" />
              )}
            </IconButton>
            <IconButton label="Next track" size={46} onClick={() => void playerActions.next()}>
              <SkipForward className="h-6 w-6 fill-current" />
            </IconButton>
            <IconButton
              label={repeat === 'off' ? 'Turn repeat on' : repeat === 'all' ? 'Repeat one' : 'Repeat off'}
              size={40}
              active={repeat !== 'off'}
              onClick={playerActions.cycleRepeat}
            >
              {repeat === 'one' ? (
                <Repeat1 className="h-[18px] w-[18px]" />
              ) : (
                <Repeat className="h-[18px] w-[18px]" />
              )}
            </IconButton>
          </div>

          {/* Secondary actions */}
          <div className="mt-6 flex items-center justify-center gap-2">
            <IconButton
              label={track.favorite ? 'Remove from favourites' : 'Add to favourites'}
              size={38}
              className={cx(track.favorite && 'text-accent')}
              onClick={() => void setFavorite(track.id, !track.favorite)}
            >
              <Heart className={cx('h-[18px] w-[18px]', track.favorite && 'fill-current')} />
            </IconButton>

            <IconButton
              label={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
              size={38}
              active={showLyrics}
              disabled={!track.hasLyrics}
              title={track.hasLyrics ? undefined : 'This file has no embedded lyrics'}
              onClick={() => setShowLyrics((value) => !value)}
            >
              <Mic2 className="h-[18px] w-[18px]" />
            </IconButton>

            <IconButton
              label="Open the equaliser"
              size={38}
              onClick={() => {
                setOpen(false);
                navigate('/equalizer');
              }}
            >
              <SlidersHorizontal className="h-[18px] w-[18px]" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Seek bar with its own subscription, so the rest of the view stays static. */
function NowPlayingSeek({ durationMs }: { durationMs: number }) {
  const positionSec = usePlayerPosition((state) => state.positionSec);
  const durationSec = usePlayerPosition((state) => state.durationSec);
  const [dragging, setDragging] = useState<number | null>(null);

  // Prefer the decoder's duration, but fall back to the tag for the moment
  // before metadata arrives.
  const total = durationSec > 0 ? durationSec : durationMs / 1000;
  const shown = dragging ?? positionSec;

  return (
    <div className="mt-6">
      <Slider
        label="Seek"
        value={shown}
        min={0}
        max={total > 0 ? total : 1}
        step={0.5}
        onValueChange={setDragging}
        onCommit={(value) => {
          playerActions.seek(value);
          setDragging(null);
        }}
      />
      <div className="mt-1 flex justify-between text-2xs tabular-nums text-subtle">
        <span>{formatDuration(shown * 1000)}</span>
        <span>{total > 0 ? `-${formatDuration((total - shown) * 1000)}` : '--:--'}</span>
      </div>
    </div>
  );
}
