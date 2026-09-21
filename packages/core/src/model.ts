import type { SerializedRidgeModel } from '@red-tracking/protocol';
import { FEATURE_VERSION, type FrameFeatures } from './features';
import { FEATURE_SETS, featureDim, featureScaleFloors, mapFeatures, type FeatureSet } from './poly';
import { type Gram, dot, emptyGram, gramAdd, gramAddInto, gramClone, ridgeSolve, standardize, zscoreFit } from './ridge';

export interface CalibSample {
  features: FrameFeatures;
  /** Target in viewport CSS px. */
  vx: number;
  vy: number;
  weight: number;
  /** Calibration point this sample belongs to (for leave-one-point-out CV). */
  pointIndex: number;
}

export interface GazeModel {
  predict(f: FrameFeatures): [number, number];
  toJSON(): SerializedRidgeModel;
}

export interface FitOptions {
  /** Candidate feature sets; the one with the lowest CV error wins. */
  featureSets?: FeatureSet[];
  lambdas?: number[];
  /** Run leave-one-point-out cross-validation (needs ≥ 4 points). */
  crossValidate?: boolean;
}

export interface FitReport {
  model: RidgeGazeModel;
  featureSet: FeatureSet;
  lambda: number;
  trainRmsePx: number;
  cvRmsePx: number | null;
  nSamples: number;
  nPoints: number;
  /** CV error per candidate, for diagnostics. */
  candidates: { featureSet: FeatureSet; lambda: number; cvRmsePx: number }[];
  /** Per calibration point: target, frames and median iris features (signal range check). */
  points: { pointIndex: number; vx: number; vy: number; nFrames: number; iris: number[]; head: number[] }[];
}

/** Features have ≈ unit variance after standardisation; with ~250 rows, λ ≥ 100 is heavy shrinkage. */
export const DEFAULT_LAMBDAS = [0.01, 0.1, 1, 10, 100];

export class RidgeGazeModel implements GazeModel {
  constructor(
    readonly featureSet: FeatureSet,
    readonly mean: Float64Array,
    readonly scale: Float64Array,
    readonly wx: Float64Array,
    readonly wy: Float64Array,
    readonly lambda: number,
  ) {}

  predict(f: FrameFeatures): [number, number] {
    const z = standardize(mapFeatures(this.featureSet, f), this.mean, this.scale);
    return [dot(this.wx, z), dot(this.wy, z)];
  }

  toJSON(): SerializedRidgeModel {
    return {
      kind: 'ridge-poly2',
      featureVersion: FEATURE_VERSION,
      featureSet: this.featureSet,
      nFeatures: featureDim(this.featureSet),
      mean: Array.from(this.mean),
      std: Array.from(this.scale),
      wx: Array.from(this.wx),
      wy: Array.from(this.wy),
      lambda: this.lambda,
    };
  }

  static fromJSON(j: SerializedRidgeModel): RidgeGazeModel {
    const set = j.featureSet as FeatureSet;
    if (j.kind !== 'ridge-poly2' || !FEATURE_SETS.includes(set) || j.nFeatures !== featureDim(set)) {
      throw new Error(`Unsupported model ${j.kind}/${j.featureSet}/${j.nFeatures}`);
    }
    return new RidgeGazeModel(set, Float64Array.from(j.mean), Float64Array.from(j.std), Float64Array.from(j.wx), Float64Array.from(j.wy), j.lambda);
  }

  /**
   * Fit from calibration samples. For every candidate feature set × λ the
   * leave-one-point-out error is computed with per-point Gram matrices; the
   * best pair is refit on all points. Per-point median rows (weight 5) are
   * added to the raw frames to anchor each target.
   */
  static fit(samples: CalibSample[], opts: FitOptions = {}): FitReport {
    if (samples.length < 10) throw new Error(`Not enough calibration samples (${samples.length})`);
    const sets = opts.featureSets ?? FEATURE_SETS;
    const lambdas = opts.lambdas ?? DEFAULT_LAMBDAS;
    const pointIds = [...new Set(samples.map((s) => s.pointIndex))];
    const doCv = (opts.crossValidate ?? true) && pointIds.length >= 4;

    let best: { set: FeatureSet; lambda: number; cv: number } | null = null;
    const candidates: FitReport['candidates'] = [];

    for (const set of sets) {
      const prep = prepare(samples, set);
      if (!doCv) {
        // No CV possible: take the simplest set with a moderate λ.
        best = best ?? { set, lambda: lambdas[Math.floor(lambdas.length / 2)]!, cv: Infinity };
        break;
      }
      for (const lambda of lambdas) {
        const cv = leaveOnePointOut(prep, lambda);
        candidates.push({ featureSet: set, lambda, cvRmsePx: cv });
        if (Number.isFinite(cv) && (!best || cv < best.cv)) best = { set, lambda, cv };
      }
    }
    if (!best) throw new Error('Ridge solve failed for every candidate');

    const prep = prepare(samples, best.set);
    const sol = ridgeSolve(prep.total, best.lambda);
    if (!sol) throw new Error('Ridge solve failed (singular system)');
    const model = new RidgeGazeModel(best.set, prep.mean, prep.scale, sol.wx, sol.wy, best.lambda);

    let se = 0, cnt = 0;
    for (let i = 0; i < prep.Z.length; i++) {
      const ex = dot(sol.wx, prep.Z[i]!) - prep.targets[i]![0];
      const ey = dot(sol.wy, prep.Z[i]!) - prep.targets[i]![1];
      se += (ex * ex + ey * ey) * prep.weights[i]!;
      cnt += prep.weights[i]!;
    }
    return {
      model,
      featureSet: best.set,
      lambda: best.lambda,
      trainRmsePx: Math.sqrt(se / Math.max(1, cnt)),
      cvRmsePx: Number.isFinite(best.cv) ? best.cv : null,
      nSamples: samples.length,
      nPoints: pointIds.length,
      candidates,
      points: pointDiagnostics(samples),
    };
  }
}

