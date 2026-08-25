/**
 * Folder browser (spec §31).
 *
 * Browses the real directory structure of each music source, which is how a
 * lot of people actually organise music — soundtracks, bootlegs and DJ sets
 * often have no useful tags at all, and the folder they live in *is* the
 * metadata.
 *
 * Rename / move / delete from spec §31 are not offered here: writing to the
 * user's disk needs a `readwrite` handle, and MusiX deliberately asks only for
 * `read`. That is stated on the page rather than hidden behind a button that
 * would fail (spec §41).
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, HardDrive, Info } from 'lucide-react';
import { childFolders, folderPath } from '@core/db/repositories/library';
import { tracksByFolder } from '@core/db/repositories/tracks';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import type { Folder as FolderRecord, Track } from '@core/types';
import { EmptyState, Spinner, cx } from '@ui/primitives';
import { PageHeader, PlayActions } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';

export function FoldersPage() {
  const revision = useLibrary((state) => state.revision);
  const sources = useLibrary((state) => state.sources);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<FolderRecord[]>([]);
  const [children, setChildren] = useState<FolderRecord[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void Promise.all([
      childFolders(currentId),
      currentId ? tracksByFolder(currentId) : Promise.resolve([]),
      currentId ? folderPath(currentId) : Promise.resolve([]),
    ]).then(([foundChildren, foundTracks, path]) => {
      if (cancelled) return;
      setChildren(foundChildren);
      setTracks(foundTracks);
      setBreadcrumb(path);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [currentId, revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);

  const header = (
    <div>
      <PageHeader
        title={breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1]!.name : 'Folders'}
        eyebrow={breadcrumb.length > 0 ? 'Folder' : undefined}
        subtitle={
          <Breadcrumb items={breadcrumb} onNavigate={setCurrentId} sourceCount={sources.length} />
        }
        stats={
          currentId
            ? `${formatCount(children.length)} folder${children.length === 1 ? '' : 's'} · ${formatCount(
                tracks.length,
              )} track${tracks.length === 1 ? '' : 's'} here`
            : `${formatCount(sources.length)} music folder${sources.length === 1 ? '' : 's'}`
        }
        actions={
          ids.length > 0 ? (
            <PlayActions
              count={ids.length}
              onPlay={() => void playerActions.playTracks(ids, 0, false)}
              onShuffle={() => void playerActions.playTracks(ids, 0, true)}
              onAddToQueue={() => playerActions.addToQueue(ids)}
            />
          ) : undefined
        }
      />

      {/* Subfolders */}
      {children.length > 0 && (
        <ul className="grid gap-1.5 px-4 pb-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {children.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => setCurrentId(folder.id)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition hover:border-accent/50 hover:bg-surface-hover"
              >
                {folder.depth === 0 ? (
                  <HardDrive className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{folder.name}</span>
                <span className="shrink-0 text-2xs tabular-nums text-subtle">
                  {folder.trackCount > 0 ? formatCount(folder.trackCount) : ''}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Honest note about what a browser will and will not allow. */}
      {currentId && (
        <p className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-2xs leading-relaxed text-muted sm:mx-6">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          MusiX asked for read-only access to this folder, so it can play and index your files but
          cannot rename, move or delete them. Use your file manager for that, then rescan.
        </p>
      )}
    </div>
  );

  if (loading && children.length === 0 && tracks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen className="h-8 w-8" />}
        title="No music folders"
        body="Add a folder and its structure will appear here exactly as it is on disk."
      />
    );
  }

  return (
    <TrackList
      ids={ids}
      ariaLabel="Tracks in this folder"
      header={header}
      showAlbum={false}
      emptyState={
        children.length === 0 ? (
          <EmptyState
            icon={<Folder className="h-8 w-8" />}
            title="This folder is empty"
            body="No audio files were found here."
          />
        ) : (
          // Subfolders are already rendered in the header; no empty state needed.
          <div className="h-2" />
        )
      }
    />
  );
}

function Breadcrumb({
  items,
  onNavigate,
  sourceCount,
}: {
  items: FolderRecord[];
  onNavigate(id: string | null): void;
  sourceCount: number;
}) {
  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className={cx(
          'rounded px-1 py-0.5 hover:text-text hover:underline',
          items.length === 0 ? 'font-medium text-text' : 'text-muted',
        )}
      >
        All folders ({sourceCount})
      </button>
      {items.map((folder, index) => (
        <span key={folder.id} className="flex items-center gap-1">
          <ChevronRight className="h-3 w-3 text-subtle" />
          <button
            type="button"
            onClick={() => onNavigate(folder.id)}
            className={cx(
              'max-w-[12rem] truncate rounded px-1 py-0.5 hover:text-text hover:underline',
              index === items.length - 1 ? 'font-medium text-text' : 'text-muted',
            )}
          >
            {folder.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
