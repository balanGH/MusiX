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
import {
  activeAudioSource,
  activeSourceSnapshot,
  onAudioSourceChange,
  seekActiveSource,
} from '@core/audio/exclusivity';
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
  const mainPlaying = usePlayer((state) => state.status === 'playing');
  // Only read while paused (see the second effect below): subscribing to this
  // while playing would re-render on every ~250ms position tick, which the RAF
  // loop exists specifically to avoid.
  const pausedPositionSec = usePlayerPosition((state) => state.positionSec);

  /**
   * The stem mixer (spec §18, §19) is a second, independent audio graph with
   * no store of its own — unlike the main player, nothing here re-renders
   * automatically when it starts, stops or is seeked. `exclusivity.ts` is
   * both engines' single point of coordination, so this subscribes to it and
   * bumps a counter on any change; `mixerActive`/`mixerPlaying` below are then
   * read fresh off it on every render that counter causes, rather than kept
   * as their own duplicate state.
   */
  const [sourceVersion, setSourceVersion] = useState(0);
  useEffect(() => onAudioSourceChange(() => setSourceVersion((v) => v + 1)), []);
  const mixerActive = activeAudioSource() === 'mixer';
  const mixerPlaying = mixerActive && (activeSourceSnapshot()?.playing ?? false);
  // While the mixer owns playback the main player is paused (the exclusivity
  // guard stops it), so `mainPlaying` alone would freeze the lyrics during a
  // karaoke session — this is what makes them follow whichever is audible.
  const effectivelyPlaying = mixerActive ? mixerPlaying : mainPlaying;

  const [active, setActive] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  /** Suppresses auto-scroll briefly after the user scrolls by hand. */
  const userScrolledAt = useRef(0);

  /**
   * Track the playhead while playing.
   *
   * Polls position directly each animation frame rather than subscribing to a
   * store: the main player's store updates on every native `timeupdate`
   * (~4/sec), which would re-render this component that often, and the stem
   * mixer has no store at all. Polling and only calling `setActive` when the
   * *line* actually changes keeps re-renders down to once per lyric line.
   */
  useEffect(() => {
    if (!effectivelyPlaying) return;
    let frame = 0;
    const tick = () => {
      const index = activeLyricIndex(lines, currentPositionMs());
      setActive((current) => (current === index ? current : index));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lines, effectivelyPlaying]);

  /**
   * Track the playhead while paused.
   *
   * The RAF loop above only runs while playing, so without this a seek made
   * at rest — dragging either engine's seek bar, or clicking a different
   * lyric line — left the highlight frozen on whatever line was active when
   * playback stopped, which reads as broken sync. `sourceVersion` is the
   * mixer half of that: its own paused seeks have no store to trigger a
   * re-render, only the exclusivity notification below.
   */
  useEffect(() => {
    if (effectivelyPlaying) return;
    setActive(activeLyricIndex(lines, currentPositionMs()));
    // `pausedPositionSec` and `sourceVersion` are not read in the body above —
    // `currentPositionMs()` reads live state instead — they are here purely as
    // triggers, so this effect re-runs on a main-player seek or a mixer-side
    // change respectively.
  }, [lines, effectivelyPlaying, pausedPositionSec, sourceVersion]);

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
          // synchronised lyric sheet can do. Seeks whichever engine actually
          // owns playback (the stem mixer, during karaoke); falls back to the
          // main player when nothing has claimed yet, e.g. lyrics opened
          // before the track has been played at all.
          onClick={() => {
            if (!seekActiveSource(line.timeMs / 1000)) player.seek(line.timeMs / 1000);
          }}
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

/**
 * Live playhead in milliseconds, from whichever engine is actually audible.
 *
 * Prefers the exclusivity layer's snapshot, which is correct for both engines;
 * falls back to the main player directly for the moment before anything has
 * ever claimed playback (exclusivity.ts's `active` starts as null).
 */
function currentPositionMs(): number {
  const snapshot = activeSourceSnapshot();
  return (snapshot ? snapshot.positionSec : player.getState().positionSec) * 1000;
}
