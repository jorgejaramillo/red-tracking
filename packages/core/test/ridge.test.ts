import { describe, expect, it } from 'vitest';
import { RidgePoly2Model, type CalibSample } from '../src/model';
import { calibrationTargets, seededRng, validationTargets } from '../src/geometry';
import { FEATURE_SETS, featureDim, featureScaleFloors, mapFeatures } from '../src/poly';
import { makeFeatures } from './helpers';
import { emptyGram, gramAdd, ridgeSolve } from '../src/ridge';
import { syntheticFrame } from './helpers';

const W = 1440, H = 900;

function calibSamples(n: 9 | 13, rng: () => number, framesPerPoint = 25): CalibSample[] {
  const out: CalibSample[] = [];
  for (const t of calibrationTargets(n, { w: W, h: H })) {
    for (let k = 0; k < framesPerPoint; k++) {
      out.push({ features: syntheticFrame(t.vx, t.vy, W, H, rng), vx: t.vx, vy: t.vy, weight: 1, pointIndex: t.index });
    }
  }
  return out;
}

describe('feature mappings', () => {
  it('have consistent dimensions, scales and layout', () => {
    const f = makeFeatures([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11, 12, 13, 14, 15]);
    expect(featureDim('iris-linear')).toBe(5);
    expect(featureDim('iris-poly2')).toBe(15);
    expect(featureDim('iris-poly2-head')).toBe(26);
    for (const set of FEATURE_SETS) {
      const x = mapFeatures(set, f);
      expect(x.length).toBe(featureDim(set));
      expect(featureScaleFloors(set).length).toBe(featureDim(set));
      expect(x[0]).toBe(1);
      expect(x[1]).toBe(1);
    }
    const rich = mapFeatures('iris-poly2-head', f);
    expect(rich[5]).toBe(1 * 1); // first square
    expect(rich[6]).toBe(1 * 2); // first cross term
    expect(rich[15]).toBe(5); // yaw term
    expect(rich[23]).toBe(13); // inter-ocular
    expect(rich[25]).toBe(15); // EAR right
  });
});

describe('ridge solver', () => {
  it('recovers coefficients of an exact linear system', () => {
    const rng = seededRng(7);
    const n = 4;
    const g = emptyGram(n);
    const wTrueX = [3, -2, 0.5, 1];
    const wTrueY = [-1, 4, 2, -0.5];
    for (let i = 0; i < 200; i++) {
      const x = [1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
      const yx = x.reduce((s, v, k) => s + v * wTrueX[k]!, 0);
      const yy = x.reduce((s, v, k) => s + v * wTrueY[k]!, 0);
      gramAdd(g, x, yx, yy);
    }
    const sol = ridgeSolve(g, 1e-9)!;
    for (let k = 0; k < n; k++) {
      expect(sol.wx[k]).toBeCloseTo(wTrueX[k]!, 4);
      expect(sol.wy[k]).toBeCloseTo(wTrueY[k]!, 4);
    }
  });
});

describe('RidgePoly2Model', () => {
  it('fits 9-point calibration and predicts unseen targets within tolerance', () => {
    const rng = seededRng(42);
    const report = RidgePoly2Model.fit(calibSamples(9, rng));
    expect(report.nPoints).toBe(9);
    expect(report.trainRmsePx).toBeLessThan(40);
    expect(report.cvRmsePx).not.toBeNull();

    // Validation targets are never calibration points.
    let sum = 0;
    for (const t of validationTargets({ w: W, h: H })) {
      let sx = 0, sy = 0;
      const n = 20;
      for (let k = 0; k < n; k++) {
        const [x, y] = report.model.predict(syntheticFrame(t.vx, t.vy, W, H, rng));
        sx += x;
        sy += y;
      }
      const err = Math.hypot(sx / n - t.vx, sy / n - t.vy);
      sum += err;
      expect(err).toBeLessThan(60);
    }
    expect(sum / 4).toBeLessThan(40);
  });

  it('13 points is at least as good as 9 on held-out targets', () => {
    const r9 = RidgePoly2Model.fit(calibSamples(9, seededRng(3)));
    const r13 = RidgePoly2Model.fit(calibSamples(13, seededRng(3)));
    const rng = seededRng(99);
    const err = (m: RidgePoly2Model) => {
      let s = 0;
      for (const t of validationTargets({ w: W, h: H })) {
        const [x, y] = m.predict(syntheticFrame(t.vx, t.vy, W, H, rng, 0));
        s += Math.hypot(x - t.vx, y - t.vy);
      }
      return s / 4;
    };
    expect(err(r13.model)).toBeLessThanOrEqual(err(r9.model) * 1.25);
  });

  it('cross-validation picks a λ and a feature set from the candidates', () => {
    const report = RidgePoly2Model.fit(calibSamples(9, seededRng(5)), { lambdas: [0.1, 1, 10] });
    expect([0.1, 1, 10]).toContain(report.lambda);
    expect(FEATURE_SETS).toContain(report.featureSet);
    expect(report.candidates.length).toBe(FEATURE_SETS.length * 3);
  });

  it('is robust when head-pose features barely vary during calibration but shift later', () => {
    // Calibrate with the head perfectly still …
    const rng = seededRng(77);
    const still = calibSamples(9, rng).map((s) => {
      s.features.core[4] = 0.001; // yaw/45 ≈ 0
      s.features.core[9] = -4.0; // tz/10 constant
      return s;
    });
    const report = RidgePoly2Model.fit(still);
    // … then predict with a small head shift (2° yaw, 1 cm closer). Must not explode.
    const f = syntheticFrame(700, 400, W, H, rng, 0);
    f.core[4] = 2 / 45;
    f.core[9] = -3.9;
    const [x, y] = report.model.predict(f);
    expect(Math.hypot(x - 700, y - 400)).toBeLessThan(120);
  });

  it('serialises and deserialises to identical predictions', () => {
    const report = RidgePoly2Model.fit(calibSamples(9, seededRng(11)));
    const clone = RidgePoly2Model.fromJSON(JSON.parse(JSON.stringify(report.model.toJSON())));
    const f = syntheticFrame(300, 500, W, H, seededRng(2));
    const a = report.model.predict(f);
    const b = clone.predict(f);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it('rejects too few samples', () => {
    expect(() => RidgePoly2Model.fit([])).toThrow();
  });
});
