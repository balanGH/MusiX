/**
 * Pure helpers for the phone-library source: turning MediaStore rows into
 * `FileEntry`s and grouping them into the folders the user picks from.
 *
 * Kept free of any bridge or DOM access so it can be unit-tested directly; the
 * provider that calls the native plugin is nativeSource.ts.
 */

import { isSupportedAudioFile } from '../metadata';
import { joinPath, type FileEntry } from './fs';

/** One row of `MusicLibrary.scan()` (native/android/MusicLibraryPlugin.java). */
export interface MediaStoreTrack {
  id: number;
  /** Absolute path, e.g. /storage/emulated/0/Music/Artist/Album/01.mp3. */
  path: string;
  /** Folder relative to its storage volume, e.g. "Music/Artist/Album/". Null below Android 10. */
  relativePath: string | null;
  /** File name, e.g. "01.mp3". */
  name: string;
  size: number;
  modifiedMs: number;
  durationMs: number;
  mimeType: string | null;
}

/** A listed file plus what `open()` needs to read it again. */
export interface NativeEntry extends FileEntry {
  absolutePath: string;
  mimeType: string | null;
}

/** Shared internal storage, under any of the paths Android exposes it as. */
const PRIMARY_VOLUME = /^\/(?:storage\/emulated\/\d+|storage\/self\/primary|sdcard)(?:\/|$)/;
/** Any other volume: /storage/<id>/..., typically an SD card or USB drive. */
const OTHER_VOLUME = /^\/storage\/([^/]+)(?:\/|$)/;

function cleanSegments(path: string): string[] {
  return path
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
}

/** Label for files that are not on internal storage, so two volumes never collide. */
function volumeLabel(absolutePath: string): string {
  if (PRIMARY_VOLUME.test(absolutePath)) return '';
  const other = absolutePath.match(OTHER_VOLUME);
  return other ? `SD card (${other[1]})` : '';
}

/**
 * The folder a file lives in, relative to the storage root, without a trailing
 * slash ('' for the root). Files on an SD card get an "SD card (id)" prefix.
 */
export function storageFolder(row: Pick<MediaStoreTrack, 'path' | 'relativePath'>): string {
  let segments: string[];
  if (row.relativePath) {
    segments = cleanSegments(row.relativePath);
  } else {
    // Android 9 and older: derive it from the absolute path.
    const withoutVolume = row.path.replace(PRIMARY_VOLUME, '').replace(OTHER_VOLUME, '');
    segments = cleanSegments(withoutVolume).slice(0, -1);
  }
  return joinPath(volumeLabel(row.path), ...segments);
}

/**
 * Where separated stems are saved (MusicLibraryPlugin.saveFromUrl). Never part
 * of the library: vocals.mp3, drums.mp3 and so on are parts of a song, not songs.
 */
export const SAVED_STEMS_FOLDER = 'Music/MusiX/Stems';

/** Map a MediaStore row to a listing entry, or null for files MusiX cannot read. */
export function toNativeEntry(row: MediaStoreTrack): NativeEntry | null {
  if (!row.path) return null;
  const name = row.name || row.path.slice(row.path.lastIndexOf('/') + 1);
  if (!name || !isSupportedAudioFile(name)) return null;
  const folder = storageFolder(row);
  const stems = SAVED_STEMS_FOLDER.toLowerCase();
  const lower = folder.toLowerCase();
  if (lower === stems || lower.startsWith(stems + '/')) return null;
  return {
    path: joinPath(folder, name),
    name,
    sizeBytes: row.size > 0 ? row.size : 0,
    lastModified: row.modifiedMs > 0 ? row.modifiedMs : 0,
    absolutePath: row.path,
    mimeType: row.mimeType || null,
  };
}

/**
 * The selectable folder a file belongs to: its top-level folder, or for the
 * per-app media folders the first three segments ("Android/media/com.whatsapp"),
 * since "Android" alone would lump unrelated apps together. SD-card files keep
 * their volume prefix. Root-level files belong to ''.
 */
export function folderGroupOf(folder: string): string {
  const segments = cleanSegments(folder);
  const volume = segments[0]?.startsWith('SD card (') ? segments.shift()! : '';
  const depth = segments[0] === 'Android' ? 3 : 1;
  return joinPath(volume, ...segments.slice(0, depth));
}

/** Folder names that hold voice notes, recordings and system sounds, not music. */
const JUNK_SEGMENT =
  /^(whatsapp|com\.whatsapp|whatsapp (audio|voice notes)|recordings?|call ?recordings?|call_rec|calls?|sound_recorder|voice ?recorder|notifications?|ringtones?|alarms?|miui)$/i;

/** Whether a folder group should start unticked. */
export function isLikelyJunk(group: string): boolean {
  return cleanSegments(group).some((segment) => JUNK_SEGMENT.test(segment));
}

export function isExcluded(entryPath: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  const slash = entryPath.lastIndexOf('/');
  return excluded.has(folderGroupOf(slash === -1 ? '' : entryPath.slice(0, slash)));
}

export interface FolderSummary {
  /** Group key, as stored in `MusicSource.excludedFolders`. */
  folder: string;
  trackCount: number;
  /** Suggested to leave out: WhatsApp, recordings, ringtones and the like. */
  junk: boolean;
}

/** Folder groups with their track counts, largest first. */
export function summariseFolders(entries: readonly FileEntry[]): FolderSummary[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const group = folderGroupOf(slash === -1 ? '' : entry.path.slice(0, slash));
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts]
    .map(([folder, trackCount]) => ({ folder, trackCount, junk: isLikelyJunk(folder) }))
    .sort((a, b) => b.trackCount - a.trackCount || a.folder.localeCompare(b.folder));
}

/** How a group is shown in the picker. */
export function folderLabel(folder: string): string {
  return folder === '' ? 'Phone storage (top level)' : folder;
}
