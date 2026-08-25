/**
 * First run (spec §43 steps 1–4).
 *
 * The one screen where the desktop/mobile split has to be explained rather than
 * hidden, because the two paths behave differently and the user deserves to
 * know which one they are getting *before* they pick files. Spec §32 is
 * privacy-first; being straight about where the bytes go is part of that.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, FolderOpen, Loader2, ShieldCheck, Upload, WifiOff, Zap } from 'lucide-react';
import { capabilities, importStrategy, importStrategyExplanation } from '@core/platform';
import { formatCount } from '@core/utils';
import { useLibrary } from '@state/libraryStore';
import { useUi } from '@state/uiStore';
import { Button } from '@ui/primitives';

export function WelcomePage() {
  const addFolder = useLibrary((state) => state.addFolder);
  const addFiles = useLibrary((state) => state.addFiles);
  const importing = useLibrary((state) => state.importing);
  const scan = useLibrary((state) => state.scan);
  const counts = useLibrary((state) => state.counts);
  const sources = useLibrary((state) => state.sources);
  const toast = useUi((state) => state.toast);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const canPickFolder = capabilities().directoryPicker;
  const strategy = importStrategy();
  const working = busy || importing !== null || scan !== null;

  const run = async (action: () => Promise<{ added: boolean; message?: string }>) => {
    setBusy(true);
    try {
      const result = await action();
      if (result.message) toast(result.message, { kind: 'warn' });
      if (result.added) navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-scroll flex-1">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-6 py-12">
        <div className="mb-8">
          <span className="mb-5 flex h-12 w-12 items-end justify-center gap-1 rounded-xl bg-accent/15 pb-3">
            <span className="h-6 w-1 rounded-full bg-accent" />
            <span className="h-3.5 w-1 rounded-full bg-accent" />
            <span className="h-5 w-1 rounded-full bg-accent" />
            <span className="h-7 w-1 rounded-full bg-accent" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Your music, on your device</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            MusiX reads the music you already own and builds a library you can browse, search and
            play with no internet connection. Nothing is uploaded, and no account is needed.
          </p>
        </div>

        {/* Promises, all of which this build actually keeps. */}
        <ul className="mb-8 grid gap-3 sm:grid-cols-3">
          <Pledge icon={<WifiOff className="h-4 w-4" />} title="Works offline">
            Once scanned, everything runs with the network off.
          </Pledge>
          <Pledge icon={<ShieldCheck className="h-4 w-4" />} title="Stays private">
            No uploads, no analytics, no telemetry.
          </Pledge>
          <Pledge icon={<Zap className="h-4 w-4" />} title="Stays quiet">
            Scans only when you ask; idles at near-zero CPU.
          </Pledge>
        </ul>

        {/* The import choice */}
        <div className="rounded-panel border border-line bg-surface p-5">
          <h2 className="text-base font-semibold">Add your music</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{importStrategyExplanation()}</p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {canPickFolder ? (
              <Button
                variant="primary"
                size="lg"
                className="flex-1"
                disabled={working}
                loading={working}
                onClick={() => void run(addFolder)}
              >
                <FolderOpen className="h-4 w-4" />
                Choose a music folder
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                className="flex-1"
                disabled={working}
                loading={working}
                onClick={() => void run(() => addFiles({ folder: true }))}
              >
                <FolderOpen className="h-4 w-4" />
                Choose a folder
              </Button>
            )}

            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              disabled={working}
              onClick={() => void run(() => addFiles({ folder: false }))}
            >
              <Upload className="h-4 w-4" />
              Pick individual files
            </Button>
          </div>

          {strategy === 'files' && (
            <p className="mt-3 rounded-lg border border-line bg-bg p-2.5 text-2xs leading-relaxed text-muted">
              <strong className="text-text">Note for this browser:</strong> Chrome or Edge on a
              desktop can index a folder in place, leaving your files untouched. Here, the files you
              pick are copied into MusiX’s private storage so they survive a reload — the original
              files are never modified or moved.
            </p>
          )}

          {/* Live progress */}
          {importing && (
            <div className="mt-4 flex items-center gap-2.5 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {importing.phase === 'copying'
                ? `Copying ${importing.copied} of ${importing.total}…`
                : 'Reading tags…'}
            </div>
          )}
          {scan && (
            <div className="mt-4 flex items-center gap-2.5 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {scan.phase === 'listing'
                ? `${formatCount(scan.filesSeen)} files found…`
                : `Read ${formatCount(scan.processed)} of ${formatCount(scan.total)}…`}
            </div>
          )}
        </div>

        {/* Already has music: offer a way back in. */}
        {sources.length > 0 && (
          <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs text-muted">
              <Check className="mr-1.5 inline h-3.5 w-3.5 text-ok" />
              {formatCount(counts.tracks)} tracks in your library
            </p>
            <Button size="sm" onClick={() => navigate('/')}>
              Open library
            </Button>
          </div>
        )}

        <p className="mt-8 text-2xs leading-relaxed text-subtle">
          Supported formats: MP3, FLAC, WAV, M4A/ALAC, AAC, OGG, Opus and AIFF. MusiX reads tags,
          artwork and embedded lyrics directly from the files.
        </p>
      </div>
    </div>
  );
}

function Pledge({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-xl border border-line bg-surface p-3.5">
      <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-lg bg-accent/12 text-accent">
        {icon}
      </span>
      <p className="text-xs font-semibold text-text">{title}</p>
      <p className="mt-0.5 text-2xs leading-relaxed text-muted">{children}</p>
    </li>
  );
}
