/**
 * The library scanner.
 *
 * This is the function spec §4 is really about, so the cost model is worth
 * stating up front. For a source with N files of which C have changed:
 *
 *   1. Build the fingerprint map — one *key* cursor over
 *      `[sourceId, path, mtime, size]`. Zero records deserialised.
 *   2. Walk the directory — N `getFile()` stats.
 *   3. Parse tags for C files only, at bounded concurrency.
 *   4. Read the C existing rows, to carry over the user's data.
 *   5. Rebuild folders, then album/artist aggregates.
 *
 * So a rescan of an unchanged 50k-track library does N stats and nothing else:
 * no tag parsing, no image decoding, no writes. That is the difference between
 * a rescan being something a user can do freely and something they learn to
 * avoid.
 *
 * The whole thing runs in a Web Worker (worker/scan.worker.ts), which is why
 * this module never touches the DOM.
 */

import { getDb } from '../db/database';
import { Idx, Stores } from '../db/schema';
import { putArtworkBatch, knownArtworkIds } from '../db/repositories/artwork';
import { putLyricsBatch } from '../db/repositories/lyrics';
import { putScan, trimScans } from '../db/repositories/scans';
import { getTracks, deleteTracks, putTracks } from '../db/repositories/tracks';
import { pruneMissingEntries } from '../db/repositories/playlists';
import { trimHistory } from '../db/repositories/history';
import { createLogger, describeError } from '../logger';
import { lyricsFromTag } from '../lyrics/lrc';
import { parseAudioFile } from '../metadata';
import { dirname, mapLimit, throttle, uid } from '../utils';
import { artworkIdFor, pickBestPicture, processArtwork } from './artworkProcessor';
import { rebuildAggregates, rebuildFolders } from './importer';
import { buildTrack, trackIdFor } from './trackBuilder';
import type { SourceProvider } from '../platform/fs';
import type { Artwork, Lyrics, ScanError, ScanRecord, Track } from '../types';

const log = createLogger('scanner');

/** Files read concurrently. Four keeps the disk busy without thrashing it. */
const READ_CONCURRENCY = 4;
/** Tracks per database transaction. */
const WRITE_BATCH = 200;
/** Progress messages are throttled to roughly 8/sec. */
const PROGRESS_INTERVAL_MS = 120;
/** Upper bound for a string key range: no path sorts above U+FFFF. */
const MAX_KEY = '￿';

export type ScanPhase = 'listing' | 'reading' | 'pruning' | 'aggregating' | 'done';

export interface ScanProgress {
  sourceId: string;
  phase: ScanPhase;
  filesSeen: number;
  /** Files whose tags have been parsed so far. */
  processed: number;
  /** Files that need parsing. Zero until the listing phase completes. */
  total: number;
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  failed: number;
  currentPath: string;
}

export interface ScanOptions {
  /** `full` re-parses every file, ignoring fingerprints. */
  mode?: 'incremental' | 'full';
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

interface Fingerprint {
  trackId: string;
  lastModified: number;
  sizeBytes: number;
}

/**
 * Existing files for a source, keyed by path.
 *
 * Read via `openKeyCursor` on the compound fingerprint index, so the mtime and
 * size come out of the index key and no record is ever fetched.
 */
async function loadFingerprints(sourceId: string): Promise<Map<string, Fingerprint>> {
  const db = await getDb();
  const map = new Map<string, Fingerprint>();
  const tx = db.transaction(Stores.tracks, 'readonly');
  const index = tx.objectStore(Stores.tracks).index(Idx.tracks.fingerprint);
  const range = IDBKeyRange.bound(
    [sourceId, '', -Infinity, -Infinity],
    [sourceId, MAX_KEY, Infinity, Infinity],
  );

  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openKeyCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const key = cursor.key as [string, string, number, number];
      map.set(key[1], {
        trackId: cursor.primaryKey as string,
        lastModified: key[2],
        sizeBytes: key[3],
      });
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });

  return map;
}

