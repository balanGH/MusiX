/**
 * Stems saved on this device, so they play without the studio service.
 *
 * The service keeps every separation on the computer it runs on. From the
 * Android app that computer is a PC on the LAN, which is not always on or in
 * reach, so after a split the stems are also copied to the phone (see
 * `platform/stemFiles.ts`). This module remembers, per track, which files
 * those are; the record lives in the settings store under `savedStems:<id>`.
 */

import { deleteSetting, getSetting, setSetting } from '../db/repositories/settings';
import { stemFiles } from '../platform/stemFiles';
import { stemUrl, type JobState, type StemName } from './client';

export interface SavedStem {
  name: StemName;
  /** Absolute path on the device. */
  path: string;
  sizeBytes: number;
}

export interface SavedStems {
  trackId: string;
  /** The service's job these came from. Its stems may since have been deleted there. */
  jobId: string;
  sourceName: string;
  /** Folder name under the stems folder, e.g. "Artist - Title". */
  folder: string;
  stems: SavedStem[];
  savedAt: number;
}

const key = (trackId: string) => `savedStems:${trackId}`;

export function canSaveStems(): boolean {
  return stemFiles.available();
}

export async function getSavedStems(trackId: string): Promise<SavedStems | null> {
  if (!stemFiles.available()) return null;
  return (await getSetting<SavedStems>(key(trackId))) ?? null;
}

/** "Artist - Title" made safe as a folder name on any filesystem. */
export function stemFolderName(sourceName: string): string {
  const cleaned = sourceName
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (cleaned || 'Untitled').slice(0, 100);
}

/**
 * Copy a finished job's stems to the device.
 *
 * Replaces any earlier save for the same track. `onProgress` gets the number
 * of stems saved so far.
 */
export async function saveStems(
  trackId: string,
  job: JobState,
  onProgress?: (saved: number, total: number) => void,
): Promise<SavedStems> {
  const folder = stemFolderName(job.sourceName);
  const previous = await getSavedStems(trackId);

  const stems: SavedStem[] = [];
  onProgress?.(0, job.stems.length);
  for (const stem of job.stems) {
    const path = await stemFiles.download(
      stemUrl(job.jobId, stem.name),
      folder,
      `${stem.name}.mp3`,
    );
    stems.push({ name: stem.name, path, sizeBytes: stem.sizeBytes });
    onProgress?.(stems.length, job.stems.length);
  }

  // Files of an earlier save that this one did not overwrite (another folder
  // name, or a stem no longer produced).
  if (previous) {
    const kept = new Set(stems.map((stem) => stem.path));
    await stemFiles.remove(
      previous.stems.map((stem) => stem.path).filter((path) => !kept.has(path)),
    );
  }

  const record: SavedStems = {
    trackId,
    jobId: job.jobId,
    sourceName: job.sourceName,
    folder,
    stems,
    savedAt: Date.now(),
  };
  await setSetting(key(trackId), record);
  return record;
}

export async function removeSavedStems(trackId: string): Promise<void> {
  const saved = await getSavedStems(trackId);
  if (!saved) return;
  await stemFiles.remove(saved.stems.map((stem) => stem.path));
  await deleteSetting(key(trackId));
}

/** Playable URLs for the mixer, by stem name. */
export function savedStemSources(saved: SavedStems): Partial<Record<StemName, string>> {
  const sources: Partial<Record<StemName, string>> = {};
  for (const stem of saved.stems) {
    const url = stemFiles.urlFor(stem.path);
    if (url) sources[stem.name] = url;
  }
  return sources;
}

/** A finished-job record for the mixer, built from a save alone (no service needed). */
export function jobFromSavedStems(saved: SavedStems): JobState {
  return {
    jobId: saved.jobId,
    status: 'complete',
    progress: 100,
    stage: 'Done',
    sourceName: saved.sourceName,
    stems: saved.stems.map((stem) => ({ name: stem.name, url: '', sizeBytes: stem.sizeBytes })),
    error: null,
    createdAt: saved.savedAt,
    updatedAt: saved.savedAt,
  };
}
