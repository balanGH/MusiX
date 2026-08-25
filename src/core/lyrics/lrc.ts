/**
 * LRC (synchronised lyrics).
 *
 * Included in Phase 1 because embedded lyric tags very often already *contain*
 * LRC timestamps — detecting that costs one regex and turns a wall of text into
 * a synchronised display, whereas storing it as plain text would throw the
 * timing away and require a re-scan to recover it later.
 *
 * Writing (`formatLrc`) and the timestamping editor belong to Phase 3; the
 * format functions live here so both directions stay in one file.
 */

import type { Lyrics, LyricsLine } from '../types';

/** `[mm:ss.xx]`, `[mm:ss:xx]` or `[mm:ss]`, one or more per line. */
const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
/** `[ar: Artist]`-style metadata lines. */
const METADATA = /^\[(ar|ti|al|au|by|offset|length|re|ve|tool):\s*(.*)\]$/i;

export function looksLikeLrc(text: string): boolean {
  // Two timestamps is the threshold: a single one could be a literal bracket in
  // plain lyrics, but two means it is a timed file.
  TIMESTAMP.lastIndex = 0;
  let matches = 0;
  for (const _ of text.matchAll(TIMESTAMP)) {
    void _;
    if (++matches >= 2) return true;
  }
  return false;
}

export interface ParsedLrc {
  lines: LyricsLine[];
  /** Plain text, timestamps stripped — what a non-synced view shows. */
  plain: string;
  metadata: Record<string, string>;
  /** Global offset in ms from an `[offset:]` tag; already applied to `lines`. */
  offsetMs: number;
}

export function parseLrc(text: string): ParsedLrc {
  const metadata: Record<string, string> = {};
  const collected: LyricsLine[] = [];
  let offsetMs = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = line.match(METADATA);
    if (meta) {
      const key = meta[1]!.toLowerCase();
      const value = meta[2]!.trim();
      metadata[key] = value;
      if (key === 'offset') {
        const parsed = Number.parseInt(value, 10);
        // The tag is "milliseconds to shift lyrics earlier", i.e. negated.
        if (Number.isFinite(parsed)) offsetMs = -parsed;
      }
      continue;
    }

    TIMESTAMP.lastIndex = 0;
    const stamps = [...line.matchAll(TIMESTAMP)];
    if (stamps.length === 0) {
      // Untimed line inside an otherwise timed file: keep it, timed to whatever
      // came before, so nothing is silently dropped.
      if (collected.length > 0) collected.push({ timeMs: collected[collected.length - 1]!.timeMs, text: line });
      continue;
    }

    const content = line.replace(TIMESTAMP, '').trim();
    for (const stamp of stamps) {
      const minutes = Number.parseInt(stamp[1]!, 10);
      const seconds = Number.parseInt(stamp[2]!, 10);
      const fraction = stamp[3] ?? '';
      // Two digits mean centiseconds, three mean milliseconds.
      const fractionMs =
        fraction.length === 0
          ? 0
          : fraction.length <= 2
            ? Number.parseInt(fraction.padEnd(2, '0'), 10) * 10
            : Number.parseInt(fraction.slice(0, 3), 10);
      collected.push({ timeMs: minutes * 60_000 + seconds * 1000 + fractionMs, text: content });
    }
  }

  // A line can carry several timestamps (a repeated chorus), so sorting is
  // required, not just convenient.
  collected.sort((a, b) => a.timeMs - b.timeMs);
  const lines = collected.map((line) => ({
    timeMs: Math.max(0, line.timeMs + offsetMs),
    text: line.text,
  }));

  return {
    lines,
    plain: lines
      .map((line) => line.text)
      .filter(Boolean)
      .join('\n'),
    metadata,
    offsetMs,
  };
}

export function formatLrc(lines: readonly LyricsLine[]): string {
  return lines
    .map((line) => {
      const totalCs = Math.round(line.timeMs / 10);
      const cs = totalCs % 100;
      const totalSeconds = Math.floor(totalCs / 100);
      const seconds = totalSeconds % 60;
      const minutes = Math.floor(totalSeconds / 60);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `[${pad(minutes)}:${pad(seconds)}.${pad(cs)}]${line.text}`;
    })
    .join('\n');
}

/**
 * Which line is current at `positionMs`.
 *
 * Binary search: the Now Playing view calls this on every animation frame, and
 * a linear scan over a 120-line lyric sheet 60 times a second is exactly the
 * kind of idle CPU burn spec §37 rules out.
 */
export function activeLyricIndex(lines: readonly LyricsLine[], positionMs: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.timeMs <= positionMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** Build the stored record from an embedded lyric tag. */
export function lyricsFromTag(trackId: string, text: string): Lyrics {
  if (looksLikeLrc(text)) {
    const parsed = parseLrc(text);
    if (parsed.lines.length > 0) {
      return {
        id: trackId,
        trackId,
        kind: 'lrc',
        text,
        lines: parsed.lines,
        language: parsed.metadata.la ?? null,
        source: 'embedded',
        updatedAt: Date.now(),
      };
    }
  }
  return {
    id: trackId,
    trackId,
    kind: 'plain',
    text,
    lines: null,
    language: null,
    source: 'embedded',
    updatedAt: Date.now(),
  };
}
