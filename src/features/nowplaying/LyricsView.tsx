/**
 * Lyrics display (spec §14).
 *
 * Synchronised lyrics scroll themselves and highlight the current line;
 * unsynchronised lyrics render as plain text. Both come from the file the user
 * already has — nothing here touches the network.
 *
 * The active line is found by binary search on a `requestAnimationFrame` loop
 * that only runs while this component is mounted, which is the whole reason
 * lyrics live behind a toggle rather than being always-on (spec §37).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeLyricIndex } from '@core/lyrics/lrc';
import { player } from '@core/playback/controller';
import { usePlayer, usePlayerPosition } from '@state/playerStore';
import type { Lyrics } from '@core/types';
import { cx } from '@ui/primitives';

export function LyricsView({ lyrics }: { lyrics: Lyrics }) {
  if (!lyrics.lines || lyrics.lines.length === 0) {
    return (
      <div className="mx-scroll max-h-[46vh] whitespace-pre-wrap text-sm leading-loose text-muted">
        {lyrics.text}
      </div>
    );
  }
  return <SyncedLyrics lyrics={lyrics} />;
}

function SyncedLyrics({ lyrics }: { lyrics: Lyrics }) {
  // Memoised: a fresh `[]` each render would restart the animation loop below
  // on every frame it caused.
  const lines = useMemo(() => lyrics.lines ?? [], [lyrics.lines]);
  const playing = usePlayer((state) => state.status === 'playing');
  // Only read while paused (see the second effect below): subscribing to this
  // while playing would re-render on every ~250ms position tick, which the RAF
  // loop exists specifically to avoid.
  const pausedPositionSec = usePlayerPosition((state) => state.positionSec);
  const [active, setActive] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  /** Suppresses auto-scroll briefly after the user scrolls by hand. */
  const userScrolledAt = useRef(0);

  /**
   * Track the playhead while playing.
   *
   * Polls `player`'s position directly each animation frame rather than
   * subscribing to the position store: the store updates on every native
   * `timeupdate` (~4/sec), which would re-render this component that often.
   * Polling and only calling `setActive` when the *line* actually changes
   * keeps re-renders down to once per lyric line, not once per tick.
   */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const index = activeLyricIndex(lines, playerPositionMs());
      setActive((current) => (current === index ? current : index));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lines, playing]);

  /**
   * Track the playhead while paused.
   *
   * The RAF loop above only runs while playing, so without this a seek made
   * at rest — dragging the seek bar, or clicking a different lyric line —
   * left the highlight frozen on whatever line was active when playback
   * stopped, which reads as broken sync.
   */
  useEffect(() => {
    if (playing) return;
    setActive(activeLyricIndex(lines, pausedPositionSec * 1000));
  }, [lines, playing, pausedPositionSec]);

  // Keep the active line centred, unless the user is scrolling themselves.
  useLayoutEffect(() => {
    if (active < 0) return;
    if (Date.now() - userScrolledAt.current < 4000) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active]);

  return (
    <div
      ref={containerRef}
      onWheel={() => {
        userScrolledAt.current = Date.now();
      }}
      onTouchMove={() => {
        userScrolledAt.current = Date.now();
      }}
      className="mx-scroll max-h-[46vh] py-8"
      aria-label="Lyrics"
    >
      {lines.map((line, index) => (
        <p
          key={`${line.timeMs}-${index}`}
          ref={index === active ? activeRef : undefined}
          // Clicking a line seeks to it — the single most useful thing a
          // synchronised lyric sheet can do.
          onClick={() => player.seek(line.timeMs / 1000)}
          className={cx(
            'cursor-pointer py-1.5 text-center text-lg leading-snug transition-colors',
            index === active
              ? 'font-semibold text-text'
              : index < active
                ? 'text-subtle'
                : 'text-muted',
          )}
        >
          {line.text || '·'}
        </p>
      ))}
    </div>
  );
}

/** Live playhead in milliseconds. */
function playerPositionMs(): number {
  return player.getState().positionSec * 1000;
}
