/**
 * Ten-band graphic equaliser (spec §16).
 *
 * Built from `BiquadFilterNode`s: a low shelf, eight peaking filters and a high
 * shelf, on ISO octave centres. The filters are native, so the DSP runs off the
 * main thread in the browser's audio renderer — the alternative, an
 * `AudioWorklet` doing its own biquads, would burn measurably more CPU for no
 * audible gain.
 *
 * The important behaviour for battery life (spec §37) is `bypass`: when every
 * band is at 0 dB the filter chain is disconnected entirely rather than left in
 * place multiplying by one. Eleven nodes per sample frame is not free.
 */

import { clamp, dbToGain } from '../utils';
import type { EqBand } from '../types';

/** ISO octave centre frequencies. */
export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

/**
 * Octave-band Q.
 *
 * √2 ≈ 1.414 is the textbook value for non-overlapping octave bands; slightly
 * below that lets adjacent bands blend, which sounds better on a broad tone
 * control than mathematically ideal separation does.
 */
const BAND_Q = 1.2;

export type EqPresetName =
  | 'Flat'
  | 'Rock'
  | 'Pop'
  | 'Classical'
  | 'EDM'
  | 'Hip Hop'
  | 'Vocal'
  | 'Bass'
  | 'Treble'
  | 'Cinema'
  | 'Podcast';

/** Gains in dB, one per entry of `EQ_FREQUENCIES`. */
export const EQ_PRESETS: Record<EqPresetName, readonly number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 4, 2.5, 0, -1, -0.5, 1.5, 3.5, 4.5, 4.5],
  Pop: [-1.5, -1, 0, 2, 3.5, 3.5, 1.5, 0, -1, -1.5],
  Classical: [3.5, 3, 2, 1, -0.5, -0.5, 0, 1.5, 2.5, 3],
  EDM: [6, 5.5, 3, 0, -2, 1, 2, 3.5, 5, 5.5],
  'Hip Hop': [6, 5, 2.5, 1.5, -1, -0.5, 1, 1.5, 2.5, 3],
  Vocal: [-3, -2.5, -1, 1.5, 4, 4.5, 3.5, 1.5, 0, -1],
  Bass: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1.5, 3, 4.5, 6, 6.5],
  Cinema: [4, 3, 1, 0, 1.5, 2, 1.5, 2.5, 3.5, 4],
  Podcast: [-6, -4, -1.5, 2, 4, 4, 3, 1, -1, -2],
};

export function flatBands(): EqBand[] {
  return EQ_FREQUENCIES.map((frequency) => ({ frequency, gainDb: 0 }));
}

export function presetBands(name: EqPresetName): EqBand[] {
  const gains = EQ_PRESETS[name];
  return EQ_FREQUENCIES.map((frequency, index) => ({
    frequency,
    gainDb: gains[index] ?? 0,
  }));
}

export function bandsAreFlat(bands: readonly EqBand[]): boolean {
  return bands.every((band) => Math.abs(band.gainDb) < 0.05);
}

/** Name of the preset these bands match, or null for a custom curve. */
export function matchPreset(bands: readonly EqBand[]): EqPresetName | null {
  for (const [name, gains] of Object.entries(EQ_PRESETS) as [EqPresetName, number[]][]) {
    if (bands.every((band, index) => Math.abs(band.gainDb - (gains[index] ?? 0)) < 0.05)) {
      return name;
    }
  }
  return null;
}

/**
 * The filter chain, plus the preamp that compensates for it.
 *
 * Boosting bands adds gain, and enough boost will clip. `preampDb` is applied
 * automatically to offset the largest positive band, which is what stops a bass
 * preset from turning into distortion.
 */
export class Equalizer {
  private readonly filters: BiquadFilterNode[];
  private readonly preamp: GainNode;
  private bands: EqBand[] = flatBands();
  private userPreampDb = 0;
  private enabled = false;
  /**
   * Current routing, or `null` before the graph has been wired at all.
   *
   * The null matters: `applyRouting` returns early when nothing has changed,
   * and a plain `true` here meant the constructor's first call — which also
   * wants to bypass, since the EQ starts disabled and flat — decided there was
   * nothing to do and left `input` connected to nothing. The result was total
   * silence on a fresh launch until the user touched a slider, which finally
   * made the state differ and wired the graph.
   */
  private bypassed: boolean | null = null;
  /** Where audio enters; never changes, so callers connect once. */
  readonly input: GainNode;
  /** Where audio leaves; never changes. */
  readonly output: GainNode;

