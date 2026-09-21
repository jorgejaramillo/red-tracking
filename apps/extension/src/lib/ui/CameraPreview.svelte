<script lang="ts">
  /**
   * Live camera preview: face mesh + gaze rays drawn from `PreviewFrame`s, with
   * an optional local video layer underneath (second getUserMedia on the same
   * device — the offscreen engine never shares its stream).
   */
  import { onDestroy } from 'svelte';
  import { i18n } from '#i18n';
  import type { EngineStatus, PreviewFrame } from '@red-tracking/protocol';
  import { clearCanvas, drawNoFace, drawPreview, drawVideo, fitCanvas } from '../mesh-draw';
  import { envHintLines } from './format';

  interface Props {
    frame: PreviewFrame | null;
    engine: EngineStatus | null;
    deviceId?: string | null;
    mirror?: boolean;
    showToggles?: boolean;
    showStatus?: boolean;
    showHints?: boolean;
    /** Camera switched off by the participant. */
    disabled?: boolean;
  }

  let {
    frame,
    engine,
    deviceId = null,
    mirror = true,
    showToggles = true,
    showStatus = true,
    showHints = true,
    disabled = false,
  }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let video: HTMLVideoElement | undefined = $state();
  let showMesh = $state(true);
  let showVideo = $state(false);
  let videoBusy = $state(false);

  let stream: MediaStream | null = null;
  let rafPending = false;
  let loopId = 0;
  let lastLoopDraw = 0;

  const faceDetected = $derived(frame ? frame.lm.length > 0 : (engine?.faceDetected ?? false));
  const hints = $derived(showHints ? envHintLines(frame?.env) : []);

  const engineText = $derived.by(() => {
    if (disabled) return i18n.t('panel.camera_disabled');
    if (!engine) return i18n.t('common.loading');
    switch (engine.state) {
      case 'running':
        return i18n.t('panel.engine_running');
      case 'no-camera':
        return i18n.t('panel.engine_no_camera');
      case 'error':
        return i18n.t('panel.engine_error', [engine.error ?? '']);
      case 'starting':
      case 'stopped':
      default:
        return i18n.t('panel.engine_starting');
    }
  });

  const fpsText = $derived(frame ? i18n.t('panel.fps', [Math.round(frame.fps)]) : '');

  function placeholderText(): string {
    if (engine?.state === 'running' || frame) return i18n.t('panel.face_lost');
    return engineText;
  }

  function render(): void {
    rafPending = false;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    fitCanvas(canvas, frame);
    const w = canvas.width;
    const h = canvas.height;
    clearCanvas(ctx, w, h);

    const videoReady = showVideo && !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (videoReady && video) drawVideo(ctx, video, w, h, mirror);

    if (frame && frame.lm.length > 0) {
      drawPreview(ctx, frame, { mirror, showMesh, showRays: true, showGaze: false });
    } else if (!videoReady) {
      drawNoFace(ctx, w, h, placeholderText());
    }
  }

  function requestDraw(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }

  // Redraw whenever a new frame arrives or a toggle changes (frames are dropped
  // if one is already pending).
  $effect(() => {
    void frame;
    void showMesh;
    void engine;
    requestDraw();
  });

  // While the local video layer is on, keep painting at ~30 fps even if the
  // engine sends no frames.
  function loop(now: number): void {
    if (now - lastLoopDraw >= 33) {
      lastLoopDraw = now;
      render();
    }
    loopId = requestAnimationFrame(loop);
  }

  function startLoop(): void {
    if (!loopId) loopId = requestAnimationFrame(loop);
  }

  function stopLoop(): void {
    if (loopId) cancelAnimationFrame(loopId);
    loopId = 0;
  }

  async function startVideo(): Promise<void> {
    if (stream || videoBusy) return;
    videoBusy = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: 640,
          height: 480,
        },
      });
      stream = s;
      if (video) {
        video.srcObject = s;
        await video.play().catch(() => undefined);
      }
      startLoop();
    } catch (err) {
      console.warn('[preview] local video failed', err);
      showVideo = false;
    } finally {
      videoBusy = false;
    }
  }

  function stopVideo(): void {
    stopLoop();
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (video) video.srcObject = null;
    requestDraw();
  }

  function toggleVideo(on: boolean): void {
    showVideo = on;
    if (on) void startVideo();
    else stopVideo();
  }

  onDestroy(() => {
    stopVideo();
  });
</script>

<div class="preview">
  <div class="canvas-wrap">
    <canvas bind:this={canvas} width="640" height="480"></canvas>
    <video bind:this={video} class="src-video" muted playsinline autoplay></video>
  </div>

  {#if showToggles}
    <div class="row row-wrap toggles">
      <label class="row small">
        <input type="checkbox" bind:checked={showMesh} />
        <span>{i18n.t('panel.preview_toggle_mesh')}</span>
      </label>
      <label class="row small">
        <input
          type="checkbox"
          checked={showVideo}
          disabled={videoBusy}
          onchange={(e) => toggleVideo(e.currentTarget.checked)}
        />
        <span>{i18n.t('panel.preview_toggle_video')}</span>
      </label>
    </div>
  {/if}

  {#if showStatus}
    <div class="row row-wrap status small">
      <span class="dot" class:ok={engine?.state === 'running'} class:err={engine?.state === 'error' || engine?.state === 'no-camera'}></span>
      <span class="grow" class:err={engine?.state === 'error'}>{engineText}</span>
      {#if fpsText}
        <span class="muted mono">{fpsText}</span>
      {/if}
      <span class="face" class:ok={faceDetected} class:err={!faceDetected}>
        {faceDetected ? i18n.t('panel.face_detected') : i18n.t('panel.face_lost')}
      </span>
    </div>
  {/if}

  {#if hints.length}
    <ul class="hint-list">
      {#each hints as hint (hint.key)}
        <li class:ok={hint.ok}>{hint.text}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .canvas-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* Kept in the layout (1px, invisible) so it keeps decoding while hidden. */
  .src-video {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .toggles {
    gap: 14px;
  }
  .toggles label {
    cursor: pointer;
    gap: 5px;
  }
  .status {
    gap: 6px;
  }
  .face {
    font-weight: 600;
    white-space: nowrap;
  }
</style>
