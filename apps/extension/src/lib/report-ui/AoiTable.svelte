<script lang="ts">
  import { metricsToCsv } from '@red-tracking/core';
  import type { AOIMetrics } from '@red-tracking/protocol';
  import { i18n } from '#i18n';
  import { relevantMetrics } from '../report/analysis';
  import { downloadBlob } from '../report/export';

  interface Props {
    metrics: AOIMetrics[];
    visitId: string;
  }
  let { metrics, visitId }: Props = $props();
  let showAll = $state(false);
  let rows = $derived(showAll ? metrics : relevantMetrics(metrics));

  function csv() {
    downloadBlob(new Blob([metricsToCsv(metrics)], { type: 'text/csv' }), `aoi-metrics-${visitId}.csv`);
  }
</script>

<div class="card grid">
  <div class="row" style="justify-content: space-between">
    <h2 style="margin:0">{i18n.t('report.aois')} <span class="tag">{rows.length}/{metrics.length}</span></h2>
    <div class="row">
      <label class="row" style="margin:0; color: var(--text)"><input type="checkbox" bind:checked={showAll} style="width:auto" /> todas</label>
      <button onclick={csv} disabled={!metrics.length}>{i18n.t('report.export_csv')}</button>
    </div>
  </div>
  <div style="overflow:auto; max-height: 60vh">
    <table>
      <thead>
        <tr>
          <th class="num">{i18n.t('report.aoi_order')}</th>
          <th>{i18n.t('report.aoi_label')}</th>
          <th>Origen</th>
          <th class="num">{i18n.t('report.aoi_ttff')}</th>
          <th class="num">{i18n.t('report.aoi_dwell')}</th>
          <th class="num">{i18n.t('report.aoi_fixations')}</th>
          <th class="num">{i18n.t('report.aoi_visits')}</th>
          <th class="num">%</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as m (m.aoiId)}
          <tr>
            <td class="num">{m.firstVisitOrder ?? '—'}</td>
            <td title={m.aoiId} style="white-space: normal; max-width: 320px">
              {m.label}
              {#if m.belowResolution}<span class="tag warn" title={i18n.t('report.aoi_below_resolution')}>!</span>{/if}
            </td>
            <td><span class="tag">{m.source}</span></td>
            <td class="num">{m.ttffMs === null ? '—' : Math.round(m.ttffMs)}</td>
            <td class="num">{Math.round(m.dwellMs)}</td>
            <td class="num">{m.fixationCount}</td>
            <td class="num">{m.visitCount}</td>
            <td class="num">{(m.pctSessionTime * 100).toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
