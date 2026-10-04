/**
 * "Scan phone music" — the Android app's way of adding music.
 *
 * Three steps, each one visible: ask for the audio permission (explaining what
 * to do if Android will no longer show the dialog), list what MediaStore found
 * grouped by folder, and let the user untick folders before anything is added.
 * Voice notes, call recordings and ringtones start unticked, because a library
 * full of WhatsApp voice notes is the classic first-run disappointment.
 *
 * Used on the welcome screen and in Settings › Music folders.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, Loader2, Settings as SettingsIcon, Smartphone } from 'lucide-react';
import {
  ensureMusicPermission,
  folderLabel,
  musicLibrary,
  previewPhoneFolders,
  type FolderSummary,
  type NativePermission,
} from '@core/platform';
import { describeError } from '@core/logger';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useUi } from '@state/uiStore';
import { Button, cx } from '@ui/primitives';

type Phase =
  | { step: 'idle' }
  | { step: 'asking' }
  | { step: 'permission'; state: Exclude<NativePermission, 'granted'> }
  | { step: 'scanning' }
  | { step: 'choose'; folders: FolderSummary[] }
  | { step: 'adding' }
  | { step: 'failed'; message: string };

export interface PhoneMusicPickerProps {
  /** Current exclusions when changing an existing phone source. */
  initialExcluded?: readonly string[];
  /** Label of the button that starts the flow. */
  startLabel?: string;
  /**
   * Also offer "Choose music folders" next to the scan button. The scan then
   * adds everything straight away (skipping junk folders), and choosing opens
   * the folder list with nothing ticked so the user picks their own.
   */
  offerChoice?: boolean;
  /** Called after songs were added or the folder choice was saved. */
  onDone?: (added: boolean) => void;
  /** Lets the parent offer a way back out of the folder list. */
  onCancel?: () => void;
  /** Start straight away (the parent's button was the click). */
  autoStart?: boolean;
  className?: string;
}

export function PhoneMusicPicker({
  initialExcluded,
  startLabel = 'Scan phone music',
  onDone,
  onCancel,
  autoStart = false,
  offerChoice = false,
  className,
}: PhoneMusicPickerProps) {
  const addPhoneMusic = useLibrary((state) => state.addPhoneMusic);
  const scan = useLibrary((state) => state.scan);
  const toast = useUi((state) => state.toast);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // "Try again" after a permission refusal repeats whichever button was used.
  const lastMode = useRef<'auto' | 'choose' | 'review'>('review');

  /**
   * `auto` adds every non-junk folder without showing the list; `choose` shows
   * the list empty; `review` (the default) shows it pre-ticked.
   */
  const start = async (mode: 'auto' | 'choose' | 'review' = 'review') => {
    lastMode.current = mode;
    setPhase({ step: 'asking' });
    try {
      const permission = await ensureMusicPermission();
      if (permission !== 'granted') {
        setPhase({ step: 'permission', state: permission });
        return;
      }
      setPhase({ step: 'scanning' });
      const folders = await previewPhoneFolders();
      if (mode === 'auto' && folders.length > 0) {
        await add(folders.filter((folder) => folder.junk).map((folder) => folder.folder));
        return;
      }
      const excluded = initialExcluded ? new Set(initialExcluded) : null;
      setSelected(
        new Set(
          mode === 'choose'
            ? []
            : folders
                .filter((folder) => (excluded ? !excluded.has(folder.folder) : !folder.junk))
                .map((folder) => folder.folder),
        ),
      );
      setPhase({ step: 'choose', folders });
    } catch (error) {
      setPhase({ step: 'failed', message: describeError(error) });
    }
  };

  // Kick off once when the parent already received the click. The ref keeps
  // StrictMode's double effect run from asking twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void start();
    // `start` is recreated every render; this must run once only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const confirm = (folders: FolderSummary[]) =>
    add(folders.filter((folder) => !selected.has(folder.folder)).map((f) => f.folder));

  const add = async (excluded: string[]) => {
    setPhase({ step: 'adding' });
    const result = await addPhoneMusic(excluded);
    if (result.message) toast(result.message, { kind: result.added ? 'info' : 'warn' });
    setPhase({ step: 'idle' });
    onDone?.(result.added);
  };

  const toggle = (folder: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  if (phase.step === 'choose') {
    return (
      <FolderChoice
        folders={phase.folders}
        selected={selected}
        updating={initialExcluded !== undefined}
        onToggle={toggle}
        onSetAll={(all) => setSelected(new Set(all ? phase.folders.map((f) => f.folder) : []))}
        onConfirm={() => void confirm(phase.folders)}
        onCancel={() => {
          setPhase({ step: 'idle' });
          onCancel?.();
        }}
        className={className}
      />
    );
  }

  const busy = phase.step === 'asking' || phase.step === 'scanning' || phase.step === 'adding';

  return (
    <div className={className}>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy || scan !== null}
        loading={busy}
        onClick={() =>
          void start(
            phase.step === 'permission' ? lastMode.current : offerChoice ? 'auto' : 'review',
          )
        }
      >
        <Smartphone className="h-4 w-4" />
        {phase.step === 'permission' ? 'Try again' : startLabel}
      </Button>

      {offerChoice && phase.step !== 'permission' && (
        <Button
          variant="secondary"
          size="lg"
          className="mt-2 w-full"
          disabled={busy || scan !== null}
          onClick={() => void start('choose')}
        >
          <FolderOpen className="h-4 w-4" />
          Choose music folders
        </Button>
      )}

      {phase.step === 'scanning' && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Looking for music on this phone…
        </p>
      )}

      {phase.step === 'permission' && <PermissionHelp state={phase.state} />}

      {phase.step === 'failed' && (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Could not read the music library: {phase.message}
        </p>
      )}
    </div>
  );
}

