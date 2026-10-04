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
import { countTracks, favoriteCount, trackIdsBySource } from '@core/db/repositories/tracks';
import { pruneMissingEntries } from '@core/db/repositories/playlists';
import { rebuildAggregates } from '@core/library/importer';
import { getSource, putSource, removeSource } from '@core/db/repositories/library';
import { requestPersistentStorage } from '@core/db/database';
import { createLogger, describeError } from '@core/logger';
import { ensureBuiltinPlaylists } from '@core/playlists/smart';
import { invalidateSearchIndex } from '@core/search';
import { hashId } from '@core/utils';
import {
  addFileToSource,
  capabilities,
  disposeSource,
  ensureMusicPermission,
  importFiles,
  ImportedSource,
  NATIVE_SOURCE_ID,
  NATIVE_SOURCE_NAME,
  NativeSource,
  previewPhoneFolders,
  pickDirectory,
  pickFiles,
  registerProvider,
  restoreAllSources,
  unregisterProvider,
} from '@core/platform';
import { cancelScan, PermissionRequiredError, runScan } from '@core/library/worker/client';
import type { ScanProgress } from '@core/library/scanner';
import type { MusicSource, ScanRecord } from '@core/types';

/**
 * Fixed, not random: every downloaded song needs to land in the *same* source
 * across the whole app lifetime, which a `hashId(...Date.now()...)` — the id
 * every other imported source gets — cannot give, since a new one is minted
 * on every call. A single well-known id lets `importDownloadedFile` find its
 * own source back on the next download without keeping any extra state.
 */
const DOWNLOADS_SOURCE_ID = hashId('musix:downloads-source');

const log = createLogger('library.store');

/**
 * One scan at a time keeps the disk and the UI sane. The flag is module state,
 * set synchronously on entry — `state.scan` only fills in on the first progress
 * message, so guarding on it let a second scan start in the gap.
 */
let scanRunning = false;
/**
 * Scans requested while another was running, one per source, drained in order
 * afterwards. Dropping them instead meant a download imported mid-scan was
 * copied into OPFS but never indexed.
 */
const scanQueue = new Map<string, { mode: 'incremental' | 'full'; waiters: (() => void)[] }>();

