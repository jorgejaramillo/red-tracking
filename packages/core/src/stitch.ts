import type { Rect } from '@red-tracking/protocol';

export interface TileMeta {
  id: string;
  t: number;
  scrollX: number;
  scrollY: number;
  viewportW: number;
  viewportH: number;
  dpr: number;
  docW: number;
  docH: number;
  stickyRects: Rect[];
}

export interface StitchOp {
  tileId: string;
  /** Destination rect on the stitched canvas (canvas px). */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Regions of THIS tile to skip (canvas px), e.g. sticky headers duplicated across tiles. */
  masks: Rect[];
}

export interface StitchPlan {
  /** Canvas size in px. */
  canvasW: number;
  canvasH: number;
  /** canvas px per page CSS px (≤ 1 when the page exceeds maxDim). */
  scale: number;
  docW: number;
  docH: number;
  ops: StitchOp[];
}

/**
 * Plan how to paint viewport tiles onto one full-page canvas.
 * Tiles are painted in chronological order (later tiles win). Sticky/fixed rects
 * are masked on every tile except the top-most one (smallest scrollY), so headers
 * appear once, at their natural position.
 */
export function planStitch(tiles: TileMeta[], opts: { maxDim?: number } = {}): StitchPlan {
  const maxDim = opts.maxDim ?? 16384;
  if (tiles.length === 0) {
    return { canvasW: 1, canvasH: 1, scale: 1, docW: 1, docH: 1, ops: [] };
  }
  const docW = Math.max(...tiles.map((t) => Math.max(t.docW, t.scrollX + t.viewportW)));
  const docH = Math.max(...tiles.map((t) => Math.max(t.docH, t.scrollY + t.viewportH)));
  const scale = Math.min(1, maxDim / Math.max(docW, docH));
  const canvasW = Math.ceil(docW * scale);
  const canvasH = Math.ceil(docH * scale);

  const sorted = tiles.slice().sort((a, b) => a.t - b.t);
  const topTile = sorted.reduce((best, t) => (t.scrollY < best.scrollY ? t : best), sorted[0]!);

  const ops: StitchOp[] = sorted.map((t) => {
    const masks: Rect[] = t.id === topTile.id
      ? []
      : t.stickyRects.map((r) => ({
          x: (t.scrollX + r.x) * scale,
          y: (t.scrollY + r.y) * scale,
          w: r.w * scale,
          h: r.h * scale,
        }));
    return {
      tileId: t.id,
      dx: t.scrollX * scale,
      dy: t.scrollY * scale,
      dw: t.viewportW * scale,
      dh: t.viewportH * scale,
      masks,
    };
  });
  return { canvasW, canvasH, scale, docW, docH, ops };
}

/** Which page-px rows are covered by at least one tile (for "uncaptured area" hints). */
export function coverage(plan: StitchPlan): number {
  if (plan.ops.length === 0) return 0;
  const rows = new Uint8Array(plan.canvasH);
  for (const op of plan.ops) {
    const y0 = Math.max(0, Math.floor(op.dy));
    const y1 = Math.min(plan.canvasH, Math.ceil(op.dy + op.dh));
    for (let y = y0; y < y1; y++) rows[y] = 1;
  }
  let c = 0;
  for (let y = 0; y < rows.length; y++) c += rows[y]!;
  return c / plan.canvasH;
}
