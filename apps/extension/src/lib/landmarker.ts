import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Delegate } from '@red-tracking/protocol';
import { browser } from 'wxt/browser';

export interface LandmarkerHandle {
  landmarker: FaceLandmarker;
  delegate: Delegate;
  loadMs: number;
}

/** Create a FaceLandmarker from the bundled WASM + model, preferring GPU. */
export async function createLandmarker(preferred: Delegate[] = ['GPU', 'CPU']): Promise<LandmarkerHandle> {
  const t0 = performance.now();
  // Derive the directory from a known bundled file so the path stays type-checked.
  const wasmPath = browser.runtime.getURL('/mediapipe/wasm/vision_wasm_internal.js').replace(/\/vision_wasm_internal\.js$/, '');
  const modelPath = browser.runtime.getURL('/models/face_landmarker.task');
  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  let lastErr: unknown = null;
  for (const delegate of preferred) {
    if (delegate === 'fake') continue;
    try {
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      return { landmarker, delegate, loadMs: performance.now() - t0 };
    } catch (err) {
      console.warn(`[rt:landmarker] ${delegate} delegate failed`, err);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('FaceLandmarker init failed');
}

export type { FaceLandmarkerResult };
