/**
 * Mutual exclusion between the local audio sources MusiX can drive at once:
 * the main player, and the stem mixer's separate Web Audio graph (spec §18).
 *
 * They are two independent audio graphs with no natural way to know about each
 * other. Guarding this in the UI (disabling one button while the other plays)
 * is not enough, because there is more than one route into starting the main
 * player that never touches any stem-mixer component at all: a keyboard
 * shortcut, an OS media key, a Bluetooth headset button, and a crossfade
 * auto-advance are all wired straight into `AudioEngine`. So this lives one
 * layer below every one of those entry points instead of being duplicated in
 * each of them — `AudioEngine.play()`/`handoff()` and `StemMixer`'s own
 * play action both call `claimAudioSource` before they actually start sound,
 * and whichever claims last stops everything else.
 *
 * It doubles as the answer to "what should synced lyrics follow right now"
 * (spec §14): whichever source last claimed playback is the one actually
 * audible, and `activeSourceSnapshot` reports that source's live position
 * regardless of which one it is — the lyrics view does not need to know the
 * stem mixer exists.
 */

export type AudioSourceId = 'player' | 'mixer';

export interface AudioSourceHandle {
  /** Stop this source immediately. Called when another source claims playback. */
  stop(): void;
  /** Move this source's playhead. Used by "click a lyric line to jump there". */
  seek(seconds: number): void;
  /** Live position in seconds, polled by whoever wants to sync to this source. */
  getPositionSec(): number;
  isPlaying(): boolean;
}

const sources = new Map<AudioSourceId, AudioSourceHandle>();
let active: AudioSourceId | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Register a source's controls. Safe to call once and leave registered. */
export function registerAudioSource(id: AudioSourceId, handle: AudioSourceHandle): void {
  sources.set(id, handle);
}

/** Remove a source, e.g. when the stem mixer unmounts. */
export function unregisterAudioSource(id: AudioSourceId): void {
  sources.delete(id);
  if (active === id) {
    active = null;
    notify();
  }
}

/**
 * Claim playback for `id`, silencing every other registered source.
 *
 * Call this immediately *before* actually starting playback. A source that
 * claims and then fails to play (an autoplay rejection, a missing file) still
 * leaves every other source correctly stopped, which is the safe direction to
 * fail in — better a moment of silence than two tracks at once.
 */
export function claimAudioSource(id: AudioSourceId): void {
  const changed = active !== id;
  for (const [other, handle] of sources) {
    if (other !== id) handle.stop();
  }
  active = id;
  if (changed) notify();
}

/**
 * Announce that the active source's state changed without a new claim — it
 * paused, resumed, or was seeked while paused. The stem mixer has no shared
 * store the way the main player does, so this is how anything polling
 * `activeSourceSnapshot` (the lyrics view) learns to re-check it.
 */
export function notifyAudioSourceChanged(): void {
  notify();
}

/** Subscribe to "the active source, or its state, may have changed." */
export function onAudioSourceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Which source last claimed playback, or null if none ever has. */
export function activeAudioSource(): AudioSourceId | null {
  return active;
}

export interface AudioSourceSnapshot {
  source: AudioSourceId;
  positionSec: number;
  playing: boolean;
}

/** Live position and playing state of whichever source currently owns playback. */
export function activeSourceSnapshot(): AudioSourceSnapshot | null {
  if (!active) return null;
  const handle = sources.get(active);
  if (!handle) return null;
  return { source: active, positionSec: handle.getPositionSec(), playing: handle.isPlaying() };
}

/** Seek whichever source is active. Returns false when nothing has claimed yet. */
export function seekActiveSource(seconds: number): boolean {
  if (!active) return false;
  const handle = sources.get(active);
  if (!handle) return false;
  handle.seek(seconds);
  return true;
}
