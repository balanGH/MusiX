/**
 * Playlists (spec §22).
 *
 * Built-in smart playlists and the user's own manual ones live in the same
 * store and are shown in the same list, distinguished by a badge. The built-ins
 * are ordinary rule sets — they are not special-cased queries — so a user can
 * open one and see exactly why a track is in it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListMusic, Plus, Sparkles, Trash2 } from 'lucide-react';
import { createPlaylist, deletePlaylist, listPlaylists } from '@core/db/repositories/playlists';
import { formatCount, formatDurationLong } from '@core/utils';
import { useUi } from '@state/uiStore';
import type { Playlist } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, Chip, EmptyState, IconButton, SectionHeader, Spinner, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';

export function PlaylistsPage() {
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const confirm = useUi((state) => state.requestConfirm);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    setPlaylists(await listPlaylists());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const playlist = await createPlaylist({ name: trimmed });
    setName('');
    setCreating(false);
    await load();
    navigate(`/playlists/${playlist.id}`);
  };

  const remove = async (playlist: Playlist) => {
    const ok = await confirm({
      title: `Delete “${playlist.name}”?`,
      body: 'The playlist is removed. Your music files and the tracks themselves are not touched.',
      preview: [`${formatCount(playlist.trackCount)} tracks will be removed from this playlist`],
      confirmLabel: 'Delete playlist',
      destructive: true,
    });
    if (!ok) return;
    await deletePlaylist(playlist.id);
    await load();
    toast(`Deleted “${playlist.name}”.`, { kind: 'success' });
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const smart = playlists.filter((playlist) => playlist.kind === 'smart');
  const manual = playlists.filter((playlist) => playlist.kind === 'manual');

  return (
    <div className="mx-scroll flex-1">
      <PageHeader
        title="Playlists"
        stats={`${formatCount(manual.length)} of your own · ${formatCount(smart.length)} smart`}
        actions={
          creating ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (!name.trim()) setCreating(false);
                }}
                placeholder="Playlist name"
                aria-label="Playlist name"
                className="h-10 w-56 rounded-xl border border-line bg-surface px-3 text-sm outline-none placeholder:text-subtle focus-visible:border-accent"
              />
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Create
              </Button>
            </form>
          ) : (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New playlist
            </Button>
          )
        }
      />

      <div className="px-4 pb-10 sm:px-6">
        {/* Your playlists */}
        <SectionHeader
          title="Your playlists"
          subtitle={manual.length === 0 ? 'None yet' : undefined}
        />
        {manual.length === 0 ? (
          <EmptyState
            icon={<ListMusic className="h-7 w-7" />}
            title="No playlists yet"
            body="Create one, then add tracks from any list with the ⋯ menu."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New playlist
              </Button>
            }
            className="!py-10"
          />
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {manual.map((playlist) => (
              <PlaylistCard
                key={playlist.id}
                playlist={playlist}
                onOpen={() => navigate(`/playlists/${playlist.id}`)}
                onDelete={() => void remove(playlist)}
              />
            ))}
          </ul>
        )}

        {/* Smart playlists */}
        <SectionHeader
          title="Smart playlists"
          subtitle="Built from rules, and always up to date"
          className="mt-8"
        />
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {smart.map((playlist) => (
            <PlaylistCard
              key={playlist.id}
              playlist={playlist}
              onOpen={() => navigate(`/playlists/${playlist.id}`)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlaylistCard({
  playlist,
  onOpen,
  onDelete,
}: {
  playlist: Playlist;
  onOpen(): void;
  onDelete?(): void;
}) {
  const isSmart = playlist.kind === 'smart';

  return (
    <li className="group/pl">
      <div
        className={cx(
          'flex items-center gap-3 rounded-xl border border-line bg-surface p-2.5 transition',
          'hover:border-accent/50 hover:bg-surface-hover',
        )}
      >
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {isSmart ? (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
              <Sparkles className="h-5 w-5" />
            </span>
          ) : (
            <Artwork
              artworkId={null}
              name={playlist.name}
              size={48}
              rounded="md"
              decorative
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-text">{playlist.name}</span>
              {isSmart && <Chip tone="accent">Smart</Chip>}
            </span>
            <span className="block truncate text-2xs text-muted">
              {isSmart
                ? playlist.description
                : `${formatCount(playlist.trackCount)} track${playlist.trackCount === 1 ? '' : 's'}${
                    playlist.durationMs > 0 ? ` · ${formatDurationLong(playlist.durationMs)}` : ''
                  }`}
            </span>
          </span>
        </button>

        {onDelete && (
          <IconButton
            label={`Delete ${playlist.name}`}
            size={30}
            onClick={onDelete}
            className="shrink-0 opacity-0 group-hover/pl:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </li>
  );
}
