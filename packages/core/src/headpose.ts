import { LM, type Landmark, type Vec2, dist, mid } from './landmarks';

/** Head pose: rotations in degrees, translation in MediaPipe metric-ish units (≈ cm). */
export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
  tx: number;
  ty: number;
  tz: number;
  /** true when derived from the facial transformation matrix, false when estimated from landmarks. */
  fromMatrix: boolean;
}

const RAD = 180 / Math.PI;

/**
 * Euler angles from a column-major 4×4 facial transformation matrix
 * (MediaPipe `facialTransformationMatrixes[i].data`).
 */
export function poseFromMatrix(m: ArrayLike<number>): HeadPose {
  // R[r][c] = m[c * 4 + r] (column-major)
  const r00 = m[0]!, r10 = m[1]!;
  const r02 = m[8]!, r12 = m[9]!, r22 = m[10]!;
  const yaw = Math.atan2(r02, r22) * RAD;
  const pitch = Math.atan2(-r12, Math.hypot(r02, r22)) * RAD;
  const roll = Math.atan2(r10, r00) * RAD;
  return {
    yaw,
    pitch,
    roll,
    tx: m[12]!,
    ty: m[13]!,
    tz: m[14]!,
    fromMatrix: true,
  };
}

/**
 * Rough head pose from 2D landmarks (pixel coords) when the transformation
 * matrix is unavailable (e.g. the TF.js fallback model). Angles are approximate
 * but monotonic in the true rotation, which is all the regression needs.
 */
export function estimatePoseFromLandmarks(px: Landmark[], frameW: number): HeadPose {
  const lo = px[LM.L_OUTER]!;
  const ro = px[LM.R_OUTER]!;
  const nose = px[LM.NOSE_TIP]!;
  const chin = px[LM.CHIN]!;
  const forehead = px[LM.FOREHEAD]!;
  const lCheek = px[LM.L_CHEEK]!;
  const rCheek = px[LM.R_CHEEK]!;

  const eyeMid: Vec2 = mid(lo, ro);
  const interOcular = Math.max(1e-6, dist(lo, ro));
  const faceH = Math.max(1e-6, dist(forehead, chin));

  // Yaw: nose horizontal offset from the eye midpoint, relative to inter-ocular distance.
  const yaw = Math.asin(clamp(((nose.x - eyeMid.x) / interOcular) * 1.6, -1, 1)) * RAD;
  // Pitch: nose vertical position between eyes and chin; neutral ≈ 0.45 of the way down.
  const noseFrac = (nose.y - eyeMid.y) / faceH;
  const pitch = ((noseFrac - 0.36) * 180);
  // Roll: eye line angle.
  const roll = Math.atan2(ro.y - lo.y, ro.x - lo.x) * RAD;
  // Distance proxy: cheek-to-cheek width relative to the frame width (larger = closer).
  const faceScale = dist(lCheek, rCheek) / frameW;
  return {
    yaw,
    pitch,
    roll,
    tx: (eyeMid.x / frameW - 0.5) * 60,
    ty: (eyeMid.y / frameW - 0.375) * 60,
    tz: -30 / Math.max(0.05, faceScale),
    fromMatrix: false,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
