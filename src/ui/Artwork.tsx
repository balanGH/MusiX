/**
 * Album art, with a fallback that is not an empty grey box.
 *
 * Every cover in MusiX comes from the user's own files, so a good fraction of
 * any real library has none. The fallback derives a stable hue from the album
 * name, which means an untagged library still looks organised and — more
 * usefully — the same album is the same colour every time you see it.
 */

import { useMemo } from 'react';
import { Music2 } from 'lucide-react';
import { useArtwork } from '@state/artworkCache';
import { cx } from './primitives';

export interface ArtworkProps {
  artworkId: string | null;
  /** Used for the fallback colour and the alt text. */
  name: string;
  size?: number | string;
  /** Load the original instead of the thumbnail. For Now Playing and headers. */
  full?: boolean;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
  /** Decorative — the surrounding row already names the track. */
  decorative?: boolean;
}

const RADIUS = {
  sm: 'rounded',
  md: 'rounded-lg',
  lg: 'rounded-xl',
  full: 'rounded-full',
} as const;

/** Stable hue from a string, so a given album always gets the same colour. */
function hueOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export function Artwork({
  artworkId,
  name,
  size,
  full = false,
  rounded = 'md',
  className,
  decorative = false,
}: ArtworkProps) {
  const { url, loading } = useArtwork(artworkId, full);
  const hue = useMemo(() => hueOf(name || 'unknown'), [name]);
  const dimension = typeof size === 'number' ? `${size}px` : size;

  return (
    <div
      style={{ width: dimension, height: dimension }}
      className={cx(
        'relative shrink-0 overflow-hidden bg-surface-hover',
        RADIUS[rounded],
        className,
      )}
    >
      {url ? (
        <img
          src={url}
          alt={decorative ? '' : `${name} cover art`}
          aria-hidden={decorative || undefined}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          // Two stops of the same hue read as artwork-shaped rather than as an
          // error state, and stay legible in both themes.
          style={{
            background: `linear-gradient(140deg, hsl(${hue} 42% 32%), hsl(${(hue + 40) % 360} 38% 18%))`,
          }}
          className="flex h-full w-full items-center justify-center"
          aria-hidden="true"
        >
          {!loading && <Music2 className="h-[35%] w-[35%] text-white/35" strokeWidth={1.5} />}
        </div>
      )}
    </div>
  );
}

/**
 * A stack of up to four covers, for playlists.
 *
 * Falls back to a single tile when there is only one distinct cover, because a
 * "collage" of one image just looks broken.
 */
export function ArtworkStack({
  artworkIds,
  name,
  size,
  className,
}: {
  artworkIds: (string | null)[];
  name: string;
  size?: number | string;
  className?: string;
}) {
  const distinct = [...new Set(artworkIds.filter(Boolean))].slice(0, 4) as string[];
  const dimension = typeof size === 'number' ? `${size}px` : size;

  if (distinct.length < 2) {
    return (
      <Artwork
        artworkId={distinct[0] ?? null}
        name={name}
        size={size}
        rounded="lg"
        className={className}
      />
    );
  }

  return (
    <div
      style={{ width: dimension, height: dimension }}
      className={cx('grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-xl', className)}
    >
      {Array.from({ length: 4 }, (_, index) => (
        <Artwork
          key={index}
          artworkId={distinct[index % distinct.length] ?? null}
          name={`${name} ${index}`}
          rounded="sm"
          decorative
          className="!rounded-none h-full w-full"
        />
      ))}
    </div>
  );
}
