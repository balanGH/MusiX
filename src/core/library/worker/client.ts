/**
 * Main-thread interface to the scan worker.
 *
 * Two things this file is responsible for beyond message passing:
 *
 *  - **Permission.** A directory handle's read grant can only be *requested*
 *    from a user gesture on the main thread, so that happens here, before the
 *    handle is handed over.
 *  - **Graceful degradation.** Where `Worker` is unavailable the same scanner
 *    runs in-thread. Slower and it will cost some frames, but it works, which
 *    beats a feature that silently does nothing (spec §41).
 *
 * The worker is created on demand and terminated when idle, so an app sitting
 * on the Home screen is not holding a second thread alive (spec §37).
 */

import { createLogger, describeError } from '../../logger';
import { capabilities } from '../../platform/capabilities';
import { restoreDirectorySource } from '../../platform/directorySource';
import { providerFor } from '../../platform';
import { getSource, listSources, putSource } from '../../db/repositories/library';
import { invalidateSearchIndex } from '../../search';
import { uid } from '../../utils';
import { scanSource, type ScanProgress } from '../scanner';
import type { MusicSource, ScanRecord } from '../../types';
import type { ScanWorkerRequest, ScanWorkerResponse } from './protocol';

const log = createLogger('scan.client');

interface PendingScan {
  resolve(record: ScanRecord): void;
  reject(error: Error): void;
  onProgress?: (progress: ScanProgress) => void;
}

let worker: Worker | null = null;
const pending = new Map<string, PendingScan>();

function ensureWorker(): Worker | null {
  if (!capabilities().workers) return null;
  if (worker) return worker;

  try {
    worker = new Worker(new URL('./scan.worker.ts', import.meta.url), {
      type: 'module',
      name: 'musix-scan',
    });
  } catch (error) {
    log.warn('could not start scan worker; falling back to in-thread scanning', error);
    return null;
  }

  worker.addEventListener('message', (event: MessageEvent<ScanWorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.requestId);
    if (!entry) return;

    if (message.type === 'progress') {
      entry.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.requestId);
    if (message.type === 'done') entry.resolve(message.record);
    else entry.reject(new Error(message.message));
    retireWorkerIfIdle();
  });

  worker.addEventListener('error', (event) => {
    log.error('scan worker crashed', event.message);
    // Fail every in-flight scan rather than leaving promises hanging forever.
    for (const [, entry] of pending) {
      entry.reject(new Error('The scanner stopped unexpectedly.'));
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  });

  return worker;
}

function retireWorkerIfIdle(): void {
  if (pending.size > 0 || !worker) return;
  worker.terminate();
  worker = null;
}

export interface RunScanOptions {
  mode?: 'incremental' | 'full';
  onProgress?: (progress: ScanProgress) => void;
  /** Called when the folder needs the user to re-grant access. */
  onPermissionNeeded?: (source: MusicSource) => void;
}

export class PermissionRequiredError extends Error {
  constructor(readonly source: MusicSource) {
    super(`MusiX needs permission to read “${source.name}” again.`);
    this.name = 'PermissionRequiredError';
  }
}

/**
 * Scan one source.
 *
 * Must be called from a user gesture the first time after a page load for a
 * directory source, because that is when the permission prompt can appear.
 */
export async function runScan(
  sourceId: string,
  options: RunScanOptions = {},
): Promise<ScanRecord> {
  const source = await getSource(sourceId);
  if (!source) throw new Error('That music folder is no longer in the library.');

  const provider = await providerFor(source);
  if (!provider) throw new Error(`“${source.name}” could not be opened.`);

  // Interactive: this is the moment a re-grant prompt is allowed to appear.
  const access = await provider.access(true);
  if (access !== 'granted') {
    options.onPermissionNeeded?.(source);
    throw new PermissionRequiredError(source);
  }

  const record = await dispatch(source, options);

  // Search results and the source's own counters both derive from what just
  // changed, so they are refreshed here rather than by every reader.
  invalidateSearchIndex();
  await putSource({
    ...source,
    lastScanAt: record.finishedAt ?? Date.now(),
    trackCount: Math.max(0, source.trackCount + record.added - record.removed),
  });

  return record;
}

async function dispatch(source: MusicSource, options: RunScanOptions): Promise<ScanRecord> {
  const host = ensureWorker();
  const mode = options.mode ?? 'incremental';

  if (!host) {
    const provider = await providerFor(source);
    if (!provider) throw new Error(`“${source.name}” could not be opened.`);
    return scanSource(provider, { mode, onProgress: options.onProgress });
  }

  const requestId = uid('scan');
  const handle =
    source.kind === 'directory' && source.handleKey
      ? await handleFor(source)
      : undefined;

  if (source.kind === 'directory' && !handle) {
    throw new Error(`The stored folder reference for “${source.name}” is missing.`);
  }

  const request: ScanWorkerRequest = {
    type: 'scan',
    requestId,
    mode,
    source: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      ...(handle ? { handle } : {}),
    },
  };

  return new Promise<ScanRecord>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress: options.onProgress });
    host.postMessage(request);
  });
}

/**
 * Pull the raw handle back out of storage for transfer to the worker.
 *
 * `DirectorySource` keeps its handle private, so this goes through the same
 * restore path and reads the handle from the provider it builds.
 */
async function handleFor(source: MusicSource): Promise<FileSystemDirectoryHandle | undefined> {
  if (!source.handleKey) return undefined;
  const restored = await restoreDirectorySource(source.id, source.name, source.handleKey);
  return restored?.rootHandle;
}

/** Ask the worker to stop; the scan resolves with a `cancelled` record. */
export function cancelScan(): void {
  if (!worker) return;
  for (const requestId of pending.keys()) {
    const message: ScanWorkerRequest = { type: 'cancel', requestId };
    worker.postMessage(message);
  }
}

export function scanInProgress(): boolean {
  return pending.size > 0;
}

/** Scan every source in turn, returning one record each. */
export async function runScanAll(options: RunScanOptions = {}): Promise<ScanRecord[]> {
  const records: ScanRecord[] = [];
  for (const source of await listSources()) {
    try {
      records.push(await runScan(source.id, options));
    } catch (error) {
      log.warn(`scan of ${source.name} did not run: ${describeError(error)}`);
    }
  }
  return records;
}
