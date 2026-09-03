/**
 * Source registry.
 *
 * One place that knows how to turn a stored `MusicSource` row back into a live
 * `SourceProvider`, and the only place the rest of the app asks "give me the
 * bytes for this track".
 */

import { listSources } from '../db/repositories/library';
import { createLogger } from '../logger';
import type { MusicSource, Track } from '../types';
import { capabilities } from './capabilities';
import { DirectorySource, forgetHandle, restoreDirectorySource } from './directorySource';
import { ImportedSource, restoreImportedSource } from './importedSource';
import type { SourceProvider } from './fs';

const log = createLogger('fs');

/** Live providers, keyed by source id. Rebuilt lazily. */
const providers = new Map<string, SourceProvider>();

export function registerProvider(provider: SourceProvider): void {
  providers.set(provider.sourceId, provider);
}

export function unregisterProvider(sourceId: string): void {
  providers.delete(sourceId);
}

export function knownProvider(sourceId: string): SourceProvider | undefined {
  return providers.get(sourceId);
}

/**
 * Get (or rebuild) the provider for a source.
 *
 * A directory source may come back null when its stored handle is gone — for
 * example after the user cleared site data. Callers surface that as "reconnect
 * this folder" rather than as an error (spec §34).
 */
export async function providerFor(source: MusicSource): Promise<SourceProvider | null> {
  const existing = providers.get(source.id);
  if (existing) return existing;

  let provider: SourceProvider | null = null;
  if (source.kind === 'directory' && source.handleKey) {
    provider = await restoreDirectorySource(source.id, source.name, source.handleKey);
  } else if (source.kind === 'imported') {
    provider = restoreImportedSource(source.id, source.name);
  }

  if (provider) providers.set(source.id, provider);
  else log.warn(`could not restore provider for source ${source.name}`);
  return provider;
}

/** Rebuild every provider, reporting which ones need the user to reconnect. */
export async function restoreAllSources(): Promise<{
  ready: MusicSource[];
  needsPermission: MusicSource[];
  broken: MusicSource[];
}> {
  const ready: MusicSource[] = [];
  const needsPermission: MusicSource[] = [];
  const broken: MusicSource[] = [];

  for (const source of await listSources()) {
    const provider = await providerFor(source);
    if (!provider) {
      broken.push(source);
      continue;
    }
    // `false`: startup has no user gesture, so this only *detects* the state.
    const state = await provider.access(false);
    if (state === 'granted') ready.push(source);
    else if (state === 'prompt') needsPermission.push(source);
    else broken.push(source);
  }

  return { ready, needsPermission, broken };
}

/** Open the audio bytes for a track, or null if the file has gone. */
export async function openTrackFile(track: Track): Promise<File | null> {
  const provider = providers.get(track.sourceId);
  if (provider) return provider.open(track.path);

  const source = (await listSources()).find((candidate) => candidate.id === track.sourceId);
  if (!source) return null;
  const restored = await providerFor(source);
  return restored ? restored.open(track.path) : null;
}

/** Tear down a source and, for imported ones, delete its copied files. */
export async function disposeSource(source: MusicSource): Promise<void> {
  const provider = providers.get(source.id) ?? (await providerFor(source));
  await provider?.dispose(source.kind === 'imported');
  providers.delete(source.id);
  if (source.handleKey) await forgetHandle(source.handleKey);
}

/**
 * Show the file picker used when there is no directory picker.
 *
 * `webkitdirectory` is set when the browser supports it, because picking a
 * folder preserves the relative paths that album and folder grouping rely on.
 * Returns an empty array when the user cancels.
 */
export function pickFiles(options: { folder?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.aiff,.aif';
    if (options.folder) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.style.display = 'none';

    // `cancel` is not universally supported, so a focus fallback resolves the
    // promise rather than leaving it pending forever.
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener(
      'focus',
      () => {
        // Give `change` a chance to fire first.
        setTimeout(() => finish(Array.from(input.files ?? [])), 300);
      },
      { once: true },
    );

    document.body.append(input);
    input.click();
  });
}

export { capabilities, DirectorySource, ImportedSource };
export { pickDirectory } from './directorySource';
export { addFileToSource, importFiles, importedStorageUsage } from './importedSource';
export { importStrategy, importStrategyExplanation } from './capabilities';
export type { AccessState, FileEntry, SourceProvider } from './fs';
