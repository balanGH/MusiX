/**
 * The stem mixer (spec §18 §19).
 *
 * The single most important thing here is **synchronisation**. Five separate
 * `<audio>` elements each told to `play()` will drift apart within seconds —
 * they start at slightly different times and their clocks are independent. That
 * is what made the previous version unusable.
 *
 * The fix: one element is the clock. Every frame, the others are checked
 * against it and nudged back if they have drifted more than a few milliseconds.
 * Volume, mute and solo run through Web Audio gain nodes rather than element
 * volume, so the mix is sample-accurate and the karaoke/acapella presets are
 * instant.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Headphones, Mic2, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import {
  claimAudioSource,
  notifyAudioSourceChanged,
  registerAudioSource,
  unregisterAudioSource,
} from '@core/audio/exclusivity';
import { clamp, formatDuration, sliderToGain } from '@core/utils';
import { stemUrl, type JobState, type StemName } from '@core/studio/client';
import { Button, IconButton, Slider, cx } from '@ui/primitives';

/** Drift above this is corrected; below it, leave well alone. */
const DRIFT_TOLERANCE_SEC = 0.035;

interface StemChannel {
  name: StemName;
  element: HTMLAudioElement;
  gain: GainNode;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export type MixPreset = 'original' | 'karaoke' | 'acapella' | 'reduce-vocals';

export function StemMixer({ job }: { job: JobState }) {
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  // While dragging, the slider shows this instead of the live `position` —
  // otherwise the sync loop's per-frame setPosition(now) fights the drag and
  // snaps the thumb back before a release can ever register a seek.
  const [dragging, setDragging] = useState<number | null>(null);
  const [levels, setLevels] = useState<Record<string, { volume: number; muted: boolean; solo: boolean }>>(
    {},
  );

  const contextRef = useRef<AudioContext | null>(null);
  const channelsRef = useRef<StemChannel[]>([]);
  const frameRef = useRef(0);
  // Mirrors `playing` for the exclusivity handle below, which is registered
  // once on mount and would otherwise close over a stale `playing` from that
  // first render — refs read live, state closures do not.
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const stems = useMemo(() => job.stems.map((stem) => stem.name), [job.stems]);

  /** Build the graph once per job. */
  useEffect(() => {
    if (job.status !== 'complete' || job.stems.length === 0) return;

    const context = new AudioContext({ latencyHint: 'playback' });
    contextRef.current = context;

    const master = context.createGain();
    master.connect(context.destination);

    const channels: StemChannel[] = job.stems.map((stem) => {
      const element = new Audio(stemUrl(job.jobId, stem.name));
      element.preload = 'auto';
      element.crossOrigin = 'anonymous';
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = sliderToGain(1);
      source.connect(gain);
      gain.connect(master);
      return { name: stem.name, element, gain, volume: 1, muted: false, solo: false };
    });

    channelsRef.current = channels;
    setLevels(
      Object.fromEntries(channels.map((c) => [c.name, { volume: 1, muted: false, solo: false }])),
    );

    // Wait for every stem to be ready; starting before that guarantees drift.
    let remaining = channels.length;
    const onReady = () => {
      remaining -= 1;
      if (remaining <= 0) {
        setReady(true);
        setDuration(Math.max(...channels.map((c) => c.element.duration || 0)));
      }
    };
    for (const channel of channels) {
      if (channel.element.readyState >= HTMLMediaElement.HAVE_METADATA) onReady();
      else channel.element.addEventListener('loadedmetadata', onReady, { once: true });
    }

    return () => {
      cancelAnimationFrame(frameRef.current);
      for (const channel of channels) {
        channel.element.pause();
        channel.element.removeAttribute('src');
        channel.element.load();
      }
      channelsRef.current = [];
      void context.close().catch(() => undefined);
      contextRef.current = null;
      setReady(false);
      setPlaying(false);
    };
  }, [job.jobId, job.status, job.stems]);

  /**
   * The sync loop.
   *
   * Channel 0 is the clock. Any channel more than `DRIFT_TOLERANCE_SEC` away is
   * snapped back. Runs only while playing, so a paused mixer costs nothing.
   */
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(frameRef.current);
      return;
    }