function PermissionHelp({ state }: { state: Exclude<NativePermission, 'granted'> }) {
  if (state !== 'denied') {
    return (
      <p className="mt-3 rounded-lg border border-line bg-bg p-2.5 text-xs leading-relaxed text-muted">
        MusiX needs the <strong className="text-text">Music and audio</strong> permission to find
        the songs on this phone. It only reads them — nothing is changed, moved or uploaded. Tap{' '}
        <strong className="text-text">Try again</strong> and choose <strong className="text-text">Allow</strong>.
      </p>
    );
  }
  // "Don't ask again": Android no longer shows the dialog, only Settings can help.
  return (
    <div className="mt-3 rounded-lg border border-warn/40 bg-bg p-2.5 text-xs leading-relaxed text-muted">
      <p>
        Android is no longer showing the permission request for MusiX. To allow it: open{' '}
        <strong className="text-text">Settings › Apps › MusiX › Permissions</strong>, tap{' '}
        <strong className="text-text">Music and audio</strong> (or{' '}
        <strong className="text-text">Files and media</strong> on older phones) and choose{' '}
        <strong className="text-text">Allow</strong>. Then come back and tap Try again.
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => void musicLibrary.openSettings().catch(() => undefined)}
      >
        <SettingsIcon className="h-3.5 w-3.5" />
        Open app settings
      </Button>
    </div>
  );
}

function FolderChoice({
  folders,
  selected,
  updating,
  onToggle,
  onSetAll,
  onConfirm,
  onCancel,
  className,
}: {
  folders: FolderSummary[];
  selected: ReadonlySet<string>;
  updating: boolean;
  onToggle: (folder: string) => void;
  onSetAll: (all: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const songCount = useMemo(
    () => folders.reduce((sum, f) => sum + (selected.has(f.folder) ? f.trackCount : 0), 0),
    [folders, selected],
  );

  if (folders.length === 0) {
    return (
      <div className={className}>
        <p className="text-sm text-muted">
          No music was found on this phone. Copy some songs into the Music folder, then scan again.
        </p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={onCancel}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Found music in {formatCount(folders.length)} folder{folders.length === 1 ? '' : 's'}.
          Tick the folders that hold your music.
        </p>
        <button
          type="button"
          className="shrink-0 text-xs text-accent hover:underline"
          onClick={() => onSetAll(selected.size < folders.length)}
        >
          {selected.size < folders.length ? 'Select all' : 'Select none'}
        </button>
      </div>

      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg">
        {folders.map((folder) => (
          <li key={folder.folder}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-accent"
                checked={selected.has(folder.folder)}
                onChange={() => onToggle(folder.folder)}
              />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-sm', folder.folder === '' && 'italic')}>
                  {folderLabel(folder.folder)}
                </span>
                {folder.junk && (
                  <span className="block text-2xs text-subtle">
                    Looks like recordings or system sounds
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {formatCount(folder.trackCount)}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          disabled={!updating && songCount === 0}
          onClick={onConfirm}
        >
          {updating
            ? `Save and rescan (${formatCount(songCount)} songs)`
            : `Add ${formatCount(songCount)} song${songCount === 1 ? '' : 's'}`}
        </Button>
        <Button variant="secondary" size="lg" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-subtle">
        Songs are read where they are; nothing is copied. Folders you add to later are picked up
        when you rescan.
      </p>
    </div>
  );
}
