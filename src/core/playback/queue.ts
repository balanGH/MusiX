/**
 * The play queue, as pure functions.
 *
 * No engine, no database, no React — every operation takes a state and returns
 * a new one, which is what makes shuffle and repeat behaviour something that
 * can actually be unit-tested rather than argued about.
 *
 * **Shape.** `items` is the queue as the user built it, in the order they see.
 * `order` is the *playback* sequence: an index permutation of `items`, identity
 * when shuffle is off. `cursor` indexes `order`, not `items`.
 *
 * Keeping the two separate is what makes shuffle non-destructive: turning it off
 * restores the visible order exactly, and turning it on again reshuffles only
 * what has not been played, leaving the current track where it is.
 */

import { seededRandom, shuffle as shuffleArray, uid } from '../utils';
import type { QueueItem, RepeatMode } from '../types';

export interface QueueState {
  items: QueueItem[];
  /** Indices into `items`, in playback order. */
  order: number[];
  /** Position within `order`. -1 when the queue is empty. */
  cursor: number;
  shuffle: boolean;
  /** Persisted so a restored shuffled queue keeps the order the user left. */
  shuffleSeed: number;
  repeat: RepeatMode;
}

export function emptyQueue(): QueueState {
  return { items: [], order: [], cursor: -1, shuffle: false, shuffleSeed: 1, repeat: 'off' };
}

function toItems(trackIds: readonly string[]): QueueItem[] {
  return trackIds.map((trackId) => ({ uid: uid('q'), trackId }));
}

function identityOrder(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

/**
 * Build a queue from a list of tracks.
 *
 * With shuffle on, the chosen track still plays first — clicking a song in a
 * shuffled library should play *that* song, then wander.
 */
export function createQueue(
  trackIds: readonly string[],
  options: { startIndex?: number; shuffle?: boolean; repeat?: RepeatMode; seed?: number } = {},
): QueueState {
  const items = toItems(trackIds);
  const shuffleOn = options.shuffle ?? false;
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff) + 1;
  const startIndex = Math.max(0, Math.min(options.startIndex ?? 0, items.length - 1));

  let order = identityOrder(items.length);
  let cursor = items.length === 0 ? -1 : startIndex;

  if (shuffleOn && items.length > 1) {
    order = shuffleKeepingFirst(order, startIndex, seed);
    cursor = 0;
  }

  return {
    items,
    order,
    cursor,
    shuffle: shuffleOn,
    shuffleSeed: seed,
    repeat: options.repeat ?? 'off',
  };
}

/** Shuffle `order` so that `keepIndex` is first and the rest are permuted. */
function shuffleKeepingFirst(order: readonly number[], keepIndex: number, seed: number): number[] {
  const rest = order.filter((index) => index !== keepIndex);
  shuffleArray(rest, seededRandom(seed));
  return [keepIndex, ...rest];
}

export function currentItem(state: QueueState): QueueItem | null {
  if (state.cursor < 0 || state.cursor >= state.order.length) return null;
  const itemIndex = state.order[state.cursor];
  return itemIndex === undefined ? null : (state.items[itemIndex] ?? null);
}

export function currentTrackId(state: QueueState): string | null {
  return currentItem(state)?.trackId ?? null;
}

/** The item that will play after the current one, without advancing. */
export function peekNext(state: QueueState): QueueItem | null {
  const advanced = advance(state, 'auto');
  return advanced ? currentItem(advanced) : null;
}

export function queueLength(state: QueueState): number {
  return state.items.length;
}

/** Items in playback order — what the Up Next panel shows. */
export function upcoming(state: QueueState, limit = 100): QueueItem[] {
  const out: QueueItem[] = [];
  for (let i = state.cursor + 1; i < state.order.length && out.length < limit; i++) {
    const item = state.items[state.order[i]!];
    if (item) out.push(item);
  }
  return out;
}

