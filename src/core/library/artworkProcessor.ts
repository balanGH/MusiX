/**
 * Embedded artwork -> stored `Artwork` record.
 *
 * Three things happen once, at scan time, so that nothing happens at render
 * time (spec §4, §13):
 *
 *  - the image is decoded to learn its real dimensions;
 *  - a small square thumbnail is produced, because a 3000×3000 cover scaled
 *    down by the browser in a 48 px list row costs both memory and paint time
 *    on every scroll;
 *  - the dominant colour is extracted for the dynamic accent (§38).
 *
 * Runs in the scan worker, so `createImageBitmap` and `OffscreenCanvas` are used
 * rather than `<img>` and `<canvas>`.
 */

import { createLogger } from '../logger';
import { hashBytes } from '../utils';
import type { Artwork } from '../types';
import type { RawPicture } from '../metadata';

const log = createLogger('artwork');

/** Grid thumbnails are 176 px at 2× DPR; 320 covers that with room to spare. */
const THUMB_SIZE = 320;

/** Front cover, then "other", then whatever came first. */
export function pickBestPicture(pictures: readonly RawPicture[]): RawPicture | null {
  if (pictures.length === 0) return null;
  return (
    pictures.find((picture) => picture.pictureType === 3) ??
    pictures.find((picture) => picture.pictureType === 0) ??
    pictures[0]!
  );
}

/** Stable id for a picture's bytes, so identical covers are stored once. */
export function artworkIdFor(picture: RawPicture): string {
  return hashBytes(picture.data);
}

export interface ProcessedArtwork {
  artwork: Artwork;
}

/**
 * Decode, thumbnail and colour-sample a picture.
 *
 * Returns null when the bytes are not a decodable image — a surprisingly common
 * case, since some taggers write truncated or placeholder covers. The track is
 * still imported, simply without artwork.
 */
export async function processArtwork(picture: RawPicture): Promise<ProcessedArtwork | null> {
  const id = artworkIdFor(picture);
  // A copy is required: `picture.data` is a view into a larger scan buffer that
  // will be reused, and Blob does not copy the bytes it is given.
  const bytes = picture.data.slice();
  const blob = new Blob([bytes], { type: picture.mime });

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    log.warn(`undecodable embedded artwork (${picture.mime}, ${bytes.length} bytes)`, error);
    return null;
  }

  const width = bitmap.width;
  const height = bitmap.height;
  let thumb: Blob | null = null;
  let dominant: string | null = null;

  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));

    const canvas = new OffscreenCanvas(thumbWidth, thumbHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
      dominant = dominantColour(context.getImageData(0, 0, thumbWidth, thumbHeight));
      // Only re-encode when it actually saves something.
      if (scale < 1) {
        thumb = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      }
    }
  } catch (error) {
    log.warn('thumbnail generation failed; storing full-size artwork only', error);
  } finally {
    bitmap.close();
  }

  return {
    artwork: {
      id,
      mime: picture.mime,
      width,
      height,
      sizeBytes: bytes.length + (thumb?.size ?? 0),
      data: blob,
      thumb,
      dominant,
      createdAt: Date.now(),
    },
  };
}

/**
 * Dominant colour, as `"r g b"` — the same format as the CSS colour tokens, so
 * the dynamic accent can be applied without reformatting.
 *
 * Not a true dominant-colour algorithm — those need k-means and are far too
 * expensive to run per track. This buckets pixels into a coarse 4-bit-per-
 * channel histogram, ignores near-black and near-white (album covers are mostly
 * frame and text, which would otherwise always win), and prefers the most
 * saturated of the top buckets so the accent has some life to it.
 */
function dominantColour(image: ImageData): string | null {
  const data = image.data;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  // Every 4th pixel is plenty for a colour average and 4× cheaper.
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const alpha = data[i + 3]!;
    if (alpha < 128) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 28 || min > 236) continue; // near-black / near-white

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  if (buckets.size === 0) return null;

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  let best = ranked[0]!;
  let bestScore = -1;
  for (const bucket of ranked) {
    const r = bucket.r / bucket.count;
    const g = bucket.g / bucket.count;
    const b = bucket.b / bucket.count;
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    // Weight by how common it is *and* how colourful; a slightly rarer vivid
    // colour makes a better accent than a very common grey.
    const score = Math.log1p(bucket.count) * (0.35 + saturation);
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  return [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ].join(' ');
}
