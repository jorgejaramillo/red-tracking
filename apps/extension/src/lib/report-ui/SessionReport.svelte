<script lang="ts">
  import { i18n } from '#i18n';
  import { deleteSession, loadSessionBundle } from '../db';
  import { analyzeSession, type SessionAnalysis, type VisitAnalysis } from '../report/analysis';
  import { buildExportZip, downloadBlob } from '../report/export';
  import type { StitchedPage } from '../report/render';
  import AoiTable from './AoiTable.svelte';
  import HeatmapView from './HeatmapView.svelte';
  import ReplayPlayer from './ReplayPlayer.svelte';
  import { fmtDate, fmtDuration, go } from './nav';

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  // raw: the analysis holds typed arrays and Blobs; deep proxies would be slow and pointless.
  let analysis = $state.raw<SessionAnalysis | null>(null);
  let error = $state<string | null>(null);
  let visitIdx = $state(0);
  let visit = $derived<VisitAnalysis | null>(analysis?.visits[visitIdx] ?? null);
  let page = $state.raw<StitchedPage | null>(null);
  let heatmaps: Record<string, Blob> = {};
  let replay: Blob | null = null;
  let exporting = $state(false);

  $effect(() => {
    void (async () => {
      try {
        const bundle = await loadSessionBundle(sessionId);
        if (!bundle) {
          error = 'Session not found';
          return;
        }
        analysis = analyzeSession(bundle);
        visitIdx = 0;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    })();
  });

  async function exportZip() {
    if (!analysis) return;
    exporting = true;
    try {
      const blob = await buildExportZip(analysis, { heatmaps, replay });
      downloadBlob(blob, `red-tracking-${analysis.bundle.session.id}.zip`);
    } finally {
      exporting = false;
    }
  }

  async function remove() {
    if (!analysis || !confirm(i18n.t('report.confirm_delete'))) return;
    await deleteSession(analysis.bundle.session.id);
    go({ name: 'home' });
  }

  const verdictClass = (v: string | undefined) => (v === 'pass' ? 'ok' : v === 'warn' ? 'warn' : v === 'fail' ? 'fail' : '');
</script>

{#if error}
  <div class="card" style="color:#ff8c85">{error}</div>
{:else if !analysis}
  <div class="card muted">{i18n.t('common.loading')}</div>
{:else}
  {@const s = analysis.bundle.session}
  {@const val = s.validation ?? analysis.bundle.calibration?.validation}
  <div class="grid">
    <div class="card">
      <div class="row" style="justify-content: space-between">
        <div>
          <h2 style="margin:0">{s.study?.name ?? i18n.t('report.title')}</h2>
          <div class="muted">{fmtDate(s.createdAt)} · {s.study?.targetUrl ?? ''} · <span class="tag">{s.state}</span></div>
        </div>
        <div class="row">
          <button class="primary" onclick={exportZip} disabled={exporting}>{i18n.t('report.export_zip')}</button>
          <button class="danger" onclick={remove}>{i18n.t('report.delete_session')}</button>
        </div>
      </div>
      <div class="row" style="margin-top: 14px">
        <div class="stat"><div class="v">{fmtDuration(analysis.totals.durationMs)}</div><div class="k">{i18n.t('report.summary_duration')}</div></div>
        <div class="stat"><div class="v">{analysis.totals.validSamples}<span class="muted" style="font-size:12px">/{analysis.totals.samples}</span></div><div class="k">{i18n.t('report.summary_samples')}</div></div>
        <div class="stat"><div class="v">{analysis.totals.fixations}</div><div class="k">{i18n.t('report.summary_fixations')}</div></div>
        <div class="stat">
          <div class="v">{val ? `${val.meanErrPx.toFixed(0)} px` : '—'} {#if val}<span class="tag {verdictClass(val.verdict)}">{val.verdict}</span>{/if}</div>
          <div class="k">{i18n.t('report.summary_accuracy')}{val ? ` · ${val.meanErrDeg.toFixed(1)}°` : ''}</div>
        </div>
      </div>
    </div>

    {#if analysis.visits.length > 1}
      <div class="tabs">
        {#each analysis.visits as v, i (v.visit.id)}
          <button class:active={i === visitIdx} onclick={() => { visitIdx = i; page = null; }} title={v.visit.url}>
            {i18n.t('report.page_visit')} {i + 1} · {new URL(v.visit.url).pathname.slice(0, 30)} ({fmtDuration(v.durationMs)})
          </button>
        {/each}
      </div>
    {/if}

    {#if visit}
      {#key visit.visit.id}
        <HeatmapView {visit} onPage={(p) => (page = p)} onHeatmapBlob={(b) => (heatmaps[visit!.visit.id] = b)} />
        <AoiTable metrics={visit.metrics} visitId={visit.visit.id} />
        <ReplayPlayer {visit} {page} onWebm={(b) => (replay = b)} />
      {/key}
    {:else}
      <div class="card muted">{i18n.t('report.no_sessions')}</div>
    {/if}
  </div>
{/if}
