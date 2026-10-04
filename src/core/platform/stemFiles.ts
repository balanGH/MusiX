/**
 * Writing separated stems to the device's own storage — Android app version.
 *
 * This file is the one place the App branch differs from WebApp's no-op
 * version: the MusicLibrary plugin downloads each stem from the PC straight
 * into Music/MusiX/Stems/<song>/ (native/android/MusicLibraryPlugin.java), and
 * they play back from there through Capacitor's file URL, with the PC off.
 *
 * Kept to the same small interface so `core/studio/savedStems.ts` and the UI
 * stay identical on both branches.
 */

import { callNative, hasNativePlugin, isNativeApp, nativeFileUrl } from './native';

export interface StemFiles {
  /** Whether stems can be saved on this device at all. */
  available(): boolean;
  /**
   * Download `url` into `<stems folder>/<folder>/<fileName>`.
   *
   * @returns The saved file's absolute path.
   */
  download(url: string, folder: string, fileName: string): Promise<string>;
  /** Delete saved files; missing ones are ignored. */
  remove(paths: readonly string[]): Promise<void>;
  /** A URL the page can play, for a path `download` returned. */
  urlFor(path: string): string | null;
}

const PLUGIN = 'MusicLibrary';

/** Saving goes through MediaStore without a storage permission, which needs Android 10+. */
function androidVersion(): number {
  const match = /Android (\d+)/.exec(navigator.userAgent);
  return match ? Number(match[1]) : 0;
}

export const stemFiles: StemFiles = {
  available: () => isNativeApp() && hasNativePlugin(PLUGIN) && androidVersion() >= 10,

  async download(url, folder, fileName) {
    // The plugin fetches it natively, so it needs an absolute URL.
    const absolute = new URL(url, location.href).toString();
    const { path } = await callNative<{ path: string }>(PLUGIN, 'saveFromUrl', {
      url: absolute,
      folder,
      fileName,
    });
    return path;
  },

  async remove(paths) {
    if (paths.length > 0) await callNative(PLUGIN, 'deleteFiles', { paths: [...paths] });
  },

  urlFor: (path) => nativeFileUrl(path),
};
