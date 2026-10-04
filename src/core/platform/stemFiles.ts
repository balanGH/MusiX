/**
 * Writing separated stems to the device's own storage.
 *
 * The web build cannot: a browser has no shared folder to write into, and the
 * stems already sit on the same computer as the studio service. The Android
 * app (App branch) replaces this file with one that saves them under
 * Music/MusiX/Stems through its native plugin, so they play without the PC.
 *
 * Kept to this one small interface so `core/studio/savedStems.ts` and the UI
 * stay identical on both branches.
 */

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

export const stemFiles: StemFiles = {
  available: () => false,
  download: () => Promise.reject(new Error('Saving stems is only available in the MusiX app.')),
  remove: () => Promise.resolve(),
  urlFor: () => null,
};
