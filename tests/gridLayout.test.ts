import { describe, expect, it } from 'vitest';
import { computeGridLayout } from '@ui/gridLayout';

describe('computeGridLayout', () => {
  it('row height follows the stretched tile width, not the minimum', () => {
    // 700px wide, 168px minimum, 16px gap -> 3 columns of (700 - 32) / 3 = 222.67px.
    const layout = computeGridLayout(700, 168, 16, 52);
    expect(layout.columns).toBe(3);
    expect(layout.tileWidth).toBeCloseTo(222.667, 2);
    expect(layout.tileHeight).toBeCloseTo(222.667 + 52, 2);
    expect(layout.stride).toBeCloseTo(layout.tileHeight + 16, 5);
  });

  it('never lays out wider than the content box', () => {
    for (const width of [320, 328, 360, 412, 768, 1024, 1366]) {
      for (const min of [124, 132, 156, 168, 196, 216]) {
        const { columns, tileWidth } = computeGridLayout(width, min, 16, 48);
        const used = columns * tileWidth + (columns - 1) * 16;
        expect(used).toBeLessThanOrEqual(width + 1e-6);
      }
    }
  });

  it('falls back to one column (and no negative sizes) when very narrow', () => {
    expect(computeGridLayout(100, 168, 16, 52).columns).toBe(1);
    expect(computeGridLayout(100, 168, 16, 52).tileWidth).toBe(100);
    const zero = computeGridLayout(0, 168, 16, 52);
    expect(zero.columns).toBe(1);
    expect(zero.tileWidth).toBe(0);
  });
});
