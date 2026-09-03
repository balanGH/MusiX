/**
 * The audio engine.
 *
 * **Why HTMLAudioElement and not `decodeAudioData`.** Decoding a whole track to
 * an `AudioBuffer` gives sample-accurate scheduling, and costs about 50 MB of
 * float32 for a five-minute stereo track plus a full decode before the first
 * sample plays. `HTMLAudioElement` streams through the platform's own decoder —
 * hardware-accelerated where available — which is exactly what spec §4 and §37
 * ask for. Its output is still routed into a Web Audio graph, so the equaliser,
 * ReplayGain and crossfade are all real.
 *
 * **Graph.**
 *
 *     elementA ─▶ sourceA ─▶ gainA ┐
 *     elementB ─▶ sourceB ─▶ gainB ┴▶ equaliser ─▶ limiter ─▶ master ─▶ out
 *
 * Two elements, not one, because crossfade and near-gapless handoff both need
 * the next track decoding while the current one is still playing. `gainA`/`gainB`
 * carry both the crossfade envelope and that track's ReplayGain.
 *
 * **Idle cost.** With nothing playing the engine suspends the `AudioContext`
 * after a short grace period, and the equaliser disconnects itself when flat.
 * An idle MusiX should not appear in a battery report.
 */

import { claimAudioSource, registerAudioSource } from './exclusivity';
import { createLogger, describeError } from '../logger';
import { clamp, dbToGain, sliderToGain } from '../utils';
import { Equalizer } from './equalizer';
import type { EqBand, ReplayGain, Track } from '../types';

const log = createLogger('audio');

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type ReplayGainMode = 'off' | 'track' | 'album';

export interface EngineSnapshot {
  status: PlaybackStatus;
  trackId: string | null;
  positionSec: number;
  durationSec: number;
  bufferedSec: number;
  error: string | null;
}

export interface EngineEvents {
  /** Throttled by the element's own `timeupdate`, roughly 4/sec. */
  progress: EngineSnapshot;
  statusChange: EngineSnapshot;
  /** The current track finished on its own. */
  ended: { trackId: string };
  /** Time to hand over — fired once, `crossfadeSec` before the end. */
  nearEnd: { trackId: string; remainingSec: number };
  error: { trackId: string | null; message: string };
}

type Listener<K extends keyof EngineEvents> = (payload: EngineEvents[K]) => void;

/** Seconds of silence before the context is suspended. */
const IDLE_SUSPEND_DELAY_MS = 15_000;
/** How early the next element is started so its decoder is warm. */
const HANDOFF_LEAD_SEC = 0.35;

interface Deck {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode | null;
  gain: GainNode;
  /** The loaded track, kept so ReplayGain can be recomputed on a mode change. */
  track: Track | null;
  /** Object URL currently assigned; revoked when replaced. */
  objectUrl: string | null;
  replayGainDb: number;
}

/** Convenience: a deck's track id, or null when empty. */
const deckTrackId = (deck: Deck | null): string | null => deck?.track?.id ?? null;

export class AudioEngine {
  private context: AudioContext | null = null;
  private equalizer: Equalizer | null = null;
  private master: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private decks: [Deck, Deck] | null = null;
  private active = 0;

  private volume = 1;
  private muted = false;
  private rate = 1;
  private crossfadeSec = 0;
  private replayGainMode: ReplayGainMode = 'track';
  private preventClipping = true;
  private eqBands: EqBand[] | null = null;
  private eqEnabled = false;
  private eqPreamp = 0;

