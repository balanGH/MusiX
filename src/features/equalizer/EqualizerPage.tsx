/**
 * Equaliser (spec §16).
 *
 * The sliders write straight through to the live audio graph, so changes are
 * audible while dragging. The curve behind them is the real combined magnitude
 * response of the filter chain, read from the Web Audio nodes themselves rather
 * than drawn to look plausible.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, SlidersHorizontal, Volume2 } from 'lucide-react';
import { audioEngine, type ReplayGainMode } from '@core/audio/engine';
import {
  EQ_FREQUENCIES,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESETS,
  matchPreset,
  presetBands,
  type EqPresetName,
} from '@core/audio/equalizer';
import { useSettings } from '@state/settingsStore';
import { player } from '@core/playback/controller';
import type { EqBand } from '@core/types';
import { Button, Select, Toggle, cx } from '@ui/primitives';
import { PageHeader } from '@ui/PageHeader';

const PRESET_NAMES = Object.keys(EQ_PRESETS) as EqPresetName[];

export function EqualizerPage() {
  const settings = useSettings();
  const [curve, setCurve] = useState<{ frequency: number; db: number }[]>([]);

  const bands = settings.eqBands;
  const activePreset = useMemo(() => matchPreset(bands) ?? 'Custom', [bands]);

  const applyBands = (next: EqBand[]) => {
    useSettings.setState({ eqBands: next, eqPreset: matchPreset(next) ?? 'Custom' });
    audioEngine.setEqBands(next);
    // Turning a slider is a clear intent to hear the EQ.
    if (!settings.eqEnabled) {
      useSettings.setState({ eqEnabled: true });
      audioEngine.setEqEnabled(true);
    }
  };

  // Read the real response curve whenever the filters change.
  useEffect(() => {
    const equalizer = audioEngine.getEqualizer();
    if (!equalizer) {
      setCurve([]);
      return;
    }
    // A frame's delay lets the parameter ramps settle before sampling.
    const timer = setTimeout(() => setCurve(equalizer.responseCurve(96)), 60);
    return () => clearTimeout(timer);
  }, [bands, settings.eqEnabled, settings.eqPreampDb]);

  return (
    <div className="mx-scroll flex-1">
      <PageHeader
        eyebrow="Playback"
        title="Equaliser"
        subtitle="Ten bands, applied to everything MusiX plays."
        actions={
          <>
            <Select
              label="Preset"
              value={activePreset}
              options={[
                ...(activePreset === 'Custom' ? [{ value: 'Custom' as const, label: 'Custom' }] : []),
                ...PRESET_NAMES.map((name) => ({ value: name, label: name })),
              ]}
              onChange={(value) => {
                if (value === 'Custom') return;
                applyBands(presetBands(value as EqPresetName));
              }}
            />
            <Button
              variant="ghost"
              onClick={() => {
                settings.resetEq();
                audioEngine.setEqBands(presetBands('Flat'));
                audioEngine.setEqPreamp(0);
                audioEngine.setEqEnabled(false);
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </>
        }
      />

      <div className="px-4 pb-12 sm:px-6">
        {/* Enable switch, with the honest note about bypass. */}
        <div className="rounded-panel border border-line bg-surface px-4">
          <Toggle
            label="Enable the equaliser"
            description="When every band sits at 0 dB the filters are disconnected entirely, so a flat EQ costs nothing."
            checked={settings.eqEnabled}
            onChange={(checked) => {
              useSettings.setState({ eqEnabled: checked });
              audioEngine.setEqEnabled(checked);
            }}
          />
        </div>

        {/* Curve + sliders */}
        <div
          className={cx(
            'mt-4 rounded-panel border border-line bg-surface p-4 transition',
            !settings.eqEnabled && 'opacity-60',
          )}
        >
          <ResponseCurve curve={curve} />

          <div className="mt-4 flex items-end justify-between gap-1 sm:gap-3">
            {EQ_FREQUENCIES.map((frequency, index) => (
              <BandSlider
                key={frequency}
                frequency={frequency}
                gainDb={bands[index]?.gainDb ?? 0}
                onChange={(gainDb) => {
                  const next = bands.map((band, position) =>
                    position === index ? { ...band, gainDb } : band,
                  );
                  applyBands(next);
                }}
              />
            ))}
          </div>
        </div>

        {/* Preamp */}
        <div className="mt-4 rounded-panel border border-line bg-surface p-4">
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-subtle" />
            <span className="text-sm font-medium">Preamp</span>
            <span className="ml-auto text-xs tabular-nums text-muted">
              {settings.eqPreampDb > 0 ? '+' : ''}
              {settings.eqPreampDb.toFixed(1)} dB
            </span>
          </div>
          <input
            type="range"
            aria-label="Preamp gain"
            min={-12}
            max={12}
            step={0.5}
            value={settings.eqPreampDb}
            onChange={(event) => {
              const value = Number.parseFloat(event.target.value);
              useSettings.setState({ eqPreampDb: value });
              audioEngine.setEqPreamp(value);
            }}
            className="mx-range mt-3"
            style={{ ['--mx-fill' as string]: `${((settings.eqPreampDb + 12) / 24) * 100}%` }}
          />
          <p className="mt-2 text-2xs leading-relaxed text-muted">
            MusiX already lowers the output automatically to offset whatever the loudest band is
            boosting, so a bass preset does not clip. This is on top of that.
          </p>
        </div>

        {/* Volume normalisation (spec §15) */}
        <div className="mt-4 rounded-panel border border-line bg-surface px-4">
          <div className="flex items-center justify-between gap-6 py-3">
            <div>
              <p className="text-sm font-medium">Volume normalisation</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Uses the ReplayGain tags already in your files. Album mode preserves the loudness
                differences within an album; track mode levels everything.
              </p>
            </div>
            <Select
              label="ReplayGain mode"
              value={settings.replayGainMode}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'track', label: 'Per track' },
                { value: 'album', label: 'Per album' },
              ]}
              onChange={(value) => {
                useSettings.setState({ replayGainMode: value as ReplayGainMode });
                player.setReplayGain(value as ReplayGainMode, settings.preventClipping);
              }}
            />
          </div>
          <div className="border-t border-line">
            <Toggle
              label="Prevent clipping"
              description="Never boost a track past its recorded peak, even when the tag asks for it."
              checked={settings.preventClipping}
              onChange={(checked) => {
                useSettings.setState({ preventClipping: checked });
                player.setReplayGain(settings.replayGainMode, checked);
              }}
            />
          </div>
        </div>

        {/* Crossfade */}
        <div className="mt-4 rounded-panel border border-line bg-surface p-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-subtle" />
            <span className="text-sm font-medium">Crossfade</span>
            <span className="ml-auto text-xs tabular-nums text-muted">
              {settings.crossfadeSec === 0 ? 'Off' : `${settings.crossfadeSec.toFixed(1)} s`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Crossfade length"
            min={0}
            max={12}
            step={0.5}
            value={settings.crossfadeSec}
            onChange={(event) => {
              const value = Number.parseFloat(event.target.value);
              useSettings.setState({ crossfadeSec: value });
              player.setCrossfade(value);
            }}
            className="mx-range mt-3"
            style={{ ['--mx-fill' as string]: `${(settings.crossfadeSec / 12) * 100}%` }}
          />
          <p className="mt-2 text-2xs leading-relaxed text-muted">
            With crossfade off, MusiX still starts the next track a fraction early and hands over on
            the audio clock, so album transitions stay tight.
          </p>
        </div>
      </div>
    </div>
  );
}

