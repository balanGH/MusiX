/**
 * Client for the optional local stem-separation service (spec §18, §19).
 *
 * This is the one part of MusiX that cannot run in the browser. Demucs is a
 * ~2 GB PyTorch model; separating a four-minute track is minutes of CPU work.
 * So it runs as a small FastAPI service on the user's own machine, and MusiX
 * treats it as strictly optional:
 *
 *  - nothing here runs unless the user explicitly asks for a separation (§4:
 *    "AI audio separation must NEVER run automatically");
 *  - the whole app works with the service absent, and says so plainly;
 *  - the service is local-only — audio never leaves the machine (§32).
 *
 * The contract below is the one `backend/main.py` implements. The previous
 * version of both sides disagreed about it, which is why nothing worked: the
 * server unpacked a two-tuple from a function returning a five-key dict, and
 * the download route knew only two of the five stems the player asked for.
 */

import { createLogger, describeError } from '../logger';

const log = createLogger('studio');

/** Same-origin; vite.config.ts proxies /api to the local service in dev. */
const API_BASE = '/api';

/** The stems `htdemucs_6s` produces. The default model gives the first four. */
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const;
export type StemName = (typeof STEM_NAMES)[number];

export type JobStatus = 'queued' | 'downloading' | 'converting' | 'separating' | 'complete' | 'failed';

export interface StemInfo {
  name: StemName;
  url: string;
  sizeBytes: number;
}

export interface JobState {
  jobId: string;
  status: JobStatus;
  /** 0–100. Real progress, reported by the service as it works. */
  progress: number;
  stage: string;
  sourceName: string;
  stems: StemInfo[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export class StudioUnavailableError extends Error {
  constructor() {
    super('The audio studio service is not running.');
    this.name = 'StudioUnavailableError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    // A network failure here means the local service is not running, which is
    // the normal case, not an error worth shouting about.
    log.debug(`studio service unreachable: ${describeError(error)}`);
    throw new StudioUnavailableError();
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Not JSON; the status line is the best available message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export interface ServiceInfo {
  status: 'ok';
  model: string;
  device: 'cpu' | 'cuda';
  /** Whether the model weights have been downloaded yet. */
  modelReady: boolean;
  maxUploadBytes: number;
  availableStems: StemName[];
}

/** Is the local service running? Used to decide what the Studio page shows. */
export async function probeService(): Promise<ServiceInfo | null> {
  try {
    return await call<ServiceInfo>('/health');
  } catch {
    return null;
  }
}

export interface SeparateOptions {
  /** Which stems to produce. Fewer is faster. */
  stems: StemName[];
  signal?: AbortSignal;
  onUploadProgress?(fraction: number): void;
}

/**
 * Submit a file for separation.
 *
 * `XMLHttpRequest` rather than `fetch`, purely because it reports upload
 * progress — a 60 MB FLAC over localhost is quick, but silence during an upload
 * reads as a hang.
 */
export function submitFile(
  file: Blob,
  filename: string,
  options: SeparateOptions,
): Promise<{ jobId: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, filename);
    form.append('stems', options.stems.join(','));

    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}/jobs`);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onUploadProgress?.(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as { jobId: string });
        } catch {
          reject(new Error('The studio service returned an unreadable response.'));
        }
        return;
      }
      let message = `Upload failed (${request.status})`;
      try {
        const body = JSON.parse(request.responseText) as { detail?: string };
        if (body.detail) message = body.detail;
      } catch {
        // Keep the status message.
      }
      reject(new Error(message));
    });

    request.addEventListener('error', () => reject(new StudioUnavailableError()));
    request.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));

    options.signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(form);
  });
}

export function getJob(jobId: string): Promise<JobState> {
  return call<JobState>(`/jobs/${jobId}`);
}

export function listJobs(): Promise<JobState[]> {
  return call<JobState[]>('/jobs');
}

export function cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
  return call<{ cancelled: boolean }>(`/jobs/${jobId}`, { method: 'DELETE' });
}

/**
 * Poll until the job finishes.
 *
 * Polling rather than a WebSocket because the job takes minutes and one request
 * every 1.5 s is cheaper than holding a socket open — and it recovers by itself
 * if the service restarts mid-job.
 */
export async function waitForJob(
  jobId: string,
  onUpdate: (state: JobState) => void,
  signal?: AbortSignal,
): Promise<JobState> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const state = await getJob(jobId);
    onUpdate(state);
    if (state.status === 'complete' || state.status === 'failed') return state;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}

/** Absolute URL for a produced stem, for playback and download. */
export function stemUrl(jobId: string, stem: StemName): string {
  return `${API_BASE}/jobs/${jobId}/stems/${stem}`;
}
