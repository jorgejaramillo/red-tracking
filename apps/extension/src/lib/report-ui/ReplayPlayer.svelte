<script lang="ts">
  import { untrack } from 'svelte';
  import { i18n } from '#i18n';
  import type { VisitAnalysis } from '../report/analysis';
  import type { StitchedPage } from '../report/render';
  import { ReplayRenderer } from '../report/replay';
  import { downloadBlob } from '../report/export';
  import { fmtDuration } from './nav';

  interface Props {
    visit: VisitAnalysis;
    page: StitchedPage | null;
    onWebm?: (blob: Blob) => void;
  }
  let { visit, page, onWebm }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let renderer: ReplayRenderer | null = null;
  let playing = $state(false);
  let pos = $state(0); // ms from start
  let speed = $state(1);
  let exporting = $state(false);
  let progress = $state(0);
  let duration = $state(1);
  let raf = 0;
  let wallStart = 0;
  let posStart = 0;

  $effect(() => {
    const p = page;
    const el = canvasEl;
    const v = visit;
    if (!p || !el) return;
    untrack(() => {
      renderer = new ReplayRenderer(el, p, v);
      duration = renderer.durationMs;
      pos = 0;
      renderer.draw(renderer.tStart);
    });
    return () => {
      cancelAnimationFrame(raf);
      playing = false;
    };
  });

  function frame() {
    if (!renderer || !playing) return;
    pos = Math.min(duration, posStart + (performance.now() - wallStart) * speed);
    renderer.draw(renderer.tStart + pos);
    if (pos >= duration) {
      playing = false;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function toggle() {
    if (!renderer) return;
    if (playing) {
      playing = false;
      cancelAnimationFrame(raf);
    } else {
      if (pos >= duration) pos = 0;
      playing = true;
      wallStart = performance.now();
      posStart = pos;
      raf = requestAnimationFrame(frame);
    }
  }

  function seek(e: Event) {
    pos = Number((e.currentTarget as HTMLInputElement).value);
    posStart = pos;
    wallStart = performance.now();
    renderer?.draw(renderer.tStart + pos);
  }

  async function exportWebm() {
    if (!renderer || exporting) return;
    exporting = true;
    playing = false;
    cancelAnimationFrame(raf);
    try {
      const blob = await renderer.exportWebm({ speed, onProgress: (p) => (progress = p) });
      onWebm?.(blob);
      downloadBlob(blob, `replay-${visit.visit.id}.webm`);
    } finally {
      exporting = false;
      progress = 0;
      renderer.draw(renderer.tStart + pos);
    }
  }
</script>

<div class="card grid">
  <div class="row" style="justify-content: space-between">
    <h2 style="margin:0">{i18n.t('report.replay')}</h2>
    <div class="row">
      <select bind:value={speed} style="width:auto">
        <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
      </select>
      <button onclick={exportWebm} disabled={!page || exporting}>
        {exporting ? i18n.t('report.rendering_video', [Math.round(progress * 100).toString()]) : i18n.t('report.export_webm')}
      </button>
    </div>
  </div>
  <canvas class="fit" bind:this={canvasEl} style="aspect-ratio: 16/9"></canvas>
  <div class="row">
    <button class="primary" onclick={toggle} disabled={!page || exporting}>{playing ? '❚❚' : '▶'}</button>
    <input type="range" min="0" max={duration} step="33" value={pos} oninput={seek} style="flex:1" disabled={exporting} />
    <span class="muted" style="font-variant-numeric: tabular-nums">{fmtDuration(pos)} / {fmtDuration(duration)}</span>
  </div>
</div>
