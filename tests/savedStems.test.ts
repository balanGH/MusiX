/**
 * Stems saved on the device (core/studio/savedStems.ts): the parts that do
 * not need the native plugin.
 */

import { describe, expect, it } from 'vitest';
import {
  canSaveStems,
  getSavedStems,
  jobFromSavedStems,
  stemFolderName,
  type SavedStems,
} from '@core/studio/savedStems';

const saved: SavedStems = {
  trackId: 't1',
  jobId: 'job-1',
  sourceName: 'Lady Gaga - Shallow',
  folder: 'Lady Gaga - Shallow',
  stems: [
    { name: 'vocals', path: '/storage/emulated/0/Music/MusiX/Stems/x/vocals.mp3', sizeBytes: 100 },
    { name: 'drums', path: '/storage/emulated/0/Music/MusiX/Stems/x/drums.mp3', sizeBytes: 200 },
  ],
  savedAt: 1_700_000_000_000,
};

describe('stemFolderName', () => {
  it('keeps ordinary names', () => {
    expect(stemFolderName('Lady Gaga - Shallow')).toBe('Lady Gaga - Shallow');
  });

  it('replaces characters no filesystem accepts', () => {
    expect(stemFolderName('AC/DC - Back In Black')).toBe('AC_DC - Back In Black');
    expect(stemFolderName('What? "Why": <now>|*')).toBe('What_ _Why__ _now___');
  });

  it('never returns an empty or dot-only name', () => {
    expect(stemFolderName('   ')).toBe('Untitled');
    expect(stemFolderName('...')).toBe('Untitled');
  });

  it('caps the length', () => {
    expect(stemFolderName('a'.repeat(300))).toHaveLength(100);
  });
});

describe('jobFromSavedStems', () => {
  it('builds a finished job the mixer can open without the service', () => {
    const job = jobFromSavedStems(saved);
    expect(job.status).toBe('complete');
    expect(job.jobId).toBe('job-1');
    expect(job.sourceName).toBe('Lady Gaga - Shallow');
    expect(job.stems.map((stem) => stem.name)).toEqual(['vocals', 'drums']);
  });
});

describe('on the web', () => {
  it('cannot save, and finds nothing saved', async () => {
    expect(canSaveStems()).toBe(false);
    expect(await getSavedStems('t1')).toBeNull();
  });
});
