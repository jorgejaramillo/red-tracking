/**
 * Canvas rendering for reports: stitched page image + heatmap overlay.
 */
import {
  blurGrid,
  buildLut,
  colorize,
  createGrid,
  depositPoints,
  normalizeGrid,
  rawPointsFromChunks,
  type HeatGrid,
  type StitchPlan,
  type WeightedPoint,
} from '@red-tracking/core';
import type { Fixation, SampleChunk, ScreenshotTile } from '@red-tracking/protocol';

export type HeatMode = 'fixations' | 'raw';

export interface StitchedPage {
  canvas: OffscreenCanvas;
  plan: StitchPlan;
}

export async function renderStitched(tiles: ScreenshotTile[], plan: StitchPlan): Promise<StitchedPage> {
  const canvas = new OffscreenCanvas(Math.max(1, plan.canvasW), Math.max(1, plan.canvasH));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const byId = new Map(tiles.map((t) => [t.id, t]));
  for (const op of plan.ops) {
    const tile = byId.get(op.tileId);
    if (!tile) continue;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(tile.blob);
    } catch {
      continue;
    }
    ctx.save();
    if (op.masks.length) {
      const path = new Path2D();
      path.rect(op.dx, op.dy, op.dw, op.dh);
      for (const m of op.masks) path.rect(m.x, m.y, m.w, m.h);
      ctx.clip(path, 'evenodd');
    }
    ctx.drawImage(bmp, op.dx, op.dy, op.dw, op.dh);
    ctx.restore();
    bmp.close();
  }
  return { canvas, plan };
}

export function heatPoints(mode: HeatMode, fixations: Fixation[], chunks: SampleChunk[]): WeightedPoint[] {
  if (mode === 'raw') return rawPointsFromChunks(chunks);
  return fixations.map((f) => ({ x: f.px, y: f.py, w: f.durationMs / 100 }));
}

export interface HeatmapOptions {
  sigmaPx?: number;
  alpha?: number;
  gridScale?: number;
}

/** Build the heat grid in page coordinates. */
export function buildHeatGrid(points: WeightedPoint[], docW: number, docH: number, opts: HeatmapOptions = {}): HeatGrid {
  const grid = createGrid(docW, docH, opts.gridScale ?? 0.25);
  depositPoints(grid, points);
  blurGrid(grid, opts.sigmaPx ?? 40);
  return grid;
}

/** Heat layer as an RGBA canvas at grid resolution (scale up with drawImage). */
export function heatLayer(grid: HeatGrid): OffscreenCanvas {
  const norm = normalizeGrid(grid, 0.98);
  const rgba = colorize(norm, buildLut());
  const c = new OffscreenCanvas(grid.w, grid.h);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, grid.w, grid.h), 0, 0);
  return c;
}

/** Compose page + heat into a new canvas (page px scaled by plan.scale). */
export function composeHeatmap(page: StitchedPage, grid: HeatGrid, alpha = 0.6): OffscreenCanvas {
  const out = new OffscreenCanvas(page.canvas.width, page.canvas.height);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(page.canvas, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heatLayer(grid), 0, 0, out.width, out.height);
  ctx.globalAlpha = 1;
  return out;
}

export function drawFixations(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, fixations: Fixation[], scale: number, offsetX = 0, offsetY = 0): void {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fixations.forEach((f, i) => {
    const r = Math.max(6, Math.min(40, Math.sqrt(f.durationMs) * 0.9)) * scale;
    const x = (f.px - offsetX) * scale;
    const y = (f.py - offsetY) * scale;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(230, 60, 50, 0.25)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(230, 60, 50, 0.9)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i + 1), x, y);
  });
  ctx.restore();
}

export async function canvasToBlob(canvas: OffscreenCanvas, type = 'image/png', quality?: number): Promise<Blob> {
  return canvas.convertToBlob({ type, quality });
}

/** Scaled-down copy for on-screen display (keeps memory bounded on huge pages). */
export function downscale(canvas: OffscreenCanvas, maxWidth: number): OffscreenCanvas {
  if (canvas.width <= maxWidth) return canvas;
  const s = maxWidth / canvas.width;
  const out = new OffscreenCanvas(Math.round(canvas.width * s), Math.round(canvas.height * s));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}
