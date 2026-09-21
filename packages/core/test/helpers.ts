import { CORE_DIM, LINEAR_DIM, type FrameFeatures } from '../src/features';
import { seededRng } from '../src/geometry';

export function makeFeatures(core: number[], linear: number[] = []): FrameFeatures {
  const c = new Float64Array(CORE_DIM);
  const l = new Float64Array(LINEAR_DIM);
  core.forEach((v, i) => (c[i] = v));
  linear.forEach((v, i) => (l[i] = v));
  return {
    core: c,
    linear: l,
    earL: 0.3,
    earR: 0.3,
    irisL: { x: 0, y: 0 },
    irisR: { x: 0, y: 0 },
    eyeL: { x: 0, y: 0 },
    eyeR: { x: 0, y: 0 },
    faceScale: 0.3,
    head: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -30, fromMatrix: true },
  };
}

/**
 * Synthetic "eye" that looks at (vx, vy) on a W×H viewport: iris offsets are a
 * mildly non-linear function of the target plus gaussian-ish noise.
 */
export function syntheticFrame(vx: number, vy: number, W: number, H: number, rng = seededRng(1), noise = 0.004): FrameFeatures {
  const nx = (vx - W / 2) / W; // -0.5..0.5
  const ny = (vy - H / 2) / H;
  const n = () => (rng() + rng() + rng() - 1.5) * noise;
  const irisX = 0.28 * nx + 0.05 * nx * nx * Math.sign(nx);
  const irisY = 0.22 * ny + 0.04 * ny * Math.abs(ny);
  return makeFeatures(
    [irisX + n(), irisY + n(), irisX * 0.95 + n(), irisY * 1.05 + n(), n(), n(), n(), n(), n(), -3 + n()],
    [0 + n(), 0 + n(), 0.25 + n(), 0.3 + n(), 0.3 + n()],
  );
}
