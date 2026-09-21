<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { i18n } from '#i18n';
  import { studyMatchPattern } from '@red-tracking/core';
  import type { PanelSnapshot, PreviewFrame, SwToPanel, ValidationResult } from '@red-tracking/protocol';
  import { PanelClient, type CalibProgress } from '../../lib/ui/panelClient';
  import { openReport, sendRuntime } from '../../lib/ui/runtime';
  import Banner from '../../lib/ui/Banner.svelte';
  import CameraPreview from '../../lib/ui/CameraPreview.svelte';
  import StudyCard from '../../lib/ui/StudyCard.svelte';
  import SessionCard from '../../lib/ui/SessionCard.svelte';

  const PREVIEW_FPS = 15;

  let snapshot = $state.raw<PanelSnapshot | null>(null);
  let diagCopied = $state(false);

  /** Copies the last calibration's diagnostics as JSON (no personal data: features and errors only). */
  async function copyDiag(): Promise<void> {
    const cal = snapshot?.calibration;
    if (!cal) return;
    const payload = {
      createdAt: new Date(cal.createdAt).toISOString(),
      geometry: cal.geometry,
      headRef: cal.headRef,
      offset: cal.offset,
      trainRmsePx: Math.round(cal.trainRmsePx),
      cvRmsePx: cal.cvRmsePx ?? null,
      validation: cal.validation ?? snapshot?.validation ?? null,
      diag: cal.diag ?? null,
      ua: navigator.userAgent,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      diagCopied = true;
      setTimeout(() => (diagCopied = false), 2000);
    } catch (err) {
      console.warn('[panel] clipboard failed', err);
    }
  }
  let frame = $state.raw<PreviewFrame | null>(null);
  let calib = $state.raw<CalibProgress | null>(null);
  const calibSeen = new Set<number>();
  let validation = $state.raw<ValidationResult | null>(null);
  let drift = $state<'warn' | 'recalibrate' | null>(null);
  let error = $state<string | null>(null);
  let doneSessionId = $state<string | null>(null);
  let recordedMs = $state(0);
  let joinPending = $state(false);
  let joinInvalid = $state(false);
  let hostDenied = $state(false);

  const client = new PanelClient({
    previewFps: PREVIEW_FPS,
    onMessage: handleMessage,
  });

  function handleMessage(msg: SwToPanel): void {
    switch (msg.type) {
      case 'SNAPSHOT':
        applySnapshot(msg.snapshot);
        break;
      case 'PREVIEW':
        frame = msg.frame;
        break;
      case 'CALIB_PROGRESS':
        // Targets are shown in random order, so report the sequence position
        // (how many distinct targets have been shown), not the target's index.
        calibSeen.add(msg.index);
        calib = { index: calibSeen.size - 1, validFrames: msg.validFrames, needed: msg.needed };
        break;
      case 'VALIDATION_RESULT':
        validation = msg.result;
        break;
      case 'HEAD_DRIFT':
        drift = msg.severity === 'ok' ? null : msg.severity;
        break;
      case 'ERROR':
        error = msg.message;
        if (joinPending) {
          joinPending = false;
          joinInvalid = true;
        }
        break;
      case 'SESSION_DONE':
        doneSessionId = msg.sessionId;
        break;
    }
  }

  function applySnapshot(next: PanelSnapshot): void {
    if (next.sessionState !== 'CALIBRATING' && next.sessionState !== 'VALIDATING') calibSeen.clear();
    snapshot = next;
    recordedMs = next.recordedMs;

    if (joinPending) {
      joinPending = false;
      joinInvalid = next.study === null;
    } else if (next.study) {
      joinInvalid = false;
    }

    const s = next.sessionState;
    if (s !== 'CALIBRATING') calib = null;
    if (s !== 'RECORDING' && s !== 'PAUSED') drift = null;
    if (s === 'IDLE' || s === 'READY') {
      doneSessionId = null;
      hostDenied = false;
    }
    if (next.validation) validation = next.validation;
    else if (s === 'IDLE' || s === 'READY' || s === 'CALIBRATING') validation = null;
  }

  // Local 1 s tick while recording; each SNAPSHOT resynchronises `recordedMs`.
  $effect(() => {
    if (snapshot?.sessionState !== 'RECORDING') return;
    const id = setInterval(() => {
      recordedMs += 1000;
    }, 1000);
    return () => clearInterval(id);
  });

  onMount(() => {
    client.connect();
  });

  onDestroy(() => {
    client.destroy();
  });

  // --- actions ---------------------------------------------------------------

  function join(code: string): void {
    error = null;
    joinInvalid = false;
    joinPending = true;
    client.send({ type: 'JOIN_STUDY', code });
  }

  function leave(): void {
    error = null;
    joinInvalid = false;
    joinPending = false;
    client.send({ type: 'LEAVE_STUDY' });
  }

  /**
   * Must run synchronously from the click so `permissions.request` keeps the
   * user gesture (no awaits before it).
   */
  function startSession(): void {
    const study = snapshot?.study;
    if (!study) return;
    error = null;
    hostDenied = false;
    const fallback = snapshot?.hostGranted ?? false;
    browser.permissions
      .request({ origins: ['<all_urls>', studyMatchPattern(study)] })
      .catch((err: unknown) => {
        console.warn('[panel] permissions.request failed', err);
        return fallback;
      })
      .then((granted) => {
        hostDenied = !granted;
        client.send({ type: 'START_SESSION', hostGranted: granted });
      });
  }

  function stopSession(): void {
    client.send({ type: 'STOP_SESSION' });
  }

  function recalibrate(): void {
    drift = null;
    client.send({ type: 'RECALIBRATE' });
  }

  function resumeSession(): void {
    client.send({ type: 'RESUME_SESSION' });
  }

  function setDebugGazeDot(visible: boolean): void {
    client.send({ type: 'SET_DEBUG_GAZE_DOT', visible });
  }

  function setCameraEnabled(enabled: boolean): void {
    if (!enabled && snapshot && ['CALIBRATING', 'VALIDATING', 'RECORDING', 'PAUSED'].includes(snapshot.sessionState)) {
      if (!confirm(i18n.t('panel.camera_disable_hint'))) return;
    }
    frame = null;
    client.send({ type: 'SET_CAMERA_ENABLED', enabled });
  }

  function openOnboarding(): void {
    void sendRuntime({ type: 'OPEN_ONBOARDING' });
  }

  function showReport(sessionId: string | null): void {
    void openReport(sessionId);
  }
