import type { Landmark } from '@red-tracking/core';
import { BrightnessMeter, CameraSource, type CameraOptions, type FrameImage } from './camera';
import type { LandmarkFrame, LandmarkSource } from './gaze-engine';
import { createLandmarker, type LandmarkerHandle } from './landmarker';

/** Camera + MediaPipe Face Landmarker → LandmarkFrame stream. */
export class RealLandmarkSource implements LandmarkSource {
  private readonly camera: CameraSource;
  private readonly brightness = new BrightnessMeter();
  private handle: LandmarkerHandle | null = null;
  private lastTs = 0;
  private useBitmapFallback = false;

  constructor(private readonly opts: CameraOptions, private readonly onReady?: (h: LandmarkerHandle) => void) {
    this.camera = new CameraSource(opts);
  }

  get width(): number {
    return this.camera.width;
  }
  get height(): number {
    return this.camera.height;
  }

  async start(onFrame: (f: LandmarkFrame) => Promise<void> | void): Promise<void> {
    this.handle = await createLandmarker();
    this.onReady?.(this.handle);
    await this.camera.start(async (img, tMs) => {
      const lm = this.handle!.landmarker;
      // MediaPipe requires strictly increasing timestamps.
      const ts = Math.max(this.lastTs + 1, Math.round(tMs));
      this.lastTs = ts;
      let result;
      try {
        result = this.useBitmapFallback ? await this.detectViaBitmap(img, ts) : lm.detectForVideo(img as unknown as HTMLVideoElement, ts);
      } catch (err) {
        if (!this.useBitmapFallback && typeof VideoFrame !== 'undefined' && img instanceof VideoFrame) {
          console.warn('[rt:source] detectForVideo(VideoFrame) failed, switching to ImageBitmap fallback', err);
          this.useBitmapFallback = true;
          result = await this.detectViaBitmap(img, ts);
        } else {
          throw err;
        }
      }
      const face = result.faceLandmarks[0];
      const matrix = result.facialTransformationMatrixes?.[0]?.data ?? null;
      await onFrame({
        landmarks: face && face.length ? (face as Landmark[]) : null,
        matrix,
        tMs,
        width: this.camera.width,
        height: this.camera.height,
        brightness: this.brightness.sample(img, tMs),
      });
    });
  }

  private async detectViaBitmap(img: FrameImage, ts: number) {
    const bmp = await createImageBitmap(img as ImageBitmapSource);
    try {
      return this.handle!.landmarker.detectForVideo(bmp, ts);
    } finally {
      bmp.close();
    }
  }

  stop(): void {
    this.camera.stop();
    this.handle?.landmarker.close();
    this.handle = null;
  }
}
