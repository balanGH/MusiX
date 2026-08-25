/**
 * Queue behaviour.
 *
 * The queue is pure, which is what makes shuffle and repeat testable rather
 * than something you verify by listening. These tests pin down the behaviours
 * users notice immediately when they are wrong: shuffle keeping the current
 * track, repeat-one not trapping the next button, and removing a played track
 * not skipping the one that is playing.
 */

import { describe, expect, it } from 'vitest';
import * as Q from '@core/playback/queue';

const TRACKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** The track ids in play order. */
function playOrder(state: Q.QueueState): string[] {
  return state.order.map((index) => state.items[index]!.trackId);
}

describe('creating a queue', () => {
  it('starts at the chosen track', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 3 });
    expect(Q.currentTrackId(queue)).toBe('d');
    expect(Q.queueLength(queue)).toBe(8);
  });

  it('plays the chosen track first even when shuffled', () => {
    // Clicking a song in a shuffled library must play *that* song, then wander.
    for (let attempt = 0; attempt < 20; attempt++) {
      const queue = Q.createQueue(TRACKS, { startIndex: 5, shuffle: true });
      expect(Q.currentTrackId(queue)).toBe('f');
      expect(playOrder(queue)).toHaveLength(8);
      expect(new Set(playOrder(queue)).size).toBe(8);
    }
  });

  it('produces the same order for the same seed', () => {
    const a = Q.createQueue(TRACKS, { shuffle: true, seed: 12345 });
    const b = Q.createQueue(TRACKS, { shuffle: true, seed: 12345 });
    expect(playOrder(a)).toEqual(playOrder(b));
  });
});

describe('advancing', () => {
  it('moves forward and stops at the end with repeat off', () => {
    let queue = Q.createQueue(TRACKS, { startIndex: 6 });
    queue = Q.advance(queue, 'user')!;
    expect(Q.currentTrackId(queue)).toBe('h');
    expect(Q.advance(queue, 'user')).toBeNull();
  });

  it('wraps with repeat all', () => {
    let queue = Q.createQueue(TRACKS, { startIndex: 7, repeat: 'all' });
    queue = Q.advance(queue, 'auto')!;
    expect(Q.currentTrackId(queue)).toBe('a');
  });

  it('repeats the same track automatically but not on a user skip', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 2, repeat: 'one' });

    // Track ended by itself: stay put.
    const auto = Q.advance(queue, 'auto')!;
    expect(Q.currentTrackId(auto)).toBe('c');

    // User pressed next: move on. Otherwise repeat-one traps them.
    const manual = Q.advance(queue, 'user')!;
    expect(Q.currentTrackId(manual)).toBe('d');
  });

  it('reshuffles each lap of repeat-all', () => {
    const first = Q.createQueue(TRACKS, { shuffle: true, repeat: 'all', seed: 7 });
    let queue = first;
    // Walk to the end.
    for (let i = 0; i < TRACKS.length - 1; i++) queue = Q.advance(queue, 'auto')!;
    const wrapped = Q.advance(queue, 'auto')!;

    expect(wrapped.cursor).toBe(0);
    // A fixed permutation replayed forever does not feel shuffled.
    expect(wrapped.shuffleSeed).not.toBe(first.shuffleSeed);
  });

  it('retreat stops at the first track', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 0 });
    expect(Q.retreat(queue).cursor).toBe(queue.cursor);
  });
});

describe('toggling shuffle mid-listen', () => {
  it('keeps the current track current and only shuffles what is left', () => {
    const linear = Q.createQueue(TRACKS, { startIndex: 3 });
    const shuffled = Q.setShuffle(linear, true);

    expect(Q.currentTrackId(shuffled)).toBe('d');
    // Already-played tracks keep their place.
    expect(playOrder(shuffled).slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(new Set(playOrder(shuffled)).size).toBe(8);
  });

  it('returns to the visible order when switched off, still on the same track', () => {
    const linear = Q.createQueue(TRACKS, { startIndex: 3 });
    const restored = Q.setShuffle(Q.setShuffle(linear, true), false);

    expect(playOrder(restored)).toEqual(TRACKS);
    expect(Q.currentTrackId(restored)).toBe('d');
  });
});

describe('editing the queue', () => {
  it('inserts "play next" directly after the current track', () => {
    const queue = Q.insertNext(Q.createQueue(TRACKS, { startIndex: 2 }), ['x', 'y']);
    const next = Q.advance(queue, 'user')!;
    expect(Q.currentTrackId(next)).toBe('x');
    expect(Q.currentTrackId(Q.advance(next, 'user')!)).toBe('y');
    // The original next track still follows.
    expect(Q.currentTrackId(Q.advance(Q.advance(next, 'user')!, 'user')!)).toBe('d');
  });

  it('appends to the end', () => {
    const queue = Q.append(Q.createQueue(TRACKS), ['z']);
    expect(Q.queueLength(queue)).toBe(9);
    expect(playOrder(queue).at(-1)).toBe('z');
  });

  it('removing an already-played track does not skip the current one', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 4 });
    expect(Q.currentTrackId(queue)).toBe('e');

    const removed = Q.removeItem(queue, queue.items[1]!.uid); // 'b', already played
    expect(Q.currentTrackId(removed)).toBe('e');
    expect(Q.queueLength(removed)).toBe(7);
  });

  it('removing the current track moves to the next one', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 4 });
    const removed = Q.removeItem(queue, queue.items[4]!.uid);
    expect(Q.currentTrackId(removed)).toBe('f');
  });

  it('reordering keeps the cursor on the same track', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 2 });
    const moved = Q.moveItem(queue, 0, 7); // 'a' to the end
    expect(Q.currentTrackId(moved)).toBe('c');
    expect(moved.items.at(-1)!.trackId).toBe('a');
  });

  it('clearing up next keeps history and the current track', () => {
    const queue = Q.clearUpcoming(Q.createQueue(TRACKS, { startIndex: 3 }));
    expect(Q.currentTrackId(queue)).toBe('d');
    expect(Q.queueLength(queue)).toBe(4);
    expect(Q.upcoming(queue)).toHaveLength(0);
  });

  it('drops tracks whose files have gone', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 0 });
    const pruned = Q.pruneMissing(queue, new Set(['a', 'c', 'e']));
    expect(pruned.items.map((item) => item.trackId)).toEqual(['a', 'c', 'e']);
  });

  it('allows the same track more than once', () => {
    // A playlist that deliberately repeats a track must not be deduplicated.
    const queue = Q.append(Q.createQueue(['a']), ['a', 'a']);
    expect(Q.queueLength(queue)).toBe(3);
    expect(new Set(queue.items.map((item) => item.uid)).size).toBe(3);
  });
});

describe('inspection', () => {
  it('reports what is coming and what has been played', () => {
    const queue = Q.createQueue(TRACKS, { startIndex: 3 });
    expect(Q.upcoming(queue, 2).map((item) => item.trackId)).toEqual(['e', 'f']);
    expect(Q.history(queue, 2).map((item) => item.trackId)).toEqual(['c', 'b']);
  });

  it('cycles repeat off → all → one → off', () => {
    let queue = Q.createQueue(TRACKS);
    expect(queue.repeat).toBe('off');
    queue = Q.cycleRepeat(queue);
    expect(queue.repeat).toBe('all');
    queue = Q.cycleRepeat(queue);
    expect(queue.repeat).toBe('one');
    queue = Q.cycleRepeat(queue);
    expect(queue.repeat).toBe('off');
  });
});