  private status: PlaybackStatus = 'idle';
  private lastError: string | null = null;
  private nearEndFired = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Map<keyof EngineEvents, Set<Listener<never>>>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the graph.
   *
   * Deferred until the first play, because a browser will not let an
   * `AudioContext` start outside a user gesture and creating one earlier just
   * produces a suspended context that has to be resumed anyway.
   */
  private ensureGraph(): { context: AudioContext; decks: [Deck, Deck] } {
    if (this.context && this.decks) return { context: this.context, decks: this.decks };

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');

    // `latencyHint` is a genuine trade-off, and 'playback' was the wrong side
    // of it. It asks for a large output buffer — fewer wakeups and less battery
    // drain (spec §36), but a couple of hundred milliseconds of already-buffered
    // audio keeps playing after the element is paused. Pressing pause and
    // hearing it a beat later makes the whole player feel broken.
    //
    // 'interactive' keeps the buffer small so transport controls respond
    // immediately. The battery saving that actually matters comes from
    // suspending the context when idle (see `scheduleIdleSuspend`), which is
    // unaffected by this.
    const context = new Ctor({ latencyHint: 'interactive' });

    const master = context.createGain();
    master.gain.value = this.muted ? 0 : sliderToGain(this.volume);

    // A gentle limiter, not a compressor: it exists so that ReplayGain boost or
    // EQ boost cannot clip, and is transparent below threshold.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    const equalizer = new Equalizer(context);
    if (this.eqBands) equalizer.setBands(this.eqBands);
    equalizer.setPreamp(this.eqPreamp);
    equalizer.setEnabled(this.eqEnabled);

    equalizer.output.connect(limiter);
    limiter.connect(master);
    master.connect(context.destination);

    const decks: [Deck, Deck] = [
      this.createDeck(context, equalizer),
      this.createDeck(context, equalizer),
    ];

    this.context = context;
    this.master = master;
    this.equalizer = equalizer;
    this.decks = decks;

    return { context, decks };
  }

  private createDeck(context: AudioContext, equalizer: Equalizer): Deck {
    const element = new Audio();
    element.preload = 'auto';
    element.crossOrigin = 'anonymous';
    // The graph's master gain owns loudness; leaving element volume at 1 keeps
    // one control path rather than two that can disagree.
    element.volume = 1;

    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(equalizer.input);

    return { element, source: null, gain, track: null, objectUrl: null, replayGainDb: 0 };
  }

  private get currentDeck(): Deck | null {
    return this.decks ? this.decks[this.active]! : null;
  }

  private get idleDeck(): Deck | null {
    return this.decks ? this.decks[this.active === 0 ? 1 : 0]! : null;
  }

  // -------------------------------------------------------------------------
  // Loading and transport
  // -------------------------------------------------------------------------

  /**
   * Load a track and, unless told otherwise, start playing it.
   *
   * `file` comes from the platform layer, so this works identically for a file
   * on disk and a file in OPFS, and needs no network.
   */
  async load(
    track: Track,
    file: Blob,
    options: { autoplay?: boolean; startAtSec?: number } = {},
  ): Promise<void> {
    const { context, decks } = this.ensureGraph();
    const deck = decks[this.active]!;
    const other = decks[this.active === 0 ? 1 : 0]!;

    // A crossfade may still be ramping the other deck down; stop it cleanly.
    this.stopDeck(other);

    this.setStatus('loading');
    this.lastError = null;
    this.nearEndFired = false;

    this.attachSource(context, deck);
    this.assignFile(deck, file);
    deck.track = track;
    deck.replayGainDb = this.gainForTrack(track);
    this.applyDeckGain(deck, 1, 0);

    if (options.startAtSec && options.startAtSec > 0) {
      // Seeking before metadata arrives is silently ignored by the element.
      await waitForMetadata(deck.element);
      deck.element.currentTime = options.startAtSec;
    }

    deck.element.playbackRate = this.rate;
    this.applyPreservesPitch(deck.element);

    if (options.autoplay !== false) {
      await this.play();
    } else {
      this.setStatus('paused');
    }
  }

  /** Warm up the next track so the handoff has no gap. */
  async preload(track: Track, file: Blob): Promise<void> {
    const { context, decks } = this.ensureGraph();
    const deck = decks[this.active === 0 ? 1 : 0]!;
    if (deck.track?.id === track.id) return;

    this.attachSource(context, deck);
    this.assignFile(deck, file);
    deck.track = track;
    deck.replayGainDb = this.gainForTrack(track);
    deck.gain.gain.value = 0;
    // `load()` starts buffering without playing; the element stays silent
    // because its deck gain is zero.
    deck.element.load();
  }

