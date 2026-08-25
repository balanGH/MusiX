/**
 * The filesystem contract the rest of MusiX codes against.
 *
 * There are two implementations — a real directory held by handle, and files
 * copied into the origin-private file system — and the scanner, the player and
 * the folder browser cannot tell them apart. That boundary is what makes the
 * same core work on desktop and mobile, and what a native shell would replace
 * with a real filesystem later (docs/ARCHITECTURE.md).
 */

import type { SourceKind } from '../types';

export interface FileEntry {
  /** Path relative to the source root, POSIX separators, no leading slash. */
  path: string;
  name: string;
  sizeBytes: number;
  /** Epoch ms. Half of the incremental-scan fingerprint. */
  lastModified: number;
}

export type AccessState = 'granted' | 'prompt' | 'denied' | 'unavailable';

export interface ListOptions {
  signal?: AbortSignal;
  /** Called as directories are walked, so the UI can show progress. */
  onProgress?: (filesSeen: number, currentPath: string) => void;
}

export interface SourceProvider {
  readonly sourceId: string;
  readonly kind: SourceKind;
  /** Human-readable root name, for the sidebar and folder breadcrumb. */
  readonly name: string;

  /**
   * Enumerate audio files under the root.
   *
   * An async generator rather than an array: a 100k-file walk should start
   * producing work immediately and must be abortable mid-way (spec §35).
   */
  list(options?: ListOptions): AsyncGenerator<FileEntry, void, void>;

  /** Open one file for reading. Returns null when it has since disappeared. */
  open(path: string): Promise<File | null>;

  /**
   * Confirm MusiX may still read this source.
   *
   * Directory handles lose their grant between sessions and can only be
   * re-granted from a user gesture, hence the `interactive` flag: startup calls
   * it with `false` to detect the state, and a button calls it with `true`.
   */
  access(interactive: boolean): Promise<AccessState>;

  /** Release anything held; for OPFS sources this deletes the copies. */
  dispose(deleteData: boolean): Promise<void>;
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly sourceId: string,
    readonly state: AccessState,
  ) {
    super(
      state === 'prompt'
        ? 'MusiX needs permission to read this folder again.'
        : 'This music folder is no longer reachable.',
    );
    this.name = 'SourceUnavailableError';
  }
}

/** Join path segments into the POSIX form `FileEntry.path` uses. */
export function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join('/');
}
