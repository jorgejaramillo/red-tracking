/**
 * Camera frame sources for the offscreen gaze engine.
 *
 * The offscreen document is hidden, so requestAnimationFrame never fires. We
 * pull frames with MediaStreamTrackProcessor (preferred: no timers, natural
 * back-pressure drops stale frames) and fall back to a <video> element polled
 * by setInterval.
 */

export type FrameImage = VideoFrame | HTMLVideoElement;

export interface FrameSource {
  readonly width: number;
  readonly height: number;
  start(onFrame: (img: FrameImage, tMs: number) => Promise<void> | void): Promise<void>;
  stop(): void;
}

export interface CameraOptions {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export async function openCamera(opts: CameraOptions = {}): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: opts.width ?? 640 },
    height: { ideal: opts.height ?? 480 },
    frameRate: { ideal: opts.frameRate ?? 30, max: 30 },
    facingMode: 'user',
  };
  if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    // The saved device may have been unplugged; retry with any camera.
    if (opts.deviceId) {
      delete video.deviceId;
      return navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    throw err;
  }
}

export class CameraSource implements FrameSource {
  width = 640;
  height = 480;
  private stream: MediaStream | null = null;
  private stopped = false;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: CameraOptions = {}) {}

  async start(onFrame: (img: FrameImage, tMs: number) => Promise<void> | void): Promise<void> {
    this.stopped = false;
    this.stream = await openCamera(this.opts);
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error('No video track');
    const settings = track.getSettings();
    this.width = settings.width ?? 640;
    this.height = settings.height ?? 480;

    if ('MediaStreamTrackProcessor' in globalThis) {
      const processor = new (globalThis as unknown as {
        MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => {
          readable: ReadableStream<VideoFrame>;
        };
      }).MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      this.reader = processor.readable.getReader();
      void this.pump(onFrame);
      return;
    }

    // Fallback: hidden <video> + interval polling.
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    this.videoEl = v;
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy || this.stopped || v.readyState < 2) return;
      busy = true;
      try {
        await onFrame(v, performance.now());
      } finally {
        busy = false;
      }
    }, 33);
  }

  private async pump(onFrame: (img: FrameImage, tMs: number) => Promise<void> | void): Promise<void> {
    const reader = this.reader!;
    while (!this.stopped) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      const frame = result.value;
      try {
        if (frame.displayWidth && frame.displayHeight) {
          this.width = frame.displayWidth;
          this.height = frame.displayHeight;
        }
        await onFrame(frame, performance.now());
      } catch (err) {
        console.error('[rt:camera] frame handler failed', err);
      } finally {
        frame.close();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Mean luma (0..255) of a frame, sampled on a tiny canvas. */
export class BrightnessMeter {
  private readonly canvas = new OffscreenCanvas(64, 48);
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private last = 0;
  value = 128;

  /** Samples at most every `intervalMs`. Returns the current value. */
  sample(img: FrameImage, tMs: number, intervalMs = 500): number {
    if (tMs - this.last < intervalMs) return this.value;
    this.last = tMs;
    try {
      this.ctx.drawImage(img as CanvasImageSource, 0, 0, 64, 48);
      const { data } = this.ctx.getImageData(0, 0, 64, 48);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      }
      this.value = sum / (data.length / 4);
    } catch {
      /* ignore */
    }
    return this.value;
  }
}
