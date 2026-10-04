/**
 * The phone's music library, inside the MusiX Android app.
 *
 * The browser build cannot see the phone's files at all — `<input
 * webkitdirectory>` is ignored by Android's WebView — so the app ships a small
 * native plugin (native/android/MusicLibraryPlugin.java) that lists audio
 * through MediaStore. Files are then read *in place* through Capacitor's local
 * server (`/_capacitor_file_/<absolute path>`); nothing is copied, unlike an
 * imported source.
 *
 * Capacitor's bridge only exists on the main thread, so the scan worker cannot
 * use this provider; worker/client.ts scans native sources in-thread.
 */

import { createLogger, describeError } from '../logger';
import { hashId } from '../utils';
import type { MusicSource } from '../types';
import type { AccessState, FileEntry, ListOptions, SourceProvider } from './fs';
import { callNative, hasNativePlugin, isNativeApp, nativeFileUrl } from './native';
import {
  isExcluded,
  summariseFolders,
  toNativeEntry,
  type FolderSummary,
  type MediaStoreTrack,
  type NativeEntry,
} from './nativeLibrary';

const log = createLogger('fs:native');

const PLUGIN = 'MusicLibrary';

/** One phone, one library: the native source has a fixed id. */
export const NATIVE_SOURCE_ID = hashId('musix:native-source');
export const NATIVE_SOURCE_NAME = 'Phone music';

/**
 * Android's answer for the audio permission.
 * `prompt-with-rationale`: denied once, can ask again. `denied`: "don't ask
 * again" — only Android Settings can change it now.
 */
export type NativePermission = 'granted' | 'prompt' | 'prompt-with-rationale' | 'denied';

/** Typed wrapper over the native plugin; injectable so tests can replace it. */
export interface MusicLibraryApi {
  checkPermission(): Promise<NativePermission>;
  requestPermission(): Promise<NativePermission>;
  scan(): Promise<MediaStoreTrack[]>;
  openSettings(): Promise<void>;
}

export const musicLibrary: MusicLibraryApi = {
  async checkPermission() {
    return (await callNative<{ audio: NativePermission }>(PLUGIN, 'checkPermissions')).audio;
  },
  async requestPermission() {
    return (await callNative<{ audio: NativePermission }>(PLUGIN, 'requestPermissions')).audio;
  },
  async scan() {
    return (await callNative<{ tracks?: MediaStoreTrack[] }>(PLUGIN, 'scan')).tracks ?? [];
  },
  async openSettings() {
    await callNative<void>(PLUGIN, 'openSettings');
  },
};

/** Whether this is the Android app *and* it was built with the plugin. */
export function nativeLibraryAvailable(): boolean {
  return isNativeApp() && hasNativePlugin(PLUGIN);
}

/** Check, and if needed ask for, the audio permission. Call from a click. */
export async function ensureMusicPermission(
  library: MusicLibraryApi = musicLibrary,
): Promise<NativePermission> {
  const current = await library.checkPermission();
  if (current === 'granted') return current;
  // Asking again after "don't ask again" returns at once without a dialog, so
  // this is harmless and also picks up a grant made in Settings meanwhile.
  return library.requestPermission();
}

/** Everything MediaStore lists, grouped by folder, for the folder picker. */
export async function previewPhoneFolders(
  library: MusicLibraryApi = musicLibrary,
): Promise<FolderSummary[]> {
  const entries: FileEntry[] = [];
  for (const row of await library.scan()) {
    const entry = toNativeEntry(row);
    if (entry) entries.push(entry);
  }
  return summariseFolders(entries);
}

export class NativeSource implements SourceProvider {
  readonly kind = 'native' as const;
  private readonly excluded: ReadonlySet<string>;
  /** Entries by `FileEntry.path`, from the latest MediaStore query. */
  private readonly located = new Map<string, NativeEntry>();
  private locating: Promise<void> | null = null;

  constructor(
    readonly sourceId: string,
    readonly name: string,
    excludedFolders: readonly string[] = [],
    private readonly library: MusicLibraryApi = musicLibrary,
  ) {
    this.excluded = new Set(excludedFolders);
  }

  /**
   * A permanently denied permission is still reported as `prompt`, so the
   * source shows as "needs reconnecting" rather than broken: once the user
   * allows it in Android Settings, the reconnect button works again.
   */
  async access(interactive: boolean): Promise<AccessState> {
    try {
      const state = interactive
        ? await ensureMusicPermission(this.library)
        : await this.library.checkPermission();
      return state === 'granted' ? 'granted' : 'prompt';
    } catch (error) {
      log.warn(`cannot check the audio permission: ${describeError(error)}`);
      return 'unavailable';
    }
  }

  /** Every rescan re-queries MediaStore, so new and deleted files show up. */
  async *list(options: ListOptions = {}): AsyncGenerator<FileEntry, void, void> {
    const entries = await this.query();
    let seen = 0;
    for (const entry of entries) {
      if (options.signal?.aborted) return;
      seen++;
      options.onProgress?.(seen, entry.path);
      yield {
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        lastModified: entry.lastModified,
      };
    }
  }

  /** The WebView URL for a track, or null if MediaStore no longer lists it. */
  async urlFor(path: string): Promise<string | null> {
    const entry = await this.locate(path);
    return entry ? nativeFileUrl(entry.absolutePath) : null;
  }

  async open(path: string): Promise<File | null> {
    const entry = await this.locate(path);
    if (!entry) return null;
    const url = nativeFileUrl(entry.absolutePath);
    if (!url) return null;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size === 0 && entry.sizeBytes > 0) return null;
      return new File([blob], entry.name, {
        type: entry.mimeType ?? blob.type,
        lastModified: entry.lastModified,
      });
    } catch (error) {
      log.warn(`cannot read ${entry.absolutePath}: ${describeError(error)}`);
      return null;
    }
  }

  async dispose(): Promise<void> {
    // Nothing to delete: the files belong to the phone, not to MusiX.
    this.located.clear();
  }

  private async query(): Promise<NativeEntry[]> {
    const entries: NativeEntry[] = [];
    this.located.clear();
    for (const row of await this.library.scan()) {
      const entry = toNativeEntry(row);
      if (!entry || isExcluded(entry.path, this.excluded)) continue;
      // Two rows for one path can occur briefly while MediaStore rescans.
      if (this.located.has(entry.path)) continue;
      this.located.set(entry.path, entry);
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Find the absolute path for a library path. After a reload nothing has been
   * listed yet, so the first play runs one MediaStore query and keeps it.
   */
  private async locate(path: string): Promise<NativeEntry | null> {
    const known = this.located.get(path);
    if (known) return known;
    if (!this.locating) {
      this.locating = this.query()
        .then(() => undefined)
        .catch((error: unknown) => {
          log.warn(`cannot query the music library: ${describeError(error)}`);
          // Let the next open try again rather than failing for the session.
          this.locating = null;
        });
    }
    await this.locating;
    return this.located.get(path) ?? null;
  }
}

/** Rebuild the provider for a stored native source; null outside the app. */
export function restoreNativeSource(source: MusicSource): NativeSource | null {
  if (!isNativeApp()) return null;
  return new NativeSource(source.id, source.name, source.excludedFolders ?? []);
}