</script>

<main class="panel">
  <header class="row">
    <img src="/icons/icon-32.png" alt="" width="20" height="20" />
    <h1>{i18n.t('panel.title')}</h1>
  </header>

  {#if error}
    <Banner kind="error" text={error} ondismiss={() => (error = null)} />
  {/if}

  {#if drift}
    <Banner
      kind="warn"
      text={drift === 'recalibrate' ? i18n.t('panel.head_drift_recalibrate') : i18n.t('panel.head_drift_warn')}
      actionLabel={drift === 'recalibrate' ? i18n.t('panel.recalibrate') : undefined}
      onaction={drift === 'recalibrate' ? recalibrate : undefined}
      ondismiss={() => (drift = null)}
    />
  {/if}

  {#if !snapshot}
    <p class="row muted loading">
      <span class="spinner"></span>
      <span>{i18n.t('common.loading')}</span>
    </p>
  {:else}
    <section class="card">
      <CameraPreview {frame} engine={snapshot.engine} deviceId={snapshot.deviceId} disabled={!snapshot.cameraEnabled} />
      <div class="row" style="margin-top: 8px">
        <button
          type="button"
          class="grow"
          class:btn-danger={snapshot.cameraEnabled}
          onclick={() => setCameraEnabled(!snapshot!.cameraEnabled)}
        >
          {snapshot.cameraEnabled ? i18n.t('panel.camera_disable') : i18n.t('panel.camera_enable')}
        </button>
      </div>
      {#if snapshot.cameraEnabled}
        <p class="muted small" style="margin: 6px 0 0">{i18n.t('panel.camera_disable_hint')}</p>
      {/if}
    </section>

    {#if !snapshot.cameraGranted}
      <Banner
        kind="warn"
        text={i18n.t('panel.camera_needed')}
        actionLabel={i18n.t('panel.open_onboarding')}
        onaction={openOnboarding}
      />
    {/if}

    <StudyCard study={snapshot.study} invalid={joinInvalid} busy={joinPending} onjoin={join} onleave={leave} />

    <SessionCard
      {snapshot}
      {calib}
      {validation}
      {recordedMs}
      {hostDenied}
      {doneSessionId}
      onstart={startSession}
      onstop={stopSession}
      onrecalibrate={recalibrate}
      onresume={resumeSession}
      onreport={showReport}
    />

    {#if doneSessionId && snapshot.sessionState !== 'DONE'}
      <Banner
        kind="success"
        text={i18n.t('panel.done')}
        actionLabel={i18n.t('panel.open_report')}
        onaction={() => showReport(doneSessionId)}
      />
    {/if}

    <footer class="row footer">
      <label class="row small grow">
        <input
          type="checkbox"
          checked={snapshot.debugGazeDot}
          onchange={(e) => setDebugGazeDot(e.currentTarget.checked)}
        />
        <span>{i18n.t('panel.debug_gaze_dot')}</span>
      </label>
      {#if snapshot.calibration}
        <button type="button" class="btn-link small" onclick={copyDiag}>
          {diagCopied ? i18n.t('panel.copied_diag') : i18n.t('panel.copy_diag')}
        </button>
      {/if}
      <button type="button" class="btn-link small" onclick={() => showReport(null)}>
        {i18n.t('panel.sessions_title')}
      </button>
    </footer>
  {/if}
</main>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    min-width: 300px;
    max-width: 480px;
    margin: 0 auto;
    min-height: 100vh;
  }
  header {
    gap: 8px;
    padding: 2px 0;
  }
  header img {
    display: block;
    border-radius: 4px;
  }
  h1 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .loading {
    padding: 20px 0;
    justify-content: center;
  }
  .footer {
    margin-top: auto;
    padding-top: 4px;
    border-top: 1px solid var(--border);
    gap: 10px;
  }
  .footer label {
    cursor: pointer;
    gap: 6px;
  }
</style>
