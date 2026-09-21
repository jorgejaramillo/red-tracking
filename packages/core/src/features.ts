import { LM, LANDMARK_COUNT, type Landmark, type Vec2, dist, mid } from './landmarks';
import { estimatePoseFromLandmarks, poseFromMatrix, type HeadPose } from './headpose';

export const CORE_DIM = 10;
export const LINEAR_DIM = 5;
export const FEATURE_VERSION = 1 as const;

export interface FrameFeatures {
  /** 10 features that get the quadratic expansion. */
  core: Float64Array;
  /** 5 features used linearly. */
  linear: Float64Array;
  earL: number;
  earR: number;
  /** Iris centres and eye centres in frame pixels (for drawing rays). */
  irisL: Vec2;
  irisR: Vec2;
  eyeL: Vec2;
  eyeR: Vec2;
  /** Face width (cheek to cheek) relative to the frame width. */
  faceScale: number;
  head: HeadPose;
}

/**
 * Extract the gaze feature vector from a MediaPipe landmark set.
 *
 * @param lm       478 normalised landmarks (0..1, as returned by MediaPipe)
 * @param matrix   facial transformation matrix (column-major 16 floats) or null
 * @param frameW   camera frame width in px
 * @param frameH   camera frame height in px
 */
export function extractFeatures(
  lm: ArrayLike<Landmark>,
  matrix: ArrayLike<number> | null,
  frameW: number,
  frameH: number,
): FrameFeatures | null {
  if (lm.length < LANDMARK_COUNT) return null;

  // Convert to pixel coordinates so ratios are aspect-correct.
  const px: Landmark[] = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = lm[i]!;
    px[i] = { x: p.x * frameW, y: p.y * frameH, z: p.z * frameW };
  }

  const lOuter = px[LM.L_OUTER]!, lInner = px[LM.L_INNER]!;
  const lTop = px[LM.L_TOP]!, lBottom = px[LM.L_BOTTOM]!;
  const rInner = px[LM.R_INNER]!, rOuter = px[LM.R_OUTER]!;
  const rTop = px[LM.R_TOP]!, rBottom = px[LM.R_BOTTOM]!;
  const irisL = px[LM.L_IRIS]!, irisR = px[LM.R_IRIS]!;
  const nose = px[LM.NOSE_TIP]!;

  const eyeWL = Math.max(1e-6, dist(lOuter, lInner));
  const eyeWR = Math.max(1e-6, dist(rInner, rOuter));
  const eyeL = mid(lOuter, lInner);
  const eyeR = mid(rInner, rOuter);

  const earL = dist(lTop, lBottom) / eyeWL;
  const earR = dist(rTop, rBottom) / eyeWR;

  const head = matrix && matrix.length >= 16 ? poseFromMatrix(matrix) : estimatePoseFromLandmarks(px, frameW);

  const core = new Float64Array(CORE_DIM);
  // Iris offsets relative to the corner midpoint (corners are the most stable
  // landmarks; eyelids move with vertical gaze and blinks).
  core[0] = (irisL.x - eyeL.x) / eyeWL;
  core[1] = (irisL.y - eyeL.y) / eyeWL;
  core[2] = (irisR.x - eyeR.x) / eyeWR;
  core[3] = (irisR.y - eyeR.y) / eyeWR;
  core[4] = head.yaw / 45;
  core[5] = head.pitch / 45;
  core[6] = head.roll / 45;
  core[7] = head.tx / 10;
  core[8] = head.ty / 10;
  core[9] = head.tz / 10;

  const interOcular = dist(lOuter, rOuter);
  const faceScale = dist(px[LM.L_CHEEK]!, px[LM.R_CHEEK]!) / frameW;

  const linear = new Float64Array(LINEAR_DIM);
  linear[0] = nose.x / frameW - 0.5;
  linear[1] = nose.y / frameH - 0.5;
  linear[2] = interOcular / frameW;
  linear[3] = earL;
  linear[4] = earR;

  return { core, linear, earL, earR, irisL, irisR, eyeL, eyeR, faceScale, head };
}

/** Gaze ray endpoints for the preview: from eye centre through the iris, extended. */
export function gazeRays(
  f: FrameFeatures,
  length = 80,
): { l: [number, number, number, number]; r: [number, number, number, number] } {
  const ray = (eye: Vec2, iris: Vec2): [number, number, number, number] => {
    // Iris offset relative to the eye centre is small; amplify so the ray is visible.
    const dx = (iris.x - eye.x) * 6;
    const dy = (iris.y - eye.y) * 6;
    const n = Math.hypot(dx, dy) || 1;
    return [iris.x, iris.y, iris.x + (dx / n) * length, iris.y + (dy / n) * length];
  };
  return { l: ray(f.eyeL, f.irisL), r: ray(f.eyeR, f.irisR) };
}
