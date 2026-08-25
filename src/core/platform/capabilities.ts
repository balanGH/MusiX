/**
 * What this browser can actually do.
 *
 * MusiX asks these questions once at startup and adapts the UI, rather than
 * offering a control and failing when it is used (spec §41). The answers differ
 * sharply by platform, which is the single biggest constraint on a web build:
 *
 *   Desktop Chromium  directory picker, persistent handles, files stay in place
 *   Android Chrome     file picker only, so files are copied into OPFS
 *   iOS Safari         file picker only, tighter storage quota
 *   Firefox            file picker only (no File System Access API at all)
 */

export interface Capabilities {
  /** `showDirectoryPicker` — lets MusiX scan a folder without copying it. */
  directoryPicker: boolean;
  /** Origin-private file system, used to persist individually-imported files. */
  opfs: boolean;
  /** `navigator.storage.persist` — protects the library from eviction. */
  persistentStorage: boolean;
  /** Media Session API — lock-screen and hardware media keys (spec §15). */
  mediaSession: boolean;
  /** Web Audio, without which there is no equaliser or crossfade. */
  webAudio: boolean;
  /** Web Workers, so scanning does not block the UI. */
  workers: boolean;
  /** `Blob.prototype.stream`, needed for the OPFS copy path. */
  blobStream: boolean;
  /** Coarse pointer — drives touch-sized controls and the mobile layout. */
  touch: boolean;
  /** Running as an installed PWA. */
  standalone: boolean;
  /** Running inside the Capacitor Android shell rather than a browser tab. */
  native: boolean;
  /**
   * `<input webkitdirectory>` picks a whole folder.
   *
   * Desktop browsers support it; Android's file chooser does not, so the
   * onboarding copy has to say "files" rather than "folder" there.
   */
  folderInput: boolean;
}

/**
 * Is MusiX running inside the native shell?
 *
 * Read off the global Capacitor injects rather than by importing
 * `@capacitor/core`, so `core/` keeps no dependency on the shell and still
 * builds for the plain web target.
 */
function isNativeShell(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?(): boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

let cached: Capabilities | null = null;

export function capabilities(): Capabilities {
  if (cached) return cached;

  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const win = typeof window === 'undefined' ? undefined : window;
  const native = isNativeShell();

  cached = {
    native,
    // Android's chooser has no notion of picking a directory, and the WebView
    // silently ignores the attribute rather than reporting it.
    folderInput:
      !native &&
      typeof document !== 'undefined' &&
      'webkitdirectory' in document.createElement('input'),
    directoryPicker: typeof win?.showDirectoryPicker === 'function',
    opfs: typeof nav?.storage?.getDirectory === 'function',
    persistentStorage: typeof nav?.storage?.persist === 'function',
    mediaSession: typeof nav !== 'undefined' && 'mediaSession' in nav,
    webAudio:
      typeof AudioContext !== 'undefined' ||
      typeof (win as unknown as { webkitAudioContext?: unknown })?.webkitAudioContext !==
        'undefined',
    workers: typeof Worker !== 'undefined',
    blobStream: typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function',
    touch: win?.matchMedia?.('(pointer: coarse)').matches ?? false,
    standalone:
      win?.matchMedia?.('(display-mode: standalone)').matches ||
      (nav as unknown as { standalone?: boolean })?.standalone === true ||
      false,
  };
  return cached;
}

/**
 * How this device should import music.
 *
 * `folder` keeps files where they are, which is what the spec wants (§9).
 * `files` has to copy into OPFS, because a mobile browser cannot hand back a
 * handle that survives a reload — the alternative would be re-picking the whole
 * library on every launch.
 */
export function importStrategy(): 'folder' | 'files' {
  return capabilities().directoryPicker ? 'folder' : 'files';
}

/** One-line explanation for the onboarding screen. */
export function importStrategyExplanation(): string {
  if (importStrategy() === 'folder') {
    return 'MusiX will index the folder in place. Your files are never copied or moved.';
  }
  if (capabilities().native) {
    // Being specific about Android: the shell can reach the real filesystem,
    // but that needs the native source provider (see docs/ANDROID.md). Until
    // then the WebView is subject to the same limit as a browser tab.
    return 'Pick the audio files you want. MusiX copies them into its own private storage on this device so they are always available offline.';
  }
  return 'This browser cannot re-open a folder after a reload, so the files you pick are copied into MusiX’s private storage on this device.';
}