function idleProgress(sourceId: string): ScanProgress {
  return {
    sourceId,
    phase: 'listing',
    filesSeen: 0,
    processed: 0,
    total: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    failed: 0,
    currentPath: '',
  };
}

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
  /**
   * Android app: add (or update) the phone-library source. `excludedFolders`
   * defaults to the source's current choice, or to the junk-looking folders.
   */
  addPhoneMusic(excludedFolders?: string[]): Promise<{ added: boolean; message?: string }>;
  importDownloadedFile(file: File): Promise<{ added: boolean; message?: string }>;
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
    // The Android app has no folder picker that works; "add a folder" there
    // means the phone's library (every "Add folder" button lands here).
    if (capabilities().nativeLibrary) return get().addPhoneMusic();
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
   * Android app path: the phone's own music library, read in place.
   *
   * There is only ever one such source (fixed id), so calling this again —
   * from "Scan phone music" or with a new folder choice — updates and rescans
   * it rather than adding a second copy of the same files.
   */
  async addPhoneMusic(excludedFolders) {
    try {
      const permission = await ensureMusicPermission();
      if (permission !== 'granted') {
        return {
          added: false,
          message:
            permission === 'denied'
              ? 'MusiX is not allowed to read music. In Android Settings, open Apps › MusiX › Permissions › Music and audio and choose Allow.'
              : 'MusiX needs permission to read the music on this phone.',
        };
      }

      const existing = await getSource(NATIVE_SOURCE_ID);
      const excluded =
        excludedFolders ??
        existing?.excludedFolders ??
        (await previewPhoneFolders())
          .filter((folder) => folder.junk)
          .map((folder) => folder.folder);

      const source: MusicSource = existing
        ? { ...existing, excludedFolders: excluded }
        : {
            id: NATIVE_SOURCE_ID,
            kind: 'native',
            name: NATIVE_SOURCE_NAME,
            addedAt: Date.now(),
            lastScanAt: null,
            trackCount: 0,
            handleKey: null,
            excludedFolders: excluded,
          };
      // A fresh provider, so the new exclusions apply to this scan.
      registerProvider(new NativeSource(source.id, source.name, excluded));
      await putSource(source);
      set((state) => ({
        sources: existing
          ? state.sources.map((candidate) => (candidate.id === source.id ? source : candidate))
          : [...state.sources, source],
      }));

      // Incremental for an update: unchanged files are skipped, and files in
      // newly excluded folders are pruned because the listing no longer has them.
      await get().scanSource(source.id, existing ? 'incremental' : 'full');
      const trackCount = (await getSource(source.id))?.trackCount ?? 0;
      return {
        added: trackCount > 0,
        message: trackCount === 0 ? 'No songs were found in the folders you chose.' : undefined,
      };
    } catch (error) {
      const message = describeError(error);
      set({ error: message });
      return { added: false, message };
    }
  },

  /**
   * A single track fetched from the online downloader (spec §23's "not in
   * your library" path). Copied into OPFS through the same imported-source
   * pipeline as a manual file pick, so it shows up, plays, and survives a
   * reload exactly like any other imported track.
   */
  /**
   * All songs downloaded from search land in the same "Downloads" source —
   * created once, on the first download, and reused after that — rather than
   * each one minting its own single-track source. The latter is what
   * `importFiles` does (correctly, for the folder/file *picker*, where each
   * pick genuinely is a new source); calling it per song instead filled the
   * Folders page with a separate one-track folder per download.
   */
  async importDownloadedFile(file) {
    try {
      let source = await getSource(DOWNLOADS_SOURCE_ID);

      if (!source) {
        source = {
          id: DOWNLOADS_SOURCE_ID,
          kind: 'imported',
          name: 'Downloads',
          addedAt: Date.now(),
          lastScanAt: null,
          trackCount: 0,
          handleKey: null,
        };
        await putSource(source);
        set((state) => ({ sources: [...state.sources, source!] }));
      }

      registerProvider(new ImportedSource(DOWNLOADS_SOURCE_ID, source.name));

      const result = await addFileToSource(DOWNLOADS_SOURCE_ID, file);
      if (!result.copied) {
        return { added: false, message: result.reason ?? 'Could not save the download.' };
      }

      await get().scanSource(DOWNLOADS_SOURCE_ID, 'incremental');
      return { added: true };
    } catch (error) {
      const message = describeError(error);
      set({ error: message });
      return { added: false, message };
    }
  },

  async scanSource(sourceId, mode = 'incremental') {
    if (scanRunning) {
      // Resolves once the queued scan has actually run, so callers such as
      // `importDownloadedFile` still see the track indexed when they resume.
      return new Promise<void>((resolve) => {
        const queued = scanQueue.get(sourceId);
        if (queued) {
          if (mode === 'full') queued.mode = 'full';
          queued.waiters.push(resolve);
        } else {
          scanQueue.set(sourceId, { mode, waiters: [resolve] });
        }
      });
    }
    scanRunning = true;
    set({ scan: idleProgress(sourceId), error: null });

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
    } finally {
      scanRunning = false;
      const next = scanQueue.entries().next();
      if (!next.done) {
        const [nextId, queued] = next.value;
        scanQueue.delete(nextId);
        // Synchronous up to its own `scanRunning = true`, so nothing can slip in.
        void get()
          .scanSource(nextId, queued.mode)
          .finally(() => {
            for (const resolve of queued.waiters) resolve();
          });
      }
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
      // Captured before the rows go, so playlist entries pointing at them can
      // be pruned afterwards.
      const removedTrackIds = await trackIdsBySource(sourceId);
      await disposeSource(source);
      await removeSource(sourceId);
      unregisterProvider(sourceId);
      // Albums/artists are derived caches; without a rebuild the removed
      // source's albums and artists linger as empty ghosts.
      await rebuildAggregates();
      await pruneMissingEntries(removedTrackIds);
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
