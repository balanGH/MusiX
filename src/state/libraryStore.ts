/**
 * Library state: sources, counts, and the scan lifecycle.
 *
 * The store holds *summaries* only — counts, source rows, scan progress. Track
 * lists are never held here: at 100k tracks that would be tens of megabytes of
 * React state re-rendering on every change. Pages fetch what they display
 * through the repositories and keep it in local state.
 */

import { create } from 'zustand';
import { countAlbums, countArtists, countFolders, listSources } from '@core/db/repositories/library';
import { countTracks, favoriteCount } from '@core/db/repositories/tracks';
import { putSource, removeSource } from '@core/db/repositories/library';
import { requestPersistentStorage } from '@core/db/database';
import { createLogger, describeError } from '@core/logger';
import { ensureBuiltinPlaylists } from '@core/playlists/smart';
import { invalidateSearchIndex } from '@core/search';
import {
  capabilities,
  disposeSource,
  importFiles,
  pickDirectory,
  pickFiles,
  registerProvider,
  restoreAllSources,
  unregisterProvider,
} from '@core/platform';
import { cancelScan, PermissionRequiredError, runScan } from '@core/library/worker/client';
import type { ScanProgress } from '@core/library/scanner';
import type { MusicSource, ScanRecord } from '@core/types';

const log = createLogger('library.store');

export interface LibraryCounts {
  tracks: number;
  albums: number;
  artists: number;
  folders: number;
  favorites: number;
}

export interface ImportProgressState {
  phase: 'copying' | 'scanning';
  copied: number;
  total: number;
  currentFile: string;
}

export interface LibraryState {
  ready: boolean;
  sources: MusicSource[];
  /** Sources whose folder permission has lapsed and needs a click to restore. */
  needsPermission: MusicSource[];
  counts: LibraryCounts;
  scan: ScanProgress | null;
  /** Set while files are being copied into OPFS on the mobile path. */
  importing: ImportProgressState | null;
  lastScan: ScanRecord | null;
  error: string | null;
  /** Bumped whenever the library's contents change, so pages can refetch. */
  revision: number;

  bootstrap(): Promise<void>;
  refreshCounts(): Promise<void>;
  addFolder(): Promise<{ added: boolean; message?: string }>;
  addFiles(options: { folder: boolean }): Promise<{ added: boolean; message?: string }>;
  importDownloadedFile(file: File, displayName: string): Promise<{ added: boolean; message?: string }>;
  scanSource(sourceId: string, mode?: 'incremental' | 'full'): Promise<void>;
  scanAll(mode?: 'incremental' | 'full'): Promise<void>;
  cancelScan(): void;
  forgetSource(sourceId: string): Promise<void>;
  reconnect(sourceId: string): Promise<boolean>;
  refreshSources(): Promise<void>;
  clearError(): void;
}

const EMPTY_COUNTS: LibraryCounts = { tracks: 0, albums: 0, artists: 0, folders: 0, favorites: 0 };

