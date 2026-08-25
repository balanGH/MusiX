/**
 * Home (spec §27).
 *
 * Every row here is a real query against the local database — "Recently Added"
 * is a reverse cursor over the `addedAt` index, "Most Played" over `playCount`,
 * and so on. Each one stops after the handful of rows it shows, so opening Home
 * costs a few dozen record reads regardless of library size.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Clock,
  Disc3,
  FolderPlus,
  Heart,
  Mic2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { recentAlbums } from '@core/db/repositories/library';
import { favorites, mostPlayed, recentlyAdded, recentlyPlayed } from '@core/db/repositories/tracks';
import { formatCount, formatDurationLong, formatRelative } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions, usePlayer } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Album, Track } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, SectionHeader, Skeleton, cx } from '@ui/primitives';
import { AlbumCard } from '../albums/AlbumsPage';

interface HomeData {
  continueTrack: Track | null;
  recentlyPlayed: Track[];
  recentlyAdded: Track[];
  mostPlayed: Track[];
  favorites: Track[];
  newAlbums: Album[];
}

export function HomePage() {
  const revision = useLibrary((state) => state.revision);
  const counts = useLibrary((state) => state.counts);
  const scanAll = useLibrary((state) => state.scanAll);
  const addFolder = useLibrary((state) => state.addFolder);
  const scan = useLibrary((state) => state.scan);
  const currentTrack = usePlayer((state) => state.track);
  const toast = useUi((state) => state.toast);
  const navigate = useNavigate();

  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      recentlyPlayed(20),
      recentlyAdded(20),
      mostPlayed(20),
      favorites(20),
      recentAlbums(12),
    ]).then(([played, added, most, faves, albums]) => {
      if (cancelled) return;
      setData({
        continueTrack: played[0] ?? null,
        recentlyPlayed: played,
        recentlyAdded: added,
        mostPlayed: most,
        favorites: faves,
        newAlbums: albums,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [revision, currentTrack?.id]);

  const greeting = greetingForNow();

  return (
    <div className="mx-scroll flex-1 px-4 pb-12 pt-4 sm:px-6">
      {/* Greeting + library summary */}
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting}</h1>
        <p className="mt-1 text-sm text-muted">
          {counts.tracks === 0
            ? 'Your library is empty — add a music folder to get started.'
            : `${formatCount(counts.tracks)} tracks · ${formatCount(counts.albums)} albums · ${formatCount(
                counts.artists,
              )} artists · ${formatCount(counts.folders)} folders`}
        </p>
      </header>

      {/* Quick actions (spec §27) */}
      <div className="mb-8 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => void scanAll('incremental')}
          disabled={scan !== null || counts.tracks === 0}
          loading={scan !== null}
        >
          <RefreshCw className="h-4 w-4" />
          Scan for changes
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            const result = await addFolder();
            if (result.message) toast(result.message, { kind: 'warn' });
          }}
        >
          <FolderPlus className="h-4 w-4" />
          Add folder
        </Button>
        <Button variant="secondary" onClick={() => navigate('/search')}>
          <Search className="h-4 w-4" />
          Search
        </Button>
        <Button variant="secondary" onClick={() => navigate('/health')}>
          <Activity className="h-4 w-4" />
          Library health
        </Button>
        <Button variant="secondary" onClick={() => navigate('/studio')}>
          <Mic2 className="h-4 w-4" />
          Audio Studio
        </Button>
      </div>

      {!data ? (
        <LoadingRows />
      ) : (
        <>
          {/* Continue listening */}
          {data.continueTrack && (
            <section className="mb-8">
              <SectionHeader title="Continue listening" />
              <button
                type="button"
                onClick={() => void playerActions.playTrack(data.continueTrack!.id)}
                className="group/cont mt-3 flex w-full items-center gap-4 rounded-panel border border-line bg-surface p-3 text-left transition hover:border-accent/50 hover:bg-surface-hover"
              >
                <div className="relative">
                  <Artwork
                    artworkId={data.continueTrack.artworkId}
                    name={data.continueTrack.album}
                    size={72}
                    rounded="lg"
                    decorative
                  />
                  <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/45 opacity-0 transition group-hover/cont:opacity-100">
                    <Play className="h-6 w-6 fill-white text-white" />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{data.continueTrack.title}</p>
                  <p className="truncate text-sm text-muted">{data.continueTrack.artist}</p>
                  {data.continueTrack.lastPlayedAt && (
                    <p className="mt-0.5 text-2xs text-subtle">
                      <Clock className="mr-1 inline h-3 w-3" />
                      {formatRelative(data.continueTrack.lastPlayedAt)}
                    </p>
                  )}
                </div>
              </button>
            </section>
          )}

          <TrackStrip
            title="Recently added"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            tracks={data.recentlyAdded}
            onSeeAll={() => navigate('/songs')}
            emptyHint="Newly imported tracks will appear here."
          />

          {data.newAlbums.length > 0 && (
            <section className="mb-8">
              <SectionHeader
                title="New albums"
                action={
                  <Button size="sm" variant="ghost" onClick={() => navigate('/albums')}>
                    See all
                  </Button>
                }
              />
              <div className="mx-scroll -mx-1 mt-3 flex gap-4 overflow-x-auto px-1 pb-2">
                {data.newAlbums.map((album) => (
                  <div key={album.id} className="w-36 shrink-0 sm:w-40">
                    <AlbumCard album={album} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <TrackStrip
            title="Recently played"
            icon={<Clock className="h-3.5 w-3.5" />}
            tracks={data.recentlyPlayed}
            emptyHint="Play something and it will show up here."
          />

          <TrackStrip
            title="Most played"
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            tracks={data.mostPlayed}
            emptyHint="Your most-played tracks will collect here over time."
          />

          <TrackStrip
            title="Favourites"
            icon={<Heart className="h-3.5 w-3.5" />}
            tracks={data.favorites}
            onSeeAll={() => navigate('/favorites')}
            emptyHint="Tap the heart on any track."
          />

          {counts.tracks === 0 && (
            <div className="rounded-panel border border-dashed border-line p-8 text-center">
              <Disc3 className="mx-auto mb-3 h-8 w-8 text-subtle" />
              <p className="text-sm font-medium">Nothing to show yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
                Add a music folder and MusiX will read the tags, artwork and lyrics straight from
                your files.
              </p>
              <Button
                variant="primary"
                className="mt-4"
                onClick={async () => {
                  const result = await addFolder();
                  if (result.message) toast(result.message, { kind: 'warn' });
                }}
              >
                <FolderPlus className="h-4 w-4" />
                Add a music folder
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A horizontally scrolling row of tracks. */
function TrackStrip({
  title,
  icon,
  tracks,
  onSeeAll,
  emptyHint,
}: {
  title: string;
  icon: React.ReactNode;
  tracks: Track[];
  onSeeAll?(): void;
  emptyHint: string;
}) {
  if (tracks.length === 0) {
    return (
      <section className="mb-8">
        <SectionHeader title={title} />
        <p className="mt-2 text-xs text-subtle">{emptyHint}</p>
      </section>
    );
  }

  const ids = tracks.map((track) => track.id);

  return (
    <section className="mb-8">
      <SectionHeader
        title={title}
        subtitle={
          <span className="flex items-center gap-1">
            {icon}
            {formatCount(tracks.length)} ·{' '}
            {formatDurationLong(tracks.reduce((sum, track) => sum + track.durationMs, 0))}
          </span>
        }
        action={
          onSeeAll && (
            <Button size="sm" variant="ghost" onClick={onSeeAll}>
              See all
            </Button>
          )
        }
      />
      <div className="mx-scroll -mx-1 mt-3 flex gap-3 overflow-x-auto px-1 pb-2">
        {tracks.map((track, index) => (
          <button
            key={track.id}
            type="button"
            onClick={() => void playerActions.playTracks(ids, index)}
            className="group/tile flex w-32 shrink-0 flex-col gap-1.5 text-left sm:w-36"
          >
            <span className="relative block">
              <Artwork
                artworkId={track.artworkId}
                name={track.album}
                rounded="lg"
                className={cx('aspect-square w-full shadow-card')}
                decorative
              />
              <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 opacity-0 transition group-hover/tile:opacity-100">
                <Play className="h-6 w-6 fill-white text-white" />
              </span>
            </span>
            <span className="mx-clamp-2 text-2xs font-medium leading-snug text-text">
              {track.title}
            </span>
            <span className="-mt-1 truncate text-2xs text-muted">{track.artist}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-8">
      {[0, 1, 2].map((row) => (
        <div key={row}>
          <Skeleton className="h-5 w-40" />
          <div className="mt-3 flex gap-3">
            {[0, 1, 2, 3, 4, 5].map((tile) => (
              <div key={tile} className="w-32 shrink-0 sm:w-36">
                <Skeleton className="aspect-square w-full rounded-xl" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-1.5 h-2.5 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
