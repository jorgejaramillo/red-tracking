<script lang="ts">
  import { i18n } from '#i18n';
  import type { PanelSnapshot, ValidationResult } from '@red-tracking/protocol';
  import { pxToDeg } from '@red-tracking/core';
  import { formatMmSs } from './format';
  import type { CalibProgress } from './panelClient';

  interface Props {
    snapshot: PanelSnapshot;
    calib: CalibProgress | null;
    validation: ValidationResult | null;
    recordedMs: number;
    hostDenied: boolean;
    doneSessionId: string | null;
    onstart: () => void;
    onstop: () => void;
    onrecalibrate: () => void;
    onresume: () => void;
    onreport: (sessionId: string | null) => void;
  }

  let {
    snapshot,
    calib,
    validation,
    recordedMs,
    hostDenied,
    doneSessionId,
    onstart,
    onstop,
    onrecalibrate,
    onresume,
    onreport,
  }: Props = $props();

  const state = $derived(snapshot.sessionState);
  const canStart = $derived(!!snapshot.study && snapshot.cameraGranted && snapshot.engine.state === 'running');
  const totalPoints = $derived(snapshot.study?.calibration.points ?? 9);
  const calibIndex = $derived(calib ? Math.min(calib.index + 1, totalPoints) : 0);
  const calibPct = $derived(calib ? Math.round((calibIndex / totalPoints) * 100) : 0);
  const reportId = $derived(doneSessionId ?? snapshot.session?.id ?? null);

  const pausedText = $derived.by(() => {
    switch (snapshot.pauseReason) {
      case 'face-lost':
        return i18n.t('panel.paused_face');
      case 'wrong-tab':
      case 'tab-hidden':
        return i18n.t('panel.paused_tab');
      case 'geometry':
        return i18n.t('panel.paused_geometry');
      default:
        return i18n.t('panel.paused');
    }
  });

  const validationText = $derived.by(() => {
    if (!validation) return null;
    const deg = Number.isFinite(validation.meanErrDeg) ? validation.meanErrDeg : pxToDeg(validation.meanErrPx);
    return i18n.t('panel.validation_result', [validation.meanErrPx.toFixed(0), deg.toFixed(1)]);
  });

  const verdictText = $derived.by(() => {
    if (!validation) return null;
    switch (validation.verdict) {
      case 'pass':
        return i18n.t('panel.validation_pass');
      case 'warn':
        return i18n.t('panel.validation_warn');
      default:
        return i18n.t('panel.validation_fail');
    }
  });

  const verdictClass = $derived(
    validation?.verdict === 'pass' ? 'ok' : validation?.verdict === 'warn' ? 'warn' : 'err',
  );

  const errorText = $derived(snapshot.session?.error ?? i18n.t('common.error'));
</script>

<section class="card stack">
  {#if state === 'IDLE' || state === 'READY'}
    <button type="button" class="btn-primary btn-block" disabled={!canStart} onclick={onstart}>
      {i18n.t('panel.start_session')}
    </button>
    {#if hostDenied}
      <p class="err small" role="alert">{i18n.t('panel.host_permission_denied')}</p>
    {/if}
    <p class="muted small">{i18n.t('panel.start_hint')}</p>
    <p class="muted small">{i18n.t('panel.window_hint')}</p>
  {:else if state === 'CALIBRATING'}
    <div class="row">
      <span class="spinner"></span>
      <span class="grow">{i18n.t('panel.calibrating')}</span>
      {#if calib}
        <span class="mono muted small">{i18n.t('overlay.calibration_progress', [calibIndex, totalPoints])}</span>
      {/if}
    </div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={calibPct}>
      <div class="bar" style:width="{calibPct}%"></div>
    </div>
    <p class="muted small">{i18n.t('panel.window_hint')}</p>
  {:else if state === 'VALIDATING'}
    <div class="row">
      <span class="spinner"></span>
      <span>{i18n.t('panel.validating')}</span>
    </div>
  {:else if state === 'RECORDING'}
    <div class="row">
      <span class="dot rec"></span>
      <span class="grow rec-label">{i18n.t('panel.recording')}</span>
      <span class="mono timer" aria-label={i18n.t('panel.elapsed')}>{formatMmSs(recordedMs)}</span>
    </div>
    <div class="row actions">
      <button type="button" class="btn-primary grow" onclick={onstop}>{i18n.t('panel.stop_session')}</button>
      <button type="button" onclick={onrecalibrate}>{i18n.t('panel.recalibrate')}</button>
    </div>
  {:else if state === 'PAUSED'}
    <div class="row">
      <span class="dot"></span>
      <span class="grow warn">{pausedText}</span>
      <span class="mono timer muted">{formatMmSs(recordedMs)}</span>
    </div>
    <div class="row actions">
      <button type="button" class="btn-primary grow" onclick={onresume}>{i18n.t('panel.resume')}</button>
      <button type="button" onclick={onstop}>{i18n.t('panel.stop_session')}</button>
    </div>
  {:else if state === 'FINALIZING'}
    <div class="row">
      <span class="spinner"></span>
      <span>{i18n.t('panel.finalizing')}</span>
    </div>
  {:else if state === 'DONE'}
    <div class="row">
      <span class="dot ok"></span>
      <span class="grow">{i18n.t('panel.done')}</span>
    </div>
    <button type="button" class="btn-primary btn-block" onclick={() => onreport(reportId)}>
      {i18n.t('panel.open_report')}
    </button>
  {:else if state === 'ERROR'}
    <p class="err" role="alert">{errorText}</p>
    {#if reportId}
      <button type="button" class="btn-block" onclick={() => onreport(reportId)}>{i18n.t('panel.open_report')}</button>
    {/if}
  {/if}

  {#if validationText && verdictText && state !== 'IDLE' && state !== 'READY'}
    <div class="validation small">
      <div class="mono">{validationText}</div>
      <div class={verdictClass}>{verdictText}</div>
    </div>
  {/if}
</section>

<style>
  .progress {
    height: 4px;
    background: var(--panel-2);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .rec-label {
    font-weight: 600;
  }
  .timer {
    font-size: 14px;
  }
  .actions {
    gap: 6px;
  }
  .validation {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
