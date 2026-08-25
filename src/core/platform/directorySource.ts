/**
 * A music folder held as a `FileSystemDirectoryHandle` (desktop Chromium).
 *
 * This is the implementation the spec really describes: files are indexed where
 * they live and never copied (§9). The handle survives in IndexedDB across
 * sessions, but its *permission* does not — Chromium requires a user gesture to
 * re-grant read access after a restart, which is why `access(interactive)`
 * exists and why the UI shows a "Reconnect folder" affordance rather than
 * silently failing.
 */

import { getDb } from '../db/database';
import { get as getOne, putMany, remove } from '../db/idb';
import { Stores } from '../db/schema';
import { createLogger, describeError } from '../logger';
import { isSupportedAudioFile } from '../metadata';
import { hashId } from '../utils';
import { joinPath, type AccessState, type FileEntry, type ListOptions, type SourceProvider } from './fs';

const log = createLogger('fs:directory');

interface HandleRow {
  key: string;
  handle: FileSystemDirectoryHandle;
}

/** Directories MusiX will not walk into — never music, often enormous. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash',
  '.Trashes',
  '__MACOSX',
  '.thumbnails',
]);

export class DirectorySource implements SourceProvider {
  readonly kind = 'directory' as const;
  /** Directory handles cached by relative path, so repeated opens are cheap. */
  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(
    readonly sourceId: string,
    readonly name: string,
    private readonly root: FileSystemDirectoryHandle,
  ) {
    this.dirCache.set('', root);
  }

  /**
   * The underlying handle, so it can be transferred to the scan worker.
   *
   * Exposed read-only rather than made public on the field, because nothing
   * else should be reaching around this class to touch the filesystem.
   */
  get rootHandle(): FileSystemDirectoryHandle {
    return this.root;
  }

  async access(interactive: boolean): Promise<AccessState> {
    const options: FileSystemHandlePermissionDescriptor = { mode: 'read' };
    // Inside a worker the Permissions methods may be absent. Assume access is
    // granted there — the main thread verified it before handing the handle
    // over, and a genuine denial surfaces as a read error with a clear message.
    if (typeof this.root.queryPermission !== 'function') return 'granted';
    try {
      const current = await this.root.queryPermission(options);
      if (current === 'granted') return 'granted';
      if (!interactive) return current === 'denied' ? 'denied' : 'prompt';
      // Only reachable from a click; the browser rejects it otherwise.
      const requested = await this.root.requestPermission(options);
      return requested === 'granted' ? 'granted' : requested === 'denied' ? 'denied' : 'prompt';
    } catch (error) {
      log.warn(`permission check failed for ${this.name}`, error);
      return 'unavailable';
    }
  }

  async *list(options: ListOptions = {}): AsyncGenerator<FileEntry, void, void> {
    let seen = 0;
    // Explicit stack rather than recursion: a deeply-nested library should not
    // be able to overflow, and an abort must take effect immediately.
    const stack: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [
      { handle: this.root, path: '' },
    ];

    while (stack.length > 0) {
      if (options.signal?.aborted) return;
      const { handle, path } = stack.pop()!;
      this.dirCache.set(path, handle);

      let entries: AsyncIterableIterator<[string, FileSystemHandle]>;
      try {
        entries = handle.entries();
      } catch (error) {
        // An unreadable directory is reported and skipped, not fatal (spec §34).
        log.warn(`cannot read directory ${path || this.name}`, error);
        continue;
      }

      try {
        for await (const [entryName, entryHandle] of entries) {
          if (options.signal?.aborted) return;

          if (entryHandle.kind === 'directory') {
            if (entryName.startsWith('.') || SKIP_DIRECTORIES.has(entryName)) continue;
            stack.push({
              handle: entryHandle as FileSystemDirectoryHandle,
              path: joinPath(path, entryName),
            });
            continue;
          }

          if (!isSupportedAudioFile(entryName)) continue;

          try {
            const file = await (entryHandle as FileSystemFileHandle).getFile();
            seen++;
            options.onProgress?.(seen, path);
            yield {
              path: joinPath(path, entryName),
              name: entryName,
              sizeBytes: file.size,
              lastModified: file.lastModified,
            };
          } catch (error) {
            log.warn(`cannot stat ${joinPath(path, entryName)}`, error);
          }
        }
      } catch (error) {
        log.warn(`directory walk failed under ${path || this.name}`, error);
      }
    }
  }

  async open(path: string): Promise<File | null> {
    const slash = path.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : path.slice(0, slash);
    const fileName = slash === -1 ? path : path.slice(slash + 1);

    try {
      const dir = await this.resolveDirectory(dirPath);
      if (!dir) return null;
      const fileHandle = await dir.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch (error) {
      // NotFoundError is the normal case for a file the user deleted outside
      // MusiX; anything else is worth a log line.
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        log.warn(`cannot open ${path}: ${describeError(error)}`);
      }
      return null;
    }
  }

  private async resolveDirectory(dirPath: string): Promise<FileSystemDirectoryHandle | null> {
    const cached = this.dirCache.get(dirPath);
    if (cached) return cached;

    let current = this.root;
    let walked = '';
    for (const segment of dirPath.split('/')) {
      if (!segment) continue;
      current = await current.getDirectoryHandle(segment);
      walked = joinPath(walked, segment);
      this.dirCache.set(walked, current);
    }
    return current;
  }

  async dispose(): Promise<void> {
    // Nothing to release: the files were never ours. The stored handle is
    // removed by `forgetHandle` when the source itself is deleted.
    this.dirCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Picking and persistence
// ---------------------------------------------------------------------------

export interface PickedDirectory {
  sourceId: string;
  name: string;
  handleKey: string;
  provider: DirectorySource;
}

/**
 * Show the folder picker and persist the resulting handle.
 *
 * Returns null when the user cancels, which is not an error.
 */
export async function pickDirectory(): Promise<PickedDirectory | null> {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error('This browser cannot open a folder. Import individual files instead.');
  }

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({
      // `id` makes the browser remember where the user last looked.
      id: 'musix-music-folder',
      mode: 'read',
      startIn: 'music',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }

  // Two folders with the same name are common ("Music" on two drives), so the
  // id includes a random component and is not derived from the name alone.
  const sourceId = hashId(`dir:${handle.name}:${Date.now()}:${Math.random()}`);
  const handleKey = `source:${sourceId}`;
  await saveHandle(handleKey, handle);

  return {
    sourceId,
    name: handle.name,
    handleKey,
    provider: new DirectorySource(sourceId, handle.name, handle),
  };
}

async function saveHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await putMany<HandleRow>(await getDb(), Stores.handles, [{ key, handle }]);
}

/** Rebuild a provider for a source stored in a previous session. */
export async function restoreDirectorySource(
  sourceId: string,
  name: string,
  handleKey: string,
): Promise<DirectorySource | null> {
  const row = await getOne<HandleRow>(await getDb(), Stores.handles, handleKey);
  if (!row?.handle) {
    log.warn(`no stored handle for ${handleKey}`);
    return null;
  }
  return new DirectorySource(sourceId, name, row.handle);
}

export async function forgetHandle(handleKey: string): Promise<void> {
  await remove(await getDb(), Stores.handles, handleKey);
}
