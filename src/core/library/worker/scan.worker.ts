/// <reference lib="webworker" />
/**
 * The scan worker.
 *
 * Everything expensive about importing a library — walking directories, parsing
 * tags, decoding cover art, writing to IndexedDB, rebuilding aggregates —
 * happens in here, so a 50,000-file import cannot make the UI drop a frame
 * (spec §35). IndexedDB is available in workers, so the scanner runs unchanged.
 */

import { DirectorySource } from '../../platform/directorySource';
import { ImportedSource } from '../../platform/importedSource';
import { createLogger, describeError } from '../../logger';
import { scanSource } from '../scanner';
import type { SourceProvider } from '../../platform/fs';
import type { ScanSourceDescriptor, ScanWorkerRequest, ScanWorkerResponse } from './protocol';

const log = createLogger('scan.worker');
const scope = self as unknown as DedicatedWorkerGlobalScope;

/** In-flight scans, so a cancel message can reach the right one. */
const inFlight = new Map<string, AbortController>();

function post(message: ScanWorkerResponse): void {
  scope.postMessage(message);
}

function providerFor(descriptor: ScanSourceDescriptor): SourceProvider {
  if (descriptor.kind === 'directory') {
    if (!descriptor.handle) {
      throw new Error('No folder handle was provided for this source.');
    }
    return new DirectorySource(descriptor.id, descriptor.name, descriptor.handle);
  }
  return new ImportedSource(descriptor.id, descriptor.name);
}

scope.addEventListener('message', (event: MessageEvent<ScanWorkerRequest>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    inFlight.get(message.requestId)?.abort();
    return;
  }

  if (message.type !== 'scan') return;

  const controller = new AbortController();
  inFlight.set(message.requestId, controller);

  void (async () => {
    try {
      const provider = providerFor(message.source);
      const record = await scanSource(provider, {
        mode: message.mode,
        signal: controller.signal,
        onProgress: (progress) => post({ type: 'progress', requestId: message.requestId, progress }),
      });
      post({ type: 'done', requestId: message.requestId, record });
    } catch (error) {
      log.error('scan failed in worker', error);
      post({ type: 'failed', requestId: message.requestId, message: describeError(error) });
    } finally {
      inFlight.delete(message.requestId);
    }
  })();
});
