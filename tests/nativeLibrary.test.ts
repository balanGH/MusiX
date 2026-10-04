/**
 * The Android phone-library source: MediaStore rows → library entries, folder
 * grouping and exclusion, and the provider over a mocked native plugin.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  folderGroupOf,
  isExcluded,
  isLikelyJunk,
  storageFolder,
  summariseFolders,
  toNativeEntry,
  type MediaStoreTrack,
} from '@core/platform/nativeLibrary';
import {
  ensureMusicPermission,
  NativeSource,
  previewPhoneFolders,
  type MusicLibraryApi,
  type NativePermission,
} from '@core/platform/nativeSource';
import type { FileEntry } from '@core/platform/fs';

function row(path: string, overrides: Partial<MediaStoreTrack> = {}): MediaStoreTrack {
  const slash = path.lastIndexOf('/');
  return {
    id: 1,
    path,
    relativePath: null,
    name: path.slice(slash + 1),
    size: 4_000_000,
    modifiedMs: 1_700_000_000_000,
    durationMs: 200_000,
    mimeType: 'audio/mpeg',
    ...overrides,
  };
}

function mockLibrary(
  rows: MediaStoreTrack[],
  permission: NativePermission = 'granted',
  afterRequest: NativePermission = permission,
): MusicLibraryApi & { scan: ReturnType<typeof vi.fn>; requestPermission: ReturnType<typeof vi.fn> } {
  return {
    checkPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => afterRequest),
    scan: vi.fn(async () => rows),
    openSettings: vi.fn(async () => undefined),
  };
}

async function collect(source: NativeSource): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for await (const entry of source.list()) entries.push(entry);
  return entries;
}

describe('storageFolder', () => {
  it('uses RELATIVE_PATH when MediaStore provides it', () => {
    expect(
      storageFolder({
        path: '/storage/emulated/0/Music/Artist/Album/01.mp3',
        relativePath: 'Music/Artist/Album/',
      }),
    ).toBe('Music/Artist/Album');
  });

  it('derives the folder from the absolute path on older Android', () => {
    expect(storageFolder({ path: '/storage/emulated/0/Music/Album/01.mp3', relativePath: null })).toBe(
      'Music/Album',
    );
    expect(storageFolder({ path: '/sdcard/Download/song.mp3', relativePath: null })).toBe('Download');
    expect(storageFolder({ path: '/storage/emulated/0/song.mp3', relativePath: null })).toBe('');
  });

  it('prefixes files on an SD card so they never collide with internal storage', () => {
    expect(
      storageFolder({ path: '/storage/1234-ABCD/Music/01.mp3', relativePath: 'Music/' }),
    ).toBe('SD card (1234-ABCD)/Music');
    expect(storageFolder({ path: '/storage/1234-ABCD/Music/01.mp3', relativePath: null })).toBe(
      'SD card (1234-ABCD)/Music',
    );
  });
});

describe('toNativeEntry', () => {
  it('maps a row to a library entry with a storage-relative path', () => {
    const entry = toNativeEntry(
      row('/storage/emulated/0/Music/Artist/Album/01 Song.flac', {
        relativePath: 'Music/Artist/Album/',
        mimeType: 'audio/flac',
        size: 30_000_000,
        modifiedMs: 1_650_000_000_000,
      }),
    );
    expect(entry).toEqual({
      path: 'Music/Artist/Album/01 Song.flac',
      name: '01 Song.flac',
      sizeBytes: 30_000_000,
      lastModified: 1_650_000_000_000,
      absolutePath: '/storage/emulated/0/Music/Artist/Album/01 Song.flac',
      mimeType: 'audio/flac',
    });
  });

  it('skips formats MusiX cannot read', () => {
    expect(toNativeEntry(row('/storage/emulated/0/Recordings/call.amr'))).toBeNull();
    expect(toNativeEntry(row('/storage/emulated/0/Music/song.mid'))).toBeNull();
  });

  it('falls back to the path for a missing display name', () => {
    expect(toNativeEntry(row('/storage/emulated/0/Music/a.mp3', { name: '' }))?.name).toBe('a.mp3');
  });

  it('leaves out stems saved by MusiX, which are parts of songs', () => {
    expect(
      toNativeEntry(
        row('/storage/emulated/0/Music/MusiX/Stems/Lady Gaga - Shallow/vocals.mp3', {
          relativePath: 'Music/MusiX/Stems/Lady Gaga - Shallow/',
        }),
      ),
    ).toBeNull();
    // Android 9 and older report no relative path.
    expect(toNativeEntry(row('/storage/emulated/0/Music/MusiX/Stems/x/drums.mp3'))).toBeNull();
    // Other MusiX folders are ordinary music.
    expect(toNativeEntry(row('/storage/emulated/0/Music/MusiX/song.mp3'))?.path).toBe('Music/MusiX/song.mp3');
  });
});

describe('folder groups', () => {
  it('groups by top-level folder, and by app for Android/media', () => {
    expect(folderGroupOf('Music/Artist/Album')).toBe('Music');
    expect(folderGroupOf('')).toBe('');
    expect(folderGroupOf('Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio')).toBe(
      'Android/media/com.whatsapp',
    );
    expect(folderGroupOf('SD card (1234-ABCD)/Music/Album')).toBe('SD card (1234-ABCD)/Music');
  });

  it('flags voice notes, recordings and system sounds as junk', () => {
    for (const junk of [
      'WhatsApp',
      'Android/media/com.whatsapp',
      'Recordings',
      'Call',
      'Notifications',
      'Ringtones',
      'Alarms',
      'MIUI',
    ]) {
      expect(isLikelyJunk(junk), junk).toBe(true);
    }
    for (const music of ['Music', 'Download', 'Telegram', '', 'SD card (1234-ABCD)/Music']) {
      expect(isLikelyJunk(music), music).toBe(false);
    }
  });

  it('summarises folders largest first with junk marked', () => {
    const entries = [
      'Music/A/1.mp3',
      'Music/A/2.mp3',
      'Music/B/3.mp3',
      'WhatsApp/Media/WhatsApp Audio/v.opus',
      'Download/x.mp3',
      'Download/y.mp3',
      'root.mp3',
    ].map((path) => ({ path, name: path, sizeBytes: 1, lastModified: 1 }));

    expect(summariseFolders(entries)).toEqual([
      { folder: 'Music', trackCount: 3, junk: false },
      { folder: 'Download', trackCount: 2, junk: false },
      { folder: '', trackCount: 1, junk: false },
      { folder: 'WhatsApp', trackCount: 1, junk: true },
    ]);
  });

  it('excludes by group, so leaving out the root does not drop everything', () => {
    expect(isExcluded('WhatsApp/Media/a.opus', new Set(['WhatsApp']))).toBe(true);
    expect(isExcluded('Music/a.mp3', new Set(['WhatsApp']))).toBe(false);
    expect(isExcluded('root.mp3', new Set(['']))).toBe(true);
    expect(isExcluded('Music/a.mp3', new Set(['']))).toBe(false);
  });
});

describe('NativeSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const rows = [
    row('/storage/emulated/0/Music/Album/01.mp3', { relativePath: 'Music/Album/' }),
    row('/storage/emulated/0/Music/Album/02.mp3', { relativePath: 'Music/Album/' }),
    row('/storage/emulated/0/WhatsApp/Media/WhatsApp Audio/v.opus', {
      relativePath: 'WhatsApp/Media/WhatsApp Audio/',
    }),
    row('/storage/emulated/0/Recordings/memo.m4a', { relativePath: 'Recordings/' }),
    row('/storage/emulated/0/Notifications/ding.ogg', { relativePath: 'Notifications/' }),
  ];

  it('lists every readable file, honouring excluded folders', async () => {
    const library = mockLibrary(rows);
    const source = new NativeSource('s', 'Phone music', ['WhatsApp', 'Recordings'], library);
    const entries = await collect(source);
    expect(entries.map((entry) => entry.path)).toEqual([
      'Music/Album/01.mp3',
      'Music/Album/02.mp3',
      'Notifications/ding.ogg',
    ]);
    // Only FileEntry fields reach the scanner.
    expect(Object.keys(entries[0]!).sort()).toEqual(['lastModified', 'name', 'path', 'sizeBytes']);
  });

  it('re-queries MediaStore on every listing, so a rescan sees changes', async () => {
    const library = mockLibrary(rows);
    const source = new NativeSource('s', 'Phone music', [], library);
    await collect(source);
    await collect(source);
    expect(library.scan).toHaveBeenCalledTimes(2);
  });

  it('maps permission states to access states', async () => {
    expect(await new NativeSource('s', 'n', [], mockLibrary([], 'granted')).access(false)).toBe('granted');
    // Denied for good still means "reconnect", not "broken".
    expect(await new NativeSource('s', 'n', [], mockLibrary([], 'denied')).access(false)).toBe('prompt');

    const asking = mockLibrary([], 'prompt', 'granted');
    expect(await new NativeSource('s', 'n', [], asking).access(true)).toBe('granted');
    expect(asking.requestPermission).toHaveBeenCalledOnce();

    const passive = mockLibrary([], 'prompt', 'granted');
    expect(await new NativeSource('s', 'n', [], passive).access(false)).toBe('prompt');
    expect(passive.requestPermission).not.toHaveBeenCalled();
  });

  it('opens a file through the WebView file URL, querying once after a reload', async () => {
    const convertFileSrc = vi.fn((path: string) => `http://localhost/_capacitor_file_${path}`);
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', convertFileSrc },
    });
    const fetchMock = vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])])));
    vi.stubGlobal('fetch', fetchMock);

    const library = mockLibrary([
      row('/storage/emulated/0/Music/A #1.mp3', { relativePath: 'Music/', modifiedMs: 42_000 }),
    ]);
    const source = new NativeSource('s', 'Phone music', [], library);

    const file = await source.open('Music/A #1.mp3');
    expect(file).not.toBeNull();
    expect(file!.name).toBe('A #1.mp3');
    expect(file!.size).toBe(3);
    expect(file!.lastModified).toBe(42_000);
    expect(file!.type).toBe('audio/mpeg');
    // "#" would end the URL path, so segments are encoded.
    expect(convertFileSrc).toHaveBeenCalledWith('/storage/emulated/0/Music/A%20%231.mp3');

    expect(await source.open('Music/gone.mp3')).toBeNull();
    expect(library.scan).toHaveBeenCalledOnce();
  });

  it('returns null when the file cannot be fetched', async () => {
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, convertFileSrc: (path: string) => path },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const source = new NativeSource('s', 'n', [], mockLibrary([row('/storage/emulated/0/Music/a.mp3')]));
    expect(await source.open('Music/a.mp3')).toBeNull();
  });
});

describe('permission and preview helpers', () => {
  it('only asks when not already granted', async () => {
    const granted = mockLibrary([], 'granted');
    expect(await ensureMusicPermission(granted)).toBe('granted');
    expect(granted.requestPermission).not.toHaveBeenCalled();

    const blocked = mockLibrary([], 'denied');
    expect(await ensureMusicPermission(blocked)).toBe('denied');
  });

  it('previews every folder, junk included, for the picker', async () => {
    const folders = await previewPhoneFolders(
      mockLibrary([
        row('/storage/emulated/0/Music/a.mp3', { relativePath: 'Music/' }),
        row('/storage/emulated/0/Ringtones/r.ogg', { relativePath: 'Ringtones/' }),
        row('/storage/emulated/0/Recordings/x.amr', { relativePath: 'Recordings/' }),
      ]),
    );
    expect(folders).toEqual([
      { folder: 'Music', trackCount: 1, junk: false },
      { folder: 'Ringtones', trackCount: 1, junk: true },
    ]);
  });
});
