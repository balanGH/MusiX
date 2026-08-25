/**
 * Applies the theme and the accent colour to the document.
 *
 * Renders nothing. All three inputs — the chosen theme, the chosen accent, and
 * the colour sampled from the current album artwork (spec §38) — resolve to CSS
 * custom properties on `<html>`, so a change repaints without re-rendering a
 * single component.
 *
 * index.html applies the stored theme before first paint; this keeps it in sync
 * afterwards and handles the `system` case changing while the app is open.
 */

import { useEffect } from 'react';
import { artworkDominant } from '@state/artworkCache';
import { usePlayer } from '@state/playerStore';
import { resolveTheme, useSettings } from '@state/settingsStore';

export function ThemeManager() {
  const theme = useSettings((state) => state.theme);
  const accent = useSettings((state) => state.accent);
  const dynamicAccent = useSettings((state) => state.dynamicAccent);
  const artworkId = usePlayer((state) => state.track?.artworkId ?? null);

  // Theme, including following the OS while set to `system`.
  useEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(theme);
      document.documentElement.dataset.theme = resolved;
      // Keeps the mobile browser chrome in step with the app background.
      const meta = document.querySelector('meta[name="theme-color"]');
      meta?.setAttribute('content', resolved === 'light' ? '#f9f9fb' : '#0b0b0f');
    };

    apply();
    if (theme !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  // User-chosen accent.
  useEffect(() => {
    document.documentElement.style.setProperty('--mx-accent-user', accent);
  }, [accent]);

  /**
   * Artwork-derived accent.
   *
   * The colour was extracted once at scan time, so this is a database read, not
   * an image decode — switching tracks costs nothing (spec §4).
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!dynamicAccent || !artworkId) {
      root.style.removeProperty('--mx-accent-dynamic');
      return;
    }

    let cancelled = false;
    void artworkDominant(artworkId).then((dominant) => {
      if (cancelled) return;
      if (dominant) root.style.setProperty('--mx-accent-dynamic', dominant);
      else root.style.removeProperty('--mx-accent-dynamic');
    });

    return () => {
      cancelled = true;
    };
  }, [dynamicAccent, artworkId]);

  return null;
}
