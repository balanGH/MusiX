/**
 * Media Session integration (spec §15).
 *
 * This is what puts MusiX on the lock screen, in the Android notification
 * shade, on the macOS Now Playing widget, and under the play/pause key on a
 * keyboard or Bluetooth headset. It is also the single highest-value API for a
 * web music player, because without it the app stops being usable the moment it
 * is not the focused tab.
 *
 * Everything here degrades silently: Firefox supports part of it, older Safari
 * none of it, and neither should produce an error.
 */

import { createLogger } from '../logger';
import type { Track } from '../types';

const log = createLogger('mediaSession');

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  stop(): void;
  seekTo(positionSec: number): void;
  seekBy(offsetSec: number): void;
}

function available(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/** Wire the OS transport controls to the player. Call once. */
export function bindMediaSession(handlers: MediaSessionHandlers): void {
  if (!available()) return;
  const session = navigator.mediaSession;

  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An action this browser does not know about; nothing to do.
    }
  };

  set('play', () => handlers.play());
  set('pause', () => handlers.pause());
  set('stop', () => handlers.stop());
  set('nexttrack', () => handlers.next());
  set('previoustrack', () => handlers.previous());
  set('seekforward', (details) => handlers.seekBy(details.seekOffset ?? 10));
  set('seekbackward', (details) => handlers.seekBy(-(details.seekOffset ?? 10)));
  set('seekto', (details) => {
    if (typeof details.seekTime === 'number') handlers.seekTo(details.seekTime);
  });
}

/** Current artwork object URL, revoked when replaced. */
let artworkUrl: string | null = null;

export interface NowPlayingInfo {
  track: Track;
  /** Cover image, if the library has one. */
  artwork: Blob | null;
}

export function setNowPlaying(info: NowPlayingInfo | null): void {
  if (!available()) return;
  const session = navigator.mediaSession;

  if (!info) {
    session.metadata = null;
    revokeArtwork();
    return;
  }

  const { track, artwork } = info;
  revokeArtwork();

  const artworkList: MediaImage[] = [];
  if (artwork) {
    artworkUrl = URL.createObjectURL(artwork);
    // Several sizes are declared for the same image: the platform picks by size
    // and, given only one entry, some will refuse to show anything at all.
    for (const size of ['96x96', '256x256', '512x512']) {
      artworkList.push({ src: artworkUrl, sizes: size, type: artwork.type || 'image/jpeg' });
    }
  }

  try {
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: artworkList,
    });
  } catch (error) {
    log.warn('could not set media metadata', error);
  }
}

export function setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!available()) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    // Not supported here.
  }
}

/**
 * Report the position, so the OS scrubber is live.
 *
 * Called on the engine's `timeupdate` cadence rather than per frame: the OS UI
 * interpolates between updates, and pushing this 60 times a second is pure
 * wasted work (spec §37).
 */
export function setPositionState(durationSec: number, positionSec: number, rate: number): void {
  if (!available()) return;
  const session = navigator.mediaSession;
  if (typeof session.setPositionState !== 'function') return;
  // Chromium throws if position exceeds duration, which happens routinely for a
  // frame or two at the end of a track.
  if (!Number.isFinite(durationSec) || durationSec <= 0) return;
  try {
    session.setPositionState({
      duration: durationSec,
      position: Math.min(Math.max(positionSec, 0), durationSec),
      playbackRate: rate > 0 ? rate : 1,
    });
  } catch {
    // Ignore: a bad position state must never interrupt playback.
  }
}

export function clearMediaSession(): void {
  if (!available()) return;
  setNowPlaying(null);
  setPlaybackState('none');
}

function revokeArtwork(): void {
  if (!artworkUrl) return;
  URL.revokeObjectURL(artworkUrl);
  artworkUrl = null;
}
