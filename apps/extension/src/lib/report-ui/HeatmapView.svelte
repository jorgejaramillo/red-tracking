<script lang="ts">
  import { untrack } from 'svelte';
  import { coverage } from '@red-tracking/core';
  import { i18n } from '#i18n';
  import type { VisitAnalysis } from '../report/analysis';
  import { buildHeatGrid, canvasToBlob, composeHeatmap, drawFixations, heatPoints, renderStitched, type HeatMode, type StitchedPage } from '../report/render';
  import { downloadBlob } from '../report/export';

  interface Props {
    visit: VisitAnalysis;
    onPage?: (page: StitchedPage) => void;
    onHeatmapBlob?: (blob: Blob) => void;
  }
  let { visit, onPage, onHeatmapBlob }: Props = $props();

  let mode = $state<HeatMode>('fixations');
  let showFixations = $state(true);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let page = $state.raw<StitchedPage | null>(null);
  let composed = $state.raw<OffscreenCanvas | null>(null);
  let rendering = $state(false);
  let cov = $derived(visit.tiles.length ? coverage(visit.plan) : 0);

  async function buildPage(v: VisitAnalysis) {
    rendering = true;
    try {
      let built: StitchedPage;
      if (v.tiles.length) {
        built = await renderStitched(v.tiles, v.plan);
      } else {
        // No screenshots (e.g. capture failed): draw the harvested AOI boxes as a wireframe of the page.
        const c = new OffscreenCanvas(Math.max(1, v.docSize.w), Math.max(1, v.docSize.h));
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.font = '12px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        for (const a of v.aois) {
          const r = a.rects.at(-1);
          if (!r || r.w < 4 || r.h < 4) continue;
          ctx.fillStyle = a.source === 'auto-image' ? 'rgba(148,163,184,0.35)' : 'rgba(255,255,255,0.6)';
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.strokeStyle = 'rgba(71,85,105,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
          if (r.w > 60 && r.h > 18) {
            ctx.fillStyle = '#334155';
            ctx.fillText(a.label.slice(0, Math.max(4, Math.floor(r.w / 7))), r.x + 4, r.y + 3);
          }
        }
        built = { canvas: c, plan: { ...v.plan, canvasW: c.width, canvasH: c.height, scale: 1, docW: c.width, docH: c.height } };
      }
      // Never read `page` here: this runs synchronously inside an effect that writes it.
      page = built;
      onPage?.(built);
    } finally {
      rendering = false;
    }
  }

  async function compose() {
    if (!page || !canvasEl) return;
    const pts = heatPoints(mode, visit.fixations, visit.chunks);
    const grid = buildHeatGrid(pts, page.plan.docW, page.plan.docH, { sigmaPx: mode === 'raw' ? 30 : 40 });
    // Heat grid is in page px; the composed canvas is page px × plan.scale.
    composed = composeHeatmap(page, grid, 0.6);
    const maxW = 1400;
    const s = Math.min(1, maxW / composed.width);
    canvasEl.width = Math.round(composed.width * s);
    canvasEl.height = Math.round(composed.height * s);
    const ctx = canvasEl.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(composed, 0, 0, canvasEl.width, canvasEl.height);
    if (showFixations) drawFixations(ctx, visit.fixations, page.plan.scale * s);
    onHeatmapBlob?.(await canvasToBlob(composed, 'image/png'));
  }

  $effect(() => {
    const v = visit;
    untrack(() => {
      page = null;
      void buildPage(v);
    });
  });
  $effect(() => {
    void mode;
    void showFixations;
    const p = page;
    const el = canvasEl;
    if (p && el) untrack(() => void compose());
  });

  async function downloadPng() {
    if (!composed) return;
    const out = new OffscreenCanvas(composed.width, composed.height);
    const ctx = out.getContext('2d')!;
    ctx.drawImage(composed, 0, 0);
    if (showFixations && page) drawFixations(ctx, visit.fixations, page.plan.scale);
    downloadBlob(await canvasToBlob(out, 'image/png'), `heatmap-${visit.visit.id}.png`);
  }
</script>

<div class="card grid">
  <div class="row" style="justify-content: space-between">
    <h2 style="margin:0">{i18n.t('report.heatmap')}</h2>
    <div class="row">
      <div class="tabs">
        <button class:active={mode === 'fixations'} onclick={() => (mode = 'fixations')}>{i18n.t('report.mode_fixations')}</button>
        <button class:active={mode === 'raw'} onclick={() => (mode = 'raw')}>{i18n.t('report.mode_raw')}</button>
      </div>
      <label class="row" style="margin:0; color: var(--text)"><input type="checkbox" bind:checked={showFixations} style="width:auto" /> {i18n.t('report.summary_fixations')}</label>
      <button onclick={downloadPng} disabled={!composed}>{i18n.t('report.export_png')}</button>
    </div>
  </div>
  {#if !visit.tiles.length}
    <div style="color: var(--warn)">{i18n.t('report.no_tiles')}</div>
  {/if}
  {#if visit.tiles.length && cov < 0.6}
    <div class="muted" style="color: var(--warn)">{i18n.t('report.coverage_warning', [Math.round(cov * 100).toString()])}</div>
  {/if}
  {#if rendering}<div class="muted">{i18n.t('common.loading')}</div>{/if}
  <div style="overflow:auto; max-height: 75vh; border-radius: 8px">
    <canvas class="fit" bind:this={canvasEl}></canvas>
  </div>
</div>
