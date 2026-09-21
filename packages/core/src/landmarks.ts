/** MediaPipe Face Landmarker (478 points) indices used by the gaze pipeline. */
export const LM = {
  L_OUTER: 33,
  L_INNER: 133,
  L_TOP: 159,
  L_BOTTOM: 145,
  R_INNER: 362,
  R_OUTER: 263,
  R_TOP: 386,
  R_BOTTOM: 374,
  L_IRIS: 468,
  R_IRIS: 473,
  NOSE_TIP: 1,
  CHIN: 152,
  FOREHEAD: 10,
  L_CHEEK: 234,
  R_CHEEK: 454,
} as const;

export const L_IRIS_RING = [469, 470, 471, 472] as const;
export const R_IRIS_RING = [474, 475, 476, 477] as const;

export const LANDMARK_COUNT = 478;

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