interface PendingFile {
  path: string;
  name: string;
  sizeBytes: number;
  lastModified: number;
  /** Set when this is a rescan of a file already in the library. */
  existingId: string | null;
}

export async function scanSource(
  provider: SourceProvider,
  options: ScanOptions = {},
): Promise<ScanRecord> {
  const mode = options.mode ?? 'incremental';
  const sourceId = provider.sourceId;
  const startedAt = Date.now();

  const record: ScanRecord = {
    id: uid('scan'),
    sourceId,
    startedAt,
    finishedAt: null,
    status: 'running',
    filesSeen: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    message: null,
  };

  const progress: ScanProgress = {
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

  const report = throttle(() => options.onProgress?.({ ...progress }), PROGRESS_INTERVAL_MS);
  const fail = (path: string, reason: string) => {
    record.failed++;
    progress.failed++;
    // The error list is capped: a source with 40k unreadable files should not
    // produce a 40k-entry record that is itself a memory problem.
    if (record.errors.length < 200) record.errors.push({ path, reason });
  };

  try {
    const access = await provider.access(false);
    if (access !== 'granted') {
      record.status = 'failed';
      record.message =
        access === 'prompt'
          ? 'MusiX needs permission to read this folder again.'
          : 'This music folder is no longer reachable.';
      record.finishedAt = Date.now();
      await putScan(record);
      return record;
    }

    // ---- 1. Fingerprints ----
    const fingerprints = await loadFingerprints(sourceId);
    const seenPaths = new Set<string>();
    const pending: PendingFile[] = [];
    /** directory path -> number of tracks directly inside it */
    const directories = new Map<string, number>();

    // ---- 2. Walk ----
    for await (const entry of provider.list({
      signal: options.signal,
      onProgress: (filesSeen, currentPath) => {
        progress.filesSeen = filesSeen;
        progress.currentPath = currentPath;
        report();
      },
    })) {
      if (options.signal?.aborted) break;

      record.filesSeen++;
      seenPaths.add(entry.path);
      const directory = dirname(entry.path);
      directories.set(directory, (directories.get(directory) ?? 0) + 1);

      const known = fingerprints.get(entry.path);
      const unchanged =
        known !== undefined &&
        known.lastModified === entry.lastModified &&
        known.sizeBytes === entry.sizeBytes;

      if (mode === 'incremental' && unchanged) {
        record.skipped++;
        progress.skipped++;
        continue;
      }

      pending.push({
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        lastModified: entry.lastModified,
        existingId: known?.trackId ?? null,
      });
    }

    if (options.signal?.aborted) {
      record.status = 'cancelled';
      record.finishedAt = Date.now();
      await putScan(record);
      report.flush();
      return record;
    }

    // ---- 3. Parse changed files ----
    progress.phase = 'reading';
    progress.total = pending.length;
    report();

    // Existing rows for changed files only, so user data survives the rescan.
    const existingRows = await getTracks(
      pending.map((file) => file.existingId).filter((id): id is string => id !== null),
    );
    const existingById = new Map(existingRows.map((track) => [track.id, track]));
    const artworkSeen = await knownArtworkIds();

    let trackBatch: Track[] = [];
    let artworkBatch: Artwork[] = [];
    let lyricsBatch: Lyrics[] = [];

    const flush = async () => {
      // Artwork and lyrics are written first: a track row that references an
      // artwork id which is not yet stored would render a broken cover.
      if (artworkBatch.length > 0) {
        await putArtworkBatch(artworkBatch);
        artworkBatch = [];
      }
      if (lyricsBatch.length > 0) {
        await putLyricsBatch(lyricsBatch);
        lyricsBatch = [];
      }
      if (trackBatch.length > 0) {
        await putTracks(trackBatch);
        trackBatch = [];
      }
    };

    for (let offset = 0; offset < pending.length; offset += WRITE_BATCH) {
      if (options.signal?.aborted) break;
      const slice = pending.slice(offset, offset + WRITE_BATCH);

      const built = await mapLimit(slice, READ_CONCURRENCY, async (file) => {
        if (options.signal?.aborted) return null;
        progress.currentPath = file.path;

        try {
          const blob = await provider.open(file.path);
          if (!blob) {
            fail(file.path, 'file could not be opened');
            return null;
          }

          const parsed = await parseAudioFile(blob, file.name);
          const trackId = trackIdFor(sourceId, file.path);

          // ---- Artwork ----
          let artworkId: string | null = null;
          const picture = pickBestPicture(parsed.tags.pictures);
          if (picture) {
            const candidateId = artworkIdFor(picture);
            if (artworkSeen.has(candidateId)) {
              // Same cover as an album-mate: skip the decode entirely (§13).
              artworkId = candidateId;
            } else {
              const processed = await processArtwork(picture);
              if (processed) {
                artworkSeen.add(processed.artwork.id);
                artworkId = processed.artwork.id;
                artworkBatch.push(processed.artwork);
              }
            }
          }

          // ---- Lyrics ----
          let hasLyrics = false;
          if (parsed.tags.lyrics) {
            lyricsBatch.push(lyricsFromTag(trackId, parsed.tags.lyrics));
            hasLyrics = true;
          }

          return buildTrack({
            sourceId,
            entry: {
              path: file.path,
              name: file.name,
              sizeBytes: file.sizeBytes,
              lastModified: file.lastModified,
            },
            parsed,
            artworkId,
            hasLyrics,
            existing: file.existingId ? existingById.get(file.existingId) : undefined,
          });
        } catch (error) {
          // One bad file must never end the scan (spec §34).
          fail(file.path, describeError(error));
          return null;
        }
      });

      for (let i = 0; i < built.length; i++) {
        const track = built[i];
        if (!track) continue;
        trackBatch.push(track);
        if (slice[i]!.existingId) {
          record.updated++;
          progress.updated++;
        } else {
          record.added++;
          progress.added++;
        }
      }

      progress.processed = Math.min(pending.length, offset + slice.length);
      report();
      await flush();
    }

    await flush();

    // ---- 4. Prune files that have gone ----
    progress.phase = 'pruning';
    report();

    const removedIds: string[] = [];
    for (const [path, fingerprint] of fingerprints) {
      if (!seenPaths.has(path)) removedIds.push(fingerprint.trackId);
    }
    // A cancelled scan has an incomplete `seenPaths`, so pruning would delete
    // files that simply had not been walked yet.
    if (removedIds.length > 0 && !options.signal?.aborted) {
      await deleteTracks(removedIds);
      await pruneMissingEntries(removedIds);
      record.removed = removedIds.length;
      progress.removed = removedIds.length;
      report();
    }

    // ---- 5. Derived data ----
    progress.phase = 'aggregating';
    report();

    await rebuildFolders(sourceId, provider.name, directories);
    await rebuildAggregates();
    await trimHistory();

    record.status = options.signal?.aborted ? 'cancelled' : 'complete';
    record.finishedAt = Date.now();
    await putScan(record);
    await trimScans(sourceId);

    progress.phase = 'done';
    report.flush();

    log.info(
      `scan of ${provider.name}: +${record.added} ~${record.updated} -${record.removed} ` +
        `(${record.skipped} unchanged, ${record.failed} failed) in ` +
        `${((record.finishedAt - startedAt) / 1000).toFixed(1)}s`,
    );
    return record;
  } catch (error) {
    record.status = 'failed';
    record.message = describeError(error);
    record.finishedAt = Date.now();
    log.error(`scan of ${provider.name} failed`, error);
    await putScan(record).catch(() => undefined);
    report.flush();
    return record;
  }
}

/** Merge several scan records for a combined summary. */
export function summariseScans(records: readonly ScanRecord[]): {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  errors: ScanError[];
} {
  return records.reduce(
    (total, record) => ({
      added: total.added + record.added,
      updated: total.updated + record.updated,
      removed: total.removed + record.removed,
      failed: total.failed + record.failed,
      errors: [...total.errors, ...record.errors],
    }),
    { added: 0, updated: 0, removed: 0, failed: 0, errors: [] as ScanError[] },
  );
}