    const tick = () => {
      const channels = channelsRef.current;
      const clock = channels[0];
      if (clock) {
        const now = clock.element.currentTime;
        setPosition(now);
        for (let i = 1; i < channels.length; i++) {
          const element = channels[i]!.element;
          if (Math.abs(element.currentTime - now) > DRIFT_TOLERANCE_SEC) {
            element.currentTime = now;
          }
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [playing]);

  /** Recompute every gain from volume, mute and the solo state of the whole mix. */
  const applyGains = useCallback((next: typeof levels) => {
    const context = contextRef.current;
    const anySolo = Object.values(next).some((level) => level.solo);
    for (const channel of channelsRef.current) {
      const level = next[channel.name];
      if (!level) continue;
      const audible = level.solo || (!anySolo && !level.muted);
      const target = audible ? sliderToGain(level.volume) : 0;
      if (context) channel.gain.gain.setTargetAtTime(target, context.currentTime, 0.01);
      else channel.gain.gain.value = target;
    }
  }, []);

  const update = useCallback(
    (name: StemName, patch: Partial<{ volume: number; muted: boolean; solo: boolean }>) => {
      setLevels((current) => {
        const next = { ...current, [name]: { ...current[name]!, ...patch } };
        applyGains(next);
        return next;
      });
    },
    [applyGains],
  );

  const applyPreset = useCallback(
    (preset: MixPreset) => {
      setLevels((current) => {
        const next = Object.fromEntries(
          Object.entries(current).map(([name, level]) => {
            const isVocals = name === 'vocals';
            const volume =
              preset === 'original'
                ? 1
                : preset === 'karaoke'
                  ? isVocals
                    ? 0
                    : 1
                  : preset === 'acapella'
                    ? isVocals
                      ? 1
                      : 0
                    : // reduce-vocals: duck rather than remove, which sounds far
                      // more natural for a sing-along than a hard mute.
                      isVocals
                      ? 0.28
                      : 1;
            return [name, { ...level, volume, muted: false, solo: false }];
          }),
        );
        applyGains(next);
        return next;
      });
    },
    [applyGains],
  );

  /** Pause every channel without touching the AudioContext itself. */
  const pauseAll = useCallback(() => {
    for (const channel of channelsRef.current) channel.element.pause();
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const toggle = useCallback(async () => {
    const context = contextRef.current;
    if (!context) return;
    if (context.state === 'suspended') await context.resume();

    if (playing) {
      pauseAll();
      notifyAudioSourceChanged();
      return;
    }

    // Claimed before the elements actually start: the main player (or
    // anything else) must be silenced first, not after a race with it.
    claimAudioSource('mixer');

    // Align before starting, then start together.
    const clock = channelsRef.current[0];
    const start = clock?.element.currentTime ?? 0;
    for (const channel of channelsRef.current) channel.element.currentTime = start;
    await Promise.all(channelsRef.current.map((channel) => channel.element.play()));
    playingRef.current = true;
    setPlaying(true);
    notifyAudioSourceChanged();
  }, [playing, pauseAll]);

  const seek = useCallback((seconds: number) => {
    for (const channel of channelsRef.current) channel.element.currentTime = seconds;
    setPosition(seconds);
    setDragging(null);
    // Only matters while paused — the sync loop already reports live position
    // every frame while playing — but it's what lets the lyrics view notice a
    // paused seek made from its own "click a line to jump there" handler.
    notifyAudioSourceChanged();
  }, []);

  /**
   * Make this mixer a source other code can discover, stop, seek and poll —
   * registered once so the main player (and, through it, a keyboard shortcut
   * or an OS media key) can silence this mixer without knowing it exists, and
   * so the lyrics view can follow it during karaoke playback (spec §14).
   */
  useEffect(() => {
    registerAudioSource('mixer', {
      stop: pauseAll,
      seek,
      getPositionSec: () => channelsRef.current[0]?.element.currentTime ?? 0,
      isPlaying: () => playingRef.current,
    });
    return () => unregisterAudioSource('mixer');
  }, [pauseAll, seek]);

  if (job.status !== 'complete') return null;

  const anySolo = Object.values(levels).some((level) => level.solo);
  const shownPosition = dragging ?? position;

  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Stem mixer</h3>
        <span className="text-2xs text-subtle">{job.sourceName}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => applyPreset('original')}>
            <RotateCcw className="h-3.5 w-3.5" />
            Original
          </Button>
          <Button size="sm" variant="secondary" onClick={() => applyPreset('karaoke')}>
            <Headphones className="h-3.5 w-3.5" />
            Karaoke
          </Button>
          <Button size="sm" variant="secondary" onClick={() => applyPreset('acapella')}>
            <Mic2 className="h-3.5 w-3.5" />
            Acapella
          </Button>
          <Button size="sm" variant="ghost" onClick={() => applyPreset('reduce-vocals')}>
            Reduce vocals
          </Button>
        </div>
      </div>

      {/* Transport */}
      <div className="mt-4 flex items-center gap-3">
        <IconButton
          label={playing ? 'Pause the mix' : 'Play the mix'}
          size={42}
          variant="accent"
          disabled={!ready}
          onClick={() => void toggle()}
        >
          {playing ? (
            <Pause className="h-5 w-5 fill-current" />
          ) : (
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          )}
        </IconButton>

        <span className="w-11 shrink-0 text-right text-2xs tabular-nums text-subtle">
          {formatDuration(shownPosition * 1000)}
        </span>
        <Slider
          label="Seek the mix"
          value={shownPosition}
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.1}
          onValueChange={setDragging}
          onCommit={seek}
          className="flex-1"
          disabled={!ready}
        />
        <span className="w-11 shrink-0 text-2xs tabular-nums text-subtle">
          {formatDuration(duration * 1000)}
        </span>
      </div>

      {!ready && <p className="mt-2 text-2xs text-muted">Loading stems…</p>}

      {/* Channels */}
      <ul className="mt-4 space-y-2">
        {stems.map((name) => {
          const level = levels[name];
          if (!level) return null;
          const dimmed = anySolo && !level.solo;

          return (
            <li
              key={name}
              className={cx(
                'flex items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2 transition',
                dimmed && 'opacity-50',
              )}
            >
              <span className="w-16 shrink-0 text-xs font-medium capitalize">{name}</span>

              <IconButton
                label={level.muted ? `Unmute ${name}` : `Mute ${name}`}
                size={28}
                active={level.muted}
                onClick={() => update(name, { muted: !level.muted })}
              >
                {level.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </IconButton>

              <button
                type="button"
                aria-pressed={level.solo}
                onClick={() => update(name, { solo: !level.solo })}
                className={cx(
                  'h-7 shrink-0 rounded-md px-2 text-2xs font-semibold transition',
                  level.solo
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface text-muted hover:bg-surface-hover hover:text-text',
                )}
              >
                SOLO
              </button>

              <Slider
                label={`${name} volume`}
                value={level.volume}
                min={0}
                max={1}
                step={0.01}
                onValueChange={(value) => update(name, { volume: clamp(value, 0, 1) })}
                className="flex-1"
              />

              <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-subtle">
                {Math.round(level.volume * 100)}%
              </span>

              <a
                href={stemUrl(job.jobId, name)}
                download={`${job.sourceName} - ${name}.mp3`}
                aria-label={`Download the ${name} stem`}
                title={`Download the ${name} stem`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-hover hover:text-text"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-2xs leading-relaxed text-subtle">
        The stems play from the local studio service and are kept in sync against the first channel
        every frame. Your original file was not modified — separation always writes new files.
      </p>
    </div>
  );
}
