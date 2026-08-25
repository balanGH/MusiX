/**
 * Native-shell integration (Android).
 *
 * Everything here is a no-op in a browser tab, so the same bundle ships to the
 * web and to the APK. The imports are dynamic for the same reason: a browser
 * build should not pay for plugin code it will never call.
 *
 * Scope is deliberately small — the shell exists to give MusiX a real
 * filesystem and a home-screen icon, not to take over the UI.
 */

import { createLogger } from '@core/logger';
import { capabilities } from '@core/platform';
import { useUi } from '@state/uiStore';

const log = createLogger('native');

let initialised = false;

export async function initNative(): Promise<void> {
  if (initialised || !capabilities().native) return;
  initialised = true;

  await Promise.all([configureStatusBar(), wireBackButton()]);
  log.info('native shell ready');
}

/**
 * Draw behind the status bar and tint it to match the app background.
 *
 * The CSS already reserves `env(safe-area-inset-top)`, so overlaying gives the
 * edge-to-edge look without content sliding under the clock.
 */
async function configureStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
  } catch (error) {
    log.warn('could not configure the status bar', error);
  }
}

/**
 * Android's back button.
 *
 * Android users expect back to close whatever is on top before it navigates,
 * and to leave the app only from the root. Without this the button exits
 * mid-playlist, which reads as a crash.
 */
async function wireBackButton(): Promise<void> {
  try {
    const { App } = await import('@capacitor/app');

    await App.addListener('backButton', ({ canGoBack }) => {
      const ui = useUi.getState();

      // Innermost first, matching what Escape does on the desktop.
      if (ui.addToPlaylistFor) {
        ui.closeAddToPlaylist();
        return;
      }
      if (ui.confirm) {
        ui.resolveConfirm(false);
        return;
      }
      if (ui.nowPlayingOpen) {
        ui.setNowPlaying(false);
        return;
      }
      if (ui.queueOpen) {
        ui.setQueueOpen(false);
        return;
      }
      if (ui.mobileNavOpen) {
        ui.setMobileNavOpen(false);
        return;
      }

      if (canGoBack) {
        window.history.back();
        return;
      }
      void App.exitApp();
    });
  } catch (error) {
    log.warn('could not wire the back button', error);
  }
}
