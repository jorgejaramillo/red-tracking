<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { i18n } from '#i18n';
  import type { PanelSnapshot, PreviewFrame, SwToPanel } from '@red-tracking/protocol';
  import { PanelClient } from '../../lib/ui/panelClient';
  import { sendRuntime } from '../../lib/ui/runtime';
  import Banner from '../../lib/ui/Banner.svelte';
  import CameraPreview from '../../lib/ui/CameraPreview.svelte';

  const STEP_KEYS = [
    'onboarding.step_consent',
    'onboarding.step_camera',
    'onboarding.step_check',
    'onboarding.step_ready',
  ] as const;
  const STEP_CONSENT = 0;
  const STEP_CAMERA = 1;
  const STEP_CHECK = 2;
  const STEP_READY = 3;
  const CHECK_TIMEOUT_MS = 8000;
  const CONSENT_KEY = 'consentAcceptedAt';

  type CameraState = 'idle' | 'requesting' | 'granted' | 'denied';

  const stepLabels = STEP_KEYS.map((k) => i18n.t(k));
  const studyCode = readStudyCode();

  let step = $state(STEP_CONSENT);
  let consent = $state(false);
  let saving = $state(false);
  let cameraState = $state<CameraState>('idle');
  let devices = $state.raw<MediaDeviceInfo[]>([]);
  let deviceId = $state<string | null>(null);
  let snapshot = $state.raw<PanelSnapshot | null>(null);
  let frame = $state.raw<PreviewFrame | null>(null);
  let checkTimedOut = $state(false);
  let openPanelFailed = $state(false);

  // Not reactive on purpose: written from an effect, read once.
  let joinSent = false;

  const envOk = $derived(frame?.env?.ok === true);
  const canContinueCheck = $derived(envOk || checkTimedOut);

  function readStudyCode(): string | null {
    const fromQuery = new URLSearchParams(location.search).get('study');
    if (fromQuery && fromQuery.trim()) return fromQuery.trim();
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return null;
    const fromHash = new URLSearchParams(hash).get('study');
    return fromHash && fromHash.trim() ? fromHash.trim() : null;
  }

  onMount(async () => {
    let hasConsent = false;
    try {
      const stored = await browser.storage.local.get(CONSENT_KEY);
      const at: unknown = stored[CONSENT_KEY];
      hasConsent = typeof at === 'number' && at > 0;
    } catch (err) {
      console.warn('[onboarding] storage read failed', err);
    }
    if (hasConsent) consent = true;

    if (studyCode) {
      const res = await sendRuntime({ type: 'GET_SNAPSHOT' });
      const snap = res.ok ? (res.data as PanelSnapshot | undefined) : undefined;
      if (hasConsent && snap?.cameraGranted) {
        deviceId = snap.deviceId;
        cameraState = 'granted';
        step = STEP_READY;
      }
    }
  });

  // Live environment check: subscribe to the preview only while on that step.
  $effect(() => {
    if (step !== STEP_CHECK) return;
    checkTimedOut = false;
    const client = new PanelClient({
      previewFps: 15,
      onMessage: (msg: SwToPanel) => {
        if (msg.type === 'SNAPSHOT') snapshot = msg.snapshot;
        else if (msg.type === 'PREVIEW') frame = msg.frame;
      },
    });
    client.connect();
    const timer = setTimeout(() => {
      checkTimedOut = true;
    }, CHECK_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      client.destroy();
      frame = null;
    };
  });

  // Join the study from the URL once the participant reaches the final step.
  $effect(() => {
    if (step !== STEP_READY || !studyCode || joinSent) return;
    joinSent = true;
    void sendRuntime({ type: 'JOIN_STUDY', code: studyCode });
  });

  // --- step 1: consent -------------------------------------------------------

  async function acceptConsent(): Promise<void> {
    if (!consent || saving) return;
    saving = true;
    try {
      await browser.storage.local.set({ [CONSENT_KEY]: Date.now() });
    } catch (err) {
      console.warn('[onboarding] storage write failed', err);
    } finally {
      saving = false;
    }
    step = STEP_CAMERA;
  }

  // --- step 2: camera --------------------------------------------------------

  async function requestCamera(): Promise<void> {
    if (cameraState === 'requesting') return;
    cameraState = 'requesting';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const grantedId = track?.getSettings().deviceId ?? null;
      for (const t of stream.getTracks()) t.stop();

      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === 'videoinput');
      deviceId = grantedId ?? devices[0]?.deviceId ?? null;
      cameraState = 'granted';
      await notifyPermission();
    } catch (err) {
      console.warn('[onboarding] getUserMedia failed', err);
      cameraState = 'denied';
    }
  }

  async function notifyPermission(): Promise<void> {
    await sendRuntime({ type: 'PERMISSION_GRANTED', deviceId });
  }

  function selectDevice(id: string): void {
    deviceId = id || null;
    void notifyPermission();
  }

  function deviceLabel(d: MediaDeviceInfo, index: number): string {
    return d.label || `${i18n.t('onboarding.camera_select')} ${index + 1}`;
  }

  // --- step 4: open the side panel -----------------------------------------

  async function openPanel(): Promise<void> {
    openPanelFailed = false;
    try {
      const win = await browser.windows.getCurrent();
      if (win.id !== undefined) {
        await browser.sidePanel.open({ windowId: win.id });
        return;
      }
    } catch (err) {
      console.warn('[onboarding] sidePanel.open failed, falling back to the service worker', err);
    }
    const res = await sendRuntime({ type: 'OPEN_SIDE_PANEL' });
    if (!res.ok) openPanelFailed = true;
  }

  function back(): void {
    if (step > STEP_CONSENT) step -= 1;
  }
