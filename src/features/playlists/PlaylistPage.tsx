/**
 * Playlist detail.
 *
 * Handles both kinds. A manual playlist reads its ordered entries and supports
 * removal; a smart playlist is evaluated from its rules on open (spec §22) and
 * shows those rules in plain language, so the membership is never mysterious.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ListMusic, Sparkles } from 'lucide-react';
import {
  getPlaylist,
  playlistEntries,
  removePlaylistEntries,
} from '@core/db/repositories/playlists';
import { getTracks } from '@core/db/repositories/tracks';
import { materialiseSmartPlaylist } from '@core/playlists/smart';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { playerActions } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Playlist, PlaylistEntry, SmartRule, Track } from '@core/types';
import { Button, Chip, EmptyState, Spinner } from '@ui/primitives';
import { PageHeader, PlayActions, trackStats } from '@ui/PageHeader';
import { TrackList } from '@ui/TrackList';

export function PlaylistPage() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const revision = useLibrary((state) => state.revision);
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!playlistId) return;
    setLoading(true);
    const found = await getPlaylist(playlistId);
    setPlaylist(found ?? null);

    if (!found) {
      setTracks([]);
      setEntries([]);
      setLoading(false);
      return;
    }

    if (found.kind === 'smart' && found.rules) {
      setEntries([]);
      setTracks(await materialiseSmartPlaylist(found.rules));
    } else {
      const found_entries = await playlistEntries(found.id);
      setEntries(found_entries);
      // Entry order is the playlist order, and `getTracks` preserves it.
      setTracks(await getTracks(found_entries.map((entry) => entry.trackId)));
    }
    setLoading(false);
  }, [playlistId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);
  const totalDuration = useMemo(
    () => tracks.reduce((sum, track) => sum + track.durationMs, 0),
    [tracks],
  );

  const removeAt = useCallback(
    async (_trackId: string, index: number) => {
      if (!playlist || playlist.kind === 'smart') return;
      const entry = entries[index];
      if (!entry) return;
      await removePlaylistEntries(playlist.id, [entry.id]);
      toast('Removed from playlist.', {
        kind: 'success',
        // Undo matters here: removing the wrong row from a long playlist is
        // easy and otherwise unrecoverable (spec §11).
        action: {
          label: 'Undo',
          run: async () => {
            const { addTracksToPlaylist, movePlaylistEntry } = await import(
              '@core/db/repositories/playlists'
            );
            await addTracksToPlaylist(playlist.id, [entry.trackId]);
            const current = await playlistEntries(playlist.id);
            await movePlaylistEntry(playlist.id, current.length - 1, index);
            await load();
          },
        },
      });
      await load();
    },
    [playlist, entries, toast, load],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (!playlist) {
    return (
      <EmptyState
        icon={<ListMusic className="h-8 w-8" />}
        title="Playlist not found"
        action={<Button onClick={() => navigate('/playlists')}>Back to playlists</Button>}
      />
    );
  }

  const isSmart = playlist.kind === 'smart';

  const header = (
    <div>
      <PageHeader
        eyebrow={isSmart ? 'Smart playlist' : 'Playlist'}
        title={playlist.name}
        subtitle={playlist.description || undefined}
        stats={trackStats(tracks.length, totalDuration)}
        actions={
          <>
            <PlayActions
              count={ids.length}
              onPlay={() => void playerActions.playTracks(ids, 0, false)}
              onShuffle={() => void playerActions.playTracks(ids, 0, true)}
              onAddToQueue={() => playerActions.addToQueue(ids)}
            />
            {ids.length > 0 && (
              <Button variant="ghost" onClick={() => openAddToPlaylist(ids)}>
                Copy to playlist
              </Button>
            )}
          </>
        }
      />

      {isSmart && playlist.rules && (
        <div className="mx-4 mb-4 rounded-xl border border-line bg-surface p-3 sm:mx-6">
          <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
            <Sparkles className="h-3 w-3" />
            Rules
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {playlist.rules.rules.map((rule, index) => (
              <li key={index}>
                <Chip tone="neutral" className="normal-case tracking-normal">
                  {describeRule(rule)}
                </Chip>
              </li>
            ))}
            <li>
              <Chip tone="accent" className="normal-case tracking-normal">
                match {playlist.rules.match}
              </Chip>
            </li>
            {playlist.rules.limit !== null && (
              <li>
                <Chip tone="neutral" className="normal-case tracking-normal">
                  limit {formatCount(playlist.rules.limit)}
                </Chip>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );

  return (
    <TrackList
      ids={ids}
      ariaLabel={`Tracks in ${playlist.name}`}
      header={header}
      onRemove={
        isSmart ? undefined : { label: 'Remove from playlist', run: (id, index) => void removeAt(id, index) }
      }
      emptyState={
        <EmptyState
          icon={isSmart ? <Sparkles className="h-8 w-8" /> : <ListMusic className="h-8 w-8" />}
          title={isSmart ? 'Nothing matches these rules yet' : 'This playlist is empty'}
          body={
            isSmart
              ? 'As your library grows — or as you play, rate and favourite tracks — this will fill in.'
              : 'Add tracks from any list using the ⋯ menu.'
          }
        />
      }
    />
  );
}

/** Render a rule as something a person can read. */
function describeRule(rule: SmartRule): string {
  const field = rule.field.replace(/([A-Z])/g, ' $1').toLowerCase();

  switch (rule.operator) {
    case 'isTrue':
      return `has ${field}`;
    case 'isFalse':
      return `no ${field}`;
    case 'isEmpty':
      return `${field} is empty`;
    case 'isNotEmpty':
      return `${field} is set`;
    case 'inLastDays':
      return `${field} in last ${rule.value} days`;
    case 'gte':
      return `${field} ≥ ${rule.value}`;
    case 'lte':
      return `${field} ≤ ${rule.value}`;
    case 'gt':
      return `${field} > ${rule.value}`;
    case 'lt':
      return `${field} < ${rule.value}`;
    case 'between':
      return `${field} ${rule.value}–${rule.value2}`;
    case 'is':
      return `${field} is ${rule.value}`;
    case 'isNot':
      return `${field} is not ${rule.value}`;
    case 'contains':
      return `${field} contains “${rule.value}”`;
    case 'notContains':
      return `${field} excludes “${rule.value}”`;
    case 'startsWith':
      return `${field} starts with “${rule.value}”`;
    case 'endsWith':
      return `${field} ends with “${rule.value}”`;
    default:
      return field;
  }
}
