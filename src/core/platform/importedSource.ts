/**
 * Files copied into the origin-private file system (mobile, Firefox, Safari).
 *
 * The trade-off is deliberate and worth being explicit about, because it is the
 * one place a web build cannot honour the spec's "never copy the user's files"
 * rule (§9):
 *
 *   A browser without the File System Access API cannot hand back a folder — or
 *   even a single file — after a reload. A `File` from an `<input>` is a
 *   one-session-only reference. So either MusiX copies the bytes it was given
 *   into storage it *can* reopen, or the user re-picks their whole library on
 *   every launch. Copying once is the only version of this that is offline-first.
 *
 * The original folder structure is preserved from `webkitRelativePath`, so the
 * folder browser (§31) and album grouping work exactly as they do on desktop.
 */

import { createLogger, describeError } from '../logger';
import { isSupportedAudioFile } from '../metadata';
import { hashId } from '../utils';
import { joinPath, type AccessState, type FileEntry, type ListOptions, type SourceProvider } from './fs';

const log = createLogger('fs:imported');

/** Everything MusiX stores lives under this directory inside OPFS. */
const ROOT_DIRECTORY = 'musix-sources';

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('This browser has no private file storage, so files cannot be imported.');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
}

/** Walk to a nested OPFS directory, creating segments when asked. */
async function resolveDirectory(
  from: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let current = from;
  for (const segment of path.split('/')) {
    if (!segment) continue;
    try {
      current = await current.getDirectoryHandle(segment, { create });
    } catch {
      return null;
    }
  }
  return current;
}

export class ImportedSource implements SourceProvider {
  readonly kind = 'imported' as const;

  constructor(
    readonly sourceId: string,
    readonly name: string,
  ) {}

  private async base(create = false): Promise<FileSystemDirectoryHandle | null> {
    const root = await opfsRoot();
    try {
      return await root.getDirectoryHandle(this.sourceId, { create });
    } catch {
      return null;
    }
  }

  /** OPFS is always readable — it belongs to the origin, not the user's disk. */
  async access(): Promise<AccessState> {
    try {
      return (await this.base()) ? 'granted' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async *list(options: ListOptions = {}): AsyncGenerator<FileEntry, void, void> {
    const base = await this.base();
    if (!base) return;

    let seen = 0;
    const stack: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [
      { handle: base, path: '' },
    ];

    while (stack.length > 0) {
      if (options.signal?.aborted) return;
      const { handle, path } = stack.pop()!;
      for await (const [entryName, entryHandle] of handle.entries()) {
        if (options.signal?.aborted) return;
        if (entryHandle.kind === 'directory') {
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
          log.warn(`cannot stat imported file ${joinPath(path, entryName)}`, error);
        }
      }
    }
  }

  async open(path: string): Promise<File | null> {
    const base = await this.base();
    if (!base) return null;
    const slash = path.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : path.slice(0, slash);
    const fileName = slash === -1 ? path : path.slice(slash + 1);
    try {
      const dir = await resolveDirectory(base, dirPath, false);
      if (!dir) return null;
      const fileHandle = await dir.getFileHandle(fileName);
      return await fileHandle.getFile();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        log.warn(`cannot open imported ${path}: ${describeError(error)}`);
      }
      return null;
    }
  }

  /**
   * Delete the copies.
   *
   * Unlike a directory source this really does own its bytes, so removing the
   * source must reclaim the space or the user's storage quota leaks.
   */
  async dispose(deleteData: boolean): Promise<void> {
    if (!deleteData) return;
    try {
      const root = await opfsRoot();
      await root.removeEntry(this.sourceId, { recursive: true });
    } catch (error) {
      log.warn(`could not remove imported source ${this.sourceId}`, error);
    }
  }
}

export interface ImportProgress {
  copied: number;
  total: number;
  bytesCopied: number;
  currentFile: string;
}

export interface ImportResult {
  sourceId: string;
  name: string;
  provider: ImportedSource;
  copied: number;
  skipped: number;
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Copy picked files into OPFS.
 *
 * Streams rather than buffering: a 700 MB folder of FLACs must not be held in
 * memory at once, which is exactly the constraint that matters on the phones
 * this path exists for (spec §36).
 */
export async function importFiles(
  files: readonly File[],
  displayName: string,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const audioFiles = files.filter((file) => isSupportedAudioFile(file.name));
  const sourceId = hashId(`imported:${displayName}:${Date.now()}:${Math.random()}`);
  const root = await opfsRoot();
  const base = await root.getDirectoryHandle(sourceId, { create: true });

  let copied = 0;
  let bytesCopied = 0;
  const failed: Array<{ name: string; reason: string }> = [];

  for (const file of audioFiles) {
    if (signal?.aborted) break;

    // `webkitRelativePath` is set when the user picked a folder; otherwise the
    // file lands at the root, which is the honest representation of what we know.
    const relative = sanitiseRelativePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    );
    const slash = relative.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : relative.slice(0, slash);
    const fileName = slash === -1 ? relative : relative.slice(slash + 1);

    try {
      const dir = dirPath ? await resolveDirectory(base, dirPath, true) : base;
      if (!dir) throw new Error('could not create destination directory');
      const handle = await dir.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await file.stream().pipeTo(writable);
      copied++;
      bytesCopied += file.size;
      onProgress?.({ copied, total: audioFiles.length, bytesCopied, currentFile: file.name });
    } catch (error) {
      failed.push({ name: file.name, reason: describeError(error) });
      log.warn(`failed to import ${file.name}`, error);
    }
  }