  constructor(private readonly context: BaseAudioContext) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.preamp = context.createGain();

    this.filters = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      filter.type =
        index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = BAND_Q;
      filter.gain.value = 0;
      return filter;
    });

    // Chain the filters together once; connecting them to the bus is what
    // `applyRouting` toggles.
    for (let i = 0; i < this.filters.length - 1; i++) {
      this.filters[i]!.connect(this.filters[i + 1]!);
    }
    this.filters[this.filters.length - 1]!.connect(this.preamp);
    this.preamp.connect(this.output);

    this.applyRouting();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.applyRouting();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getBands(): EqBand[] {
    return this.bands.map((band) => ({ ...band }));
  }

  setBands(bands: readonly EqBand[]): void {
    this.bands = EQ_FREQUENCIES.map((frequency, index) => ({
      frequency,
      gainDb: clamp(bands[index]?.gainDb ?? 0, EQ_MIN_DB, EQ_MAX_DB),
    }));

    const now = this.context.currentTime;
    for (let i = 0; i < this.filters.length; i++) {
      // A short ramp instead of a jump: stepping a filter gain produces an
      // audible click while the user is dragging a slider.
      this.filters[i]!.gain.setTargetAtTime(this.bands[i]!.gainDb, now, 0.02);
    }
    this.updatePreamp();
    this.applyRouting();
  }

  setBand(index: number, gainDb: number): void {
    const next = this.getBands();
    if (!next[index]) return;
    next[index]!.gainDb = gainDb;
    this.setBands(next);
  }

  /** Extra user gain on top of the automatic anti-clipping compensation. */
  setPreamp(db: number): void {
    this.userPreampDb = clamp(db, -12, 12);
    this.updatePreamp();
  }

  getPreamp(): number {
    return this.userPreampDb;
  }

  private updatePreamp(): void {
    const maxBoost = Math.max(0, ...this.bands.map((band) => band.gainDb));
    // Compensate most of the peak boost. Full compensation would make every
    // preset quieter than flat, which users read as the EQ "not working".
    const automatic = -maxBoost * 0.7;
    const total = this.enabled ? automatic + this.userPreampDb : 0;
    this.preamp.gain.setTargetAtTime(dbToGain(total), this.context.currentTime, 0.03);
  }

  /**
   * Route audio through the filters, or straight past them.
   *
   * Bypassing when disabled or flat is the whole point (spec §17: "effects must
   * be disabled when unused").
   */
  private applyRouting(): void {
    const shouldBypass = !this.enabled || bandsAreFlat(this.bands);
    if (shouldBypass === this.bypassed) return;

    this.input.disconnect();
    if (shouldBypass) {
      this.input.connect(this.output);
    } else {
      this.input.connect(this.filters[0]!);
    }
    this.bypassed = shouldBypass;
    this.updatePreamp();
  }

  /** True when audio is currently skipping the filter chain. */
  isBypassed(): boolean {
    return this.bypassed !== false;
  }

  /**
   * Magnitude response in dB across a log frequency sweep, for drawing the
   * curve behind the sliders.
   */
  responseCurve(points = 128): { frequency: number; db: number }[] {
    const frequencies = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      // 20 Hz to 20 kHz, logarithmically.
      frequencies[i] = 20 * (1000 ** (i / (points - 1)));
    }
    const magnitude = new Float32Array(points);
    const phase = new Float32Array(points);
    const total = new Float32Array(points).fill(1);

    for (const filter of this.filters) {
      filter.getFrequencyResponse(frequencies, magnitude, phase);
      for (let i = 0; i < points; i++) total[i]! *= magnitude[i]!;
    }

    return Array.from({ length: points }, (_, i) => ({
      frequency: frequencies[i]!,
      db: 20 * Math.log10(Math.max(total[i]!, 1e-6)),
    }));
  }
}
