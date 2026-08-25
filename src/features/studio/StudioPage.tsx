/**
 * Audio Studio (spec §18, §19).
 *
 * Separation is opt-in, one track at a time, and only ever when the user presses
 * the button (spec §4). The page is honest about the dependency: if the local
 * service is not running, it says so and explains how to start it rather than
 * showing controls that would fail.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  Mic2,
  Play,
  ServerCrash,
  Upload,
  X,
} from 'lucide-react';
import {
  cancelJob,
  listJobs,
  probeService,
  STEM_NAMES,
  submitFile,
  waitForJob,
  type JobState,
  type ServiceInfo,
  type StemName,
} from '@core/studio/client';
import { openTrackFile } from '@core/platform';
import { recentlyAdded } from '@core/db/repositories/tracks';
import { formatBytes, formatCount } from '@core/utils';
import { usePlayer } from '@state/playerStore';
import { useUi } from '@state/uiStore';
import type { Track } from '@core/types';
import { Artwork } from '@ui/Artwork';
import { Button, Chip, ProgressBar, Spinner, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';
import { StemMixer } from './StemMixer';

/** Four stems is the default model; six needs `htdemucs_6s` and is slower. */
const DEFAULT_STEMS: StemName[] = ['vocals', 'drums', 'bass', 'other'];