  return {
    sourceId,
    name: displayName,
    provider: new ImportedSource(sourceId, displayName),
    copied,
    skipped: files.length - audioFiles.length,
    failed,
  };
}

/**
 * Copy one more file into an *already-existing* imported source.
 *
 * `importFiles` always mints a fresh source (a new OPFS directory, a new
 * `sourceId`) — correct for the case it exists for, the user explicitly
 * picking a folder or a batch of files, where each pick genuinely is a new
 * source. It is the wrong function for a downloaded song landing one at a
 * time: calling it per song, as the online-download flow originally did,
 * gave each individual track its own top-level `MusicSource` and Folder
 * entry — a library that filled up with one-track "sources" instead of a
 * single accumulating "Downloads" folder. This is the function that lets
 * downloads keep adding into one source instead.
 */
export async function addFileToSource(
  sourceId: string,
  file: File,
): Promise<{ copied: boolean; reason?: string }> {
  if (!isSupportedAudioFile(file.name)) {
    return { copied: false, reason: `“${file.name}” is not a supported audio format.` };
  }
  try {
    const root = await opfsRoot();
    const base = await root.getDirectoryHandle(sourceId, { create: true });
    // Re-downloading the same song overwrites its old copy rather than
    // accumulating duplicates — `file.name` is stable across a re-download
    // (the backend renames to the same "Title - Artist.mp3" each time), and
    // the scanner's own fingerprinting then treats it as an updated file at
    // the same path, not a new track, once it rescans this source.
    const handle = await base.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable);
    return { copied: true };
  } catch (error) {
    return { copied: false, reason: describeError(error) };
  }
}

/**
 * Make a browser-supplied relative path safe to use as an OPFS path.
 *
 * The first segment of `webkitRelativePath` is the picked folder's own name,
 * which would otherwise be duplicated under the source directory.
 */
function sanitiseRelativePath(raw: string): string {
  const segments = raw
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  if (segments.length > 1) segments.shift();
  return segments.join('/') || 'track';
}

/** Recreate a provider for an imported source from a previous session. */
export function restoreImportedSource(sourceId: string, name: string): ImportedSource {
  return new ImportedSource(sourceId, name);
}

/** Total bytes MusiX has copied into OPFS, for the storage panel. */
export async function importedStorageUsage(): Promise<number> {
  let total = 0;
  try {
    const root = await opfsRoot();
    const stack: FileSystemDirectoryHandle[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'directory') stack.push(handle as FileSystemDirectoryHandle);
        else total += (await (handle as FileSystemFileHandle).getFile()).size;
      }
    }
  } catch {
    return 0;
  }
  return total;
}
