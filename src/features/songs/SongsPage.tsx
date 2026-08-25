/**
 * All songs (spec §40 Phase 1).
 *
 * The page that has to survive 100,000 rows. It holds only the ordered id list
 * — one `getAllKeys` on an index — and lets `TrackList` fetch the ~30 records
 * on screen (spec §35).
 */

import { useEffect, useMemo, useState } from 'react';
import { Music2 } from 'lucide-react';
import { trackIdsSorted, type TrackSort } from '@core/db/repositories/tracks';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useSettings } from '@state/settingsStore';
import { EmptyState, Select, Spinner } from '@ui/primitives';
import { PageHeader, PlayActions } from '@ui/PageHeader';
import { TrackList, useListPlayback } from '@ui/TrackList';

const SORT_OPTIONS: { value: TrackSort; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'addedAt', label: 'Recently added' },
  { value: 'lastPlayedAt', label: 'Recently played' },
  { value: 'playCount', label: 'Most played' },
  { value: 'rating', label: 'Rating' },
  { value: 'duration', label: 'Length' },
];

/** Sorts that are most useful newest-first. */
const DESCENDING_BY_DEFAULT = new Set<TrackSort>(['addedAt', 'lastPlayedAt', 'playCount', 'rating']);

export function SongsPage() {
  const revision = useLibrary((state) => state.revision);
  const total = useLibrary((state) => state.counts.tracks);
  const density = useSettings((state) => state.listDensity);
  const patchSettings = useSettings((state) => state.patch);

  const [sort, setSort] = useState<TrackSort>('title');
  const [ids, setIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const direction = DESCENDING_BY_DEFAULT.has(sort) ? 'desc' : 'asc';
    void trackIdsSorted(sort, direction).then((result) => {
      if (cancelled) return;
      setIds(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sort, revision]);

  const playback = useListPlayback(ids);

  const header = useMemo(
    () => (
      <PageHeader
        title="Songs"
        stats={`${formatCount(total)} track${total === 1 ? '' : 's'}`}
        actions={
          <>
            <PlayActions
              count={ids.length}
              onPlay={playback.play}
              onShuffle={playback.shuffle}
              onAddToQueue={playback.addToQueue}
            />
            <div className="ml-auto flex items-center gap-2">
              <Select
                label="Sort songs by"
                value={sort}
                options={SORT_OPTIONS}
                onChange={(value) => setSort(value)}
              />
              <Select
                label="Row density"
                value={density}
                options={[
                  { value: 'comfortable', label: 'Comfortable' },
                  { value: 'compact', label: 'Compact' },
                ]}
                onChange={(value) => patchSettings({ listDensity: value })}
              />
            </div>
          </>
        }
      />
    ),
    [total, ids.length, playback, sort, density, patchSettings],
  );

  if (loading && ids.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <TrackList
      ids={ids}
      ariaLabel="All songs"
      header={header}
      showAlbum
      emptyState={
        <EmptyState
          icon={<Music2 className="h-8 w-8" />}
          title="No songs yet"
          body="Add a music folder and MusiX will read the tags from your files."
        />
      }
    />
  );
}