function BandSlider({
  frequency,
  gainDb,
  onChange,
}: {
  frequency: number;
  gainDb: number;
  onChange(gainDb: number): void;
}) {
  const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);

  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <span className="text-2xs tabular-nums text-muted">
        {gainDb > 0 ? '+' : ''}
        {gainDb.toFixed(1)}
      </span>
      {/*
        A vertical range input. `writing-mode` is the modern way to do this and
        avoids the rotation transform, which breaks pointer coordinates.
      */}
      <input
        type="range"
        aria-label={`${label} hertz band`}
        min={EQ_MIN_DB}
        max={EQ_MAX_DB}
        step={0.5}
        value={gainDb}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="mx-range h-36 w-6"
        style={{
          ['writingMode' as string]: 'vertical-lr',
          ['direction' as string]: 'rtl',
          ['--mx-fill' as string]: `${((gainDb - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * 100}%`,
        }}
      />
      <span className="text-2xs text-subtle">{label}</span>
    </div>
  );
}

/** The measured response of the filter chain. */
function ResponseCurve({ curve }: { curve: { frequency: number; db: number }[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--mx-accent').trim() || '139 92 246';
    const line = styles.getPropertyValue('--mx-line').trim() || '38 38 48';

    // Zero-dB baseline.
    context.strokeStyle = `rgb(${line})`;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();

    if (curve.length === 0) return;

    // ±15 dB fills the box, which keeps a ±12 dB band visible with headroom.
    const toY = (db: number) => height / 2 - (db / 15) * (height / 2);

    context.beginPath();
    curve.forEach((point, index) => {
      const x = (index / (curve.length - 1)) * width;
      const y = toY(point.db);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = `rgb(${accent})`;
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.stroke();

    // Soft fill under the curve.
    context.lineTo(width, height / 2);
    context.lineTo(0, height / 2);
    context.closePath();
    context.fillStyle = `rgb(${accent} / 0.12)`;
    context.fill();
  }, [curve]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Equaliser response curve"
      className="h-24 w-full rounded-lg bg-bg"
    />
  );
}
