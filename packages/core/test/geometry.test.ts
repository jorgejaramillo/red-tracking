import { describe, expect, it } from 'vitest';
import type { WindowGeometry } from '@red-tracking/protocol';
import { calibrationTargets, compareGeometry, pxToDeg, quickTargets, seededRng, shuffle, validationTargets } from '../src/geometry';

const base: WindowGeometry = { screenX: 0, screenY: 25, outerWidth: 1440, outerHeight: 875, innerWidth: 1100, innerHeight: 780, dpr: 2, screenW: 1440, screenH: 900 };

describe('compareGeometry', () => {
  it('detects same / moved / resized / dpr', () => {
    expect(compareGeometry(base, { ...base })).toEqual({ kind: 'same' });
    expect(compareGeometry(base, { ...base, screenX: 120, screenY: 60 })).toEqual({ kind: 'moved', dx: 120, dy: 35 });
    expect(compareGeometry(base, { ...base, innerWidth: 900 })).toEqual({ kind: 'changed', reason: 'resize' });
    expect(compareGeometry(base, { ...base, dpr: 1 })).toEqual({ kind: 'changed', reason: 'dpr' });
    expect(compareGeometry(base, { ...base, screenW: 2560 })).toEqual({ kind: 'changed', reason: 'screen' });
  });
  it('tolerates sub-tolerance jitter', () => {
    expect(compareGeometry(base, { ...base, screenX: 1, innerHeight: 781 })).toEqual({ kind: 'same' });
  });
});

describe('targets', () => {
  it('produces 9 / 13 / 4 / 5 distinct in-bounds targets', () => {
    const vp = { w: 1000, h: 600 };
    for (const [targets, n] of [[calibrationTargets(9, vp), 9], [calibrationTargets(13, vp), 13], [validationTargets(vp), 4], [quickTargets(vp), 5]] as const) {
      expect(targets).toHaveLength(n);
      const keys = new Set(targets.map((t) => `${t.vx},${t.vy}`));
      expect(keys.size).toBe(n);
      for (const t of targets) {
        expect(t.vx).toBeGreaterThanOrEqual(0);
        expect(t.vx).toBeLessThanOrEqual(vp.w);
        expect(t.vy).toBeGreaterThanOrEqual(0);
        expect(t.vy).toBeLessThanOrEqual(vp.h);
      }
    }
  });
  it('validation targets never coincide with calibration targets', () => {
    const vp = { w: 1000, h: 600 };
    const cal = new Set(calibrationTargets(13, vp).map((t) => `${t.vx},${t.vy}`));
    for (const t of validationTargets(vp)) expect(cal.has(`${t.vx},${t.vy}`)).toBe(false);
  });
  it('shuffle is deterministic with a seed and keeps all elements', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6], seededRng(9));
    const b = shuffle([1, 2, 3, 4, 5, 6], seededRng(9));
    expect(a).toEqual(b);
    expect(a.slice().sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('pxToDeg', () => {
  it('≈ 40 px per degree at 60 cm', () => {
    expect(pxToDeg(40)).toBeCloseTo(1.0, 1);
  });
});