export function history(state: QueueState, limit = 100): QueueItem[] {
  const out: QueueItem[] = [];
  for (let i = state.cursor - 1; i >= 0 && out.length < limit; i--) {
    const item = state.items[state.order[i]!];
    if (item) out.push(item);
  }
  return out;
}

/**
 * Move forward.
 *
 * `reason` distinguishes a track ending on its own from the user pressing next,
 * because `repeat: 'one'` should loop automatically but must not trap the user
 * on the same track when they explicitly ask for the next one.
 */
export function advance(state: QueueState, reason: 'auto' | 'user'): QueueState | null {
  if (state.order.length === 0) return null;

  if (state.repeat === 'one' && reason === 'auto') return { ...state };

  const next = state.cursor + 1;
  if (next < state.order.length) return { ...state, cursor: next };

  if (state.repeat === 'all') {
    // Reshuffle on each lap, otherwise "shuffle + repeat all" replays one fixed
    // permutation forever, which does not feel shuffled at all.
    if (state.shuffle && state.items.length > 2) {
      const seed = (state.shuffleSeed * 1664525 + 1013904223) & 0x7fffffff;
      const order = identityOrder(state.items.length);
      shuffleArray(order, seededRandom(seed));
      return { ...state, order, cursor: 0, shuffleSeed: seed };
    }
    return { ...state, cursor: 0 };
  }

  return null; // End of queue.
}

/**
 * Move back.
 *
 * At the first track this returns the same state, so the caller can implement
 * the usual "restart the current track" behaviour.
 */
export function retreat(state: QueueState): QueueState {
  if (state.cursor <= 0) return { ...state };
  return { ...state, cursor: state.cursor - 1 };
}

export function jumpTo(state: QueueState, itemUid: string): QueueState {
  const itemIndex = state.items.findIndex((item) => item.uid === itemUid);
  if (itemIndex === -1) return state;
  const orderIndex = state.order.indexOf(itemIndex);
  if (orderIndex === -1) return state;
  return { ...state, cursor: orderIndex };
}

/** Insert immediately after the current track ("Play next"). */
export function insertNext(state: QueueState, trackIds: readonly string[]): QueueState {
  if (trackIds.length === 0) return state;
  const added = toItems(trackIds);

  if (state.items.length === 0) return createQueue(trackIds, { shuffle: state.shuffle, repeat: state.repeat });

  const currentItemIndex = state.order[state.cursor] ?? 0;
  const items = [...state.items];
  items.splice(currentItemIndex + 1, 0, ...added);

  // Every index above the insertion point shifts; the new items go straight
  // after the cursor in playback order.
  const shift = added.length;
  const order = state.order.map((index) => (index > currentItemIndex ? index + shift : index));
  const newIndices = added.map((_, offset) => currentItemIndex + 1 + offset);
  order.splice(state.cursor + 1, 0, ...newIndices);

  return { ...state, items, order };
}

/** Append to the end of the queue. */
export function append(state: QueueState, trackIds: readonly string[]): QueueState {
  if (trackIds.length === 0) return state;
  if (state.items.length === 0) {
    return createQueue(trackIds, { shuffle: state.shuffle, repeat: state.repeat });
  }

  const added = toItems(trackIds);
  const items = [...state.items, ...added];
  const newIndices = added.map((_, offset) => state.items.length + offset);
  // Appended tracks join the end of the play order even when shuffled: the user
  // asked for them last, so they play last.
  return { ...state, items, order: [...state.order, ...newIndices] };
}

export function removeItem(state: QueueState, itemUid: string): QueueState {
  const itemIndex = state.items.findIndex((item) => item.uid === itemUid);
  if (itemIndex === -1) return state;

  const orderIndex = state.order.indexOf(itemIndex);
  const items = state.items.filter((_, index) => index !== itemIndex);
  const order = state.order
    .filter((index) => index !== itemIndex)
    .map((index) => (index > itemIndex ? index - 1 : index));

  // Removing something already played must not skip the current track.
  let cursor = state.cursor;
  if (orderIndex !== -1 && orderIndex < state.cursor) cursor -= 1;
  else if (orderIndex === state.cursor) cursor = Math.min(state.cursor, order.length - 1);

  return { ...state, items, order, cursor: order.length === 0 ? -1 : cursor };
}

