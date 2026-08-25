/**
 * Library Health (spec §24).
 *
 * Computed on demand, never in the background. Every number is clickable —
 * "28 missing metadata" that you cannot act on is a statistic, not a tool.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Copy,
  FileWarning,
  Image,
  Mic2,
  RefreshCw,
  Tags,
} from 'lucide-react';
import {
  computeLibraryHealth,
  healthPercent,
  suggestDuplicateResolution,
  type HealthDetail,
} from '@core/library/health';
import { getTracks } from '@core/db/repositories/tracks';
import { formatBytes, formatCount, formatDurationLong, formatQuality } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import type { DuplicateGroup, Track } from '@core/types';
import { Button, Chip, EmptyState, ProgressBar, Spinner, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';

type Focus = 'none' | 'metadata' | 'artwork' | 'lyrics' | 'unreadable' | 'duplicates';

export function HealthPage() {
  const revision = useLibrary((state) => state.revision);
  const [detail, setDetail] = useState<HealthDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState<Focus>('none');

  const compute = useCallback(async () => {
    setLoading(true);
    setDetail(await computeLibraryHealth());
    setLoading(false);
  }, []);

  useEffect(() => {
    void compute();
  }, [compute, revision]);

  if (loading && !detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
        <Spinner size={20} />
        <p className="text-sm">Checking your library…</p>
      </div>
    );
  }

  if (!detail) return null;

  const { health } = detail;

  if (health.trackCount === 0) {
    return (
      <EmptyState
        icon={<Activity className="h-8 w-8" />}
        title="Nothing to check yet"
        body="Add a music folder and this page will report what is complete and what needs attention."
      />
    );
  }

  const focusIds =
    focus === 'metadata'
      ? detail.missingMetadataIds
      : focus === 'artwork'
        ? detail.missingArtworkIds
        : focus === 'lyrics'
          ? detail.missingLyricsIds
          : focus === 'unreadable'
            ? detail.unreadableIds
            : [];

  if (focus !== 'none' && focus !== 'duplicates') {
    return (
      <TrackList
        ids={focusIds}
        ariaLabel="Tracks needing attention"
        header={
          <PageHeader
            eyebrow="Library health"
            title={FOCUS_TITLES[focus]}
            stats={`${formatCount(focusIds.length)} track${focusIds.length === 1 ? '' : 's'}`}
            actions={
              <>
                <Button variant="secondary" onClick={() => setFocus('none')}>
                  Back to overview
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void playerActions.playTracks(focusIds, 0, false)}
                  disabled={focusIds.length === 0}
                >
                  Play these
                </Button>
              </>
            }
          />
        }
      />
    );
  }

  return (
    <div className="mx-scroll flex-1">
      <PageHeader
        eyebrow="Library"
        title="Health"
        stats={`${formatCount(health.trackCount)} tracks · ${formatBytes(
          health.totalBytes,
        )} · ${formatDurationLong(health.totalDurationMs)}`}
        actions={
          <Button variant="secondary" onClick={() => void compute()} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Recheck
          </Button>
        }
      />

      <div className="grid gap-3 px-4 pb-10 sm:px-6 lg:grid-cols-2">
        <Metric
          icon={<Tags className="h-4 w-4" />}
          label="Metadata"
          have={health.withMetadata}
          total={health.trackCount}
          missing={health.missingMetadata}
          missingLabel="tracks with incomplete tags"
          onInspect={() => setFocus('metadata')}
        />
        <Metric
          icon={<Image className="h-4 w-4" />}
          label="Artwork"
          have={health.withArtwork}
          total={health.trackCount}
          missing={health.missingArtwork}
          missingLabel="tracks with no cover"
          onInspect={() => setFocus('artwork')}
        />
        <Metric
          icon={<Mic2 className="h-4 w-4" />}
          label="Lyrics"
          have={health.withLyrics}
          total={health.trackCount}
          missing={health.missingLyrics}
          missingLabel="tracks with no lyrics"
          onInspect={() => setFocus('lyrics')}
        />
        <Metric
          icon={<FileWarning className="h-4 w-4" />}
          label="Readable audio"
          have={health.trackCount - health.unreadable}
          total={health.trackCount}
          missing={health.unreadable}
          missingLabel="files whose duration could not be read"
          onInspect={() => setFocus('unreadable')}
          tone={health.unreadable > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* Duplicates */}
      <div className="px-4 pb-16 sm:px-6">
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-subtle" />
            <h2 className="text-sm font-semibold">Possible duplicates</h2>
            <span className="ml-auto text-xs tabular-nums text-muted">
              {formatCount(health.duplicateGroups.length)} group
              {health.duplicateGroups.length === 1 ? '' : 's'}
            </span>
          </div>

          <p className="mt-1.5 text-2xs leading-relaxed text-muted">
            Grouped by title, artist and length rounded to two seconds — which finds a FLAC and the
            MP3 made from it, without flagging a live version as a copy of the studio one. MusiX
            never deletes anything on its own; use your file manager and then rescan.
          </p>

          {health.duplicateGroups.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No duplicates found.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {health.duplicateGroups.slice(0, 40).map((group) => (
                <DuplicateRow key={group.key} group={group} />
              ))}
            </ul>
          )}

          {health.duplicateGroups.length > 40 && (
            <p className="mt-3 text-2xs text-subtle">
              Showing the 40 largest groups of {formatCount(health.duplicateGroups.length)}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const FOCUS_TITLES: Record<Exclude<Focus, 'none' | 'duplicates'>, string> = {
  metadata: 'Incomplete metadata',
  artwork: 'Missing artwork',
  lyrics: 'Missing lyrics',
  unreadable: 'Unreadable audio metadata',
};

function Metric({
  icon,
  label,
  have,
  total,
  missing,
  missingLabel,
  onInspect,
  tone = 'accent',
}: {
  icon: React.ReactNode;
  label: string;
  have: number;
  total: number;
  missing: number;
  missingLabel: string;
  onInspect(): void;
  tone?: 'accent' | 'ok' | 'warn';
}) {
  const percent = healthPercent(have, total);

  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="text-subtle">{icon}</span>
        <h2 className="text-sm font-semibold">{label}</h2>
        <span
          className={cx(
            'ml-auto text-lg font-semibold tabular-nums',
            percent >= 90 ? 'text-ok' : percent >= 60 ? 'text-text' : 'text-warn',
          )}
        >
          {percent}%
        </span>
      </div>

      <ProgressBar
        value={total > 0 ? have / total : 0}
        label={`${label} completeness`}
        className="mt-3"
        tone={percent >= 90 ? 'ok' : percent >= 60 ? tone : 'warn'}
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-2xs text-muted">
          {missing === 0 ? (
            'Everything is covered.'
          ) : (
            <>
              <AlertTriangle className="mr-1 inline h-3 w-3 text-warn" />
              {formatCount(missing)} {missingLabel}
            </>
          )}
        </p>
        {missing > 0 && (
          <Button size="sm" variant="ghost" onClick={onInspect}>
            Show them
          </Button>
        )}
      </div>
    </div>
  );
}

function DuplicateRow({ group }: { group: DuplicateGroup }) {
  const [copies, setCopies] = useState<Track[] | null>(null);
  const navigate = useNavigate();

  return (
    <li className="rounded-lg border border-line bg-bg p-2.5">
      <button
        type="button"
        onClick={async () => {
          if (copies) {
            setCopies(null);
            return;
          }
          // Fetch on expand only — a library with 400 duplicate groups should
          // not read 1,200 records to render a summary. The ranking puts the
          // copy worth keeping first (lossless, then bitrate, then size).
          const ranked = await suggestDuplicateResolution(group);
          setCopies(ranked ? [ranked.keep, ...ranked.others] : await getTracks(group.trackIds));
        }}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{group.title}</span>
          <span className="block truncate text-2xs text-muted">{group.artist}</span>
        </span>
        <Chip tone="warn">{group.trackIds.length} copies</Chip>
      </button>

      {copies && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2">
          {copies.map((track, index) => (
            <li key={track.id} className="flex items-center gap-2 text-2xs">
              {/* The first row is the suggested keeper: lossless, then higher
                  bitrate, then longer, then larger. */}
              {index === 0 && <Chip tone="ok">keep</Chip>}
              <button
                type="button"
                onClick={() => navigate(`/albums/${track.albumId}`)}
                className="min-w-0 flex-1 truncate text-left font-mono text-muted hover:text-text hover:underline"
                title={track.path}
              >
                {track.path}
              </button>
              <span className="shrink-0 text-subtle">{formatQuality(track)}</span>
              <span className="shrink-0 tabular-nums text-subtle">
                {formatBytes(track.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
