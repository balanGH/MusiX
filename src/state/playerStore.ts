/**
 * React bindings for the player.
 *
 * Split into two stores on purpose. `usePlayer` holds state that changes when
 * the user does something — track, status, queue — and `usePlayerPosition` holds
 * the playhead, which changes several times a second. Keeping them apart means
 * a 60-row track list does not re-render four times a second just because a
 * progress bar moved.
 */

import { create } from 'zustand';
import { player, type PlayerState } from '@core/playback/controller';
import { audioEngine } from '@core/audio/engine';
import { useSettings } from './settingsStore';
import type { QueueItem, RepeatMode, Track } from '@core/types';

interface PlayerStore {
  track: Track | null;
  status: PlayerState['status'];
  queue: PlayerState['queue'];
  volume: number;
  muted: boolean;
  error: string | null;
  /** Milliseconds remaining on the sleep timer, or null. */
  sleepEndsAt: number | null;
}

export const usePlayer = create<PlayerStore>()(() => ({
  track: null,
  status: 'idle',
  queue: { items: [], order: [], cursor: -1, shuffle: false, shuffleSeed: 1, repeat: 'off' },
  volume: 0.8,
  muted: false,
  error: null,
  sleepEndsAt: null,
}));

interface PositionStore {
  positionSec: number;
  durationSec: number;
}

export const usePlayerPosition = create<PositionStore>()(() => ({
  positionSec: 0,
  durationSec: 0,
}));

let wired = false;

/**
 * Connect the controller to the stores and apply saved settings to the engine.
 *
 * Called once from the app shell. Idempotent, because React StrictMode mounts
 * effects twice in development.
 */
export function initPlayer(): void {
  if (wired) return;
  wired = true;

  player.init();

  player.on('change', (state) => {
    usePlayer.setState({
      track: state.track,
      status: state.status,
      queue: state.queue,
      volume: state.volume,
      muted: state.muted,
      error: state.error,
      sleepEndsAt: player.sleepTimerEndsAt(),
    });
  });

  player.on('progress', ({ positionSec, durationSec }) => {
    usePlayerPosition.setState({ positionSec, durationSec });
  });

  // Push the persisted mixer settings into the engine, then keep them in sync.
  const applySettings = (settings: ReturnType<typeof useSettings.getState>) => {
    audioEngine.setVolume(settings.volume);
    audioEngine.setMuted(settings.muted);
    audioEngine.setPlaybackRate(settings.playbackRate);
    audioEngine.setCrossfade(settings.crossfadeSec);
    audioEngine.setReplayGain(settings.replayGainMode, settings.preventClipping);
    audioEngine.setEqBands(settings.eqBands);
    audioEngine.setEqPreamp(settings.eqPreampDb);
    audioEngine.setEqEnabled(settings.eqEnabled);
  };

  applySettings(useSettings.getState());
  useSettings.subscribe(applySettings);
}

// ---------------------------------------------------------------------------
// Actions
//
// Thin wrappers so components never import the controller directly, and so
// volume/mute changes are written back to settings in one place.
// ---------------------------------------------------------------------------

export const playerActions = {
  playTracks: (trackIds: readonly string[], startIndex = 0, shuffle?: boolean) =>
    player.playTracks(trackIds, { startIndex, ...(shuffle === undefined ? {} : { shuffle }) }),

  playTrack: (trackId: string) => player.playTrack(trackId),
  toggle: () => player.toggle(),
  next: () => player.next('user'),
  previous: () => player.previous(),
  seek: (positionSec: number) => player.seek(positionSec),
  stop: () => player.stop(),

  setVolume(value: number) {
    useSettings.setState({ volume: value, muted: false });
    player.setVolume(value);
  },

  toggleMute() {
    const muted = !useSettings.getState().muted;
    useSettings.setState({ muted });
    player.setMuted(muted);
  },

  setPlaybackRate(rate: number) {
    useSettings.setState({ playbackRate: rate });
    player.setPlaybackRate(rate);
  },

  toggleShuffle() {
    player.setShuffle(!usePlayer.getState().queue.shuffle);
  },

  setRepeat: (repeat: RepeatMode) => player.setRepeat(repeat),
  cycleRepeat: () => player.cycleRepeat(),

  playNext: (trackIds: readonly string[]) => player.playNext(trackIds),
  addToQueue: (trackIds: readonly string[]) => player.addToQueue(trackIds),
  removeFromQueue: (itemUid: string) => player.removeFromQueue(itemUid),
  moveInQueue: (from: number, to: number) => player.moveInQueue(from, to),
  jumpToQueueItem: (itemUid: string) => player.jumpTo(itemUid),
  clearQueue: () => player.clearQueue(),
  clearUpcoming: () => player.clearUpcoming(),

  startSleepTimer(minutes: number, finishTrack = false) {
    player.startSleepTimer(minutes, { finishTrack });
    usePlayer.setState({ sleepEndsAt: player.sleepTimerEndsAt() });
  },

  cancelSleepTimer() {
    player.cancelSleepTimer();
    usePlayer.setState({ sleepEndsAt: null });
  },

  restoreSession: () => player.restore(),
};

/** Queue items after the current one, for the Up Next panel. */
export function useUpcoming(limit = 200): QueueItem[] {
  const queue = usePlayer((state) => state.queue);
  const out: QueueItem[] = [];
  for (let i = queue.cursor + 1; i < queue.order.length && out.length < limit; i++) {
    const item = queue.items[queue.order[i]!];
    if (item) out.push(item);
  }
  return out;
}

export function useIsPlaying(trackId: string | null | undefined): boolean {
  return usePlayer(
    (state) => trackId !== null && trackId !== undefined && state.track?.id === trackId,
  );
}