export const useLibrary = create<LibraryState>()((set, get) => ({
  ready: false,
  sources: [],
  needsPermission: [],
  counts: EMPTY_COUNTS,
  scan: null,
  importing: null,
  lastScan: null,
  error: null,
  revision: 0,

  async bootstrap() {
    try {
      // Ask once, early: without it the whole library is evictable storage.
      await requestPersistentStorage();
      await ensureBuiltinPlaylists();

      const { ready, needsPermission, broken } = await restoreAllSources();
      if (broken.length > 0) {
        log.warn(`${broken.length} source(s) could not be restored`);
      }

      set({
        sources: [...ready, ...needsPermission, ...broken].sort((a, b) => a.addedAt - b.addedAt),
        needsPermission,
        ready: true,
      });
      await get().refreshCounts();
    } catch (error) {
      log.error('library bootstrap failed', error);
      set({ ready: true, error: describeError(error) });
    }
  },

  async refreshCounts() {
    const [tracks, albums, artists, folders, favorites] = await Promise.all([
      countTracks(),
      countAlbums(),
      countArtists(),
      countFolders(),
      favoriteCount(),
    ]);
    set({ counts: { tracks, albums, artists, folders, favorites } });
  },

  /** Desktop path: index a real folder in place (spec §9). */
  async addFolder() {
    if (!capabilities().directoryPicker) {
      return {
        added: false,
        message: 'This browser cannot open a folder. Import files instead.',
      };
    }
    try {
      const picked = await pickDirectory();
      if (!picked) return { added: false };

      registerProvider(picked.provider);
      const source: MusicSource = {
        id: picked.sourceId,
        kind: 'directory',
        name: picked.name,
        addedAt: Date.now(),
        lastScanAt: null,
        trackCount: 0,
        handleKey: picked.handleKey,
      };
      await putSource(source);
      set((state) => ({ sources: [...state.sources, source] }));

      await get().scanSource(source.id, 'full');
      return { added: true };
    } catch (error) {
      const message = describeError(error);
      set({ error: message });
      return { added: false, message };
    }
  },

  /**
   * Mobile / Firefox / Safari path: copy the picked files into OPFS.
   *
   * The copy is unavoidable — see core/platform/importedSource.ts for why — so
   * it is at least reported honestly with a progress bar.
   */
  async addFiles({ folder }) {
    try {
      const files = await pickFiles({ folder });
      if (files.length === 0) return { added: false };

      set({ importing: { phase: 'copying', copied: 0, total: files.length, currentFile: '' } });

      const name = folder
        ? deriveFolderName(files) || 'Imported music'
        : `${files.length} imported file${files.length === 1 ? '' : 's'}`;

      const result = await importFiles(files, name, (progress) =>
        set({
          importing: {
            phase: 'copying',
            copied: progress.copied,
            total: progress.total,
            currentFile: progress.currentFile,
          },
        }),
      );

      registerProvider(result.provider);
      const source: MusicSource = {
        id: result.sourceId,
        kind: 'imported',
        name: result.name,
        addedAt: Date.now(),
        lastScanAt: null,
        trackCount: 0,
        handleKey: null,
      };
      await putSource(source);
      set((state) => ({
        sources: [...state.sources, source],
        importing: { phase: 'scanning', copied: result.copied, total: result.copied, currentFile: '' },
      }));

      await get().scanSource(source.id, 'full');
      set({ importing: null });

      return {
        added: result.copied > 0,
        message:
          result.failed.length > 0
            ? `${result.copied} imported, ${result.failed.length} could not be copied.`
            : undefined,
      };
    } catch (error) {
      const message = describeError(error);
      set({ importing: null, error: message });
      return { added: false, message };
    }
  },

  /**
   * A single track fetched from the online downloader (spec §23's "not in
   * your library" path). Copied into OPFS through the same imported-source
   * pipeline as a manual file pick, so it shows up, plays, and survives a
   * reload exactly like any other imported track.
   */
  async importDownloadedFile(file, displayName) {
    try {
      const result = await importFiles([file], displayName);
      if (result.copied === 0) {
        return { added: false, message: result.failed[0]?.reason ?? 'Could not save the download.' };
      }

      registerProvider(result.provider);
      const source: MusicSource = {
        id: result.sourceId,
        kind: 'imported',
        name: result.name,
        addedAt: Date.now(),
        lastScanAt: null,
        trackCount: 0,
        handleKey: null,
      };
      await putSource(source);
      set((state) => ({ sources: [...state.sources, source] }));

      await get().scanSource(source.id, 'full');
      return { added: true };
    } catch (error) {
      const message = describeError(error);
      set({ error: message });
      return { added: false, message };
    }
  },

  async scanSource(sourceId, mode = 'incremental') {
    if (get().scan) return; // One scan at a time keeps the disk and the UI sane.
    set({ scan: null, error: null });

    try {
      const record = await runScan(sourceId, {
        mode,
        onProgress: (progress) => set({ scan: progress }),
      });
      set((state) => ({
        scan: null,
        lastScan: record,
        revision: state.revision + 1,
        needsPermission: state.needsPermission.filter((source) => source.id !== sourceId),
      }));
      await get().refreshSources();
      await get().refreshCounts();
      invalidateSearchIndex();
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        set((state) => ({
          scan: null,
          needsPermission: state.needsPermission.some((source) => source.id === sourceId)
            ? state.needsPermission
            : [...state.needsPermission, error.source],
          error: error.message,
        }));
        return;
      }
      set({ scan: null, error: describeError(error) });
    }
  },

  async scanAll(mode = 'incremental') {
    for (const source of get().sources) {
      await get().scanSource(source.id, mode);
    }
  },

  cancelScan() {
    cancelScan();
  },

  async forgetSource(sourceId) {
    const source = get().sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    try {
      await disposeSource(source);
      await removeSource(sourceId);
      unregisterProvider(sourceId);
      set((state) => ({
        sources: state.sources.filter((candidate) => candidate.id !== sourceId),
        needsPermission: state.needsPermission.filter((candidate) => candidate.id !== sourceId),
        revision: state.revision + 1,
      }));
      invalidateSearchIndex();
      await get().refreshCounts();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  /** Re-grant folder access. Must be called from a click. */
  async reconnect(sourceId) {
    await get().scanSource(sourceId, 'incremental');
    return !get().needsPermission.some((source) => source.id === sourceId);
  },

  async refreshSources() {
    set({ sources: await listSources() });
  },

  clearError() {
    set({ error: null });
  },
}));

/** First path segment of a picked folder, which is the folder's own name. */
function deriveFolderName(files: readonly File[]): string {
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relative) {
      const first = relative.split('/')[0];
      if (first) return first;
    }
  }
  return '';
}
