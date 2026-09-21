/**
 * Data-driven replay: draws the stitched page scrolled to the recorded
 * position with the gaze trail on top; can export itself to WebM.
 */
import type { GazeSampleLite } from '@red-tracking/core';
import type { Fixation, SampleChunk } from '@red-tracking/protocol';
import type { VisitAnalysis } from './analysis';
import type { StitchedPage } from './render';

export interface ReplaySample {
  t: number;
  px: number;
  py: number;
  scrollX: number;
  scrollY: number;
  valid: boolean;
}

export interface ReplayOptions {
  width?: number;
  height?: number;
  trailMs?: number;
}

export class ReplayRenderer {
  readonly width: number;
  readonly height: number;
  private readonly trailMs: number;
  private readonly samples: ReplaySample[];
  private readonly fixations: Fixation[];
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly tStart: number;
  readonly tEnd: number;
  private cursor = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly page: StitchedPage,
    private readonly analysis: VisitAnalysis,
    opts: ReplayOptions = {},
  ) {
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.trailMs = opts.trailMs ?? 500;
    canvas.width = this.width;
    canvas.height = this.height;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.samples = replaySamples(analysis.chunks, analysis.samples);
    this.fixations = analysis.fixations;
    this.tStart = analysis.visit.tStart;
    this.tEnd = this.samples.at(-1)?.t ?? analysis.visit.tEnd ?? this.tStart + 1000;
  }

  get durationMs(): number {
    return Math.max(1, this.tEnd - this.tStart);
  }

  /** Draw the frame for absolute time `t` (epoch ms). */
  draw(t: number): void {
    const { ctx, width, height } = this;
    const vp = this.analysis.visit.viewport;
    const scale = Math.min(width / vp.w, height / vp.h);
    const vw = vp.w * scale, vh = vp.h * scale;
    const ox = (width - vw) / 2, oy = (height - vh) / 2;

    const s = this.sampleAt(t);
    const scrollX = s?.scrollX ?? 0;
    const scrollY = s?.scrollY ?? 0;

    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, width, height);

    // Page viewport.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, vw, vh);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox, oy, vw, vh);
    const ps = this.page.plan.scale; // canvas px per page px
    const src = this.page.canvas;
    ctx.drawImage(src, scrollX * ps, scrollY * ps, vp.w * ps, vp.h * ps, ox, oy, vw, vh);

    // Trail.
    const trail = this.trailBefore(t);
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i]!;
      const age = (t - p.t) / this.trailMs;
      const a = Math.max(0, 1 - age);
      const x = ox + (p.px - scrollX) * scale;
      const y = oy + (p.py - scrollY) * scale;
      ctx.beginPath();
      ctx.arc(x, y, 4 + 6 * a, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(230,60,50,${0.15 + 0.35 * a})`;
      ctx.fill();
    }
    // Current fixation.
    const fx = this.fixations.find((f) => t >= f.tStart && t <= f.tEnd);
    if (fx) {
      const r = Math.min(60, 10 + ((t - fx.tStart) / 1000) * 30) * scale;
      ctx.beginPath();
      ctx.arc(ox + (fx.px - scrollX) * scale, oy + (fx.py - scrollY) * scale, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,200,0,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // Current point.
    if (s && s.valid) {
      const x = ox + (s.px - scrollX) * scale;
      const y = oy + (s.py - scrollY) * scale;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230,60,50,0.85)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();

    // HUD.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, height - 28, width, 28);
    ctx.fillStyle = '#fff';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const el = Math.max(0, t - this.tStart);
    ctx.fillText(`${fmt(el)} / ${fmt(this.durationMs)}   ${shorten(this.analysis.visit.url, 90)}`, 10, height - 14);
    ctx.textAlign = 'right';
    ctx.fillText(s && !s.valid ? '· · ·' : '', width - 10, height - 14);
  }

  private sampleAt(t: number): ReplaySample | null {
    const s = this.samples;
    if (!s.length) return null;
    // Move the cursor monotonically when possible; binary search otherwise.
    if (this.cursor >= s.length || s[this.cursor]!.t > t) this.cursor = 0;
    while (this.cursor + 1 < s.length && s[this.cursor + 1]!.t <= t) this.cursor++;
    const cur = s[this.cursor]!;
    return cur.t <= t ? cur : null;
  }

  private trailBefore(t: number): ReplaySample[] {
    const out: ReplaySample[] = [];
    for (let i = this.cursor; i >= 0 && i < this.samples.length; i--) {
      const p = this.samples[i]!;
      if (t - p.t > this.trailMs) break;
      if (p.valid) out.push(p);
    }
    return out;
  }

  /**
   * Render the whole visit to a WebM blob in real time (MediaRecorder needs a
   * live stream). `speed` > 1 renders faster than real time by advancing the
   * clock quicker while the recorder still captures at real fps.
   */
  async exportWebm(opts: { fps?: number; speed?: number; onProgress?: (p: number) => void } = {}): Promise<Blob> {
    if (!(this.canvas instanceof HTMLCanvasElement)) throw new Error('WebM export needs an HTMLCanvasElement');
    const fps = opts.fps ?? 30;
    const speed = opts.speed ?? 1;
    const stream = this.canvas.captureStream(fps);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const parts: BlobPart[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.start(500);

    const total = this.durationMs;
    const wallStart = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        const elapsed = (performance.now() - wallStart) * speed;
        const t = this.tStart + Math.min(total, elapsed);
        this.draw(t);
        opts.onProgress?.(Math.min(1, elapsed / total));
        if (elapsed >= total + 500) resolve();
        else requestAnimationFrame(step);
      };
      step();
    });
    rec.stop();
    await done;
    stream.getTracks().forEach((tr) => tr.stop());
    return new Blob(parts, { type: mime });
  }
}

export function replaySamples(chunks: SampleChunk[], lite: GazeSampleLite[]): ReplaySample[] {
  // `lite` is time-ordered and flattened from the same chunks; re-attach scroll positions.
  const out: ReplaySample[] = [];
  const sorted = chunks.slice().sort((a, b) => a.tStart - b.tStart);
  let k = 0;
  for (const c of sorted) {
    for (let i = 0; i < c.count; i++, k++) {
      const l = lite[k];
      out.push({
        t: c.t[i]!,
        px: c.px[i]!,
        py: c.py[i]!,
        scrollX: c.scrollX[i]!,
        scrollY: c.scrollY[i]!,
        valid: l ? l.valid : true,
      });
    }
  }
  return out;
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
