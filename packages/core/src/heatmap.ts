/**
 * Heatmap accumulation on a down-scaled Float32 grid. Pure numeric core; the UI
 * turns the RGBA output into ImageData.
 */
export interface HeatGrid {
  /** Grid size in cells. */
  w: number;
  h: number;
  /** Cells per page px (e.g. 0.25). */
  scale: number;
  data: Float32Array;
}

export interface WeightedPoint {
  x: number;
  y: number;
  w: number;
}

export function createGrid(docW: number, docH: number, scale = 0.25): HeatGrid {
  const w = Math.max(1, Math.ceil(docW * scale));
  const h = Math.max(1, Math.ceil(docH * scale));
  return { w, h, scale, data: new Float32Array(w * h) };
}

export function depositPoints(grid: HeatGrid, points: Iterable<WeightedPoint>): void {
  const { w, h, scale, data } = grid;
  for (const p of points) {
    const cx = Math.floor(p.x * scale);
    const cy = Math.floor(p.y * scale);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    data[cy * w + cx]! += p.w;
  }
}

/** Separable gaussian blur in place; sigma in page px. */
export function blurGrid(grid: HeatGrid, sigmaPx: number): void {
  const sigma = sigmaPx * grid.scale;
  if (sigma <= 0) return;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum;

  const { w, h, data } = grid;
  const tmp = new Float32Array(w * h);
  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        acc += data[row + xx]! * kernel[k + radius]!;
      }
      tmp[row + x] = acc;
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        acc += tmp[yy * w + x]! * kernel[k + radius]!;
      }
      data[y * w + x] = acc;
    }
  }
}

/** Normalise to 0..1 clipping at the given percentile of non-zero cells. */
export function normalizeGrid(grid: HeatGrid, percentile = 0.98): Float32Array {
  const { data } = grid;
  const nz: number[] = [];
  for (let i = 0; i < data.length; i++) if (data[i]! > 0) nz.push(data[i]!);
  const out = new Float32Array(data.length);
  if (nz.length === 0) return out;
  nz.sort((a, b) => a - b);
  const idx = Math.min(nz.length - 1, Math.floor(percentile * (nz.length - 1)));
  const max = nz[idx]! || nz[nz.length - 1]!;
  for (let i = 0; i < data.length; i++) out[i] = Math.min(1, data[i]! / max);
  return out;
}

export interface GradientStop {
  at: number;
  rgba: [number, number, number, number];
}

/** transparent → blue → green → yellow → red */
export const DEFAULT_GRADIENT: GradientStop[] = [
  { at: 0.0, rgba: [0, 0, 255, 0] },
  { at: 0.2, rgba: [0, 90, 255, 110] },
  { at: 0.45, rgba: [0, 200, 120, 160] },
  { at: 0.7, rgba: [255, 230, 0, 200] },
  { at: 1.0, rgba: [255, 30, 0, 230] },
];

export function buildLut(gradient = DEFAULT_GRADIENT, size = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let a = gradient[0]!, b = gradient[gradient.length - 1]!;
    for (let k = 0; k < gradient.length - 1; k++) {
      if (t >= gradient[k]!.at && t <= gradient[k + 1]!.at) {
        a = gradient[k]!;
        b = gradient[k + 1]!;
        break;
      }
    }
    const span = b.at - a.at || 1;
    const u = (t - a.at) / span;
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = a.rgba[c]! + (b.rgba[c]! - a.rgba[c]!) * u;
  }
  return lut;
}

/** RGBA pixels (grid resolution) for an ImageData of size grid.w × grid.h. */
export function colorize(norm: Float32Array, lut = buildLut()): Uint8ClampedArray {
  const out = new Uint8ClampedArray(norm.length * 4);
  const steps = lut.length / 4 - 1;
  for (let i = 0; i < norm.length; i++) {
    const v = norm[i]!;
    if (v <= 0) continue;
    const k = Math.min(steps, Math.round(v * steps)) * 4;
    out[i * 4] = lut[k]!;
    out[i * 4 + 1] = lut[k + 1]!;
    out[i * 4 + 2] = lut[k + 2]!;
    out[i * 4 + 3] = lut[k + 3]!;
  }
  return out;
}

/** Location of the maximum cell in page px (for tests and "hot spot" summaries). */
export function peak(grid: HeatGrid): { x: number; y: number; value: number } {
  let best = -1, bi = 0;
  for (let i = 0; i < grid.data.length; i++) {
    if (grid.data[i]! > best) {
      best = grid.data[i]!;
      bi = i;
    }
  }
  return { x: ((bi % grid.w) + 0.5) / grid.scale, y: (Math.floor(bi / grid.w) + 0.5) / grid.scale, value: best };
}

export function gridSum(grid: HeatGrid): number {
  let s = 0;
  for (let i = 0; i < grid.data.length; i++) s += grid.data[i]!;
  return s;
}

/** Sum grids of identical geometry (aggregate heatmaps across sessions). */
export function addGrids(dst: HeatGrid, src: HeatGrid, weight = 1): void {
  if (dst.w !== src.w || dst.h !== src.h) throw new Error('grid size mismatch');
  for (let i = 0; i < dst.data.length; i++) dst.data[i]! += src.data[i]! * weight;
}
