/**
 * Search (spec §23).
 *
 * Entirely local. The input is debounced by 120 ms — long enough to avoid
 * re-scoring the index on every keypress, short enough that results feel
 * instant.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, X } from 'lucide-react';
import { EMPTY_RESULTS, searchLibrary, searchSuggestions, type SearchResults } from '@core/search';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import { Artwork } from '@ui/Artwork';
import { Button, EmptyState, IconButton, SectionHeader, Spinner, cx } from '@ui/primitives';
import { PlayActions } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';

export function SearchPage() {
  const revision = useLibrary((state) => state.revision);
  const trackCount = useLibrary((state) => state.counts.tracks);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    void searchSuggestions().then(setSuggestions);
  }, [revision]);

  // Debounce. The cleanup cancels a pending search when the query changes
  // again, so only the final keystroke does work.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(EMPTY_RESULTS);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchLibrary(trimmed).then((found) => {
        // A slower earlier search must not overwrite a newer result.
        if (cancelled) return;
        setResults(found);
        setSearching(false);
      });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, revision]);

  const trackIds = useMemo(() => results.tracks.map((track) => track.id), [results.tracks]);

  const runSuggestion = useCallback((value: string) => {
    setQuery(value);
    inputRef.current?.focus();
  }, []);

  const hasQuery = query.trim().length > 0;
  const hasResults =
    results.tracks.length > 0 ||
    results.albums.length > 0 ||
    results.artists.length > 0 ||
    results.genres.length > 0;

  const header = (
    <div className="px-4 pt-4 sm:px-6">
      {/* Search field */}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${formatCount(trackCount)} tracks, albums, artists…`}
          aria-label="Search your library"
          className={cx(
            'h-12 w-full rounded-xl border border-line bg-surface pl-10 pr-10 text-sm outline-none',
            'placeholder:text-subtle focus-visible:border-accent',
          )}
        />
        {hasQuery && (
          <IconButton
            label="Clear search"
            size={28}
            className="absolute right-2 top-1/2 -translate-y-1/2"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      {/* Suggestions before anything is typed */}
      {!hasQuery && suggestions.length > 0 && (
        <div className="mt-6">
          <SectionHeader title="Your most-played artists" />
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button key={suggestion} size="sm" variant="secondary" onClick={() => runSuggestion(suggestion)}>
                {suggestion}
              </Button>
            ))}
          </div>
          <p className="mt-6 text-2xs leading-relaxed text-subtle">
            Search matches titles, artists, albums, genres, composers, filenames and folder names.
            It runs entirely on this device — no query ever leaves it.
          </p>
        </div>
      )}

      {/* Artists and albums */}
      {hasQuery && results.artists.length > 0 && (
        <section className="mt-6">
          <SectionHeader title="Artists" />
          <div className="mx-scroll -mx-1 mt-3 flex gap-3 overflow-x-auto px-1 pb-2">
            {results.artists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                onClick={() => navigate(`/artists/${artist.id}`)}
                className="flex w-24 shrink-0 flex-col items-center gap-1.5 text-center"
              >
                <Artwork
                  artworkId={artist.artworkId}
                  name={artist.name}
                  size={80}
                  rounded="full"
                  decorative
                />
                <span className="w-full truncate text-2xs text-text">{artist.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasQuery && results.albums.length > 0 && (
        <section className="mt-4">
          <SectionHeader title="Albums" />
          <div className="mx-scroll -mx-1 mt-3 flex gap-3 overflow-x-auto px-1 pb-2">
            {results.albums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => navigate(`/albums/${album.id}`)}
                className="flex w-28 shrink-0 flex-col gap-1.5 text-left"
              >
                <Artwork
                  artworkId={album.artworkId}
                  name={album.name}
                  size={112}
                  rounded="lg"
                  decorative
                />
                <span className="truncate text-2xs font-medium text-text">{album.name}</span>
                <span className="-mt-1 truncate text-2xs text-muted">{album.albumArtist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasQuery && results.tracks.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <SectionHeader
            title="Tracks"
            subtitle={
              results.truncated
                ? `Showing the top ${results.tracks.length} matches`
                : `${formatCount(results.tracks.length)} match${results.tracks.length === 1 ? '' : 'es'}`
            }
          />
          <div className="ml-auto flex gap-2">
            <PlayActions
              count={trackIds.length}
              onPlay={() => void playerActions.playTracks(trackIds, 0, false)}
              onShuffle={() => void playerActions.playTracks(trackIds, 0, true)}
            />
          </div>
        </div>
      )}
    </div>
  );

  if (hasQuery && searching && !hasResults) {
    return (
      <div className="flex flex-1 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  return (
    <TrackList
      ids={trackIds}
      ariaLabel="Search results"
      header={header}
      emptyState={
        hasQuery ? (
          <EmptyState
            icon={<SearchIcon className="h-8 w-8" />}
            title={`Nothing matches “${query.trim()}”`}
            body="Try fewer words, or check the spelling — search also tolerates a single typo in longer words."
          />
        ) : (
          <div className="h-2" />
        )
      }
    />
  );
}
