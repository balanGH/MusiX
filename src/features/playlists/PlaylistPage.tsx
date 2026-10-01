/**
 * Playlist detail.
 *
 * Handles both kinds. A manual playlist reads its ordered entries and supports
 * removal; a smart playlist is evaluated from its rules on open (spec §22) and
 * shows those rules in plain language, so the membership is never mysterious.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const playlistsRevision = useUi((state) => state.playlistsRevision);
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const openAddToPlaylist = useUi((state) => state.openAddToPlaylist);

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Every load takes a ticket; only the latest may write state. Without it,
  // switching playlists quickly let the slower (older) read land last.
  const loadTicket = useRef(0);

  // `quiet` reloads in place (no spinner), for changes made elsewhere while
  // this page is already showing, e.g. from the add-to-playlist sheet.
  const load = useCallback(async (quiet = false) => {
    if (!playlistId) return;
    const ticket = ++loadTicket.current;
    const current = () => ticket === loadTicket.current;
    if (!quiet) setLoading(true);
    setFailed(false);

    try {
      const found = await getPlaylist(playlistId);
      if (!current()) return;

      if (!found) {
        setPlaylist(null);
        setTracks([]);
        setEntries([]);
        return;
      }

      if (found.kind === 'smart' && found.rules) {
        const matched = await materialiseSmartPlaylist(found.rules);
        if (!current()) return;
        setPlaylist(found);
        setEntries([]);
        setTracks(matched);
      } else {
        const foundEntries = await playlistEntries(found.id);
        const foundTracks = await getTracks(foundEntries.map((entry) => entry.trackId));
        if (!current()) return;
        // `getTracks` drops ids whose track no longer exists, so keep only the
        // entries that still have one. `entries[i]` and `tracks[i]` must stay
        // the same row: removal maps a list index back to an entry, and an
        // unaligned pair removed the wrong entry after a track was deleted.
        const byId = new Map(foundTracks.map((track) => [track.id, track]));
        const shown = foundEntries.filter((entry) => byId.has(entry.trackId));
        setPlaylist(found);
        setEntries(shown);
        setTracks(shown.map((entry) => byId.get(entry.trackId)!));
      }
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setLoading(false);
    }
  }, [playlistId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // Skip the first run: the effect above already does the initial load.
  const seenPlaylistsRevision = useRef(playlistsRevision);
  useEffect(() => {
    if (seenPlaylistsRevision.current === playlistsRevision) return;
    seenPlaylistsRevision.current = playlistsRevision;
    void load(true);
  }, [load, playlistsRevision]);

  // Invalidate any in-flight load when leaving the page.
  useEffect(
    () => () => {
      loadTicket.current++;
    },
    [],
  );

  const ids = useMemo(() => tracks.map((track) => track.id), [tracks]);
  const totalDuration = useMemo(
    () => tracks.reduce((sum, track) => sum + track.durationMs, 0),
    [tracks],
  );

  const removeAt = useCallback(
    async (trackId: string, index: number) => {
      if (!playlist || playlist.kind === 'smart') return;
      // Identify the entry, not just the position: the row index is only a
      // hint, and must agree with the track the user acted on.
      const hinted = entries[index];
      const entry = hinted?.trackId === trackId ? hinted : entries.find((e) => e.trackId === trackId);
      if (!entry) return;
      // Its position in the full playlist (which may include entries hidden
      // because their track is gone), for Undo to restore it to.
      const restoreAt = entry.position;
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
            await movePlaylistEntry(
              playlist.id,
              current.length - 1,
              Math.min(restoreAt, current.length - 1),
            );
            await load(true);
          },
        },
      });
      await load(true);
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

  if (failed) {
    return (
      <EmptyState
        icon={<ListMusic className="h-8 w-8" />}
        title="Couldn’t open this playlist"
        body="Reading it from your library failed."
        action={<Button onClick={() => void load()}>Try again</Button>}
      />
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
