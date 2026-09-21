import { NO_INDEX, SampleFlag, type Fixation, type SampleChunk } from '@red-tracking/protocol';

export interface FixationOptions {
  /** Max (maxX−minX)+(maxY−minY) of a fixation window, page px. */
  dispersionPx?: number;
  minDurationMs?: number;
  /** Merge consecutive fixations closer than this in time … */
  mergeGapMs?: number;
  /** … and in space. */
  mergeDistPx?: number;
}

export interface GazeSampleLite {
  t: number;
  x: number;
  y: number;
  valid: boolean;
}

/**
 * Dispersion-threshold identification (I-DT, Salvucci & Goldberg 2000).
 * Input must be time-ordered. Invalid samples (blinks, face lost) break fixations
 * only if the gap exceeds `mergeGapMs`; shorter gaps are bridged.
 */
export function detectFixations(
  samples: GazeSampleLite[],
  pageVisitId: string,
  opts: FixationOptions = {},
): Fixation[] {
  const disp = opts.dispersionPx ?? 70;
  const minDur = opts.minDurationMs ?? 100;
  const mergeGap = opts.mergeGapMs ?? 75;
  const mergeDist = opts.mergeDistPx ?? 40;

  const valid = samples.filter((s) => s.valid && Number.isFinite(s.x) && Number.isFinite(s.y));
  const out: Fixation[] = [];
  let i = 0;
  while (i < valid.length) {
    // Grow a window until it covers minDur.
    let j = i;
    while (j < valid.length && valid[j]!.t - valid[i]!.t < minDur) j++;
    if (j >= valid.length) break;
    if (dispersion(valid, i, j) > disp) {
      i++;
      continue;
    }
    // Expand while dispersion stays under threshold.
    while (j + 1 < valid.length && dispersion(valid, i, j + 1) <= disp) j++;
    out.push(makeFixation(valid, i, j, pageVisitId));
    i = j + 1;
  }
  return mergeFixations(out, mergeGap, mergeDist);
}

function dispersion(s: GazeSampleLite[], i: number, j: number): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let k = i; k <= j; k++) {
    const p = s[k]!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return maxX - minX + (maxY - minY);
}

function makeFixation(s: GazeSampleLite[], i: number, j: number, pageVisitId: string): Fixation {
  let sx = 0, sy = 0;
  for (let k = i; k <= j; k++) {
    sx += s[k]!.x;
    sy += s[k]!.y;
  }
  const n = j - i + 1;
  const tStart = s[i]!.t;
  // End = next sample time if available (sample covers until the next one), else last sample.
  const tEnd = j + 1 < s.length ? Math.min(s[j + 1]!.t, s[j]!.t + 100) : s[j]!.t + 33;
  return {
    pageVisitId,
    tStart,
    tEnd,
    durationMs: tEnd - tStart,
    px: sx / n,
    py: sy / n,
    dispersion: dispersion(s, i, j),
    nSamples: n,
    aoiId: null,
  };
}

export function mergeFixations(fix: Fixation[], gapMs: number, distPx: number): Fixation[] {
  if (fix.length === 0) return fix;
  const out: Fixation[] = [fix[0]!];
  for (let k = 1; k < fix.length; k++) {
    const prev = out[out.length - 1]!;
    const cur = fix[k]!;
    const gap = cur.tStart - prev.tEnd;
    const d = Math.hypot(cur.px - prev.px, cur.py - prev.py);
    if (gap <= gapMs && d <= distPx) {
      const n = prev.nSamples + cur.nSamples;
      out[out.length - 1] = {
        ...prev,
        tEnd: cur.tEnd,
        durationMs: cur.tEnd - prev.tStart,
        px: (prev.px * prev.nSamples + cur.px * cur.nSamples) / n,
        py: (prev.py * prev.nSamples + cur.py * cur.nSamples) / n,
        dispersion: Math.max(prev.dispersion, cur.dispersion, d),
        nSamples: n,
      };
    } else {
      out.push(cur);
    }
  }
  return out;
}

const INVALID_MASK = SampleFlag.Blink | SampleFlag.FaceLost | SampleFlag.Paused;

/** Flatten columnar chunks of one page visit into time-ordered lite samples (page coords). */
export function samplesFromChunks(chunks: SampleChunk[]): GazeSampleLite[] {
  const sorted = chunks.slice().sort((a, b) => a.tStart - b.tStart);
  const out: GazeSampleLite[] = [];
  for (const c of sorted) {
    for (let i = 0; i < c.count; i++) {
      out.push({
        t: c.t[i]!,
        x: c.px[i]!,
        y: c.py[i]!,
        valid: (c.flags[i]! & INVALID_MASK) === 0 && c.conf[i]! > 0.2,
      });
    }
  }
  return out;
}

/** Utility for reports: raw sample points with weights (for the "raw" heatmap mode). */
export function rawPointsFromChunks(chunks: SampleChunk[]): { x: number; y: number; w: number }[] {
  const pts: { x: number; y: number; w: number }[] = [];
  for (const c of chunks) {
    for (let i = 0; i < c.count; i++) {
      if ((c.flags[i]! & INVALID_MASK) !== 0) continue;
      pts.push({ x: c.px[i]!, y: c.py[i]!, w: 1 });
    }
  }
  return pts;
}

export { NO_INDEX };
