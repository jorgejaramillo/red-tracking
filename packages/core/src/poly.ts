import type { FrameFeatures } from './features';

/**
 * Feature mappings for the gaze regression, from simplest to richest.
 *
 * Real calibrations have only 9–13 distinct target locations, so the model
 * must stay small: iris offsets carry the signal, head pose is a linear
 * correction. The fit picks the set with the best leave-one-point-out error.
 */
export type FeatureSet = 'iris-linear' | 'iris-poly2' | 'iris-poly2-head';

export const FEATURE_SETS: FeatureSet[] = ['iris-linear', 'iris-poly2', 'iris-poly2-head'];

const IRIS = 4; // core[0..3]
const IRIS_POLY = (IRIS * (IRIS + 1)) / 2; // 10
const HEAD = 6; // core[4..9]
const EXTRA = 5; // nose x, nose y, inter-ocular, EAR left, EAR right

export function featureDim(set: FeatureSet): number {
  switch (set) {
    case 'iris-linear':
      return 1 + IRIS;
    case 'iris-poly2':
      return 1 + IRIS + IRIS_POLY;
    case 'iris-poly2-head':
      return 1 + IRIS + IRIS_POLY + HEAD + EXTRA;
  }
}

export function mapFeatures(set: FeatureSet, f: FrameFeatures): Float64Array {
  const out = new Float64Array(featureDim(set));
  const c = f.core;
  let k = 0;
  out[k++] = 1;
  for (let i = 0; i < IRIS; i++) out[k++] = c[i]!;
  if (set === 'iris-linear') return out;
  for (let i = 0; i < IRIS; i++) for (let j = i; j < IRIS; j++) out[k++] = c[i]! * c[j]!;
  if (set === 'iris-poly2') return out;
  for (let i = IRIS; i < IRIS + HEAD; i++) out[k++] = c[i]!;
  out[k++] = f.linear[0]!;
  out[k++] = f.linear[1]!;
  out[k++] = f.linear[2]!;
  out[k++] = f.linear[3]!;
  out[k++] = f.linear[4]!;
  return out;
}

/**
 * Per-feature standardisation floors (bias = 1). Features are scaled by
 * max(calibration std, floor): informative features get unit variance while
 * features that barely vary while the participant holds still (head pose)
 * cannot blow up once the head moves a little.
 *
 * Typical ranges: iris offset on a laptop at 60 cm ≈ ±0.04 eye-widths,
 * head angles /45 ≈ ±0.1 (≈ 4.5°), translation /10 ≈ ±0.1 (≈ 1 cm).
 */
export function featureScaleFloors(set: FeatureSet): Float64Array {
  const out = new Float64Array(featureDim(set));
  let k = 0;
  out[k++] = 1;
  for (let i = 0; i < IRIS; i++) out[k++] = 0.01;
  if (set === 'iris-linear') return out;
  for (let i = 0; i < IRIS_POLY; i++) out[k++] = 0.001;
  if (set === 'iris-poly2') return out;
  for (let i = 0; i < 3; i++) out[k++] = 0.05; // ≈ 2°
  for (let i = 0; i < 3; i++) out[k++] = 0.05; // ≈ 0.5 cm
  out[k++] = 0.02; // nose x
  out[k++] = 0.02; // nose y
  out[k++] = 0.01; // inter-ocular / frame width
  out[k++] = 0.03; // EAR left
  out[k++] = 0.03; // EAR right
  return out;
}

/** @deprecated use featureScaleFloors */
export const featureScales = featureScaleFloors;

/** @deprecated legacy name kept for callers; equals the richest feature set. */
export const POLY_DIM = featureDim('iris-poly2-head');

/** Richest mapping (kept for compatibility with older call sites). */
export function expandFeatures(f: FrameFeatures): Float64Array {
  return mapFeatures('iris-poly2-head', f);
}
