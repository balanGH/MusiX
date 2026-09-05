/**
 * Settings (spec §32, §33, §38, §39).
 *
 * The privacy section deserves a note: the three "online" switches are off by
 * default and, in this build, are also *inert* — Phase 2 adds the MusicBrainz
 * and Cover Art Archive lookups they gate. Rather than hide them or wire them
 * to nothing, they are shown disabled with the reason stated, which is what
 * spec §41 asks for.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Database,
  FolderOpen,
  HardDrive,
  Keyboard,
  Palette,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { deleteDatabase, storageReport, storeCounts, type StorageReport } from '@core/db/database';
import { importedStorageUsage } from '@core/platform';
import { formatBytes, formatCount, formatRelative } from '@core/utils';
import { clearArtworkCache } from '@state/artworkCache';
import { useLibrary } from '@state/libraryStore';
import { ACCENT_CHOICES, useSettings, type ThemeChoice } from '@state/settingsStore';
import { useUi } from '@state/uiStore';
import { pruneOrphanArtwork } from '@core/db/repositories/artwork';
import { clearHistory, countHistory } from '@core/db/repositories/history';
import { SHORTCUTS } from '@app/useKeyboardShortcuts';
import { DownloadFolderSection } from './DownloadFolderSection';
import { Button, Select, Toggle, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';

export function SettingsPage() {
  const settings = useSettings();
  const sources = useLibrary((state) => state.sources);
  const counts = useLibrary((state) => state.counts);
  const forgetSource = useLibrary((state) => state.forgetSource);
  const scanSource = useLibrary((state) => state.scanSource);
  const toast = useUi((state) => state.toast);
  const confirm = useUi((state) => state.requestConfirm);

  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [opfsBytes, setOpfsBytes] = useState(0);
  const [rows, setRows] = useState<Record<string, number>>({});
  const [historyCount, setHistoryCount] = useState(0);

  const refreshStorage = async () => {
    const [report, opfs, counted, history] = await Promise.all([
      storageReport(),
      importedStorageUsage(),
      storeCounts(),
      countHistory(),
    ]);
    setStorage(report);
    setOpfsBytes(opfs);
    setRows(counted);
    setHistoryCount(history);
  };

  useEffect(() => {
    void refreshStorage();
  }, []);

  return (
    <div className="mx-scroll flex-1">
      <PageHeader title="Settings" subtitle="Everything here stays on this device." />

      <div className="space-y-4 px-4 pb-16 sm:px-6">
        {/* ---- Appearance ---- */}
        <Section icon={<Palette className="h-4 w-4" />} title="Appearance">
          <Row label="Theme" description="AMOLED uses true black, which saves power on OLED screens.">
            <Select
              label="Theme"
              value={settings.theme}
              options={[
                { value: 'system', label: 'Match system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'amoled', label: 'AMOLED' },
              ]}
              onChange={(value) => settings.setTheme(value as ThemeChoice)}
            />
          </Row>

          <Row label="Accent colour">
            <div className="flex flex-wrap gap-1.5">
              {ACCENT_CHOICES.map((choice) => (
                <button
                  key={choice.rgb}
                  type="button"
                  aria-label={choice.name}
                  title={choice.name}
                  onClick={() => settings.setAccent(choice.rgb)}
                  style={{ backgroundColor: `rgb(${choice.rgb})` }}
                  className={cx(
                    'h-7 w-7 rounded-full transition',
                    settings.accent === choice.rgb
                      ? 'ring-2 ring-text ring-offset-2 ring-offset-bg'
                      : 'hover:scale-110',
                  )}
                />
              ))}
            </div>
          </Row>

          <Toggle
            label="Colour from album artwork"
            description="Tints the accent using a colour sampled from the current cover. The colour was extracted during the scan, so this costs nothing at playback time."
            checked={settings.dynamicAccent}
            onChange={(checked) => settings.patch({ dynamicAccent: checked })}
          />

          <Row label="List density">
            <Select
              label="List density"
              value={settings.listDensity}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
              onChange={(value) => settings.patch({ listDensity: value })}
            />
          </Row>
        </Section>

        {/* ---- Playback ---- */}
        <Section icon={<HardDrive className="h-4 w-4" />} title="Playback">
          <Toggle
            label="Resume where I left off"
            description="Restores the queue and position when MusiX opens. It never starts playing on its own."
            checked={settings.resumeOnLaunch}
            onChange={(checked) => settings.patch({ resumeOnLaunch: checked })}
          />
          <Row label="Playback speed" description="Pitch is preserved.">
            <Select
              label="Playback speed"
              value={String(settings.playbackRate)}
              options={[
                { value: '0.75', label: '0.75×' },
                { value: '1', label: 'Normal' },
                { value: '1.25', label: '1.25×' },
                { value: '1.5', label: '1.5×' },
                { value: '2', label: '2×' },
              ]}
              onChange={(value) => settings.patch({ playbackRate: Number.parseFloat(value) })}
            />
          </Row>
          <p className="pb-3 text-2xs text-subtle">
            The equaliser, crossfade and volume normalisation live on the{' '}
            <a href="/equalizer" className="text-accent hover:underline">
              Equaliser page
            </a>
            .
          </p>
        </Section>

        {/* ---- Music folders ---- */}
        <Section icon={<FolderOpen className="h-4 w-4" />} title="Music folders">
          {sources.length === 0 ? (
            <p className="py-3 text-sm text-muted">No folders added yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {sources.map((source) => (
                <li key={source.id} className="flex items-center gap-3 py-3">
                  <FolderOpen className="h-4 w-4 shrink-0 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{source.name}</p>
                    <p className="text-2xs text-muted">
                      {source.kind === 'directory' ? 'Indexed in place' : 'Copied into MusiX'} ·{' '}
                      {formatCount(source.trackCount)} tracks ·{' '}
                      {source.lastScanAt ? `scanned ${formatRelative(source.lastScanAt)}` : 'never scanned'}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void scanSource(source.id, 'full')}>
                    Rescan
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove “${source.name}”?`,
                        body:
                          source.kind === 'directory'
                            ? 'MusiX forgets this folder and its tracks. The files on your disk are not touched.'
                            : 'MusiX deletes its copies of these files and forgets the tracks. Your original files are not touched.',
                        preview: [
                          `${formatCount(source.trackCount)} tracks will be removed from the library`,
                          ...(source.kind === 'imported'
                            ? ['MusiX’s copies of these files will be deleted']
                            : ['No files on disk will be changed']),
                        ],
                        confirmLabel: 'Remove folder',
                        destructive: true,
                      });
                      if (!ok) return;
                      await forgetSource(source.id);
                      await refreshStorage();
                      toast(`Removed “${source.name}”.`, { kind: 'success' });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ---- Download folder (only when the studio service is running) ---- */}
        <DownloadFolderSection />

        {/* ---- Privacy ---- */}
        <Section icon={<ShieldCheck className="h-4 w-4" />} title="Privacy">
          <p className="rounded-lg border border-line bg-bg p-3 text-2xs leading-relaxed text-muted">
            MusiX has no accounts, no servers and no analytics. Your music, tags, artwork, lyrics,
            playlists and listening history are stored only in this browser, on this device. The
            switches below control optional lookups that would contact a third party.
          </p>

          <Toggle
            label="Online metadata lookup"
            description="MusicBrainz. Arrives in Phase 2 — the switch is here so the default (off) is visible."
            checked={settings.onlineMetadata}
            onChange={(checked) => settings.patch({ onlineMetadata: checked })}
            disabled
          />
          <Toggle
            label="Online artwork"
            description="Deezer, for a real artist photo when you look one up from their page. Album-art lookup from Cover Art Archive arrives in Phase 2."
            checked={settings.onlineArtwork}
            onChange={(checked) => settings.patch({ onlineArtwork: checked })}
          />
          <Toggle
            label="Online lyrics for downloads"
            description="Looks up lyrics from LRCLIB when you download a song, and embeds them in the file — synced ones scroll with playback in Now Playing. Lyrics already inside your own files always work offline, with or without this."
            checked={settings.onlineLyrics}
            onChange={(checked) => settings.patch({ onlineLyrics: checked })}
          />
        </Section>

        {/* ---- Storage ---- */}
        <Section icon={<Database className="h-4 w-4" />} title="Storage">
          {storage && (
            <div className="py-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">
                  {formatBytes(storage.usedBytes)} used
                  {storage.quotaBytes > 0 && (
                    <span className="text-muted"> of {formatBytes(storage.quotaBytes)}</span>
                  )}
                </span>
                <span
                  className={cx('text-2xs', storage.persisted ? 'text-ok' : 'text-warn')}
                  title={
                    storage.persisted
                      ? 'The browser will not evict your library automatically.'
                      : 'The browser may clear this data under storage pressure.'
                  }
                >
                  {storage.persisted ? 'Persistent' : 'Best-effort'}
                </span>
              </div>
              {opfsBytes > 0 && (
                <p className="mt-1 text-2xs text-muted">
                  {formatBytes(opfsBytes)} of that is audio MusiX copied for imported files.
                </p>
              )}
              {!storage.persisted && (
                <p className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-warn">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  This browser has not granted persistent storage. Installing MusiX as an app, or
                  simply using it a few times, usually earns the grant.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 py-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const result = await pruneOrphanArtwork();
                clearArtworkCache();
                await refreshStorage();
                toast(
                  result.deleted === 0
                    ? 'No unused artwork to clean up.'
                    : `Removed ${formatCount(result.deleted)} unused images, freeing ${formatBytes(
                        result.freedBytes,
                      )}.`,
                  { kind: 'success' },
                );
              }}
            >
              Clean up unused artwork
            </Button>

            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Clear playback history?',
                  body: 'Play counts on tracks are kept; the detailed listening log is deleted.',
                  preview: [`${formatCount(historyCount)} history entries will be removed`],
                  confirmLabel: 'Clear history',
                  destructive: true,
                });
                if (!ok) return;
                await clearHistory();
                await refreshStorage();
                toast('Playback history cleared.', { kind: 'success' });
              }}
            >
              Clear playback history
            </Button>

            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Reset the entire library?',
                  body: 'Deletes the MusiX database: tracks, playlists, favourites, ratings, history, artwork and lyrics. Music files indexed in place are not touched, but files MusiX copied for imported sources are deleted.',
                  preview: [
                    `${formatCount(counts.tracks)} tracks`,
                    `${formatCount(counts.albums)} albums`,
                    `${formatCount(rows.playlists ?? 0)} playlists`,
                    `${formatCount(historyCount)} history entries`,
                  ],
                  confirmLabel: 'Delete everything',
                  destructive: true,
                });
                if (!ok) return;
                await deleteDatabase();
                clearArtworkCache();
                // A full reload is the only honest way to reset every store.
                window.location.href = '/welcome';
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Reset library
            </Button>
          </div>

          {Object.keys(rows).length > 0 && (
            <details className="pb-3">
              <summary className="cursor-pointer text-2xs text-subtle hover:text-muted">
                Database contents
              </summary>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-3">
                {Object.entries(rows)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count]) => (
                    <li key={name} className="flex justify-between gap-2 font-mono text-muted">
                      <span className="truncate">{name}</span>
                      <span className="tabular-nums">{formatCount(count)}</span>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </Section>

        {/* ---- Keyboard ---- */}
        <Section icon={<Keyboard className="h-4 w-4" />} title="Keyboard shortcuts">
          <ul className="grid gap-x-6 gap-y-1.5 py-2 sm:grid-cols-2">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.keys} className="flex items-center justify-between gap-4 text-xs">
                <span className="text-muted">{shortcut.description}</span>
                <kbd className="shrink-0 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-2xs text-text">
                  {shortcut.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface px-4">
      <h2 className="flex items-center gap-2 border-b border-line py-3 text-sm font-semibold">
        <span className="text-subtle">{icon}</span>
        {title}
      </h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
