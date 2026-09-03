/**
 * Mutual exclusion between the main player and the stem mixer.
 *
 * The bug this guards: pressing the mixer's play button and the main
 * transport's play button both worked, independently, so both engines could
 * be audible at once. The fix has to hold regardless of *which* of several
 * entry points started playback — a button, a keyboard shortcut, an OS media
 * key — which is why the guard lives in `exclusivity.ts` rather than in any
 * one of them. These tests exercise the module directly with two fake
 * sources standing in for the player and the mixer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeAudioSource,
  activeSourceSnapshot,
  claimAudioSource,
  notifyAudioSourceChanged,
  onAudioSourceChange,
  registerAudioSource,
  seekActiveSource,
  unregisterAudioSource,
  type AudioSourceHandle,
} from '@core/audio/exclusivity';

function fakeSource(startPositionSec = 0): AudioSourceHandle & { playing: boolean; positionSec: number } {
  const handle = {
    playing: false,
    positionSec: startPositionSec,
    stop: vi.fn(() => {
      handle.playing = false;
    }),
    seek: vi.fn((seconds: number) => {
      handle.positionSec = seconds;
    }),
    getPositionSec: () => handle.positionSec,
    isPlaying: () => handle.playing,
  };
  return handle;
}

afterEach(() => {
  // The module holds real module-level state; every test starts clean.
  unregisterAudioSource('player');
  unregisterAudioSource('mixer');
});

describe('claiming playback', () => {
  it('stops every other registered source', () => {
    const player = fakeSource();
    const mixer = fakeSource();
    registerAudioSource('player', player);
    registerAudioSource('mixer', mixer);

    player.playing = true;
    claimAudioSource('mixer');

    // This is the actual bug: without the claim, pressing "play" on the
    // mixer never touched the main player, and both stayed audible.
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(mixer.stop).not.toHaveBeenCalled();
    expect(activeAudioSource()).toBe('mixer');
  });

  it('is symmetric: claiming the player stops the mixer', () => {
    const player = fakeSource();
    const mixer = fakeSource();
    registerAudioSource('player', player);
    registerAudioSource('mixer', mixer);

    mixer.playing = true;
    claimAudioSource('player');

    expect(mixer.stop).toHaveBeenCalledTimes(1);
    expect(activeAudioSource()).toBe('player');
  });

  it('does not stop a source that reclaims itself', () => {
    const player = fakeSource();
    registerAudioSource('player', player);

    claimAudioSource('player');
    claimAudioSource('player');

    expect(player.stop).not.toHaveBeenCalled();
  });
});

describe('the exclusivity claim covers every entry point', () => {
  // Simulates the shape of AudioEngine.play(): a single method that a button,
  // a keyboard shortcut, and a media-key handler all call into.
  function simulateEngineStart(player: ReturnType<typeof fakeSource>) {
    claimAudioSource('player');
    player.playing = true;
  }

  it('a keyboard-shortcut-style call still silences an already-playing mixer', () => {
    const player = fakeSource();
    const mixer = fakeSource();
    registerAudioSource('player', player);
    registerAudioSource('mixer', mixer);
    mixer.playing = true;
    claimAudioSource('mixer');

    // No button was pressed on the mixer's own UI — this stands in for
    // Space, a Bluetooth headset, or an OS media key calling straight into
    // the engine.
    simulateEngineStart(player);

    expect(mixer.stop).toHaveBeenCalledTimes(1);
    expect(activeAudioSource()).toBe('player');
  });
});

describe('reading the active source', () => {
  it('reports live position and playing state for whichever source is active', () => {
    const player = fakeSource(10);
    const mixer = fakeSource(42);
    registerAudioSource('player', player);
    registerAudioSource('mixer', mixer);

    claimAudioSource('mixer');
    mixer.playing = true;

    const snapshot = activeSourceSnapshot();
    expect(snapshot).toEqual({ source: 'mixer', positionSec: 42, playing: true });
  });

  it('is null before anything has ever claimed playback', () => {
    registerAudioSource('player', fakeSource());
    expect(activeAudioSource()).toBeNull();
    expect(activeSourceSnapshot()).toBeNull();
  });

  it('clears when the active source unregisters, e.g. the mixer unmounting', () => {
    const mixer = fakeSource();
    registerAudioSource('mixer', mixer);
    claimAudioSource('mixer');
    expect(activeAudioSource()).toBe('mixer');

    unregisterAudioSource('mixer');
    expect(activeAudioSource()).toBeNull();
    expect(activeSourceSnapshot()).toBeNull();
  });
});

describe('seeking the active source', () => {
  it('routes a seek to whichever source is active, not a fixed one', () => {
    const player = fakeSource();
    const mixer = fakeSource();
    registerAudioSource('player', player);
    registerAudioSource('mixer', mixer);

    claimAudioSource('mixer');
    const handled = seekActiveSource(90);

    // The bug this covers: "click a lyric line to jump there" seeking the
    // paused main player while the mixer — the thing actually audible during
    // karaoke — kept playing from wherever it already was.
    expect(handled).toBe(true);
    expect(mixer.seek).toHaveBeenCalledWith(90);
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('reports it could not seek anything before a claim has happened', () => {
    registerAudioSource('player', fakeSource());
    expect(seekActiveSource(10)).toBe(false);
  });
});

describe('change notifications', () => {
  it('fires when the active source changes', () => {
    const listener = vi.fn();
    registerAudioSource('player', fakeSource());
    registerAudioSource('mixer', fakeSource());
    const unsubscribe = onAudioSourceChange(listener);

    claimAudioSource('mixer');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does not fire again for reclaiming the same source', () => {
    const listener = vi.fn();
    registerAudioSource('player', fakeSource());
    const unsubscribe = onAudioSourceChange(listener);

    claimAudioSource('player');
    claimAudioSource('player');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('fires on an explicit notify, e.g. the mixer pausing without a new claim', () => {
    const listener = vi.fn();
    const unsubscribe = onAudioSourceChange(listener);

    notifyAudioSourceChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onAudioSourceChange(listener);
    unsubscribe();

    notifyAudioSourceChanged();
    expect(listener).not.toHaveBeenCalled();
  });
});
