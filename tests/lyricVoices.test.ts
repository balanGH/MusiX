/**
 * Singer markers in lyric lines (core/lyrics/voices.ts).
 */

import { describe, expect, it } from 'vitest';
import { assignVoices, hasVoices, splitVoice } from '@core/lyrics/voices';

describe('splitVoice', () => {
  it('reads the common marker forms and strips them', () => {
    expect(splitVoice('M: I have been waiting')).toEqual({ text: 'I have been waiting', voice: 'male' });
    expect(splitVoice('F:So have I')).toEqual({ text: 'So have I', voice: 'female' });
    expect(splitVoice('D: Together now')).toEqual({ text: 'Together now', voice: 'duet' });
    expect(splitVoice('Female: la la')).toEqual({ text: 'la la', voice: 'female' });
    expect(splitVoice('BOTH: oh')).toEqual({ text: 'oh', voice: 'duet' });
    expect(splitVoice('All: chorus')).toEqual({ text: 'chorus', voice: 'duet' });
    expect(splitVoice('(M) first')).toEqual({ text: 'first', voice: 'male' });
    expect(splitVoice('[F] second')).toEqual({ text: 'second', voice: 'female' });
  });

  it('reads Chinese duet markers and the full-width colon', () => {
    expect(splitVoice('男：我在等你')).toEqual({ text: '我在等你', voice: 'male' });
    expect(splitVoice('女：我也是')).toEqual({ text: '我也是', voice: 'female' });
    expect(splitVoice('合：一起')).toEqual({ text: '一起', voice: 'duet' });
    expect(splitVoice('F：こんにちは')).toEqual({ text: 'こんにちは', voice: 'female' });
  });

  it('leaves ordinary lyrics alone', () => {
    for (const line of ['Many: hands', 'Mind: the gap', 'Mama, just killed a man', 'Fly me to the moon', '']) {
      expect(splitVoice(line)).toEqual({ text: line, voice: null });
    }
  });
});

describe('assignVoices', () => {
  it('carries a marker over to the following lines until the next one', () => {
    const voiced = assignVoices(['intro', 'M: one', 'two', 'F: three', 'four', 'D: five']);
    expect(voiced.map((line) => line.voice)).toEqual([null, 'male', 'male', 'female', 'female', 'duet']);
    expect(voiced.map((line) => line.text)).toEqual(['intro', 'one', 'two', 'three', 'four', 'five']);
    expect(hasVoices(voiced)).toBe(true);
  });

  it('returns an unmarked sheet unchanged', () => {
    const lines = ['Hello', 'is it me', "you're looking for"];
    const voiced = assignVoices(lines);
    expect(voiced.map((line) => line.text)).toEqual(lines);
    expect(hasVoices(voiced)).toBe(false);
  });
});
