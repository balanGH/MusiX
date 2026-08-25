/**
 * User settings.
 *
 * Persisted to localStorage rather than IndexedDB for one specific reason:
 * index.html reads the theme *synchronously* before the first paint, and
 * IndexedDB is async. Everything here is small, so that is a fair trade.
 *
 * Privacy defaults (spec §32): every network feature is off, analytics does not
 * exist in this codebase at all, and nothing is uploaded. The switches below
 * are opt-in, one at a time.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { flatBands, type EqPresetName } from '@core/audio/equalizer';
import type { ReplayGainMode } from '@core/audio/engine';
import type { EqBand } from '@core/types';

export type ThemeChoice = 'system' | 'light' | 'dark' | 'amoled';
export type ListDensity = 'comfortable' | 'compact';
export type GridSize = 'small' | 'medium' | 'large';

export interface SettingsState {
  // ---- Appearance (spec §38) ----
  theme: ThemeChoice;
  /** Accent as an `r g b` triple, matching the CSS token format. */
  accent: string;
  /** Derive the accent from the current album artwork. */
  dynamicAccent: boolean;
  listDensity: ListDensity;
  gridSize: GridSize;
  sidebarCollapsed: boolean;

  // ---- Playback (spec §15) ----
  volume: number;
  muted: boolean;
  playbackRate: number;
  crossfadeSec: number;
  replayGainMode: ReplayGainMode;
  preventClipping: boolean;
  /** Resume where the last session left off. */
  resumeOnLaunch: boolean;

  // ---- Equaliser (spec §16) ----
  eqEnabled: boolean;
  eqBands: EqBand[];
  eqPreampDb: number;
  eqPreset: EqPresetName | 'Custom';

  // ---- Privacy (spec §32) — all off by default ----
  onlineMetadata: boolean;
  onlineArtwork: boolean;
  onlineLyrics: boolean;

  // ---- Library ----
  /** Ask to rescan sources on launch instead of doing it automatically (§4). */
  scanOnLaunch: boolean;

  setTheme(theme: ThemeChoice): void;
  setAccent(accent: string): void;
  patch(patch: Partial<SettingsState>): void;
  resetEq(): void;
}

export const ACCENT_CHOICES: { name: string; rgb: string }[] = [
  { name: 'Violet', rgb: '139 92 246' },
  { name: 'Indigo', rgb: '99 102 241' },
  { name: 'Sky', rgb: '56 189 248' },
  { name: 'Emerald', rgb: '52 211 153' },
  { name: 'Amber', rgb: '251 191 36' },
  { name: 'Rose', rgb: '251 113 133' },
  { name: 'Slate', rgb: '148 163 184' },
];

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      accent: '139 92 246',
      dynamicAccent: true,
      listDensity: 'comfortable',
      gridSize: 'medium',
      sidebarCollapsed: false,

      volume: 0.8,
      muted: false,
      playbackRate: 1,
      crossfadeSec: 0,
      replayGainMode: 'track',
      preventClipping: true,
      resumeOnLaunch: true,

      eqEnabled: false,
      eqBands: flatBands(),
      eqPreampDb: 0,
      eqPreset: 'Flat',

      onlineMetadata: false,
      onlineArtwork: false,
      onlineLyrics: false,

      scanOnLaunch: false,

      setTheme: (theme) => set({ theme }),
      setAccent: (accent) => set({ accent }),
      patch: (patch) => set(patch),
      resetEq: () => set({ eqBands: flatBands(), eqPreampDb: 0, eqPreset: 'Flat', eqEnabled: false }),
    }),
    {
      name: 'musix.settings',
      version: 1,
      // Actions are not state; excluding them keeps the stored blob clean and
      // means a rename cannot corrupt a user's saved settings.
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(([, value]) => typeof value !== 'function'),
        ) as SettingsState,
    },
  ),
);

/** Which concrete theme `system` currently resolves to. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' | 'amoled' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
