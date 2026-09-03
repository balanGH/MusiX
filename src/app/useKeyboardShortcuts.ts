/**
 * Global keyboard shortcuts (spec §5, §39).
 *
 * Two rules govern all of them:
 *
 *  - Never fire while the user is typing. A search box that pauses playback on
 *    every space is unusable.
 *  - Never shadow a browser shortcut. Nothing here uses Ctrl/Cmd except the
 *    search focus, which every app binds to Ctrl+K anyway.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { playerActions, usePlayer, usePlayerPosition } from '@state/playerStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';

/** True when focus is somewhere that consumes typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface Shortcut {
  keys: string;
  description: string;
}

/** Shown on the Settings page, so the bindings are discoverable. */
export const SHORTCUTS: Shortcut[] = [
  { keys: 'Space', description: 'Play or pause' },
  { keys: '→ / ←', description: 'Seek forward or back 5 seconds' },
  { keys: 'Shift + → / ←', description: 'Next or previous track' },
  { keys: '↑ / ↓', description: 'Volume up or down' },
  { keys: 'M', description: 'Mute' },
  { keys: 'S', description: 'Toggle shuffle' },
  { keys: 'R', description: 'Cycle repeat' },
  { keys: 'F', description: 'Favourite the current track' },
  { keys: 'Q', description: 'Show or hide the queue' },
  { keys: 'N', description: 'Open now playing' },
  { keys: 'Ctrl / ⌘ + K', description: 'Search' },
  { keys: 'Esc', description: 'Close the current panel' },
];

export function useKeyboardShortcuts(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+K works even from a text field, since it is a navigation command.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navigate('/search');
        return;
      }

      if (isTypingTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const ui = useUi.getState();

      switch (event.key) {
        case ' ':
          event.preventDefault();
          void playerActions.toggle();
          return;

        case 'ArrowRight':
          event.preventDefault();
          if (event.shiftKey) void playerActions.next();
          else nudgeSeek(5);
          return;

        case 'ArrowLeft':
          event.preventDefault();
          if (event.shiftKey) void playerActions.previous();
          else nudgeSeek(-5);
          return;

        case 'ArrowUp':
          event.preventDefault();
          nudgeVolume(0.05);
          return;

        case 'ArrowDown':
          event.preventDefault();
          nudgeVolume(-0.05);
          return;

        case 'Escape':
          // Close whatever is open, outermost first.
          if (ui.nowPlayingOpen) ui.setNowPlaying(false);
          else if (ui.queueOpen) ui.setQueueOpen(false);
          else if (ui.mobileNavOpen) ui.setMobileNavOpen(false);
          return;

        default:
          break;
      }

      switch (event.key.toLowerCase()) {
        case 'm':
          playerActions.toggleMute();
          return;
        case 's':
          playerActions.toggleShuffle();
          return;
        case 'r':
          playerActions.cycleRepeat();
          return;
        case 'q':
          ui.setQueueOpen(!ui.queueOpen);
          return;
        case 'n':
          ui.setNowPlaying(!ui.nowPlayingOpen);
          return;
        case 'f':
          void favoriteCurrent();
          return;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}

function nudgeSeek(deltaSec: number): void {
  if (!usePlayer.getState().track) return;
  const { positionSec, durationSec } = usePlayerPosition.getState();
  const target = positionSec + deltaSec;
  playerActions.seek(Math.min(Math.max(0, target), durationSec > 0 ? durationSec : target));
}

function nudgeVolume(delta: number): void {
  const current = useSettings.getState().volume;
  playerActions.setVolume(Math.min(1, Math.max(0, current + delta)));
}

async function favoriteCurrent(): Promise<void> {
  const track = usePlayer.getState().track;
  if (!track) return;
  // Routed through the player, not the repository directly, so the heart in
  // the player bar and Now Playing actually reflects the change (spec §15).
  await playerActions.setFavorite(track.id, !track.favorite);
  useUi
    .getState()
    .toast(track.favorite ? 'Removed from favourites.' : 'Added to favourites.', {
      kind: 'success',
    });
}
