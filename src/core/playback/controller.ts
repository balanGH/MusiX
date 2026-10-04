/**
 * The player.
 *
 * Sits between the pure queue logic, the audio engine, and the database, and
 * owns the decisions that need all three:
 *
 *  - when a play "counts" and gets written to history;
 *  - when to preload and hand off, so tracks join seamlessly;
 *  - what to do when a file has gone missing mid-queue;
 *  - what to persist so that closing the tab and reopening it resumes.
 *
 * It emits events rather than importing any UI, so the React store is a thin
 * subscriber and this stays the single source of truth for playback state.
 */

import { audioEngine, type EngineSnapshot, type ReplayGainMode } from '../audio/engine';
import {
  bindMediaSession,
  clearMediaSession,
  setNowPlaying,
  setPlaybackState,
  setPositionState,
} from '../audio/mediaSession';
import { getArtwork } from '../db/repositories/artwork';
import { loadSession, saveSession, type PersistedSession } from '../db/repositories/settings';
import {
  getTrack,
  getTracks,
  recordPlay,
  recordSkip,
  setFavorite as writeFavorite,
} from '../db/repositories/tracks';
import { createLogger, describeError } from '../logger';
import { openTrackFile } from '../platform';
import type { EqBand, QueueItem, RepeatMode, Track } from '../types';
import * as Q from './queue';

const log = createLogger('player');

/**
 * A play is recorded once half the track, or four minutes, has been heard —
 * the long-standing scrobbling convention, and the only rule that behaves
 * sensibly for both a 90-second interlude and a 20-minute live track.
 */
const PLAY_THRESHOLD_RATIO = 0.5;
const PLAY_THRESHOLD_MS = 4 * 60 * 1000;

/** Below this, skipping backwards restarts the track instead of going back. */
const RESTART_THRESHOLD_SEC = 3;

/**
 * Session saves: settle for this long after the last change, but never wait
 * longer than the max. A plain trailing debounce never fires during playback,
 * because progress re-arms it four times a second.
 */
const SESSION_SAVE_DEBOUNCE_MS = 1200;
const SESSION_SAVE_MAX_WAIT_MS = 5000;

/**
 * A trailing debounce that still fires at least every `maxWaitMs` under a
 * constant stream of calls, plus `flush()` to run a pending call right now.
 */
function debounceWithMaxWait(
  fn: () => void,
  waitMs: number,
  maxWaitMs: number,
): (() => void) & { flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstCallAt = 0;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstCallAt = 0;
    fn();
  };
  const debounced = () => {
    const now = Date.now();
    if (firstCallAt === 0) firstCallAt = now;
    if (timer) clearTimeout(timer);
    const delay = Math.max(0, Math.min(waitMs, firstCallAt + maxWaitMs - now));
    timer = setTimeout(run, delay);
  };
  debounced.flush = () => {
    if (timer) run();
  };
  return debounced;
}

export interface PlayerState {
  queue: Q.QueueState;
  track: Track | null;
  status: EngineSnapshot['status'];
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  error: string | null;
}

export interface PlayerEvents {
  change: PlayerState;
  /** Emitted on the engine's cadence; separate so lists don't re-render. */
  progress: { positionSec: number; durationSec: number };
  trackChange: { track: Track | null };
  error: { message: string };
}

type Listener<K extends keyof PlayerEvents> = (payload: PlayerEvents[K]) => void;

class PlayerController {
  private queue = Q.emptyQueue();
  private track: Track | null = null;
  private status: EngineSnapshot['status'] = 'idle';
  private positionSec = 0;
  private durationSec = 0;
  private error: string | null = null;

  /** Milliseconds of the current track actually heard, for the play threshold. */
  private heardMs = 0;
  private lastTickAt = 0;
  private playRecorded = false;
  /** Track ids preloaded onto the idle deck, to avoid repeat work. */
  private preloadedTrackId: string | null = null;
  private handingOff = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepEndsAt: number | null = null;
  /** Set when the sleep timer ran out with "finish the current track" on. */
  private stopAfterTrack = false;
  private initialised = false;
  /**
   * Bumped whenever a different track is (or starts being) loaded. Every await
   * in a load path re-checks it, so a superseded load quietly gives up instead
   * of finishing last and leaving audio and UI on different tracks.
   */
  private loadSeq = 0;
  /** Missing files skipped in a row on automatic advance, to stop a runaway. */
  private autoSkips = 0;

