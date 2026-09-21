import type { ValidationPointResult, ValidationResult } from '@red-tracking/protocol';
import type { FrameFeatures } from './features';
import type { CalibSample, GazeModel } from './model';
import { pxToDeg } from './geometry';

export interface CollectorOptions {
  /** Ignore frames during the first N ms after a target appears (saccade + settle). */
  settleMs?: number;
  /** Stop collecting for a target after this many valid frames. */
  maxFrames?: number;
  /** Fewer valid frames than this → the target must be repeated. */
  minFrames?: number;
}

interface TargetState {
  index: number;
  vx: number;
  vy: number;
  shownAt: number;
  frames: FrameFeatures[];
  done: boolean;
}

/**
 * Collects per-target feature frames during calibration or validation.
 * Pure logic — the engine feeds it `addFrame(features, t)` at camera rate.
 */
export class TargetCollector {
  private readonly settleMs: number;
  private readonly maxFrames: number;
  private readonly minFrames: number;
  private readonly targets = new Map<number, TargetState>();
  private current: TargetState | null = null;

  constructor(opts: CollectorOptions = {}) {
    this.settleMs = opts.settleMs ?? 300;
    this.maxFrames = opts.maxFrames ?? 25;
    this.minFrames = opts.minFrames ?? 10;
  }

  get needed(): number {
    return this.maxFrames;
  }

  show(index: number, vx: number, vy: number, t: number): void {
    const st: TargetState = { index, vx, vy, shownAt: t, frames: [], done: false };
    this.targets.set(index, st);
    this.current = st;
  }

  /**
   * @returns number of usable frames for the current target (capped at `needed`
   * for progress display), or -1 when idle. Frames keep being collected while
   * the target is shown; `finish()` keeps the LAST `maxFrames` so late-settling
   * eyes are favoured over the initial saccade.
   */
  addFrame(f: FrameFeatures | null, t: number, blink: boolean): number {
    const cur = this.current;
    if (!cur || cur.done) return -1;
    if (t - cur.shownAt < this.settleMs) return Math.min(cur.frames.length, this.maxFrames);
    if (!f || blink) return Math.min(cur.frames.length, this.maxFrames);
    cur.frames.push(f);
    if (cur.frames.length > this.maxFrames * 4) cur.frames.shift(); // bound memory
    return Math.min(cur.frames.length, this.maxFrames);
  }

  finish(index: number): void {
    const st = this.targets.get(index);
    if (st) {
      st.done = true;
      if (st.frames.length > this.maxFrames) st.frames = st.frames.slice(-this.maxFrames);
    }
    if (this.current?.index === index) this.current = null;
  }

  /** Targets with too few frames (to be repeated). */
  insufficient(): number[] {
    return [...this.targets.values()].filter((t) => t.frames.length < this.minFrames).map((t) => t.index);
  }

  count(index: number): number {
    return Math.min(this.targets.get(index)?.frames.length ?? 0, this.maxFrames);
  }

  samples(weight = 1): CalibSample[] {
    const out: CalibSample[] = [];
    for (const t of this.targets.values()) {
      for (const f of t.frames) out.push({ features: f, vx: t.vx, vy: t.vy, weight, pointIndex: t.index });
    }
    return out;
  }

  targetsSummary(): { index: number; vx: number; vy: number; nFrames: number }[] {
    return [...this.targets.values()].map((t) => ({ index: t.index, vx: t.vx, vy: t.vy, nFrames: t.frames.length }));
  }

  /** Evaluate a fitted model against the collected targets (validation phase). */
  evaluate(model: GazeModel, passPx: number, failPx: number): ValidationResult {
    const perPoint: ValidationPointResult[] = [];
    let sumErr = 0, sumBx = 0, sumBy = 0, n = 0;
    for (const t of this.targets.values()) {
      if (t.frames.length === 0) continue;
      let sx = 0, sy = 0;
      for (const f of t.frames) {
        const [x, y] = model.predict(f);
        sx += x;
        sy += y;
      }
      const px = sx / t.frames.length;
      const py = sy / t.frames.length;
      const err = Math.hypot(px - t.vx, py - t.vy);
      perPoint.push({ index: t.index, vx: t.vx, vy: t.vy, predX: px, predY: py, errPx: err, nFrames: t.frames.length });
      sumErr += err;
      sumBx += px - t.vx;
      sumBy += py - t.vy;
      n++;
    }
    const meanErrPx = n ? sumErr / n : Infinity;
    const verdict: ValidationResult['verdict'] = meanErrPx <= passPx ? 'pass' : meanErrPx <= failPx ? 'warn' : 'fail';
    return {
      meanErrPx,
      meanErrDeg: pxToDeg(meanErrPx),
      biasX: n ? sumBx / n : 0,
      biasY: n ? sumBy / n : 0,
      perPoint,
      verdict,
    };
  }

  reset(): void {
    this.targets.clear();
    this.current = null;
  }
}