/** Reorder the *visible* queue (drag and drop in the queue panel). */
export function moveItem(state: QueueState, fromIndex: number, toIndex: number): QueueState {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= state.items.length ||
    toIndex >= state.items.length
  ) {
    return state;
  }

  const currentUid = currentItem(state)?.uid ?? null;
  const items = [...state.items];
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved!);

  // With shuffle off the visible order *is* the play order, so rebuild it and
  // keep the cursor on the same track.
  if (!state.shuffle) {
    const order = identityOrder(items.length);
    const cursor = currentUid ? items.findIndex((item) => item.uid === currentUid) : state.cursor;
    return { ...state, items, order, cursor: cursor === -1 ? state.cursor : cursor };
  }

  // With shuffle on, reordering the visible list must not disturb the shuffled
  // play order, so `order` is remapped through the new positions.
  const uidToNewIndex = new Map(items.map((item, index) => [item.uid, index]));
  const order = state.order
    .map((oldIndex) => {
      const item = state.items[oldIndex];
      return item ? (uidToNewIndex.get(item.uid) ?? -1) : -1;
    })
    .filter((index) => index !== -1);

  return { ...state, items, order };
}

export function setShuffle(state: QueueState, shuffleOn: boolean): QueueState {
  if (state.shuffle === shuffleOn) return state;
  if (state.items.length === 0) return { ...state, shuffle: shuffleOn };

  const currentItemIndex = state.order[state.cursor] ?? 0;

  if (shuffleOn) {
    const seed = Math.floor(Math.random() * 0x7fffffff) + 1;
    // Everything already played keeps its place; the future is shuffled. This is
    // what makes toggling shuffle mid-listen feel right rather than jarring.
    const played = state.order.slice(0, state.cursor);
    const future = state.order.slice(state.cursor + 1);
    shuffleArray(future, seededRandom(seed));
    return {
      ...state,
      shuffle: true,
      shuffleSeed: seed,
      order: [...played, currentItemIndex, ...future],
      cursor: played.length,
    };
  }

  // Turning shuffle off returns to the visible order, cursor on the same track.
  return {
    ...state,
    shuffle: false,
    order: identityOrder(state.items.length),
    cursor: currentItemIndex,
  };
}

export function setRepeat(state: QueueState, repeat: RepeatMode): QueueState {
  return { ...state, repeat };
}

export function cycleRepeat(state: QueueState): QueueState {
  const next: RepeatMode = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  return setRepeat(state, next);
}

export function clearQueue(state: QueueState): QueueState {
  return { ...emptyQueue(), shuffle: state.shuffle, repeat: state.repeat };
}

/** Drop everything after the current track ("Clear up next"). */
export function clearUpcoming(state: QueueState): QueueState {
  if (state.cursor < 0) return state;
  const keptOrder = state.order.slice(0, state.cursor + 1);
  const keptItemIndices = new Set(keptOrder);
  const remap = new Map<number, number>();
  const items: QueueItem[] = [];
  for (let index = 0; index < state.items.length; index++) {
    if (!keptItemIndices.has(index)) continue;
    remap.set(index, items.length);
    items.push(state.items[index]!);
  }
  return {
    ...state,
    items,
    order: keptOrder.map((index) => remap.get(index)!),
    cursor: keptOrder.length - 1,
  };
}

/** Drop items whose track no longer exists (after a scan removed files). */
export function pruneMissing(state: QueueState, existingTrackIds: ReadonlySet<string>): QueueState {
  const missing = state.items.filter((item) => !existingTrackIds.has(item.trackId));
  return missing.reduce((next, item) => removeItem(next, item.uid), state);
}
