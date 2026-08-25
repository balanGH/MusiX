/**
 * Global overlays: toasts, the confirmation dialog, the add-to-playlist picker
 * and the mobile navigation bar.
 *
 * Grouped in one file because they are all thin, all mounted once by the shell,
 * and all driven by `uiStore`.
 */

import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Disc3,
  Home,
  Info,
  ListMusic,
  Music2,
  Plus,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { addTracksToPlaylist, createPlaylist, listPlaylists } from '@core/db/repositories/playlists';
import { formatCount } from '@core/utils';
import { useUi, type Toast } from '@state/uiStore';
import type { Playlist } from '@core/types';
import { Button, IconButton, cx } from './primitives';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_ICON = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
} as const;

const TOAST_TONE = {
  info: 'text-muted',
  success: 'text-ok',
  warn: 'text-warn',
  error: 'text-danger',
} as const;

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      // `polite` rather than `assertive`: a toast should be announced, not
      // interrupt what the user is already hearing (spec §39).
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      style={{ bottom: 'calc(var(--mx-player-height) + 1rem)' }}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(): void }) {
  const Icon = TOAST_ICON[toast.kind];
  return (
    <div className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-bg-elevated p-3 shadow-pop animate-slide-up">
      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', TOAST_TONE[toast.kind])} />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-text">{toast.message}</p>
      {toast.action && (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <IconButton label="Dismiss" size={22} onClick={onDismiss} className="shrink-0">
        <X className="h-3 w-3" />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

/**
 * The single confirmation path for every destructive action (spec §11).
 *
 * `preview` is the important part: the spec is explicit that a user must see
 * exactly what is about to change before it happens, not just a yes/no.
 */
export function ConfirmDialog() {
  const request = useUi((state) => state.confirm);
  const resolve = useUi((state) => state.resolveConfirm);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resolve(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [request, resolve]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget) resolve(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mx-confirm-title"
        className="w-full max-w-md rounded-panel border border-line bg-bg-elevated p-5 shadow-pop"
      >
        <h2 id="mx-confirm-title" className="text-base font-semibold text-text">
          {request.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{request.body}</p>

        {request.preview && request.preview.length > 0 && (
          <ul className="mx-scroll mt-3 max-h-48 rounded-lg border border-line bg-surface p-2 text-xs">
            {request.preview.map((line, index) => (
              <li key={index} className="truncate px-1 py-0.5 font-mono text-muted">
                {line}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => resolve(false)}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={request.destructive ? 'danger' : 'primary'}
            onClick={() => resolve(true)}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add to playlist
// ---------------------------------------------------------------------------

export function AddToPlaylistDialog() {
  const trackIds = useUi((state) => state.addToPlaylistFor);
  const close = useUi((state) => state.closeAddToPlaylist);
  const toast = useUi((state) => state.toast);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!trackIds) return;
    setNewName('');
    void listPlaylists().then((all) =>
      // Smart playlists are defined by rules, so tracks cannot be added to them.
      setPlaylists(all.filter((playlist) => playlist.kind === 'manual')),
    );
  }, [trackIds]);

  useEffect(() => {
    if (!trackIds) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [trackIds, close]);

  if (!trackIds) return null;

  const label = trackIds.length === 1 ? 'track' : `${formatCount(trackIds.length)} tracks`;

  const addTo = async (playlist: Playlist) => {
    setBusy(true);
    try {
      const added = await addTracksToPlaylist(playlist.id, trackIds);
      toast(`Added ${added === 1 ? '1 track' : `${added} tracks`} to “${playlist.name}”.`, {
        kind: 'success',
      });
      close();
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const playlist = await createPlaylist({ name });
      await addTracksToPlaylist(playlist.id, trackIds);
      toast(`Created “${playlist.name}” with ${label}.`, { kind: 'success' });
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mx-playlist-title"
        className="flex max-h-[70vh] w-full max-w-md flex-col rounded-panel border border-line bg-bg-elevated shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 id="mx-playlist-title" className="text-base font-semibold">
            Add {label} to a playlist
          </h2>
          <IconButton label="Close" size={28} onClick={close}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="mx-scroll flex-1 p-2">
          {playlists.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">
              No playlists yet. Create one below.
            </p>
          ) : (
            <ul>
              {playlists.map((playlist) => (
                <li key={playlist.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addTo(playlist)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-hover disabled:opacity-50"
                  >
                    <ListMusic className="h-4 w-4 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate text-sm">{playlist.name}</span>
                    <span className="shrink-0 text-2xs text-subtle">
                      {formatCount(playlist.trackCount)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          className="flex items-center gap-2 border-t border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createAndAdd();
          }}
        >
          <Plus className="h-4 w-4 shrink-0 text-subtle" />
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New playlist name"
            aria-label="New playlist name"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm outline-none placeholder:text-subtle focus-visible:border-accent"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!newName.trim() || busy}>
            <Check className="h-3.5 w-3.5" />
            Create
          </Button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile navigation
// ---------------------------------------------------------------------------

const MOBILE_TABS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/songs', label: 'Songs', icon: Music2, end: false },
  { to: '/albums', label: 'Albums', icon: Disc3, end: false },
  { to: '/playlists', label: 'Playlists', icon: ListMusic, end: false },
];

/**
 * Bottom tab bar for narrow screens.
 *
 * Five destinations, thumb-reachable, with the safe-area inset honoured so the
 * home indicator does not sit on top of the tabs.
 */
export function MobileNav() {
  return (
    <nav
      aria-label="Main navigation"
      className="z-30 flex shrink-0 items-stretch border-t border-line bg-bg-elevated md:hidden"
      style={{
        height: 'var(--mx-nav-height)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {MOBILE_TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cx(
              'flex flex-1 flex-col items-center justify-center gap-1 text-2xs transition',
              isActive ? 'text-accent' : 'text-subtle',
            )
          }
        >
          <tab.icon className="h-5 w-5" />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