  /**
   * Switch to the preloaded deck.
   *
   * With `crossfadeSec > 0` the two decks are equal-power ramped against each
   * other on the audio clock. With crossfade off the new deck is started a
   * fraction early and unmuted at the boundary, which is as close to gapless as
   * a streaming element gets — see the note in docs/ARCHITECTURE.md.
   */
  async handoff(): Promise<boolean> {
    const next = this.idleDeck;
    const current = this.currentDeck;
    if (!next?.track || !this.context) return false;

    claimAudioSource('player');
    const fade = this.crossfadeSec;
    try {
      next.element.playbackRate = this.rate;
      this.applyPreservesPitch(next.element);
      await next.element.play();
    } catch (error) {
      log.warn('handoff play() rejected', error);
      return false;
    }

    this.applyDeckGain(next, 1, fade);
    if (current) {
      this.applyDeckGain(current, 0, fade);
      // Let the ramp finish before pausing, or the tail is cut off.
      const stopAfterMs = Math.max(0, fade * 1000) + 60;
      const stopping = current;
      setTimeout(() => {
        if (stopping !== this.currentDeck) this.stopDeck(stopping);
      }, stopAfterMs);
    }

    this.active = this.active === 0 ? 1 : 0;
    this.nearEndFired = false;
    this.setStatus('playing');
    return true;
  }

  async play(): Promise<void> {
    const deck = this.currentDeck;
    if (!deck || !this.context) return;
    // Every path that can start the main player — a button, the spacebar
    // shortcut, an OS media key, a Bluetooth headset — funnels through this
    // method or `handoff()`, which is why the exclusivity claim lives here
    // rather than in each of those entry points.
    claimAudioSource('player');
    this.cancelIdleSuspend();

    if (this.context.state === 'suspended') {
      await this.context.resume().catch((error) => log.warn('context resume failed', error));
    }

    try {
      this.applyDeckGain(deck, 1, 0.02);
      await deck.element.play();
      this.setStatus('playing');
    } catch (error) {
      // Autoplay policy, or the file vanished mid-load.
      this.fail(deckTrackId(deck), describeError(error));
    }
  }

  pause(): void {
    const deck = this.currentDeck;
    if (!deck) return;
    deck.element.pause();
    this.setStatus('paused');
    this.scheduleIdleSuspend();
  }

  async toggle(): Promise<void> {
    if (this.status === 'playing') this.pause();
    else await this.play();
  }

  /** Stop, release both decks and let the context suspend. */
  stop(): void {
    if (!this.decks) return;
    for (const deck of this.decks) this.stopDeck(deck);
    this.setStatus('idle');
    this.scheduleIdleSuspend();
  }

  seek(positionSec: number): void {
    const deck = this.currentDeck;
    if (!deck) return;
    const duration = deck.element.duration;
    const target = Number.isFinite(duration)
      ? clamp(positionSec, 0, Math.max(0, duration - 0.05))
      : Math.max(0, positionSec);
    deck.element.currentTime = target;
    // Seeking backwards past the crossfade point must re-arm the handoff.
    this.nearEndFired = false;
    this.emit('progress', this.snapshot());
  }

  get currentTime(): number {
    return this.currentDeck?.element.currentTime ?? 0;
  }

