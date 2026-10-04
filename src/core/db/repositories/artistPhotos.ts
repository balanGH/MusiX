/**
 * Online-fetched artist photos (spec §32).
 *
 * A tiny store, deliberately separate from `artists`: aggregate rows are
 * cleared and rebuilt whole on every scan (`replaceAggregates`), which would
 * throw a fetched photo away on the next rescan if it lived there instead.
 */

import { getDb } from '../database';
import { getAll, get as getOne, putMany, remove } from '../idb';
import { Stores } from '../schema';
import type { ArtistPhoto } from '../../types';

export async function getArtistPhoto(artistId: string): Promise<ArtistPhoto | undefined> {
  return getOne<ArtistPhoto>(await getDb(), Stores.artistPhotos, artistId);
}

/** Every stored photo, for building an id → artwork map without one lookup per tile. */
export async function listArtistPhotos(): Promise<ArtistPhoto[]> {
  return getAll<ArtistPhoto>(await getDb(), Stores.artistPhotos);
}

export async function putArtistPhoto(photo: ArtistPhoto): Promise<void> {
  await putMany(await getDb(), Stores.artistPhotos, [photo]);
}

/**
 * Remove a stored photo — Deezer's name matching is a best guess (see
 * `onlinePhoto.ts`) and can pick the wrong person; this is how a user undoes
 * that. Only drops the `ArtistPhoto` row, not the underlying `Artwork` blob:
 * that store is content-hash-deduped and reference-counted separately via
 * `pruneOrphanArtwork` (Settings → Storage), the same as any other artwork.
 */
export async function deleteArtistPhoto(artistId: string): Promise<void> {
  await remove(await getDb(), Stores.artistPhotos, artistId);
}
