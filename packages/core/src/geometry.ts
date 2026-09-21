import type { Size, WindowGeometry } from '@red-tracking/protocol';

export type GeometryChange =
  | { kind: 'same' }
  | { kind: 'moved'; dx: number; dy: number }
  | { kind: 'changed'; reason: 'resize' | 'dpr' | 'screen' };

/**
 * Classify a window geometry change:
 *  - only screenX/screenY differ → 'moved' (gaze offset can be corrected silently)
 *  - inner/outer size, DPR or screen differ → 'changed' (recalibrate)
 */
export function compareGeometry(a: WindowGeometry, b: WindowGeometry, tolPx = 2): GeometryChange {
  if (Math.abs(a.dpr - b.dpr) > 1e-3) return { kind: 'changed', reason: 'dpr' };
  if (a.screenW !== b.screenW || a.screenH !== b.screenH) return { kind: 'changed', reason: 'screen' };
  if (
    Math.abs(a.innerWidth - b.innerWidth) > tolPx ||
    Math.abs(a.innerHeight - b.innerHeight) > tolPx ||
    Math.abs(a.outerWidth - b.outerWidth) > tolPx ||
    Math.abs(a.outerHeight - b.outerHeight) > tolPx
  ) {
    return { kind: 'changed', reason: 'resize' };
  }
  const dx = b.screenX - a.screenX;
  const dy = b.screenY - a.screenY;
  if (Math.abs(dx) > tolPx || Math.abs(dy) > tolPx) return { kind: 'moved', dx, dy };
  return { kind: 'same' };
}

export interface Target {
  index: number;
  vx: number;
  vy: number;
}

/**
 * Calibration targets in viewport px.
 * 9 → 3×3 grid at 8/50/92 %; 13 → adds the 29/71 % diagonal points.
 */
export function calibrationTargets(n: 9 | 13, viewport: Size, marginFrac = 0.08): Target[] {
  const xs = [marginFrac, 0.5, 1 - marginFrac];
  const ys = [marginFrac, 0.5, 1 - marginFrac];
  const pts: [number, number][] = [];
  for (const y of ys) for (const x of xs) pts.push([x, y]);
  if (n === 13) {
    for (const y of [0.29, 0.71]) for (const x of [0.29, 0.71]) pts.push([x, y]);
  }
  return pts.map(([nx, ny], index) => ({ index, vx: Math.round(nx * viewport.w), vy: Math.round(ny * viewport.h) }));
}

/** 4 validation targets at the 25/75 % intersections (never coincide with calibration points). */
export function validationTargets(viewport: Size): Target[] {
  const pts: [number, number][] = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  return pts.map(([nx, ny], index) => ({ index, vx: Math.round(nx * viewport.w), vy: Math.round(ny * viewport.h) }));
}

/** Quick 5-point set used after a geometry change: centre + 4 corners. */
export function quickTargets(viewport: Size, marginFrac = 0.1): Target[] {
  const pts: [number, number][] = [[0.5, 0.5], [marginFrac, marginFrac], [1 - marginFrac, marginFrac], [marginFrac, 1 - marginFrac], [1 - marginFrac, 1 - marginFrac]];
  return pts.map(([nx, ny], index) => ({ index, vx: Math.round(nx * viewport.w), vy: Math.round(ny * viewport.h) }));
}

/** Deterministic shuffle (Fisher–Yates) with an injectable RNG. */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Simple seeded RNG (mulberry32) for reproducible target orders in tests. */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert an on-screen distance in CSS px to visual degrees.
 * Defaults: 60 cm viewing distance, 0.0265 cm per CSS px (≈ 96 dpi logical).
 */
export function pxToDeg(px: number, opts: { distanceCm?: number; cmPerPx?: number } = {}): number {
  const d = opts.distanceCm ?? 60;
  const cm = px * (opts.cmPerPx ?? 0.0265);
  return (Math.atan2(cm, d) * 180) / Math.PI;
}
