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

/**
 * Word-by-word highlight within the currently active line, approximated.
 *
 * Currently switched off — not called from `SyncedLyrics`'s line loop above —
 * but kept here rather than deleted, so turning it back on is a one-line
 * change instead of rewriting it from scratch.
 *
 * LRCLIB — the only lyrics source MusiX has — gives one timestamp per
 * *line*, never per word, and no lyrics format in use here carries real
 * word-level timing either. There is nothing to read a true per-word time
 * from. What this does instead: take the gap between this line's timestamp
 * and the next line's, and split it proportionally by each word's character
 * length, on the (usually reasonable) assumption that a longer word takes
 * longer to sing. It looks like real karaoke timing most of the time, but
 * it's a guess — a long pause or an ad-lib mid-line will drift it — which is
 * why it only ever supplements the already-correct line-level highlight
 * rather than replacing it.
 *
 * Isolated in its own component deliberately: the parent's `active` (line
 * index) only changes once per line specifically to avoid re-rendering every
 * line on every frame (see its own comment). Word position, by contrast,
 * needs updating far more often — but only *this* line's words need to
 * re-render for that, so the frequent updates live here, not in the parent.
 */
export function ActiveLineWords({
  text,
  startMs,
  endMs,
  effectivelyPlaying,
  pausedPositionSec,
  sourceVersion,
}: {
  text: string;
  startMs: number;
  /** Null for the last line — there's no next timestamp to bound a guess with. */
  endMs: number | null;
  effectivelyPlaying: boolean;
  pausedPositionSec: number;
  sourceVersion: number;
}) {
  // Captures literal whitespace as its own tokens, alternating with words, so
  // re-joining them for render reproduces the original spacing exactly.
  const tokens = useMemo(() => text.split(/(\s+)/), [text]);
  const wordTokenIndices = useMemo(
    () => tokens.reduce<number[]>((acc, token, i) => (token.trim() ? [...acc, i] : acc), []),
    [tokens],
  );

  const [wordActive, setWordActive] = useState(-1);

  useEffect(() => {
    if (endMs === null || wordTokenIndices.length === 0) {
      setWordActive(-1);
      return;
    }
    const recompute = () =>
      wordIndexAt(tokens, wordTokenIndices, startMs, endMs, currentPositionMs());

    if (!effectivelyPlaying) {
      setWordActive(recompute());
      // `pausedPositionSec` / `sourceVersion` aren't read above — recompute()
      // reads live state instead — they're here purely as triggers, exactly
      // like the parent's own paused-tracking effect.
      return;
    }
    let frame = 0;
    const tick = () => {
      setWordActive((current) => {
        const next = recompute();
        return current === next ? current : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [tokens, wordTokenIndices, startMs, endMs, effectivelyPlaying, pausedPositionSec, sourceVersion]);

  return (
    <>
      {tokens.map((token, i) => {
        // `wordActive < 0` — no next line to bound a guess with, or the line
        // hasn't started yet — leaves every word in the line's own colour
        // (already set by the parent `<p>`), same as before this existed.
        const className =
          wordActive < 0 || !wordTokenIndices.includes(i)
            ? undefined
            : i <= wordActive
              ? 'text-accent transition-colors'
              : 'text-muted transition-colors';
        return (
          <span key={i} className={className}>
            {token}
          </span>
        );
      })}
    </>
  );
}

/** Which token in `tokens` is "active" at `positionMs`, or -1 before `startMs`. */
function wordIndexAt(
  tokens: string[],
  wordTokenIndices: number[],
  startMs: number,
  endMs: number,
  positionMs: number,
): number {
  if (positionMs <= startMs || wordTokenIndices.length === 0) return -1;

  const weights = wordTokenIndices.map((i) => Math.max(1, tokens[i]!.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(1, endMs - startMs);
  const fraction = Math.min(1, (positionMs - startMs) / span);
  const target = fraction * totalWeight;

  let cumulative = 0;
  for (let w = 0; w < weights.length; w++) {
    cumulative += weights[w]!;
    if (target < cumulative) return wordTokenIndices[w]!;
  }
  return wordTokenIndices[wordTokenIndices.length - 1]!;
}
