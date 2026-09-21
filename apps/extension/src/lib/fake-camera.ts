/**
 * Deterministic landmark source for tests and demos: synthesises a 478-point
 * face whose iris offsets follow a scripted gaze target, so calibration and
 * gaze prediction are reproducible without a camera.
 */
import { LANDMARK_COUNT, LM, seededRng, type Landmark } from '@red-tracking/core';
import type { LandmarkFrame, LandmarkSource } from './gaze-engine';

export interface FakeOptions {
  width?: number;
  height?: number;
  fps?: number;
  seed?: number;
  noise?: number;
}

export class FakeLandmarkSource implements LandmarkSource {
  readonly width: number;
  readonly height: number;
  private readonly fps: number;
  private readonly rng: () => number;
  private readonly noise: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Current gaze target in viewport px and the viewport size it refers to. */
  private target = { vx: 0.5, vy: 0.5 };
  private viewport = { w: 1280, h: 720 };
  private faceVisible = true;
  private blinkUntil = 0;

  constructor(opts: FakeOptions = {}) {
    this.width = opts.width ?? 640;
    this.height = opts.height ?? 480;
    this.fps = opts.fps ?? 30;
    this.rng = seededRng(opts.seed ?? 1);
    this.noise = opts.noise ?? 0.004;
  }

  /** Point the synthetic eyes at a viewport position. */
  lookAt(vx: number, vy: number, viewport?: { w: number; h: number }): void {
    if (viewport) this.viewport = viewport;
    this.target = { vx: vx / this.viewport.w, vy: vy / this.viewport.h };
  }

  setFaceVisible(v: boolean): void {
    this.faceVisible = v;
  }

  blink(ms = 150): void {
    this.blinkUntil = performance.now() + ms;
  }

  async start(onFrame: (f: LandmarkFrame) => Promise<void> | void): Promise<void> {
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await onFrame(this.frame(performance.now()));
      } finally {
        busy = false;
      }
    }, 1000 / this.fps);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private frame(tMs: number): LandmarkFrame {
    if (!this.faceVisible) {
      return { landmarks: null, matrix: null, tMs, width: this.width, height: this.height, brightness: 120 };
    }
    const n = () => (this.rng() + this.rng() + this.rng() - 1.5) * this.noise;
    const nx = this.target.vx - 0.5;
    const ny = this.target.vy - 0.5;
    const irisX = 0.28 * nx + 0.05 * nx * nx * Math.sign(nx) + n();
    const irisY = 0.22 * ny + 0.04 * ny * Math.abs(ny) + n();
    const blink = tMs < this.blinkUntil;
    const lm = synthFace(irisX, irisY, blink ? 0.15 : 1, n);
    // Column-major identity rotation with a plausible translation (cm).
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5 + n(), -1 + n(), -45 + n() * 10, 1];
    return { landmarks: lm, matrix, tMs, width: this.width, height: this.height, brightness: 120 };
  }
}

/** Neutral synthetic face in normalised coords; iris offsets are in eye-widths. */
export function synthFace(irisX: number, irisY: number, earScale = 1, n: () => number = () => 0): Landmark[] {
  const lm: Landmark[] = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    // Scatter unused points roughly over a face oval so the mesh preview looks like a face.
    const a = (i / LANDMARK_COUNT) * Math.PI * 2;
    const r = 0.18 + 0.1 * ((i * 7919) % 100) / 100;
    lm[i] = { x: 0.5 + Math.cos(a) * r * 0.8, y: 0.5 + Math.sin(a) * r, z: 0 };
  }
  const set = (i: number, x: number, y: number) => (lm[i] = { x: x + n() * 0.2, y: y + n() * 0.2, z: 0 });
  const eyeW = 0.1; // normalised eye width
  set(LM.L_OUTER, 0.35, 0.45); set(LM.L_INNER, 0.45, 0.45);
  set(LM.L_TOP, 0.4, 0.45 - 0.022 * earScale); set(LM.L_BOTTOM, 0.4, 0.45 + 0.022 * earScale);
  set(LM.R_INNER, 0.55, 0.45); set(LM.R_OUTER, 0.65, 0.45);
  set(LM.R_TOP, 0.6, 0.45 - 0.022 * earScale); set(LM.R_BOTTOM, 0.6, 0.45 + 0.022 * earScale);
  set(LM.L_IRIS, 0.4 + irisX * eyeW, 0.45 + irisY * eyeW);
  set(LM.R_IRIS, 0.6 + irisX * eyeW * 0.95, 0.45 + irisY * eyeW * 1.05);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    set(469 + k, lm[LM.L_IRIS]!.x + Math.cos(a) * 0.012, lm[LM.L_IRIS]!.y + Math.sin(a) * 0.016);
    set(474 + k, lm[LM.R_IRIS]!.x + Math.cos(a) * 0.012, lm[LM.R_IRIS]!.y + Math.sin(a) * 0.016);
  }
  set(LM.NOSE_TIP, 0.5, 0.56); set(LM.CHIN, 0.5, 0.82); set(LM.FOREHEAD, 0.5, 0.22);
  set(LM.L_CHEEK, 0.3, 0.55); set(LM.R_CHEEK, 0.7, 0.55);
  return lm;
}
