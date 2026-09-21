import { describe, expect, it } from 'vitest';
import { LANDMARK_COUNT, LM, type Landmark } from '../src/landmarks';
import { extractFeatures, gazeRays } from '../src/features';
import { poseFromMatrix } from '../src/headpose';
import { BlinkDetector } from '../src/blink';

/** A crude synthetic face in normalised coords; iris shifted by (ix, iy) eye-widths. */
function face(ix = 0, iy = 0, earScale = 1): Landmark[] {
  const lm: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i: number, x: number, y: number) => (lm[i] = { x, y, z: 0 });
  set(LM.L_OUTER, 0.35, 0.45); set(LM.L_INNER, 0.45, 0.45);
  set(LM.L_TOP, 0.40, 0.45 - 0.02 * earScale); set(LM.L_BOTTOM, 0.40, 0.45 + 0.02 * earScale);
  set(LM.R_INNER, 0.55, 0.45); set(LM.R_OUTER, 0.65, 0.45);
  set(LM.R_TOP, 0.60, 0.45 - 0.02 * earScale); set(LM.R_BOTTOM, 0.60, 0.45 + 0.02 * earScale);
  set(LM.L_IRIS, 0.40 + ix * 0.1, 0.45 + iy * 0.1); set(LM.R_IRIS, 0.60 + ix * 0.1, 0.45 + iy * 0.1);
  set(LM.NOSE_TIP, 0.5, 0.55); set(LM.CHIN, 0.5, 0.8); set(LM.FOREHEAD, 0.5, 0.25);
  set(LM.L_CHEEK, 0.3, 0.55); set(LM.R_CHEEK, 0.7, 0.55);
  return lm;
}

describe('extractFeatures', () => {
  it('returns null for incomplete landmark sets', () => {
    expect(extractFeatures([], null, 640, 480)).toBeNull();
  });
  it('encodes iris offsets relative to the eye and is finite everywhere', () => {
    const f0 = extractFeatures(face(0, 0), null, 640, 480)!;
    const f1 = extractFeatures(face(0.3, -0.2), null, 640, 480)!;
    expect(f0.core[0]).toBeCloseTo(0, 5);
    expect(f1.core[0]).toBeCloseTo(0.3, 5);
    expect(f1.core[1]).toBeLessThan(0);
    for (const v of [...f1.core, ...f1.linear]) expect(Number.isFinite(v)).toBe(true);
    expect(f0.earL).toBeGreaterThan(0.2);
  });
  it('uses the transformation matrix for head pose when provided', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.5, -2, -40, 1];
    const f = extractFeatures(face(), identity, 640, 480)!;
    expect(f.head.fromMatrix).toBe(true);
    expect(f.head.yaw).toBeCloseTo(0, 6);
    expect(f.head.tz).toBe(-40);
  });
  it('gaze rays start at the iris', () => {
    const f = extractFeatures(face(0.2, 0), null, 640, 480)!;
    const r = gazeRays(f);
    expect(r.l[0]).toBeCloseTo(f.irisL.x, 6);
    expect(r.l[2]).toBeGreaterThan(r.l[0]);
  });
});

describe('poseFromMatrix', () => {
  it('extracts yaw from a rotation about Y', () => {
    const a = (30 * Math.PI) / 180;
    // column-major R_y(a)
    const m = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
    const p = poseFromMatrix(m);
    expect(Math.abs(p.yaw)).toBeCloseTo(30, 4);
    expect(p.pitch).toBeCloseTo(0, 4);
    expect(p.roll).toBeCloseTo(0, 4);
  });
});

describe('BlinkDetector', () => {
  it('flags frames with a collapsed EAR and holds for a couple of frames', () => {
    const d = new BlinkDetector({ holdFrames: 2 });
    let t = 0;
    for (let i = 0; i < 60; i++, t += 33) expect(d.update(0.3, 0.3, t)).toBe(false);
    expect(d.update(0.08, 0.08, (t += 33))).toBe(true);
    expect(d.update(0.3, 0.3, (t += 33))).toBe(true); // hold 1
    expect(d.update(0.3, 0.3, (t += 33))).toBe(true); // hold 2
    expect(d.update(0.3, 0.3, (t += 33))).toBe(false);
    expect(d.baseline()).toBeCloseTo(0.3, 6);
  });
});