function pointDiagnostics(samples: CalibSample[]): FitReport['points'] {
  const byPoint = new Map<number, CalibSample[]>();
  for (const s of samples) {
    let arr = byPoint.get(s.pointIndex);
    if (!arr) byPoint.set(s.pointIndex, (arr = []));
    arr.push(s);
  }
  const med = (xs: number[]) => {
    const a = xs.slice().sort((p, q) => p - q);
    const m = a.length >> 1;
    return a.length ? (a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2) : 0;
  };
  return [...byPoint.entries()].map(([pointIndex, ss]) => ({
    pointIndex,
    vx: ss[0]!.vx,
    vy: ss[0]!.vy,
    nFrames: ss.length,
    iris: [0, 1, 2, 3].map((i) => +med(ss.map((s) => s.features.core[i]!)).toFixed(4)),
    head: [+med(ss.map((s) => s.features.head.yaw)).toFixed(2), +med(ss.map((s) => s.features.head.pitch)).toFixed(2), +med(ss.map((s) => s.features.head.tz)).toFixed(2)],
  }));
}

/** Backwards-compatible alias (older call sites / tests). */
export const RidgePoly2Model = RidgeGazeModel;
export type RidgePoly2Model = RidgeGazeModel;

interface Prepared {
  Z: Float64Array[];
  targets: [number, number][];
  weights: number[];
  points: number[];
  mean: Float64Array;
  scale: Float64Array;
  grams: Map<number, Gram>;
  total: Gram;
}

function prepare(samples: CalibSample[], set: FeatureSet): Prepared {
  const n = featureDim(set);
  const rows: Float64Array[] = [];
  const targets: [number, number][] = [];
  const weights: number[] = [];
  const points: number[] = [];
  const byPoint = new Map<number, Float64Array[]>();
  for (const s of samples) {
    const x = mapFeatures(set, s.features);
    rows.push(x);
    targets.push([s.vx, s.vy]);
    weights.push(s.weight);
    points.push(s.pointIndex);
    let arr = byPoint.get(s.pointIndex);
    if (!arr) byPoint.set(s.pointIndex, (arr = []));
    arr.push(x);
  }
  for (const [p, xs] of byPoint) {
    const first = samples.find((s) => s.pointIndex === p)!;
    rows.push(columnMedian(xs));
    targets.push([first.vx, first.vy]);
    weights.push(5);
    points.push(p);
  }
  const { mean, std } = zscoreFit(rows, n);
  const floors = featureScaleFloors(set);
  const scale = new Float64Array(n);
  scale[0] = 1;
  for (let i = 1; i < n; i++) scale[i] = Math.max(std[i]!, floors[i]!);
  const Z = rows.map((r) => standardize(r, mean, scale));
  const grams = new Map<number, Gram>();
  for (let i = 0; i < Z.length; i++) {
    const p = points[i]!;
    let g = grams.get(p);
    if (!g) grams.set(p, (g = emptyGram(n)));
    gramAdd(g, Z[i]!, targets[i]![0], targets[i]![1], weights[i]!);
  }
  const total = emptyGram(n);
  for (const g of grams.values()) gramAddInto(total, g);
  return { Z, targets, weights, points, mean, scale, grams, total };
}

function leaveOnePointOut(prep: Prepared, lambda: number): number {
  let se = 0, cnt = 0;
  for (const [p, gp] of prep.grams) {
    const g = gramClone(prep.total);
    gramAddInto(g, gp, -1);
    const sol = ridgeSolve(g, lambda);
    if (!sol) return Infinity;
    for (let i = 0; i < prep.Z.length; i++) {
      if (prep.points[i] !== p) continue;
      const ex = dot(sol.wx, prep.Z[i]!) - prep.targets[i]![0];
      const ey = dot(sol.wy, prep.Z[i]!) - prep.targets[i]![1];
      se += (ex * ex + ey * ey) * prep.weights[i]!;
      cnt += prep.weights[i]!;
    }
  }
  return cnt > 0 ? Math.sqrt(se / cnt) : Infinity;
}

function columnMedian(xs: Float64Array[]): Float64Array {
  const n = xs[0]!.length;
  const out = new Float64Array(n);
  const col = new Float64Array(xs.length);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < xs.length; i++) col[i] = xs[i]![j]!;
    col.sort();
    const m = col.length >> 1;
    out[j] = col.length % 2 ? col[m]! : (col[m - 1]! + col[m]!) / 2;
  }
  return out;
}
