import { describe, expect, it } from 'vitest';
import { blurGrid, buildLut, colorize, createGrid, depositPoints, gridSum, normalizeGrid, peak } from '../src/heatmap';

describe('heatmap', () => {
  it('deposits weights and preserves the total through blur (interior points)', () => {
    const g = createGrid(2000, 2000, 0.25);
    depositPoints(g, [{ x: 1000, y: 1000, w: 3 }, { x: 1010, y: 990, w: 2 }]);
    expect(gridSum(g)).toBeCloseTo(5, 6);
    blurGrid(g, 40);
    expect(gridSum(g)).toBeCloseTo(5, 3);
  });

  it('keeps the peak at the deposit location', () => {
    const g = createGrid(1200, 800, 0.25);
    depositPoints(g, [{ x: 300, y: 500, w: 10 }, { x: 900, y: 100, w: 1 }]);
    blurGrid(g, 30);
    const p = peak(g);
    expect(Math.abs(p.x - 300)).toBeLessThan(8);
    expect(Math.abs(p.y - 500)).toBeLessThan(8);
  });

  it('ignores out-of-bounds points', () => {
    const g = createGrid(100, 100, 1);
    depositPoints(g, [{ x: -5, y: 10, w: 1 }, { x: 500, y: 10, w: 1 }]);
    expect(gridSum(g)).toBe(0);
  });

  it('normalises to 0..1 and colorises with alpha increasing with intensity', () => {
    const g = createGrid(100, 100, 1);
    depositPoints(g, [{ x: 50, y: 50, w: 10 }]);
    blurGrid(g, 10);
    const norm = normalizeGrid(g);
    let max = 0;
    for (const v of norm) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 6);
    const rgba = colorize(norm, buildLut());
    const centre = (50 * g.w + 50) * 4;
    const edge = (5 * g.w + 5) * 4;
    expect(rgba[centre + 3]!).toBeGreaterThan(rgba[edge + 3]!);
    expect(rgba[edge + 3]).toBe(0);
  });
});
