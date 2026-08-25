/**
 * Messages between the main thread and the scan worker.
 *
 * `FileSystemDirectoryHandle` is structured-cloneable, so a handle the user
 * granted on the main thread can be handed to the worker and used directly —
 * which is what lets the entire scan, including tag parsing and image decoding,
 * happen off the UI thread (spec §35).
 *
 * Permission must still be *requested* on the main thread: that needs a user
 * gesture, which a worker does not have.
 */

import type { ScanProgress } from '../scanner';
import type { ScanRecord, SourceKind } from '../../types';

export interface ScanSourceDescriptor {
  id: string;
  name: string;
  kind: SourceKind;
  /** Present for `directory` sources; the worker rebuilds the provider from it. */
  handle?: FileSystemDirectoryHandle;
}

export type ScanWorkerRequest =
  | {
      type: 'scan';
      requestId: string;
      source: ScanSourceDescriptor;
      mode: 'incremental' | 'full';
    }
  | { type: 'cancel'; requestId: string };

export type ScanWorkerResponse =
  | { type: 'progress'; requestId: string; progress: ScanProgress }
  | { type: 'done'; requestId: string; record: ScanRecord }
  | { type: 'failed'; requestId: string; message: string };
