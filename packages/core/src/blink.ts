/**
 * Blink detector based on the eye aspect ratio (EAR) with an adaptive threshold
 * (0.6 × running median over the last `windowMs`), plus an absolute floor.
 */
export interface BlinkOptions {
  windowMs?: number;
  ratio?: number;
  absoluteFloor?: number;
  /** Frames to keep flagging after a blink ends (eye re-opening is noisy). */
  holdFrames?: number;
  minSamplesForAdaptive?: number;
}

export class BlinkDetector {
  private readonly windowMs: number;
  private readonly ratio: number;
  private readonly floor: number;
  private readonly holdFrames: number;
  private readonly minSamples: number;
  private readonly ts: number[] = [];
  private readonly values: number[] = [];
  private hold = 0;

  constructor(opts: BlinkOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    this.ratio = opts.ratio ?? 0.6;
    this.floor = opts.absoluteFloor ?? 0.12;
    this.holdFrames = opts.holdFrames ?? 2;
    this.minSamples = opts.minSamplesForAdaptive ?? 15;
  }

  /** @returns true when the current frame should be treated as a blink. */
  update(earL: number, earR: number, t: number): boolean {
    const ear = (earL + earR) / 2;
    const median = this.median();
    const threshold = this.values.length >= this.minSamples ? Math.max(this.floor, median * this.ratio) : this.floor;
    const closed = ear < threshold;

    if (!closed) {
      // Only open-eye frames feed the baseline, so blinks don't drag the median down.
      this.ts.push(t);
      this.values.push(ear);
      while (this.ts.length && t - this.ts[0]! > this.windowMs) {
        this.ts.shift();
        this.values.shift();
      }
    }

    if (closed) {
      this.hold = this.holdFrames;
      return true;
    }
    if (this.hold > 0) {
      this.hold--;
      return true;
    }
    return false;
  }

  /** Current adaptive baseline EAR (median of open-eye frames). */
  baseline(): number {
    return this.median();
  }

  private median(): number {
    if (this.values.length === 0) return 0.3;
    const sorted = this.values.slice().sort((a, b) => a - b);
    const m = sorted.length >> 1;
    return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
  }

  reset(): void {
    this.ts.length = 0;
    this.values.length = 0;
    this.hold = 0;
  }
}
