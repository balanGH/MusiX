/**
 * Album grid (spec §30).
 *
 * Virtualised like the song list, because a large library has thousands of
 * albums and each tile holds an image.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Disc3, Play } from 'lucide-react';
import { listAlbums, type AlbumSort } from '@core/db/repositories/library';
import { tracksByAlbum } from '@core/db/repositories/tracks';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useSettings } from '@state/settingsStore';
import { playerActions } from '@state/playerStore';
import type { Album } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { VirtualGrid } from '@ui/VirtualList';
import { EmptyState, IconButton, Select, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';

const SORT_OPTIONS: { value: AlbumSort; label: string }[] = [
  { value: 'name', label: 'Album' },
  { value: 'artist', label: 'Artist' },
  { value: 'year', label: 'Year' },
  { value: 'addedAt', label: 'Recently added' },
];

/** Tile width per size preference; the grid derives its columns from these. */
const TILE_WIDTH = { small: 132, medium: 168, large: 216 } as const;

export function AlbumsPage() {
  const revision = useLibrary((state) => state.revision);
  const gridSize = useSettings((state) => state.gridSize);
  const patchSettings = useSettings((state) => state.patch);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [sort, setSort] = useState<AlbumSort>('name');

  useEffect(() => {
    let cancelled = false;
    const direction = sort === 'addedAt' || sort === 'year' ? 'desc' : 'asc';
    void listAlbums(sort, direction).then((result) => {
      if (!cancelled) setAlbums(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sort, revision]);

  const minTileWidth = TILE_WIDTH[gridSize];
  // Tile height = square cover + two lines of caption.
  const rowHeight = minTileWidth + 52;

  const renderTile = useCallback(
    (index: number) => {
      const album = albums[index];
      return album ? <AlbumCard album={album} /> : null;
    },
    [albums],
  );

  const header = useMemo(
    () => (
      <PageHeader
        title="Albums"
        stats={`${formatCount(albums.length)} album${albums.length === 1 ? '' : 's'}`}
        actions={
          <div className="ml-auto flex items-center gap-2">
            <Select
              label="Sort albums by"
              value={sort}
              options={SORT_OPTIONS}
              onChange={(value) => setSort(value)}
            />
            <Select
              label="Tile size"
              value={gridSize}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
              onChange={(value) => patchSettings({ gridSize: value })}
            />
          </div>
        }
      />
    ),
    [albums.length, sort, gridSize, patchSettings],
  );

  return (
    <VirtualGrid
      count={albums.length}
      minTileWidth={minTileWidth}
      rowHeight={rowHeight}
      renderTile={renderTile}
      header={header}
      ariaLabel="Albums"
      className="px-4 sm:px-6"
      paddingBottom={32}
      emptyState={
        <EmptyState
          icon={<Disc3 className="h-8 w-8" />}
          title="No albums yet"
          body="Albums are grouped from the tags in your files. Add a music folder to get started."
        />
      }
    />
  );
}

export function AlbumCard({ album, className }: { album: Album; className?: string }) {
  const navigate = useNavigate();

  return (
    <div className={cx('group/card flex h-full flex-col', className)}>
      <div className="relative">
        <button
          type="button"
          onClick={() => navigate(`/albums/${album.id}`)}
          className="block w-full rounded-xl focus-visible:outline-offset-4"
          aria-label={`Open ${album.name} by ${album.albumArtist}`}
        >
          <Artwork
            artworkId={album.artworkId}
            name={album.name}
            rounded="lg"
            className="aspect-square w-full shadow-card transition group-hover/card:brightness-105"
            decorative
          />
        </button>

        {/* Play overlay — appears on hover, always reachable by keyboard. */}
        <IconButton
          label={`Play ${album.name}`}
          size={38}
          variant="accent"
          onClick={async () => {
            const tracks = await tracksByAlbum(album.id);
            if (tracks.length > 0) {
              void playerActions.playTracks(
                tracks.map((track) => track.id),
                0,
                false,
              );
            }
          }}
          className="absolute bottom-2 right-2 opacity-0 shadow-pop transition group-hover/card:opacity-100 focus-visible:opacity-100"
        >
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        </IconButton>
      </div>

      <button
        type="button"
        onClick={() => navigate(`/albums/${album.id}`)}
        className="mt-2 block text-left"
      >
        <span className="mx-clamp-2 text-xs font-medium leading-snug text-text">{album.name}</span>
      </button>
      <span className="truncate text-2xs text-muted">
        {album.albumArtist}
        {album.year ? ` · ${album.year}` : ''}
      </span>
    </div>
  );
}