  get duration(): number {
    const duration = this.currentDeck?.element.duration ?? 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  // -------------------------------------------------------------------------
  // Mixer settings
  // -------------------------------------------------------------------------

  setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : sliderToGain(this.volume),
        this.context.currentTime,
        0.015,
      );
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.setVolume(this.volume);
  }

  isMuted(): boolean {
    return this.muted;
  }

  setPlaybackRate(rate: number): void {
    this.rate = clamp(rate, 0.25, 4);
    if (!this.decks) return;
    for (const deck of this.decks) {
      deck.element.playbackRate = this.rate;
      this.applyPreservesPitch(deck.element);
    }
  }

  getPlaybackRate(): number {
    return this.rate;
  }

  setCrossfade(seconds: number): void {
    this.crossfadeSec = clamp(seconds, 0, 12);
  }

  getCrossfade(): number {
    return this.crossfadeSec;
  }

  setReplayGain(mode: ReplayGainMode, preventClipping = true): void {
    this.replayGainMode = mode;
    this.preventClipping = preventClipping;
    if (!this.decks) return;
    // Recompute from the stored track records, so the change is audible at once
    // and the preloaded deck is correct before it is handed to.
    for (const deck of this.decks) {
      if (!deck.track) continue;
      deck.replayGainDb = this.gainForTrack(deck.track);
    }
    const current = this.currentDeck;
    if (current?.track) this.applyDeckGain(current, 1, 0.05);
  }

  setEqBands(bands: readonly EqBand[]): void {
    this.eqBands = bands.map((band) => ({ ...band }));
    this.equalizer?.setBands(this.eqBands);
  }

  setEqEnabled(enabled: boolean): void {
    this.eqEnabled = enabled;
    this.equalizer?.setEnabled(enabled);
  }

  setEqPreamp(db: number): void {
    this.eqPreamp = db;
    this.equalizer?.setPreamp(db);
  }

  getEqualizer(): Equalizer | null {
    return this.equalizer;
  }

  /**
   * Attach an analyser for a visualiser.
   *
   * Connected only on request and disconnected on release, because an
   * `AnalyserNode` copies every sample frame whether or not anyone reads it.
   */
  acquireAnalyser(fftSize = 2048): AnalyserNode | null {
    if (!this.context || !this.master) return null;
    if (!this.analyserNode) {
      this.analyserNode = this.context.createAnalyser();
      this.analyserNode.smoothingTimeConstant = 0.8;
      this.master.connect(this.analyserNode);
    }
    this.analyserNode.fftSize = fftSize;
    return this.analyserNode;
  }

  releaseAnalyser(): void {
    if (!this.analyserNode) return;
    this.analyserNode.disconnect();
    this.analyserNode = null;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof EngineEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  private emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        log.error(`listener for ${event} threw`, error);
      }
    }
  }

  snapshot(): EngineSnapshot {
    const deck = this.currentDeck;
    const element = deck?.element;
    const duration = element?.duration ?? 0;
    let bufferedSec = 0;
    if (element && element.buffered.length > 0) {
      bufferedSec = element.buffered.end(element.buffered.length - 1);
    }
    return {
      status: this.status,
      trackId: deckTrackId(deck),
      positionSec: element?.currentTime ?? 0,
      durationSec: Number.isFinite(duration) ? duration : 0,
      bufferedSec,
      error: this.lastError,
    };
  }

  dispose(): void {
    this.cancelIdleSuspend();
    if (this.decks) for (const deck of this.decks) this.stopDeck(deck);
    this.releaseAnalyser();
    this.listeners.clear();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.decks = null;
    this.equalizer = null;
    this.master = null;
    this.setStatus('idle');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * `createMediaElementSource` may only be called once per element — calling it
   * again throws — so the node is created lazily and kept for the deck's life.
   */
  private attachSource(context: AudioContext, deck: Deck): void {
    if (deck.source) return;
    deck.source = context.createMediaElementSource(deck.element);
    deck.source.connect(deck.gain);
    this.bindElementEvents(deck);
  }

  private assignFile(deck: Deck, file: Blob): void {
    if (deck.objectUrl) URL.revokeObjectURL(deck.objectUrl);
    deck.objectUrl = URL.createObjectURL(file);
    deck.element.src = deck.objectUrl;
  }

  private stopDeck(deck: Deck): void {
    deck.element.pause();
    deck.gain.gain.value = 0;
    if (deck.objectUrl) {
      // Clearing `src` first stops the element holding the revoked URL, which
      // otherwise logs a network error in some builds.
      deck.element.removeAttribute('src');
      deck.element.load();
      URL.revokeObjectURL(deck.objectUrl);
      deck.objectUrl = null;
    }
    deck.track = null;
  }

  private bindElementEvents(deck: Deck): void {
    const element = deck.element;

    element.addEventListener('timeupdate', () => {
      if (deck !== this.currentDeck) return;
      this.checkNearEnd(deck);
      this.emit('progress', this.snapshot());
    });

    element.addEventListener('ended', () => {
      if (deck !== this.currentDeck) return;
      const trackId = deckTrackId(deck);
      this.setStatus('ended');
      if (trackId) this.emit('ended', { trackId });
    });

    element.addEventListener('loadedmetadata', () => {
      if (deck === this.currentDeck) this.emit('progress', this.snapshot());
    });

    element.addEventListener('error', () => {
      if (deck !== this.currentDeck) return;
      const code = element.error?.code;
      this.fail(
        deckTrackId(deck),
        code === MediaError.MEDIA_ERR_DECODE
          ? 'This file could not be decoded — it may be corrupt.'
          : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? 'This browser cannot play this audio format.'
            : 'Playback failed.',
      );
    });

    element.addEventListener('stalled', () => {
      log.warn('playback stalled');
    });
  }

  /** Fire `nearEnd` once, so the controller can start the next track. */
  private checkNearEnd(deck: Deck): void {
    if (this.nearEndFired) return;
    const duration = deck.element.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const remaining = duration - deck.element.currentTime;
    const lead = Math.max(this.crossfadeSec, HANDOFF_LEAD_SEC);
    if (remaining <= lead && remaining > 0) {
      this.nearEndFired = true;
      const trackId = deckTrackId(deck);
      if (trackId) this.emit('nearEnd', { trackId, remainingSec: remaining });
    }
  }

  /** Combine the crossfade envelope with this track's ReplayGain. */
  private applyDeckGain(deck: Deck, envelope: number, rampSec: number): void {
    if (!this.context) return;
    const target = envelope * dbToGain(this.replayGainMode === 'off' ? 0 : deck.replayGainDb);
    const now = this.context.currentTime;
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, now);
    if (rampSec <= 0) {
      deck.gain.gain.setValueAtTime(target, now);
    } else {
      // Linear ramp on a gain that already carries a perceptual curve; an
      // exponential ramp cannot reach zero, which a crossfade needs to.
      deck.gain.gain.linearRampToValueAtTime(target, now + rampSec);
    }
  }

  /**
   * ReplayGain for a track (spec §15).
   *
   * Album gain keeps the relative loudness *within* an album, which is the whole
   * point of listening to one; track gain levels everything. When the tag has
   * no gain the track plays untouched rather than being guessed at.
   */
  private gainForTrack(track: Track): number {
    if (this.replayGainMode === 'off') return 0;
    const rg: ReplayGain | null = track.replayGain;
    if (!rg) return 0;

    const gain =
      this.replayGainMode === 'album'
        ? (rg.albumGainDb ?? rg.trackGainDb)
        : (rg.trackGainDb ?? rg.albumGainDb);
    if (gain === null || gain === undefined || !Number.isFinite(gain)) return 0;

    let result = clamp(gain, -24, 24);
    if (this.preventClipping) {
      const peak = this.replayGainMode === 'album' ? (rg.albumPeak ?? rg.trackPeak) : (rg.trackPeak ?? rg.albumPeak);
      if (peak && peak > 0) {
        // Never boost a track past digital full scale; the limiter is a safety
        // net, not a mixing tool.
        const headroomDb = -20 * Math.log10(peak);
        result = Math.min(result, headroomDb);
      }
    }
    return result;
  }

  /**
   * Keep pitch constant when the playback rate changes (spec §15).
   *
   * Property-bag access rather than typed access: the standard name and the
   * still-shipping WebKit-prefixed name have to be probed at runtime.
   */
  private applyPreservesPitch(element: HTMLAudioElement): void {
    const target = element as unknown as Record<string, unknown>;
    if ('preservesPitch' in target) target.preservesPitch = true;
    else if ('webkitPreservesPitch' in target) target.webkitPreservesPitch = true;
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (status === 'playing') this.cancelIdleSuspend();
    this.emit('statusChange', this.snapshot());
  }

  private fail(trackId: string | null, message: string): void {
    this.lastError = message;
    this.status = 'error';
    log.warn(`playback error: ${message}`);
    this.emit('error', { trackId, message });
    this.emit('statusChange', this.snapshot());
  }

  /**
   * Suspend the context once nothing is playing.
   *
   * A running `AudioContext` keeps the audio thread awake and, on some
   * platforms, holds a wake lock. Suspending it is the single biggest idle-power
   * win available (spec §37).
   */
  private scheduleIdleSuspend(): void {
    this.cancelIdleSuspend();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.status === 'playing') return;
      void this.context?.suspend().catch(() => undefined);
    }, IDLE_SUSPEND_DELAY_MS);
  }

  private cancelIdleSuspend(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Resolve once the element knows its duration.
 *
 * Resolves rather than rejects on error: the caller only wants to seek, and a
 * load failure is reported through the element's own `error` event.
 */
function waitForMetadata(element: HTMLAudioElement): Promise<void> {
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      element.removeEventListener('loadedmetadata', done);
      element.removeEventListener('error', done);
      resolve();
    };
    element.addEventListener('loadedmetadata', done, { once: true });
    element.addEventListener('error', done, { once: true });
  });
}

/** The app's single engine instance. */
export const audioEngine = new AudioEngine();

// Registered unconditionally at module load: `active` stays null in
// exclusivity.ts until something actually claims playback, so this has no
// effect until the stem mixer exists and a claim happens.
registerAudioSource('player', {
  stop: () => audioEngine.pause(),
  seek: (seconds) => audioEngine.seek(seconds),
  getPositionSec: () => audioEngine.currentTime,
  isPlaying: () => audioEngine.snapshot().status === 'playing',
});
