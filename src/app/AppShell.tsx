/**
 * The application frame.
 *
 * Layout is deliberately flat: a row of [sidebar | content | queue], a player
 * bar, and a mobile tab bar. The player bar and the audio graph live *outside*
 * the router outlet, so navigation never interrupts playback.
 *
 * Also owns the two things that have to happen exactly once: library bootstrap
 * and the global keyboard shortcuts (spec §39).
 */

import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useLibrary } from '@state/libraryStore';
import { initPlayer, playerActions } from '@state/playerStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import { IconButton, Spinner, cx } from '@ui/primitives';
import { PlayerBar } from '@ui/PlayerBar';
import { QueuePanel } from '@ui/QueuePanel';
import { Sidebar } from '@ui/Sidebar';
import { AddToPlaylistDialog, ConfirmDialog, MobileNav, Toasts } from '@ui/Overlays';
import { NowPlaying } from '@features/nowplaying/NowPlaying';
import { ThemeManager } from './ThemeManager';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

export function AppShell() {
  const ready = useLibrary((state) => state.ready);
  const bootstrap = useLibrary((state) => state.bootstrap);
  const sources = useLibrary((state) => state.sources);
  const resumeOnLaunch = useSettings((state) => state.resumeOnLaunch);
  const collapsed = useSettings((state) => state.sidebarCollapsed);
  const patchSettings = useSettings((state) => state.patch);
  const mobileNavOpen = useUi((state) => state.mobileNavOpen);
  const setMobileNavOpen = useUi((state) => state.setMobileNavOpen);
  const navigate = useNavigate();
  const location = useLocation();

  useKeyboardShortcuts();

  // One-time startup: connect the player, restore sources, restore the queue.
  useEffect(() => {
    initPlayer();
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!ready || !resumeOnLaunch) return;
    // Restores the queue and position but does *not* start playing — browsers
    // block that, and a page that makes noise on open is hostile anyway.
    void playerActions.restoreSession();
  }, [ready, resumeOnLaunch]);

  // With no music yet, the only useful destination is onboarding.
  useEffect(() => {
    if (!ready) return;
    if (sources.length === 0 && location.pathname !== '/welcome') {
      navigate('/welcome', { replace: true });
    }
  }, [ready, sources.length, location.pathname, navigate]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, setMobileNavOpen]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Spinner size={22} />
          <p className="text-sm">Opening your library…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <ThemeManager />

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar />
        </div>

        {/* Mobile drawer */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/55 md:hidden"
            onClick={() => setMobileNavOpen(false)}
          >
            <div className="h-full w-[var(--mx-sidebar-width)]" onClick={(e) => e.stopPropagation()}>
              <Sidebar onNavigate={() => setMobileNavOpen(false)} />
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 px-3 md:h-0 md:px-0">
            <IconButton
              label="Open navigation"
              size={34}
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
            >
              <MenuIcon className="h-5 w-5" />
            </IconButton>
            <IconButton
              label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
              size={30}
              className="absolute left-2 top-2 z-10 hidden md:inline-flex"
              onClick={() => patchSettings({ sidebarCollapsed: !collapsed })}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </IconButton>
          </div>

          <div className={cx('flex min-h-0 flex-1 flex-col')}>
            <Outlet />
          </div>
        </main>

        <QueuePanel />
      </div>

      <PlayerBar />
      <MobileNav />

      <NowPlaying />
      <Toasts />
      <ConfirmDialog />
      <AddToPlaylistDialog />
    </div>
  );
}