  private readonly listeners = new Map<keyof PlayerEvents, Set<Listener<never>>>();
  private readonly persist = debounceWithMaxWait(
    () => void this.saveSession(),
    SESSION_SAVE_DEBOUNCE_MS,
    SESSION_SAVE_MAX_WAIT_MS,
  );

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  init(): void {
    if (this.initialised) return;
    this.initialised = true;

    audioEngine.on('progress', (snapshot) => this.onProgress(snapshot));
    audioEngine.on('statusChange', (snapshot) => this.onStatusChange(snapshot));
    audioEngine.on('nearEnd', () => void this.onNearEnd());
    audioEngine.on('ended', () => void this.onEnded());
    audioEngine.on('error', (payload) => this.onEngineError(payload.message));

    bindMediaSession({
      play: () => void this.play(),
      pause: () => this.pause(),
      stop: () => this.stop(),
      next: () => void this.next(),
      previous: () => void this.previous(),
      seekTo: (position) => this.seek(position),
      seekBy: (offset) => this.seek(this.positionSec + offset),
    });

    // A closing tab, or a mobile OS reclaiming a backgrounded app, gives no
    // further chance to save, so write the session the moment the page hides.
    if (typeof window !== 'undefined') {
      const saveNow = () => {
        this.persist.flush();
        void this.saveSession();
      };
      window.addEventListener('pagehide', saveNow);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveNow();
      });
    }
  }

  /**
   * Restore the queue from the last session (spec §27 "Continue Listening").
   *
   * Loads but deliberately does not play: a page that starts making noise on
   * open is hostile, and browsers block it anyway.
   */
  async restore(): Promise<boolean> {
    const session = await loadSession();
    if (!session || session.queue.length === 0) return false;

    // Tracks may have been removed by a scan since the session was saved, so
    // both the item list and the order permutation have to be compacted.
    const tracks = await getTracks(session.queue.map((item) => item.trackId));
    const existing = new Set(tracks.map((track) => track.id));

    // The cursor is remapped by item, not clamped by index: clamping lands on
    // the wrong track whenever a scan removed something earlier in the queue.
    const savedTrackId = session.queue[session.order?.[session.index] ?? session.index]?.trackId;
    const queue = Q.restoreQueue(
      {
        items: session.queue,
        order: session.order,
        cursor: session.index,
        shuffle: session.shuffle,
        shuffleSeed: session.shuffleSeed,
        repeat: session.repeat,
      },
      existing,
    );
    if (queue.items.length === 0) return false;
    this.queue = queue;

    const trackId = Q.currentTrackId(this.queue);
    if (trackId) {
      this.track = tracks.find((track) => track.id === trackId) ?? null;
      // The saved position belongs to the saved track, not whichever replaced it.
      this.positionSec = trackId === savedTrackId ? session.positionSec : 0;
      this.durationSec = (this.track?.durationMs ?? 0) / 1000;
      await this.updateNowPlaying();
    }
    this.emitChange();
    return true;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Replace the queue and start playing. */
  async playTracks(
    trackIds: readonly string[],
    options: { startIndex?: number; shuffle?: boolean } = {},
  ): Promise<void> {
    if (trackIds.length === 0) return;
    this.queue = Q.createQueue(trackIds, {
      startIndex: options.startIndex ?? 0,
      shuffle: options.shuffle ?? this.queue.shuffle,
      repeat: this.queue.repeat,
    });
    await this.loadCurrent({ autoplay: true });
  }

  /** Play one track, leaving the rest of the queue alone if it is already there. */
  async playTrack(trackId: string): Promise<void> {
    const inQueue = this.queue.items.find((item) => item.trackId === trackId);
    if (inQueue) {
      this.queue = Q.jumpTo(this.queue, inQueue.uid);
      await this.loadCurrent({ autoplay: true });
      return;
    }
    await this.playTracks([trackId]);
  }

  async play(): Promise<void> {
    if (!this.track) {
      // Restored session with nothing loaded onto a deck yet.
      if (Q.currentTrackId(this.queue)) await this.loadCurrent({ autoplay: true });
      return;
    }
    if (this.status === 'idle' || this.status === 'ended' || this.status === 'error') {
      await this.loadCurrent({ autoplay: true, startAtSec: this.positionSec });
      return;
    }
    await audioEngine.play();
  }

  pause(): void {
    audioEngine.pause();
  }

  async toggle(): Promise<void> {
    if (this.status === 'playing') this.pause();
    else await this.play();
  }

  stop(): void {
    this.loadSeq++; // Drop any load still in flight.
    audioEngine.stop();
    this.flushHeardTime();
    this.positionSec = 0;
    clearMediaSession();
    this.emitChange();
  }

  async next(reason: 'auto' | 'user' = 'user'): Promise<void> {
    // A track abandoned early is a skip, and worth knowing about.
    if (reason === 'user' && this.track && !this.playRecorded && this.heardMs > 2000) {
      await recordSkip(this.track.id).catch(() => undefined);
    }
    const advanced = Q.advance(this.queue, reason);
    if (!advanced) {
      // End of queue: stop at the last track rather than clearing it, so the
      // user can press play again.
      audioEngine.pause();
      this.status = 'paused';
      this.emitChange();
      return;
    }
    if (advanced.repeat === 'one' && reason === 'auto') {
      // Each loop is a fresh listen, and counts towards the play count again.
      this.heardMs = 0;
      this.playRecorded = false;
      this.lastTickAt = 0;
      this.seek(0);
      await audioEngine.play();
      return;
    }
    this.queue = advanced;
    await this.loadCurrent({ autoplay: true, auto: reason === 'auto' });
  }

  async previous(): Promise<void> {
    // Standard behaviour: restart if we are past the first few seconds.
    if (this.positionSec > RESTART_THRESHOLD_SEC) {
      this.seek(0);
      return;
    }
    const retreated = Q.retreat(this.queue);
    if (retreated.cursor === this.queue.cursor) {
      this.seek(0);
      return;
    }
    this.queue = retreated;
    await this.loadCurrent({ autoplay: true });
  }

  async jumpTo(itemUid: string): Promise<void> {
    const next = Q.jumpTo(this.queue, itemUid);
    if (next === this.queue) return;
    this.queue = next;
    await this.loadCurrent({ autoplay: true });
  }

  seek(positionSec: number): void {
    audioEngine.seek(positionSec);
    this.positionSec = audioEngine.currentTime;
    this.emit('progress', { positionSec: this.positionSec, durationSec: this.durationSec });
    this.persist();
  }

  /**
   * Favourite (or unfavourite) a track, keeping the currently-loaded copy in
   * sync when it's the one being changed.
   *
   * `usePlayer().track` — what the persistent player bar and Now Playing both
   * read — is a snapshot held on this controller, not a live query. Writing
   * straight to the database (the tracks repository's `setFavorite`) updates
   * the stored row correctly but leaves that snapshot's `favorite` field
   * exactly as it was, so a heart in either of those two places would toggle
   * the database and then immediately look like nothing happened, no matter
   * how many times it was clicked — clicking again would just toggle it back
   * and forth invisibly. Every favourite control that might be showing the
   * currently-playing track should call this rather than the repository
   * function directly.
   */
  async setFavorite(trackId: string, favorite: boolean): Promise<void> {
    const updated = await writeFavorite(trackId, favorite);
    if (updated && this.track?.id === trackId) {
      this.track = updated;
      this.emitChange();
    }
  }

  // -------------------------------------------------------------------------
  // Queue operations
  // -------------------------------------------------------------------------

  playNext(trackIds: readonly string[]): void {
    this.queue = Q.insertNext(this.queue, trackIds);
    this.preloadedTrackId = null; // The next track changed.
    this.emitChange();
    this.persist();
  }

  addToQueue(trackIds: readonly string[]): void {
    const wasEmpty = this.queue.items.length === 0;
    this.queue = Q.append(this.queue, trackIds);
    this.emitChange();
    this.persist();
    if (wasEmpty) void this.loadCurrent({ autoplay: false });
  }

  removeFromQueue(itemUid: string): void {
    const wasCurrent = Q.currentItem(this.queue)?.uid === itemUid;
    this.queue = Q.removeItem(this.queue, itemUid);
    this.preloadedTrackId = null;
    if (wasCurrent) void this.loadCurrent({ autoplay: this.status === 'playing' });
    else this.emitChange();
    this.persist();
  }

  moveInQueue(fromIndex: number, toIndex: number): void {
    this.queue = Q.moveItem(this.queue, fromIndex, toIndex);
    this.preloadedTrackId = null;
    this.emitChange();
    this.persist();
  }

  clearQueue(): void {
    this.queue = Q.clearQueue(this.queue);
    this.track = null;
    this.loadSeq++;
    audioEngine.stop();
    clearMediaSession();
    this.emitChange();
    this.persist();
  }

  clearUpcoming(): void {
    this.queue = Q.clearUpcoming(this.queue);
    this.preloadedTrackId = null;
    this.emitChange();
    this.persist();
  }

  setShuffle(shuffleOn: boolean): void {
    this.queue = Q.setShuffle(this.queue, shuffleOn);
    this.preloadedTrackId = null;
    this.emitChange();
    this.persist();
  }

  setRepeat(repeat: RepeatMode): void {
    this.queue = Q.setRepeat(this.queue, repeat);
    this.emitChange();
    this.persist();
  }

  cycleRepeat(): void {
    this.queue = Q.cycleRepeat(this.queue);
    this.emitChange();
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------------

  setVolume(value: number): void {
    audioEngine.setVolume(value);
    this.emitChange();
  }

  setMuted(muted: boolean): void {
    audioEngine.setMuted(muted);
    this.emitChange();
  }

  setPlaybackRate(rate: number): void {
    audioEngine.setPlaybackRate(rate);
  }

  setCrossfade(seconds: number): void {
    audioEngine.setCrossfade(seconds);
  }

  setReplayGain(mode: ReplayGainMode, preventClipping: boolean): void {
    audioEngine.setReplayGain(mode, preventClipping);
  }

  setEq(bands: readonly EqBand[], enabled: boolean, preampDb: number): void {
    audioEngine.setEqBands(bands);
    audioEngine.setEqPreamp(preampDb);
    audioEngine.setEqEnabled(enabled);
  }

  // -------------------------------------------------------------------------
  // Sleep timer (spec §15)
  // -------------------------------------------------------------------------

  startSleepTimer(minutes: number, options: { finishTrack?: boolean } = {}): void {
    this.cancelSleepTimer();
    const ms = Math.max(1, minutes) * 60_000;
    this.sleepEndsAt = Date.now() + ms;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      this.sleepEndsAt = null;
      // "Finish the track" is a flag `onEnded`/`onNearEnd` honour, rather than
      // an extra `ended` listener: that raced the normal advance (which then
      // started the next track anyway) and leaked if the timer was cancelled.
      if (options.finishTrack && this.status === 'playing') this.stopAfterTrack = true;
      else this.pause();
      this.emitChange();
    }, ms);
    this.emitChange();
  }

  cancelSleepTimer(): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepEndsAt = null;
    this.stopAfterTrack = false;
    this.emitChange();
  }

  sleepTimerEndsAt(): number | null {
    return this.sleepEndsAt;
  }

  // -------------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------------

  getState(): PlayerState {
    return {
      queue: this.queue,
      track: this.track,
      status: this.status,
      positionSec: this.positionSec,
      durationSec: this.durationSec,
      volume: audioEngine.getVolume(),
      muted: audioEngine.isMuted(),
      error: this.error,
    };
  }

  upcoming(limit?: number): QueueItem[] {
    return Q.upcoming(this.queue, limit);
  }

  on<K extends keyof PlayerEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadCurrent(options: {
    autoplay: boolean;
    startAtSec?: number;
    /** An automatic advance: a missing file is skipped rather than stalled on. */
    auto?: boolean;
  }): Promise<void> {
    const seq = ++this.loadSeq;
    const trackId = Q.currentTrackId(this.queue);
    if (!trackId) {
      // The queue is empty: nothing may keep playing behind a disabled Play button.
      this.flushHeardTime();
      this.track = null;
      this.positionSec = 0;
      this.durationSec = 0;
      this.preloadedTrackId = null;
      audioEngine.stop();
      clearMediaSession();
      this.emit('trackChange', { track: null });
      this.emitChange();
      return;
    }

    this.flushHeardTime();
    this.heardMs = 0;
    this.playRecorded = false;
    this.lastTickAt = 0;
    this.error = null;

    const track = await getTrack(trackId);
    if (seq !== this.loadSeq) return;
    if (!track) {
      // The row is gone; drop it from the queue and move on rather than stalling.
      log.warn(`track ${trackId} no longer exists; skipping`);
      const item = Q.currentItem(this.queue);
      if (item) this.queue = Q.removeItem(this.queue, item.uid);
      await this.loadCurrent(options);
      return;
    }

    this.track = track;
    this.durationSec = track.durationMs / 1000;
    this.positionSec = options.startAtSec ?? 0;
    this.emit('trackChange', { track });
    this.emitChange();

    const file = await openTrackFile(track);
    if (seq !== this.loadSeq) return;
    if (!file) {
      // Stop first: otherwise the previous track keeps playing under a UI that
      // shows this one, and Play/Pause no longer reaches it.
      audioEngine.stop();
      this.fail(
        `“${track.title}” could not be opened. The file may have been moved or the folder needs reconnecting.`,
      );
      if (options.auto) await this.skipUnplayable();
      return;
    }

    try {
      await audioEngine.load(track, file, {
        autoplay: options.autoplay,
        startAtSec: options.startAtSec,
      });
      if (seq !== this.loadSeq) return;
      this.autoSkips = 0;
      this.preloadedTrackId = null;
      await this.updateNowPlaying();
      if (seq !== this.loadSeq) return;
      this.persist();
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.fail(describeError(error));
    }
  }

  /**
   * Move past a track that could not be opened during an automatic advance.
   *
   * Capped at one lap of the queue, so "repeat all" over a disconnected folder
   * stops with an error instead of spinning forever.
   */
  private async skipUnplayable(): Promise<void> {
    if (++this.autoSkips >= Q.queueLength(this.queue)) {
      this.autoSkips = 0;
      return;
    }
    // 'user' so that repeat-one moves on instead of retrying the same file.
    const advanced = Q.advance(this.queue, 'user');
    if (!advanced) {
      this.autoSkips = 0;
      return;
    }
    this.queue = advanced;
    await this.loadCurrent({ autoplay: true, auto: true });
  }

  private onProgress(snapshot: EngineSnapshot): void {
    this.positionSec = snapshot.positionSec;
    if (snapshot.durationSec > 0) this.durationSec = snapshot.durationSec;

    // Accumulate only while actually playing, so pausing does not inflate the
    // heard time and turn a glance into a play.
    if (this.status === 'playing') {
      const now = Date.now();
      if (this.lastTickAt > 0) this.heardMs += Math.min(now - this.lastTickAt, 2000);
      this.lastTickAt = now;
      void this.maybeRecordPlay();
    }

    setPositionState(this.durationSec, this.positionSec, audioEngine.getPlaybackRate());
    this.emit('progress', { positionSec: this.positionSec, durationSec: this.durationSec });
    this.persist();
  }

  private onStatusChange(snapshot: EngineSnapshot): void {
    const wasPlaying = this.status === 'playing';
    this.status = snapshot.status;
    if (snapshot.status !== 'playing') this.lastTickAt = 0;
    setPlaybackState(
      snapshot.status === 'playing' ? 'playing' : snapshot.status === 'paused' ? 'paused' : 'none',
    );
    this.emitChange();
    // Progress stops arriving once paused, so save the exact resume point now.
    if (wasPlaying && snapshot.status === 'paused') this.persist();
  }

  /**
   * Prepare the handoff.
   *
   * Preloading here rather than on track start means the next file is opened
   * moments before it is needed, not minutes — one fewer open handle and one
   * fewer decoder warmed up for a track the user may well skip past.
   */
  private async onNearEnd(): Promise<void> {
    if (this.handingOff) return;
    // The sleep timer wants this track to end and nothing to follow it.
    if (this.stopAfterTrack) return;
    const next = Q.peekNext(this.queue);
    if (!next || next.trackId === this.track?.id) return;
    if (this.preloadedTrackId === next.trackId) return;

    // If the user moves on while the next file is being opened, this preload
    // belongs to a track change that no longer applies; handing off anyway
    // would advance the queue a second time.
    const seq = this.loadSeq;
    const stale = () => seq !== this.loadSeq || Q.peekNext(this.queue)?.uid !== next.uid;

    const track = await getTrack(next.trackId);
    if (!track || stale()) return;
    const file = await openTrackFile(track);
    if (stale()) return;
    if (!file) {
      log.warn(`could not preload ${track.title}`);
      return;
    }
    await audioEngine.preload(track, file);
    if (stale()) return;
    this.preloadedTrackId = track.id;

    // With crossfade on, the overlap starts now.
    if (audioEngine.getCrossfade() > 0 && !this.stopAfterTrack) await this.performHandoff();
  }

  private async onEnded(): Promise<void> {
    this.flushHeardTime();
    if (this.handingOff) return;
    if (this.stopAfterTrack) {
      // Sleep timer: the track has finished, so stop here with the next one
      // cued, ready for whenever the user presses play again.
      this.stopAfterTrack = false;
      this.preloadedTrackId = null;
      const advanced = Q.advance(this.queue, 'user');
      if (advanced) {
        this.queue = advanced;
        await this.loadCurrent({ autoplay: false });
      } else {
        this.emitChange();
      }
      return;
    }
    // Crossfade already moved us on; a plain end has to advance now.
    if (this.preloadedTrackId && audioEngine.getCrossfade() === 0) {
      await this.performHandoff();
      return;
    }
    await this.next('auto');
  }

  /** Swap decks and move the queue cursor to match. */
  private async performHandoff(): Promise<void> {
    if (this.handingOff) return;
    this.handingOff = true;
    try {
      const seq = this.loadSeq;
      const advanced = Q.advance(this.queue, 'auto');
      if (!advanced) return;
      const swapped = await audioEngine.handoff();
      // A user skip during the swap has already chosen what plays next.
      if (seq !== this.loadSeq) return;
      if (!swapped) {
        await this.next('auto');
        return;
      }
      const handoffSeq = ++this.loadSeq;
      this.queue = advanced;
      const trackId = Q.currentTrackId(this.queue);
      const track = trackId ? ((await getTrack(trackId)) ?? null) : null;
      if (handoffSeq !== this.loadSeq) return;
      this.track = track;
      this.durationSec = (this.track?.durationMs ?? 0) / 1000;
      this.heardMs = 0;
      this.playRecorded = false;
      this.lastTickAt = Date.now();
      this.preloadedTrackId = null;
      this.emit('trackChange', { track: this.track });
      this.emitChange();
      await this.updateNowPlaying();
      this.persist();
    } finally {
      this.handingOff = false;
    }
  }

  private onEngineError(message: string): void {
    this.fail(message);
  }

  private fail(message: string): void {
    this.error = message;
    this.status = 'error';
    log.warn(message);
    this.emit('error', { message });
    this.emitChange();
  }

  private async maybeRecordPlay(): Promise<void> {
    if (this.playRecorded || !this.track) return;
    // An unknown duration (0) would make the threshold zero and count a play on
    // the first tick; fall back to what the element reports, then to the cap.
    const durationMs = this.track.durationMs > 0 ? this.track.durationMs : this.durationSec * 1000;
    const threshold =
      durationMs > 0 ? Math.min(durationMs * PLAY_THRESHOLD_RATIO, PLAY_THRESHOLD_MS) : PLAY_THRESHOLD_MS;
    if (this.heardMs < threshold) return;
    this.playRecorded = true;
    try {
      await recordPlay(this.track.id, this.heardMs, true);
      // The in-memory copy would otherwise show a stale play count.
      this.track = { ...this.track, playCount: this.track.playCount + 1, lastPlayedAt: Date.now() };
      this.emitChange();
    } catch (error) {
      log.warn('could not record play', error);
    }
  }

  /** Record a partial play when leaving a track that never hit the threshold. */
  private flushHeardTime(): void {
    if (!this.track || this.playRecorded || this.heardMs < 5000) return;
    void recordPlay(this.track.id, this.heardMs, false).catch(() => undefined);
    this.playRecorded = true;
  }

  private async updateNowPlaying(): Promise<void> {
    if (!this.track) {
      clearMediaSession();
      return;
    }
    let artwork: Blob | null = null;
    if (this.track.artworkId) {
      const stored = await getArtwork(this.track.artworkId).catch(() => undefined);
      artwork = stored?.thumb ?? stored?.data ?? null;
    }
    setNowPlaying({ track: this.track, artwork });
  }

  private async saveSession(): Promise<void> {
    if (this.queue.items.length === 0) return;
    const session: PersistedSession = {
      queue: this.queue.items,
      order: this.queue.order,
      index: this.queue.cursor,
      positionSec: this.positionSec,
      shuffle: this.queue.shuffle,
      shuffleSeed: this.queue.shuffleSeed,
      repeat: this.queue.repeat,
      savedAt: Date.now(),
    };
    await saveSession(session).catch((error) => log.warn('could not save session', error));
  }

  private emitChange(): void {
    this.emit('change', this.getState());
  }

  private emit<K extends keyof PlayerEvents>(event: K, payload: PlayerEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        log.error(`player listener for ${event} threw`, error);
      }
    }
  }
}

export const player = new PlayerController();
export { Q as queueOps };
