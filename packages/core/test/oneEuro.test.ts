import { describe, expect, it } from 'vitest';
import { OneEuro2D, OneEuroFilter } from '../src/oneEuro';
import { seededRng } from '../src/geometry';

describe('OneEuroFilter', () => {
  it('passes a constant signal unchanged', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 50; i++) expect(f.filter(100, i / 30)).toBeCloseTo(100, 6);
  });

  it('attenuates noise on a still signal', () => {
    const rng = seededRng(1);
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.007 });
    let rawVar = 0, filtVar = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      const noise = (rng() - 0.5) * 40;
      const out = f.filter(500 + noise, i / 30);
      if (i > 60) {
        rawVar += noise * noise;
        filtVar += (out - 500) ** 2;
        n++;
      }
    }
    expect(Math.sqrt(filtVar / n)).toBeLessThan(Math.sqrt(rawVar / n) * 0.5);
  });

  it('follows a fast step within a few frames (low lag)', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.007 });
    for (let i = 0; i < 30; i++) f.filter(0, i / 30);
    let out = 0;
    for (let i = 30; i < 40; i++) out = f.filter(600, i / 30);
    expect(out).toBeGreaterThan(540);
  });

  it('2D wrapper filters both axes', () => {
    const f = new OneEuro2D();
    const [x, y] = f.filter(10, 20, 0);
    expect(x).toBe(10);
    expect(y).toBe(20);
  });
});
