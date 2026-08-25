/**
 * Desktop navigation.
 *
 * Also the home for library-level status: which folders are connected, whether
 * one needs reconnecting, and the scan progress. Those belong next to the
 * library navigation rather than buried in Settings, because a folder that has
 * lost permission is the one thing that makes the app look broken.
 */

import { NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  Disc3,
  FolderOpen,
  Heart,
  Home,
  ListMusic,
  Mic2,
  Music2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useSettings } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import { Button, IconButton, ProgressBar, cx } from './primitives';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  /** Shown on the right, e.g. the track count. */
  badge?: string;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useLibrary((state) => state.counts);
  const sources = useLibrary((state) => state.sources);
  const needsPermission = useLibrary((state) => state.needsPermission);
  const scan = useLibrary((state) => state.scan);
  const importing = useLibrary((state) => state.importing);
  const scanAll = useLibrary((state) => state.scanAll);
  const addFolder = useLibrary((state) => state.addFolder);
  const reconnect = useLibrary((state) => state.reconnect);
  const collapsed = useSettings((state) => state.sidebarCollapsed);
  const toast = useUi((state) => state.toast);
  const navigate = useNavigate();

  const primary: NavItem[] = [
    { to: '/', label: 'Home', icon: <Home className="h-4 w-4" /> },
    { to: '/search', label: 'Search', icon: <Search className="h-4 w-4" /> },
  ];

  const library: NavItem[] = [
    {
      to: '/songs',
      label: 'Songs',
      icon: <Music2 className="h-4 w-4" />,
      badge: formatCount(counts.tracks),
    },
    {
      to: '/albums',
      label: 'Albums',
      icon: <Disc3 className="h-4 w-4" />,
      badge: formatCount(counts.albums),
    },
    {
      to: '/artists',
      label: 'Artists',
      icon: <Users className="h-4 w-4" />,
      badge: formatCount(counts.artists),
    },
    {
      to: '/favorites',
      label: 'Favourites',
      icon: <Heart className="h-4 w-4" />,
      badge: counts.favorites > 0 ? formatCount(counts.favorites) : undefined,
    },
    {
      to: '/folders',
      label: 'Folders',
      icon: <FolderOpen className="h-4 w-4" />,
      badge: formatCount(counts.folders),
    },
    { to: '/playlists', label: 'Playlists', icon: <ListMusic className="h-4 w-4" /> },
  ];

  const tools: NavItem[] = [
    { to: '/studio', label: 'Audio Studio', icon: <Mic2 className="h-4 w-4" /> },
    { to: '/equalizer', label: 'Equaliser', icon: <SlidersHorizontal className="h-4 w-4" /> },
    { to: '/health', label: 'Library Health', icon: <Activity className="h-4 w-4" /> },
    { to: '/settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  ];

  const busy = scan !== null || importing !== null;

  return (
    <nav
      aria-label="Library navigation"
      className={cx(
        'flex h-full flex-col border-r border-line bg-bg-elevated',
        collapsed ? 'w-[68px]' : 'w-[var(--mx-sidebar-width)]',
      )}
    >
      {/* Wordmark */}
      <div className="flex h-16 items-center gap-2.5 px-4">
        <span className="flex h-8 w-8 shrink-0 items-end justify-center gap-[3px] rounded-lg bg-accent/15 pb-2">
          <span className="h-4 w-[3px] rounded-full bg-accent" />
          <span className="h-2.5 w-[3px] rounded-full bg-accent" />
          <span className="h-3.5 w-[3px] rounded-full bg-accent" />
        </span>
        {!collapsed && <span className="text-base font-semibold tracking-tight">MusiX</span>}
      </div>

      <div className="mx-scroll flex-1 px-2 pb-4">
        <Group items={primary} collapsed={collapsed} onNavigate={onNavigate} />

        <SectionLabel collapsed={collapsed}>Library</SectionLabel>
        <Group items={library} collapsed={collapsed} onNavigate={onNavigate} />

        <SectionLabel collapsed={collapsed}>Tools</SectionLabel>
        <Group items={tools} collapsed={collapsed} onNavigate={onNavigate} />

        {/* Folders that need the user to re-grant access (spec §34). */}
        {!collapsed && needsPermission.length > 0 && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-3">
            <p className="text-xs font-medium text-text">Reconnect your music folder</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Browsers drop folder access between sessions. Your library is intact — MusiX just
              needs permission to read the files again.
            </p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {needsPermission.map((source) => (
                <Button
                  key={source.id}
                  size="sm"
                  variant="secondary"
                  className="justify-start"
                  onClick={async () => {
                    const ok = await reconnect(source.id);
                    toast(
                      ok ? `Reconnected “${source.name}”.` : `“${source.name}” was not reconnected.`,
                      { kind: ok ? 'success' : 'warn' },
                    );
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {source.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Scan / import progress */}
        {!collapsed && busy && <ScanStatus />}
      </div>

      {/* Sources footer */}
      {!collapsed && (
        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wider text-subtle">
              Music folders
            </span>
            <IconButton
              label="Add a music folder"
              size={26}
              onClick={async () => {
                const result = await addFolder();
                if (result.message) toast(result.message, { kind: 'warn' });
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </div>

          {sources.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate('/welcome')}
              className="w-full rounded-lg border border-dashed border-line px-3 py-2.5 text-left text-xs text-muted hover:border-accent hover:text-text"
            >
              No folders yet — add your music
            </button>
          ) : (
            <ul className="space-y-1">
              {sources.map((source) => (
                <li key={source.id} className="flex items-center gap-2 text-xs text-muted">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="truncate" title={source.name}>
                    {source.name}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-subtle">
                    {formatCount(source.trackCount)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="mt-2 w-full justify-start"
            disabled={busy || sources.length === 0}
            loading={busy}
            onClick={() => void scanAll('incremental')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {busy ? 'Scanning…' : 'Scan for changes'}
          </Button>
        </div>
      )}
    </nav>
  );
}

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="my-2 h-px bg-line" />;
  return (
    <div className="px-3 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wider text-subtle">
      {children}
    </div>
  );
}

function Group({
  items,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
                collapsed && 'justify-center px-0',
                isActive
                  ? 'bg-accent/12 font-medium text-accent'
                  : 'text-muted hover:bg-surface-hover hover:text-text',
              )
            }
          >
            {item.icon}
            {!collapsed && (
              <>
                <span className="truncate">{item.label}</span>
                {item.badge && (
                  <span className="ml-auto shrink-0 text-2xs tabular-nums text-subtle">
                    {item.badge}
                  </span>
                )}
              </>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** Live scan / import readout. */
function ScanStatus() {
  const scan = useLibrary((state) => state.scan);
  const importing = useLibrary((state) => state.importing);
  const cancel = useLibrary((state) => state.cancelScan);

  if (importing) {
    const ratio = importing.total > 0 ? importing.copied / importing.total : 0;
    return (
      <div className="mt-4 rounded-xl border border-line bg-surface p-3">
        <p className="text-xs font-medium">
          {importing.phase === 'copying' ? 'Copying files' : 'Reading tags'}
        </p>
        <ProgressBar value={ratio} label="Import progress" className="mt-2" />
        <p className="mt-1.5 truncate text-2xs text-muted">
          {importing.copied} of {importing.total}
          {importing.currentFile ? ` — ${importing.currentFile}` : ''}
        </p>
      </div>
    );
  }

  if (!scan) return null;

  const ratio =
    scan.phase === 'listing'
      ? 0
      : scan.total > 0
        ? scan.processed / scan.total
        : 1;

  const phaseLabel: Record<typeof scan.phase, string> = {
    listing: 'Looking for music',
    reading: 'Reading tags',
    pruning: 'Tidying up',
    aggregating: 'Building albums',
    done: 'Finishing',
  };

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{phaseLabel[scan.phase]}</p>
        <IconButton label="Cancel scan" size={22} onClick={cancel}>
          <X className="h-3 w-3" />
        </IconButton>
      </div>
      <ProgressBar
        value={ratio}
        label="Scan progress"
        className="mt-2"
        // No determinate total during the listing phase; show it as barely begun
        // rather than pretending to know.
        tone="accent"
      />
      <p className="mt-1.5 text-2xs text-muted">
        {scan.phase === 'listing'
          ? `${formatCount(scan.filesSeen)} files found`
          : `${formatCount(scan.processed)} of ${formatCount(scan.total)} read`}
      </p>
      {(scan.added > 0 || scan.skipped > 0) && (
        <p className="mt-0.5 text-2xs text-subtle">
          {scan.added > 0 && `+${formatCount(scan.added)} new`}
          {scan.added > 0 && scan.skipped > 0 && ' · '}
          {scan.skipped > 0 && `${formatCount(scan.skipped)} unchanged`}
        </p>
      )}
    </div>
  );
}
