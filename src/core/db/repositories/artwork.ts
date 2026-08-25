/**
 * Artwork storage.
 *
 * Artwork is keyed by a hash of its bytes, so a 12-track album with the same
 * cover embedded in every file stores one image, not twelve (spec §13). The
 * scanner checks `hasArtwork` before decoding, so re-scanning a known album
 * costs one key lookup per file instead of an image decode.
 */

import { getDb } from '../database';
import { get as getOne, getAll, putMany, removeMany, request, withTransaction } from '../idb';
import { Stores } from '../schema';
import type { Artwork, Track } from '../../types';

export async function getArtwork(id: string): Promise<Artwork | undefined> {
  return getOne<Artwork>(await getDb(), Stores.artwork, id);
}

/** Cheap existence check — reads the key, never the image bytes. */
export async function hasArtwork(id: string): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(Stores.artwork, 'readonly');
  const key = await request(tx.objectStore(Stores.artwork).getKey(id));
  return key !== undefined;
}

export async function putArtwork(artwork: Artwork): Promise<void> {
  await putMany(await getDb(), Stores.artwork, [artwork]);
}

export async function putArtworkBatch(items: readonly Artwork[]): Promise<void> {
  await putMany(await getDb(), Stores.artwork, items);
}

/** Ids already present, so the scanner can skip decoding those images. */
export async function knownArtworkIds(): Promise<Set<string>> {
  const db = await getDb();
  const tx = db.transaction(Stores.artwork, 'readonly');
  const keys = (await request(tx.objectStore(Stores.artwork).getAllKeys())) as string[];
  return new Set(keys);
}

/**
 * Delete artwork no track references any more.
 *
 * Only invoked from Settings → Storage, never automatically: walking every
 * track to prove an image is unreferenced is exactly the kind of speculative
 * background work spec §4 rules out.
 */
export async function pruneOrphanArtwork(): Promise<{ deleted: number; freedBytes: number }> {
  const db = await getDb();
  const referenced = new Set<string>();
  await withTransaction(db, Stores.tracks, 'readonly', async (tx) => {
    const tracks = await request<Track[]>(tx.objectStore(Stores.tracks).getAll());
    for (const track of tracks) if (track.artworkId) referenced.add(track.artworkId);
  });

  const all = await getAll<Artwork>(db, Stores.artwork);
  const orphans = all.filter((artwork) => !referenced.has(artwork.id));
  await removeMany(db, Stores.artwork, orphans.map((artwork) => artwork.id));

  return {
    deleted: orphans.length,
    freedBytes: orphans.reduce((sum, artwork) => sum + artwork.sizeBytes, 0),
  };
}
