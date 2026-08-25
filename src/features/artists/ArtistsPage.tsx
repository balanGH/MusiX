/**
 * Artist grid (spec §29).
 *
 * Artists have no artwork of their own in an offline library — nothing embeds
 * an artist photo — so the tile shows the cover of one of their albums, which
 * is both recognisable and honest about where it came from.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { listArtists } from '@core/db/repositories/library';
import { formatCount, formatDurationLong } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useSettings } from '@state/settingsStore';
import type { Artist } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { VirtualGrid } from '@ui/VirtualList';
import { EmptyState, Select } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';

const TILE_WIDTH = { small: 124, medium: 156, large: 196 } as const;

export function ArtistsPage() {
  const revision = useLibrary((state) => state.revision);
  const gridSize = useSettings((state) => state.gridSize);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [sort, setSort] = useState<'name' | 'trackCount'>('name');

  useEffect(() => {
    let cancelled = false;
    void listArtists(sort, sort === 'trackCount' ? 'desc' : 'asc').then((result) => {
      if (!cancelled) setArtists(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sort, revision]);

  const minTileWidth = TILE_WIDTH[gridSize];
  const rowHeight = minTileWidth + 48;

  const renderTile = useCallback(
    (index: number) => {
      const artist = artists[index];
      return artist ? <ArtistCard artist={artist} /> : null;
    },
    [artists],
  );

  const header = useMemo(
    () => (
      <PageHeader
        title="Artists"
        stats={`${formatCount(artists.length)} artist${artists.length === 1 ? '' : 's'}`}
        actions={
          <Select
            label="Sort artists by"
            className="ml-auto"
            value={sort}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'trackCount', label: 'Most tracks' },
            ]}
            onChange={(value) => setSort(value)}
          />
        }
      />
    ),
    [artists.length, sort],
  );

  return (
    <VirtualGrid
      count={artists.length}
      minTileWidth={minTileWidth}
      rowHeight={rowHeight}
      renderTile={renderTile}
      header={header}
      ariaLabel="Artists"
      className="px-4 sm:px-6"
      paddingBottom={32}
      emptyState={
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No artists yet"
          body="Artists are derived from the tags on your tracks."
        />
      }
    />
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  const navigate = useNavigate();

  return (
    <div className="group/card flex h-full flex-col items-center text-center">
      <button
        type="button"
        onClick={() => navigate(`/artists/${artist.id}`)}
        className="block w-full rounded-full focus-visible:outline-offset-4"
        aria-label={`Open ${artist.name}`}
      >
        <Artwork
          artworkId={artist.artworkId}
          name={artist.name}
          rounded="full"
          className="aspect-square w-full shadow-card transition group-hover/card:brightness-110"
          decorative
        />
      </button>
      <button
        type="button"
        onClick={() => navigate(`/artists/${artist.id}`)}
        className="mt-2 w-full"
      >
        <span className="block truncate text-xs font-medium text-text">{artist.name}</span>
      </button>
      <span className="truncate text-2xs text-muted">
        {formatCount(artist.trackCount)} track{artist.trackCount === 1 ? '' : 's'} ·{' '}
        {formatDurationLong(artist.durationMs)}
      </span>
    </div>
  );
}
