/**
 * Weighted ridge regression via normal equations + Cholesky.
 * The first feature (index 0) is treated as the bias and is not penalised.
 */

export interface Gram {
  n: number;
  /** n×n symmetric, row-major */
  G: Float64Array;
  /** n */
  bx: Float64Array;
  by: Float64Array;
  weightSum: number;
}

export function emptyGram(n: number): Gram {
  return { n, G: new Float64Array(n * n), bx: new Float64Array(n), by: new Float64Array(n), weightSum: 0 };
}

export function gramAdd(g: Gram, x: ArrayLike<number>, yx: number, yy: number, w = 1): void {
  const n = g.n;
  for (let i = 0; i < n; i++) {
    const xi = x[i]! * w;
    g.bx[i]! += xi * yx;
    g.by[i]! += xi * yy;
    const row = i * n;
    for (let j = i; j < n; j++) {
      g.G[row + j]! += xi * x[j]!;
    }
  }
  g.weightSum += w;
}

export function gramClone(g: Gram): Gram {
  return { n: g.n, G: g.G.slice(), bx: g.bx.slice(), by: g.by.slice(), weightSum: g.weightSum };
}

export function gramAddInto(dst: Gram, src: Gram, sign = 1): void {
  for (let i = 0; i < dst.G.length; i++) dst.G[i]! += sign * src.G[i]!;
  for (let i = 0; i < dst.n; i++) {
    dst.bx[i]! += sign * src.bx[i]!;
    dst.by[i]! += sign * src.by[i]!;
  }
  dst.weightSum += sign * src.weightSum;
}

/**
 * Solve (G + λ·I') w = b for both targets, where I' is the identity with a 0 for the bias.
 * Only the upper triangle of G is read.
 */
export function ridgeSolve(g: Gram, lambda: number): { wx: Float64Array; wy: Float64Array } | null {
  const n = g.n;
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = g.G[i * n + j]!;
      A[i * n + j] = v;
      A[j * n + i] = v;
    }
    if (i > 0) A[i * n + i]! += lambda;
    else A[0]! += 1e-9;
  }
  const L = cholesky(A, n);
  if (!L) return null;
  return { wx: choleskySolve(L, n, g.bx), wy: choleskySolve(L, n, g.by) };
}

function cholesky(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j]!;
    for (let k = 0; k < j; k++) s -= L[j * n + k]! * L[j * n + k]!;
    if (s <= 1e-12) return null;
    const ljj = Math.sqrt(s);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let t = A[i * n + j]!;
      for (let k = 0; k < j; k++) t -= L[i * n + k]! * L[j * n + k]!;
      L[i * n + j] = t / ljj;
    }
  }
  return L;
}

function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Column means for centring (index 0 = bias, kept at 0). */
export function centerFit(rows: ArrayLike<number>[], n: number): Float64Array {
  const mean = new Float64Array(n);
  if (rows.length === 0) return mean;
  for (const r of rows) for (let i = 1; i < n; i++) mean[i]! += r[i]!;
  for (let i = 1; i < n; i++) mean[i]! /= rows.length;
  return mean;
}

/** (x − mean) / scale per column; the bias column stays 1. */
export function standardize(x: ArrayLike<number>, mean: ArrayLike<number>, scale: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  out[0] = 1;
  for (let i = 1; i < x.length; i++) out[i] = (x[i]! - mean[i]!) / scale[i]!;
  return out;
}

/** Data-driven z-scoring (kept for tests/tools; the gaze model uses fixed scales). */
export function zscoreFit(rows: ArrayLike<number>[], n: number): { mean: Float64Array; std: Float64Array } {
  const mean = centerFit(rows, n);
  const std = new Float64Array(n).fill(1);
  if (rows.length === 0) return { mean, std };
  const sq = new Float64Array(n);
  for (const r of rows) for (let i = 1; i < n; i++) sq[i]! += (r[i]! - mean[i]!) ** 2;
  for (let i = 1; i < n; i++) {
    const v = Math.sqrt(sq[i]! / rows.length);
    std[i] = v > 1e-9 ? v : 1;
  }
  return { mean, std };
}

export const zscoreApply = standardize;
