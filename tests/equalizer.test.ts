/**
 * Equaliser graph routing.
 *
 * These exist because of a bug that made MusiX completely silent on a fresh
 * launch: the equaliser starts disabled and flat, so its first `applyRouting`
 * call found nothing had changed and returned before ever connecting `input`
 * to anything. Audio reached the equaliser and stopped there. Moving a slider
 * made the state differ, which finally wired the graph — so the app appeared
 * to "need the equaliser touched" before it would play.
 *
 * A unit test catches it where a browser test would not have been written:
 * the whole failure is one missing `connect()`, and a fake context can see
 * that directly.
 */

import { describe, expect, it } from 'vitest';
import { Equalizer, EQ_FREQUENCIES, flatBands, presetBands } from '@core/audio/equalizer';

// ---------------------------------------------------------------------------
// A fake AudioContext that records the graph
// ---------------------------------------------------------------------------

interface FakeNode {
  kind: string;
  outputs: FakeNode[];
  connect(target: FakeNode): FakeNode;
  disconnect(): void;
}

function makeParam(value = 0) {
  return {
    value,
    setTargetAtTime(target: number) {
      // The real node ramps; for routing purposes the end value is what matters.
      this.value = target;
    },
  };
}

function makeNode(kind: string): FakeNode {
  return {
    kind,
    outputs: [],
    connect(target: FakeNode) {
      this.outputs.push(target);
      return target;
    },
    disconnect() {
      this.outputs = [];
    },
  };
}

function fakeContext() {
  return {
    currentTime: 0,
    createGain: () => ({ ...makeNode('gain'), gain: makeParam(1) }),
    createBiquadFilter: () => ({
      ...makeNode('biquad'),
      type: 'peaking',
      frequency: makeParam(0),
      Q: makeParam(1),
      gain: makeParam(0),
      getFrequencyResponse(
        frequencies: Float32Array,
        magnitude: Float32Array,
        phase: Float32Array,
      ) {
        magnitude.fill(1);
        phase.fill(0);
        void frequencies;
      },
    }),
  } as unknown as BaseAudioContext;
}

/** Can audio get from `from` to `to` by following connections? */
function reaches(from: FakeNode, to: unknown, seen = new Set<FakeNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.outputs.some((next) => reaches(next, to, seen));
}

const asNode = (value: unknown) => value as unknown as FakeNode;

// ---------------------------------------------------------------------------

describe('routing', () => {
  it('connects input to output on construction, before anything is touched', () => {
    const equalizer = new Equalizer(fakeContext());

    // The regression. This was zero, and the app played silence.
    expect(asNode(equalizer.input).outputs.length).toBeGreaterThan(0);
    expect(reaches(asNode(equalizer.input), equalizer.output)).toBe(true);
  });

  it('starts bypassed, since it starts disabled and flat', () => {
    const equalizer = new Equalizer(fakeContext());

    expect(equalizer.isBypassed()).toBe(true);
    // Bypassed means straight to output, not through eleven filter nodes.
    expect(asNode(equalizer.input).outputs[0]).toBe(asNode(equalizer.output));
  });

  it('still passes audio when enabled with flat bands', () => {
    const equalizer = new Equalizer(fakeContext());
    equalizer.setEnabled(true);

    // Enabled but flat is still a bypass — and must still be audible.
    expect(equalizer.isBypassed()).toBe(true);
    expect(reaches(asNode(equalizer.input), equalizer.output)).toBe(true);
  });

  it('routes through the filters once a band is moved, and stays audible', () => {
    const equalizer = new Equalizer(fakeContext());
    equalizer.setEnabled(true);
    equalizer.setBands(presetBands('Rock'));

    expect(equalizer.isBypassed()).toBe(false);
    // No longer a direct hop, but still connected end to end.
    expect(asNode(equalizer.input).outputs[0]).not.toBe(asNode(equalizer.output));
    expect(reaches(asNode(equalizer.input), equalizer.output)).toBe(true);
  });

  it('returns to a bypass when the bands go flat again, without losing audio', () => {
    const equalizer = new Equalizer(fakeContext());
    equalizer.setEnabled(true);
    equalizer.setBands(presetBands('Rock'));
    equalizer.setBands(flatBands());

    expect(equalizer.isBypassed()).toBe(true);
    expect(reaches(asNode(equalizer.input), equalizer.output)).toBe(true);
  });

  it('stays audible across any sequence of toggles', () => {
    const equalizer = new Equalizer(fakeContext());

    for (const step of [
      () => equalizer.setEnabled(true),
      () => equalizer.setBands(presetBands('Bass')),
      () => equalizer.setEnabled(false),
      () => equalizer.setEnabled(true),
      () => equalizer.setBands(flatBands()),
      () => equalizer.setBand(0, 6),
      () => equalizer.setEnabled(false),
    ]) {
      step();
      // Whatever the state, audio must always have a path out.
      expect(reaches(asNode(equalizer.input), equalizer.output)).toBe(true);
    }
  });
});

describe('bands', () => {
  it('exposes one band per ISO centre frequency', () => {
    const equalizer = new Equalizer(fakeContext());
    expect(equalizer.getBands().map((band) => band.frequency)).toEqual([...EQ_FREQUENCIES]);
  });

  it('clamps a band to the usable range', () => {
    const equalizer = new Equalizer(fakeContext());
    equalizer.setBand(0, 999);
    expect(equalizer.getBands()[0]!.gainDb).toBe(12);
    equalizer.setBand(0, -999);
    expect(equalizer.getBands()[0]!.gainDb).toBe(-12);
  });
});