</script>

<main class="page">
  <header class="row">
    <img src="/icons/icon-48.png" alt="" width="28" height="28" />
    <h1>{i18n.t('onboarding.title')}</h1>
  </header>

  <ol class="stepper" aria-label={i18n.t('onboarding.title')}>
    {#each stepLabels as label, i (label)}
      <li class:active={i === step} class:done={i < step} aria-current={i === step ? 'step' : undefined}>
        <span class="num">{i + 1}</span>
        <span class="label">{label}</span>
      </li>
    {/each}
  </ol>

  <section class="card step">
    {#if step === STEP_CONSENT}
      <h2>{i18n.t('onboarding.consent_title')}</h2>
      <p class="muted">{i18n.t('onboarding.intro')}</p>
      <ul class="consent">
        <li>{i18n.t('onboarding.consent_records')}</li>
        <li>{i18n.t('onboarding.consent_not_records')}</li>
        <li>{i18n.t('onboarding.consent_scope')}</li>
        <li>{i18n.t('onboarding.consent_data')}</li>
      </ul>
      <label class="row accept">
        <input type="checkbox" bind:checked={consent} />
        <span>{i18n.t('onboarding.consent_accept')}</span>
      </label>
      <div class="nav">
        <span></span>
        <button type="button" class="btn-primary" disabled={!consent || saving} onclick={acceptConsent}>
          {i18n.t('common.continue')}
        </button>
      </div>
    {:else if step === STEP_CAMERA}
      <h2>{i18n.t('onboarding.camera_title')}</h2>
      <p class="muted">{i18n.t('onboarding.camera_body')}</p>

      {#if cameraState === 'granted'}
        <Banner kind="success" text={i18n.t('onboarding.camera_granted')} />
        {#if devices.length > 0}
          <label class="stack device">
            <span class="card-title">{i18n.t('onboarding.camera_select')}</span>
            <select value={deviceId ?? ''} onchange={(e) => selectDevice(e.currentTarget.value)}>
              {#each devices as d, i (d.deviceId)}
                <option value={d.deviceId}>{deviceLabel(d, i)}</option>
              {/each}
            </select>
          </label>
        {/if}
      {:else if cameraState === 'denied'}
        <Banner kind="error" text={i18n.t('onboarding.camera_denied')} />
        <div>
          <button type="button" onclick={requestCamera}>{i18n.t('common.retry')}</button>
        </div>
      {:else}
        <div class="row">
          <button type="button" class="btn-primary" disabled={cameraState === 'requesting'} onclick={requestCamera}>
            {i18n.t('onboarding.camera_button')}
          </button>
          {#if cameraState === 'requesting'}
            <span class="spinner"></span>
          {/if}
        </div>
      {/if}

      <div class="nav">
        <button type="button" class="btn-ghost" onclick={back}>{i18n.t('common.back')}</button>
        <button type="button" class="btn-primary" disabled={cameraState !== 'granted'} onclick={() => (step = STEP_CHECK)}>
          {i18n.t('common.continue')}
        </button>
      </div>
    {:else if step === STEP_CHECK}
      <h2>{i18n.t('onboarding.check_title')}</h2>
      <p class="muted">{i18n.t('onboarding.check_body')}</p>

      <div class="preview">
        <CameraPreview {frame} engine={snapshot?.engine ?? null} {deviceId} showToggles={false} />
      </div>

      {#if envOk}
        <p class="ok check-ok">{i18n.t('onboarding.check_ok')}</p>
      {/if}

      <div class="nav">
        <button type="button" class="btn-ghost" onclick={back}>{i18n.t('common.back')}</button>
        <button type="button" class="btn-primary" disabled={!canContinueCheck} onclick={() => (step = STEP_READY)}>
          {i18n.t('common.continue')}
        </button>
      </div>
    {:else}
      <h2>{i18n.t('onboarding.ready_title')}</h2>
      <p class="muted">{i18n.t('onboarding.ready_body')}</p>

      {#if openPanelFailed}
        <Banner kind="error" text={i18n.t('common.error')} ondismiss={() => (openPanelFailed = false)} />
      {/if}

      <div class="nav">
        <button type="button" class="btn-ghost" onclick={back}>{i18n.t('common.back')}</button>
        <button type="button" class="btn-primary" onclick={openPanel}>{i18n.t('onboarding.open_panel')}</button>
      </div>
    {/if}
  </section>

  <footer>
    <a href="/privacy.html" target="_blank" rel="noreferrer">{i18n.t('onboarding.privacy_link')}</a>
  </footer>
</main>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 32px 20px 40px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 100vh;
    font-size: 14px;
  }
  header {
    gap: 12px;
  }
  header img {
    display: block;
    border-radius: 6px;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
  }
  h2 {
    font-size: 17px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .stepper {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .stepper li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
  }
  .stepper li.active {
    color: var(--text);
    border-color: var(--accent);
  }
  .stepper li.done {
    color: var(--text);
  }
  .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--panel-2);
    font-size: 11px;
    font-weight: 600;
    flex: none;
  }
  .stepper li.active .num {
    background: var(--accent);
    color: #fff;
  }
  .stepper li.done .num {
    background: var(--ok);
    color: #0b1a10;
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 22px;
  }

  .consent {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .accept {
    gap: 10px;
    cursor: pointer;
    padding: 10px 12px;
    background: var(--panel-2);
    border-radius: 6px;
    font-weight: 600;
  }

  .device {
    gap: 4px;
    max-width: 360px;
  }
  .device .card-title {
    margin-bottom: 0;
  }

  .preview {
    max-width: 480px;
    width: 100%;
    align-self: center;
  }
  .check-ok {
    font-weight: 600;
    text-align: center;
  }

  .nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-top: 6px;
  }
  .nav .btn-primary {
    min-width: 140px;
  }

  footer {
    margin-top: auto;
    text-align: center;
    font-size: 13px;
  }

  @media (max-width: 560px) {
    .stepper {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