export function StudioPage() {
  const currentTrack = usePlayer((state) => state.track);
  const toast = useUi((state) => state.toast);

  const [service, setService] = useState<ServiceInfo | null | 'checking'>('checking');
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [active, setActive] = useState<JobState | null>(null);
  const [selectedStems, setSelectedStems] = useState<StemName[]>(DEFAULT_STEMS);
  const [uploadFraction, setUploadFraction] = useState(0);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Track[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Probe once on mount. No polling: if the service starts later, the user can
  // press "Check again" — polling a service that is usually absent is exactly
  // the idle background work spec §37 rules out.
  const probe = useCallback(async () => {
    setService('checking');
    const info = await probeService();
    setService(info);
    if (info) setJobs(await listJobs().catch(() => []));
  }, []);

  useEffect(() => {
    void probe();
    void recentlyAdded(12).then(setRecent);
  }, [probe]);

  /**
   * @param filename Real filename with its extension — the server reads the
   *   format from it.
   * @param displayName What to show in the UI.
   */
  const separate = useCallback(
    async (blob: Blob, filename: string, displayName: string) => {
      setBusy(true);
      setUploadFraction(0);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { jobId, reused } = await submitFile(blob, filename, {
          stems: selectedStems,
          displayName,
          signal: controller.signal,
          onUploadProgress: setUploadFraction,
        });

        const finished = await waitForJob(
          jobId,
          (state) => setActive(state),
          controller.signal,
        );

        setActive(finished);
        setJobs(await listJobs().catch(() => []));

        if (finished.status === 'complete' && reused) {
          toast(`“${displayName}” was already separated — reusing those stems.`, {
            kind: 'success',
          });
        } else {
          toast(
            finished.status === 'complete'
              ? `Separated “${displayName}” into ${finished.stems.length} stems.`
              : `Separation failed: ${finished.error ?? 'unknown error'}`,
            { kind: finished.status === 'complete' ? 'success' : 'error' },
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          toast('Separation cancelled.', { kind: 'info' });
        } else {
          toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setUploadFraction(0);
      }
    },
    [selectedStems, toast],
  );

  const separateTrack = useCallback(
    async (track: Track) => {
      const file = await openTrackFile(track);
      if (!file) {
        toast(`“${track.title}” could not be opened. The folder may need reconnecting.`, {
          kind: 'error',
        });
        return;
      }
      // `track.filename` keeps the extension; the pretty name is just a label.
      await separate(file, track.filename, `${track.artist} - ${track.title}`);
    },
    [separate, toast],
  );

  return (
    <div className="mx-scroll flex-1">
      <PageHeader
        eyebrow="Tools"
        title="Audio Studio"
        subtitle="Split a track into vocals, drums, bass and more — then remix, mute and export."
        actions={<ServiceBadge service={service} onRecheck={() => void probe()} />}
      />

      <div className="space-y-4 px-4 pb-16 sm:px-6">
        {/* Service missing: explain, do not pretend. */}
        {service === null && <ServiceMissing onRecheck={() => void probe()} />}

        {service !== null && service !== 'checking' && (
          <>
            {/* Stem selection */}
            <section className="rounded-panel border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">What to separate</h2>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Fewer stems is faster. Guitar and piano need the six-stem model and roughly double
                the processing time.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STEM_NAMES.map((stem) => {
                  const supported = service.availableStems.includes(stem);
                  const selected = selectedStems.includes(stem);
                  return (
                    <button
                      key={stem}
                      type="button"
                      disabled={!supported || busy}
                      aria-pressed={selected}
                      onClick={() =>
                        setSelectedStems((current) =>
                          current.includes(stem)
                            ? current.filter((name) => name !== stem)
                            : [...current, stem],
                        )
                      }
                      className={cx(
                        'h-8 rounded-lg border px-3 text-xs font-medium capitalize transition',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                        selected
                          ? 'border-accent bg-accent/12 text-accent'
                          : 'border-line bg-bg text-muted hover:text-text',
                      )}
                      title={supported ? undefined : 'This stem needs the six-stem model'}
                    >
                      {stem}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Sources */}
            <section className="rounded-panel border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Choose a track</h2>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!currentTrack || busy || selectedStems.length === 0}
                  onClick={() => currentTrack && void separateTrack(currentTrack)}
                >
                  <Mic2 className="h-4 w-4" />
                  {currentTrack ? `Separate “${currentTrack.title}”` : 'Nothing playing'}
                </Button>

                <Button
                  variant="secondary"
                  disabled={busy || selectedStems.length === 0}
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'audio/*';
                    input.addEventListener('change', () => {
                      const file = input.files?.[0];
                      if (file) {
                        void separate(file, file.name, file.name.replace(/\.[^.]+$/, ''));
                      }
                    });
                    input.click();
                  }}
                >
                  <Upload className="h-4 w-4" />
                  Upload a file
                </Button>
              </div>

              {/* Quick pick from the library */}
              {recent.length > 0 && (
                <>
                  <p className="mt-5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                    Recently added
                  </p>
                  <div className="mx-scroll -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-2">
                    {recent.map((track) => (
                      <button
                        key={track.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void separateTrack(track)}
                        className="flex w-28 shrink-0 flex-col gap-1.5 text-left disabled:opacity-50"
                      >
                        <Artwork
                          artworkId={track.artworkId}
                          name={track.album}
                          size={112}
                          rounded="lg"
                          decorative
                        />
                        <span className="mx-clamp-2 text-2xs font-medium leading-snug">
                          {track.title}
                        </span>
                        <span className="-mt-1 truncate text-2xs text-muted">{track.artist}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* Progress */}
            {(busy || active) && (
              <JobProgress
                job={active}
                uploadFraction={uploadFraction}
                onCancel={() => {
                  abortRef.current?.abort();
                  if (active) void cancelJob(active.jobId).catch(() => undefined);
                }}
              />
            )}

            {/* Mixer */}
            {active?.status === 'complete' && <StemMixer job={active} />}

            {/* Earlier jobs */}
            {jobs.length > 0 && (
              <section className="rounded-panel border border-line bg-surface p-4">
                <h2 className="text-sm font-semibold">Earlier separations</h2>
                <ul className="mt-3 space-y-1.5">
                  {jobs
                    .filter((job) => job.jobId !== active?.jobId)
                    .map((job) => (
                      <li
                        key={job.jobId}
                        className="flex items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs">{job.sourceName}</span>
                        <Chip tone={job.status === 'complete' ? 'ok' : job.status === 'failed' ? 'danger' : 'neutral'}>
                          {job.status}
                        </Chip>
                        <span className="shrink-0 text-2xs text-subtle">
                          {formatCount(job.stems.length)} stems
                        </span>
                        {job.status === 'complete' && (
                          <Button size="sm" variant="ghost" onClick={() => setActive(job)}>
                            <Play className="h-3 w-3 fill-current" />
                            Open
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {/* Honest scope note */}
            <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-2xs leading-relaxed text-muted">
              <strong className="text-text">What this is not, yet.</strong> Spec §20–§21 describe a
              waveform editor and a multi-track timeline. Those are Phase 5 and are not built — the
              mixer above is real and complete, but it is a mixer, not a DAW. Nothing here is a
              placeholder for them.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function ServiceBadge({
  service,
  onRecheck,
}: {
  service: ServiceInfo | null | 'checking';
  onRecheck(): void;
}) {
  if (service === 'checking') {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-muted">
        <Spinner size={12} />
        Checking for the studio service…
      </span>
    );
  }

  if (service === null) {
    return (
      <Button size="sm" variant="secondary" onClick={onRecheck}>
        Check again
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-2xs text-muted">
      <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
      Service running
      <Chip tone="neutral">{service.model}</Chip>
      <Chip tone={service.device === 'cuda' ? 'ok' : 'neutral'}>
        <Cpu className="mr-0.5 inline h-2.5 w-2.5" />
        {service.device.toUpperCase()}
      </Chip>
      {!service.modelReady && <Chip tone="warn">model downloads on first run</Chip>}
      <span>· max {formatBytes(service.maxUploadBytes)}</span>
    </span>
  );
}

function ServiceMissing({ onRecheck }: { onRecheck(): void }) {
  return (
    <section className="rounded-panel border border-warn/40 bg-warn/10 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ServerCrash className="h-4 w-4 text-warn" />
        The studio service is not running
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Stem separation uses Demucs, a machine-learning model far too heavy to run in a browser tab.
        MusiX runs it as a small service on your own machine — audio never leaves your computer, and
        the rest of MusiX works perfectly without it.
      </p>

      <div className="mt-3 rounded-lg border border-line bg-bg p-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">Start it</p>
        <pre className="mx-scroll mt-2 overflow-x-auto text-2xs leading-relaxed text-text">
          <code>{`cd backend
pip install -r requirements.txt
python main.py`}</code>
        </pre>
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-muted">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
        The first run downloads the model — roughly 2 GB, once. FFmpeg must also be on your PATH.
      </p>

      <Button className="mt-4" variant="secondary" onClick={onRecheck}>
        Check again
      </Button>
    </section>
  );
}

function JobProgress({
  job,
  uploadFraction,
  onCancel,
}: {
  job: JobState | null;
  uploadFraction: number;
  onCancel(): void;
}) {
  const uploading = !job && uploadFraction > 0 && uploadFraction < 1;
  const fraction = uploading ? uploadFraction : (job?.progress ?? 0) / 100;

  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <h2 className="text-sm font-semibold">
          {uploading ? 'Uploading' : (job?.stage ?? 'Preparing')}
        </h2>
        <span className="ml-auto text-xs tabular-nums text-muted">
          {Math.round(fraction * 100)}%
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>

      <ProgressBar value={fraction} label="Separation progress" className="mt-3" />

      {job?.status === 'failed' && (
        <p className="mt-2 flex items-start gap-1.5 text-2xs text-danger">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {job.error}
        </p>
      )}

      <p className="mt-2 text-2xs text-subtle">
        Separation is CPU-intensive — expect roughly one to three minutes per song without a GPU.
      </p>
    </section>
  );
}
