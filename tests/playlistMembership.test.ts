/**
 * The add-to-playlist checklist: which playlists hold a track, removing it
 * from one, and Undo putting every occurrence back where it was.
 */

import { describe, expect, it } from 'vitest';
import {
  addTracksToPlaylist,
  createPlaylist,
  playlistTrackIds,
  playlistsContaining,
  removeTrackFromPlaylist,
  restoreTrackToPlaylist,
} from '@core/db/repositories/playlists';

describe('playlist membership', () => {
  it('counts every playlist a track is in, including repeats', async () => {
    const road = await createPlaylist({ name: 'Road trip' });
    const gym = await createPlaylist({ name: 'Gym' });
    await createPlaylist({ name: 'Empty' });
    await addTracksToPlaylist(road.id, ['a', 'b', 'a']);
    await addTracksToPlaylist(gym.id, ['a']);

    const found = await playlistsContaining('a');
    expect(Object.fromEntries(found)).toEqual({ [road.id]: 2, [gym.id]: 1 });
    expect((await playlistsContaining('zzz')).size).toBe(0);
  });

  it('removes only that track, only from that playlist', async () => {
    const road = await createPlaylist({ name: 'Road trip' });
    const gym = await createPlaylist({ name: 'Gym' });
    await addTracksToPlaylist(road.id, ['a', 'b', 'a', 'c']);
    await addTracksToPlaylist(gym.id, ['a']);

    const positions = await removeTrackFromPlaylist(road.id, 'a');
    expect(positions).toEqual([0, 2]);
    expect(await playlistTrackIds(road.id)).toEqual(['b', 'c']);
    expect(await playlistTrackIds(gym.id)).toEqual(['a']);
  });

  it('undo restores each occurrence to its original position', async () => {
    const road = await createPlaylist({ name: 'Road trip' });
    await addTracksToPlaylist(road.id, ['a', 'b', 'a', 'c']);

    const positions = await removeTrackFromPlaylist(road.id, 'a');
    await restoreTrackToPlaylist(road.id, 'a', positions);
    expect(await playlistTrackIds(road.id)).toEqual(['a', 'b', 'a', 'c']);
  });
});
