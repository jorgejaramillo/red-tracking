/**
 * Gaze engine: turns landmark frames into calibrated gaze predictions and
 * services the calibration / validation / preview protocol with the service
 * worker. Runs in the offscreen document. Pure orchestration — all math lives
 * in @red-tracking/core.
 */
import {
  BlinkDetector,
  OneEuro2D,
  RidgePoly2Model,
  TargetCollector,
  assessEnvironment,
  extractFeatures,
  gazeRays,
  type CalibSample,
  type FrameFeatures,
  type Landmark,
} from '@red-tracking/core';
import type {
  CalibrationModelRecord,
  EngineStatus,
  EngineToSw,
  EnvironmentCheck,
  GazePoint,
  HeadRef,
  PreviewFrame,
  SwToEngine,
  WindowGeometry,
} from '@red-tracking/protocol';
import { uid } from './ids';

export interface LandmarkFrame {
  landmarks: Landmark[] | null;
  matrix: ArrayLike<number> | null;
  tMs: number;
  width: number;
  height: number;
  brightness: number;
}

export interface LandmarkSource {
  readonly width: number;
  readonly height: number;
  start(onFrame: (f: LandmarkFrame) => Promise<void> | void): Promise<void>;
  stop(): void;
  /** Optional hook used by the fake source to follow calibration targets. */
  lookAt?(vx: number, vy: number, viewport?: { w: number; h: number }): void;
}

type Phase = 'idle' | 'calibrating' | 'validating';

const FACE_LOST_MS = 500;
const HEAD_WARN_DEG = 12;
const HEAD_RECAL_DEG = 25;
const HEAD_RECAL_SUSTAIN_MS = 5000;
const BIAS_APPLY_PX = 15;

export class GazeEngine {
  private source: LandmarkSource | null = null;
  private status: EngineStatus = { state: 'stopped', fps: 0, delegate: null, faceDetected: false, hasModel: false };

  private model: RidgePoly2Model | null = null;
  private record: CalibrationModelRecord | null = null;
  private lastCalibSamples: CalibSample[] = [];
  private headRef: HeadRef | null = null;
  private biasOffset = { dx: 0, dy: 0 };
  private externalOffset = { dx: 0, dy: 0 };

  private phase: Phase = 'idle';
  private collector: TargetCollector | null = null;
  private calibSessionId = '';
  private calibGeometry: WindowGeometry | null = null;
  private reuseWeight = 0;
  private validationThresholds = { passPx: 100, failPx: 150 };

  private readonly blink = new BlinkDetector();
  private readonly smoother = new OneEuro2D({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 });
  private lastGaze: { vx: number; vy: number } | null = null;
  private lastFeatures: FrameFeatures | null = null;

  private lastFaceAt = 0;
  private faceLostSent = false;
  private fpsWindow: number[] = [];

  private previewFps = 0;
  private lastPreviewAt = 0;
  private env: EnvironmentCheck | null = null;
  private lastEnvAt = 0;
  private earHistory: { t: number; ear: number }[] = [];

  private headHistory: { t: number; yaw: number; pitch: number; tz: number }[] = [];
  private headSeverity: 'ok' | 'warn' | 'recalibrate' = 'ok';
  private headBadSince = 0;
  private lastHeadCheck = 0;

  private clickBuffer: CalibSample[] = [];
  private clickRefineEnabled = false;
  private recentFrames: { t: number; f: FrameFeatures }[] = [];

  constructor(private readonly post: (m: EngineToSw) => void) {}

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  getStatus(): EngineStatus {
    return { ...this.status, hasModel: this.model !== null };
  }

  async start(source: LandmarkSource, delegate: EngineStatus['delegate'], modelLoadMs?: number): Promise<void> {
    this.stop();
    this.source = source;
    this.setStatus({ state: 'starting', delegate, modelLoadMs });
    try {
      await source.start((f) => this.onFrame(f));
      this.setStatus({ state: 'running' });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const noCamera = /NotAllowed|NotFound|NotReadable|Overconstrained/i.test(message);
      this.setStatus({ state: noCamera ? 'no-camera' : 'error', error: message });
      throw err;
    }
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
    this.setStatus({ state: 'stopped', fps: 0, faceDetected: false });
  }

  /** Called once the landmarker finished loading (delegate may have fallen back to CPU). */
  updateDelegate(delegate: EngineStatus['delegate'], modelLoadMs: number): void {
    this.setStatus({ delegate, modelLoadMs });
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch, hasModel: this.model !== null };
    this.post({ type: 'ENGINE_STATUS', status: this.status });
  }

  // ---------------------------------------------------------------------
  // Messages from the service worker
  // ---------------------------------------------------------------------

  handle(msg: SwToEngine): void {
    switch (msg.type) {
      case 'CALIB_BEGIN': {
        this.phase = 'calibrating';
        this.collector = new TargetCollector();
        this.calibSessionId = msg.sessionId;
        this.calibGeometry = msg.geometry;
        this.reuseWeight = msg.reusePreviousWeight ?? 0;
        if (!this.reuseWeight) this.lastCalibSamples = [];
        this.recentFrames = [];
        this.source?.lookAt?.(msg.geometry.innerWidth / 2, msg.geometry.innerHeight / 2, {
          w: msg.geometry.innerWidth,
          h: msg.geometry.innerHeight,
        });
        break;
      }
      case 'CALIB_POINT_SHOWN':
      case 'VALIDATE_POINT_SHOWN': {
        this.collector?.show(msg.index, msg.vx, msg.vy, performance.now());
        this.source?.lookAt?.(msg.vx, msg.vy);
        break;
      }
      case 'CALIB_POINT_DONE':
      case 'VALIDATE_POINT_DONE': {
        this.collector?.finish(msg.index);
        break;
      }
      case 'CALIB_FIT':
        this.fitCalibration();
        break;
      case 'CALIB_CANCEL':
        this.phase = 'idle';
        this.collector = null;
        break;
      case 'VALIDATE_BEGIN': {
        this.phase = 'validating';
        this.collector = new TargetCollector();
        this.validationThresholds = { passPx: msg.passPx, failPx: msg.failPx };
        break;
      }
      case 'VALIDATE_FINISH':
        this.finishValidation();
        break;
      case 'SET_OFFSET':
        this.externalOffset = { dx: msg.dx, dy: msg.dy };
        break;
      case 'CLICK_LABEL':
        this.onClickLabel(msg.t, msg.vx, msg.vy);
        break;
      case 'LOAD_MODEL':
        this.loadRecord(msg.record);
        break;
      case 'CLEAR_MODEL':
        this.model = null;
        this.record = null;
        this.headRef = null;
        this.biasOffset = { dx: 0, dy: 0 };
        this.externalOffset = { dx: 0, dy: 0 };
        this.lastGaze = null;
        this.smoother.reset();
        this.setStatus({});
        break;
      case 'PREVIEW_SUBSCRIBE':
        this.previewFps = Math.max(1, Math.min(30, msg.fps));
        break;
      case 'PREVIEW_UNSUBSCRIBE':
        this.previewFps = 0;
        break;
      case 'ENGINE_START':
      case 'ENGINE_STOP':
        // handled by the offscreen bootstrap
        break;
    }
  }

  private loadRecord(record: CalibrationModelRecord): void {
    try {
      this.model = RidgePoly2Model.fromJSON(record.model);
      this.record = record;
      this.headRef = record.headRef;
      this.biasOffset = { ...record.offset };
      this.externalOffset = { dx: 0, dy: 0 };
      this.smoother.reset();
      this.setStatus({});
    } catch (err) {
      console.error('[rt:engine] cannot load model', err);
    }
  }

  // ---------------------------------------------------------------------
  // Frame pipeline
  // ---------------------------------------------------------------------

  private async onFrame(frame: LandmarkFrame): Promise<void> {
    const t = frame.tMs;
    this.trackFps(t);

    const features = frame.landmarks ? extractFeatures(frame.landmarks, frame.matrix, frame.width, frame.height) : null;
    const faceDetected = features !== null;

    if (faceDetected) {
      this.lastFaceAt = t;
      if (this.faceLostSent) {
        this.faceLostSent = false;
        this.post({ type: 'FACE_FOUND' });
      }
    } else if (!this.faceLostSent && this.lastFaceAt > 0 && t - this.lastFaceAt > FACE_LOST_MS) {
      this.faceLostSent = true;
      this.post({ type: 'FACE_LOST' });
    }
    if (faceDetected !== this.status.faceDetected) {
      this.status = { ...this.status, faceDetected };
      // Status is broadcast with the preview/fps cadence to avoid chatter.
    }

    let isBlink = false;
    if (features) {
      isBlink = this.blink.update(features.earL, features.earR, t);
      this.lastFeatures = features;
      this.recentFrames.push({ t, f: features });
      if (this.recentFrames.length > 30) this.recentFrames.shift();
      this.earHistory.push({ t, ear: (features.earL + features.earR) / 2 });
      while (this.earHistory.length && t - this.earHistory[0]!.t > 1000) this.earHistory.shift();
    }

    // Calibration / validation collection.
    if (this.collector && this.phase !== 'idle') {
      const before = this.collector.targetsSummary();
      const count = this.collector.addFrame(features, t, isBlink);
      if (count >= 0) {
        const cur = this.collector.targetsSummary().find((x) => before.find((b) => b.index === x.index)?.nFrames !== x.nFrames);
        if (cur) this.post({ type: 'CALIB_PROGRESS', index: cur.index, validFrames: count, needed: this.collector.needed });
      }
    }

    // Prediction.
    let gaze: GazePoint | null = null;
    if (this.model && features) {
      let [rx, ry] = this.model.predict(features);
      rx += this.biasOffset.dx + this.externalOffset.dx;
      ry += this.biasOffset.dy + this.externalOffset.dy;
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
        rx = this.lastGaze?.vx ?? 0;
        ry = this.lastGaze?.vy ?? 0;
      }
      let vx: number, vy: number;
      if (isBlink && this.lastGaze) {
        // Hold the last position through blinks (iris landmarks are unreliable).
        vx = this.lastGaze.vx;
        vy = this.lastGaze.vy;
      } else {
        [vx, vy] = this.smoother.filter(rx, ry, t);
      }
      this.lastGaze = { vx, vy };
      const head = features.head;
      gaze = {
        t: Date.now(),
        rx,
        ry,
        vx,
        vy,
        conf: this.confidence(features, isBlink),
        blink: isBlink,
        yaw: head.yaw,
        pitch: head.pitch,
        roll: head.roll,
        tz: head.tz,
      };
      this.post({ type: 'GAZE', gaze });
      this.checkHeadDrift(t, features);
    } else if (!features && this.model && this.lastGaze) {
      // No face: emit a zero-confidence sample so the timeline has no holes.
      this.post({
        type: 'GAZE',
        gaze: { t: Date.now(), rx: this.lastGaze.vx, ry: this.lastGaze.vy, vx: this.lastGaze.vx, vy: this.lastGaze.vy, conf: 0, blink: false, yaw: 0, pitch: 0, roll: 0, tz: 0 },
      });
    }

    // Environment (2 Hz).
    if (t - this.lastEnvAt > 500) {
      this.lastEnvAt = t;
      this.env = assessEnvironment({
        faceDetected,
        faceScale: features?.faceScale ?? 0,
        brightness: frame.brightness,
        earJitter: this.earJitter(),
      });
    }

    // Preview.
    if (this.previewFps > 0 && t - this.lastPreviewAt >= 1000 / this.previewFps) {
      this.lastPreviewAt = t;
      this.post({ type: 'PREVIEW', frame: this.buildPreview(frame, features, isBlink) });
      this.post({ type: 'ENGINE_STATUS', status: this.getStatus() });
    }
  }

  private confidence(f: FrameFeatures, blink: boolean): number {
    if (blink) return 0.3;
    const yawPen = Math.max(0, (Math.abs(f.head.yaw) - 20) / 25);
    const pitchPen = Math.max(0, (Math.abs(f.head.pitch) - 15) / 25);
    return Math.max(0, Math.min(1, 1 - yawPen - pitchPen));
  }

  private trackFps(t: number): void {
    this.fpsWindow.push(t);
    while (this.fpsWindow.length && t - this.fpsWindow[0]! > 2000) this.fpsWindow.shift();
    const span = this.fpsWindow.length > 1 ? t - this.fpsWindow[0]! : 0;
    this.status = { ...this.status, fps: span > 0 ? ((this.fpsWindow.length - 1) * 1000) / span : 0 };
  }

  private earJitter(): number {
    const n = this.earHistory.length;
    if (n < 5) return 0;
    let m = 0;
    for (const e of this.earHistory) m += e.ear;
    m /= n;
    let v = 0;
    for (const e of this.earHistory) v += (e.ear - m) ** 2;
    return Math.sqrt(v / n);
  }

  private buildPreview(frame: LandmarkFrame, f: FrameFeatures | null, blink: boolean): PreviewFrame {
    const lm: number[] = [];
    if (frame.landmarks) {
      for (const p of frame.landmarks) lm.push(Math.round(p.x * frame.width), Math.round(p.y * frame.height));
    }
    return {
      t: Date.now(),
      width: frame.width,
      height: frame.height,
      lm,
      rays: f ? gazeRays(f) : null,
      head: f ? { yaw: f.head.yaw, pitch: f.head.pitch, roll: f.head.roll, tz: f.head.tz } : null,
      ear: f ? [f.earL, f.earR] : null,
      blink,
      gaze: this.model ? this.lastGaze : null,
      fps: this.status.fps,
      env: this.env,
    };
  }

  // ---------------------------------------------------------------------
  // Calibration
  // ---------------------------------------------------------------------

  private fitCalibration(): void {
    const c = this.collector;
    if (!c) {
      this.post({ type: 'CALIB_RESULT', ok: false, error: 'NO_COLLECTOR' });
      return;
    }
    const repeat = c.insufficient();
    if (repeat.length) {
      this.post({ type: 'CALIB_RESULT', ok: false, repeatIndices: repeat });
      return;
    }
    const fresh = c.samples(1);
    const samples = this.reuseWeight > 0 && this.lastCalibSamples.length
      ? [...fresh, ...this.lastCalibSamples.map((s) => ({ ...s, weight: s.weight * this.reuseWeight, pointIndex: s.pointIndex + 1000 }))]
      : fresh;
    try {
      const report = RidgePoly2Model.fit(samples);
      this.model = report.model;
      this.lastCalibSamples = fresh;
      this.headRef = medianHead(fresh.map((s) => s.features));
      this.biasOffset = { dx: 0, dy: 0 };
      this.externalOffset = { dx: 0, dy: 0 };
      this.smoother.reset();
      this.headHistory = [];
      this.headSeverity = 'ok';
      this.record = {
        id: uid('cal'),
        sessionId: this.calibSessionId,
        createdAt: Date.now(),
        model: report.model.toJSON(),
        points: c.targetsSummary(),
        geometry: this.calibGeometry ?? emptyGeometry(),
        headRef: this.headRef,
        offset: { dx: 0, dy: 0 },
        trainRmsePx: report.trainRmsePx,
        cvRmsePx: report.cvRmsePx ?? undefined,
        diag: {
          featureSet: report.featureSet,
          lambda: report.lambda,
          trainRmsePx: Math.round(report.trainRmsePx),
          cvRmsePx: report.cvRmsePx === null ? null : Math.round(report.cvRmsePx),
          nSamples: report.nSamples,
          candidates: report.candidates.map((c) => ({ ...c, cvRmsePx: Math.round(c.cvRmsePx) })),
          points: report.points,
          camera: { width: this.source?.width ?? 0, height: this.source?.height ?? 0, fps: Math.round(this.status.fps), delegate: this.status.delegate },
          viewport: { w: this.calibGeometry?.innerWidth ?? 0, h: this.calibGeometry?.innerHeight ?? 0 },
        },
      };
      console.info('[rt:engine] calibration', { featureSet: report.featureSet, lambda: report.lambda, train: Math.round(report.trainRmsePx), cv: report.cvRmsePx && Math.round(report.cvRmsePx), n: report.nSamples });
      this.phase = 'idle';
      this.collector = null;
      this.setStatus({});
      this.post({ type: 'CALIB_RESULT', ok: true, record: this.record });
    } catch (err) {
      this.post({ type: 'CALIB_RESULT', ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private finishValidation(): void {
    const c = this.collector;
    this.phase = 'idle';
    this.collector = null;
    if (!c || !this.model || !this.record) {
      this.post({ type: 'CALIB_RESULT', ok: false, error: 'NO_MODEL_FOR_VALIDATION' });
      return;
    }
    const result = c.evaluate(this.model, this.validationThresholds.passPx, this.validationThresholds.failPx);
    if (result.verdict !== 'fail' && Math.hypot(result.biasX, result.biasY) > BIAS_APPLY_PX) {
      this.biasOffset = { dx: -result.biasX, dy: -result.biasY };
    }
    this.record = { ...this.record, validation: result, offset: { ...this.biasOffset } };
    this.post({ type: 'VALIDATION_RESULT', result, record: this.record });
  }

  private onClickLabel(tEpoch: number, vx: number, vy: number): void {
    if (!this.model || !this.lastCalibSamples.length) return;
    // Map epoch → performance clock: use the most recent frame within 300 ms before the click.
    const nowEpoch = Date.now();
    const nowPerf = performance.now();
    const tPerf = nowPerf - (nowEpoch - tEpoch);
    const candidates = this.recentFrames.filter((r) => r.t <= tPerf && tPerf - r.t < 300);
    const fr = candidates.at(-1);
    if (!fr) return;
    const [px, py] = this.model.predict(fr.f);
    if (Math.hypot(px + this.biasOffset.dx - vx, py + this.biasOffset.dy - vy) > 150) return; // not looking at the click
    this.clickBuffer.push({ features: fr.f, vx, vy, weight: 0.5, pointIndex: 2000 + (this.clickBuffer.length % 40) });
    if (this.clickBuffer.length > 40) this.clickBuffer.shift();
    this.clickRefineEnabled = true;
    if (this.clickBuffer.length % 10 === 0) {
      try {
        const report = RidgePoly2Model.fit([...this.lastCalibSamples, ...this.clickBuffer], {
          crossValidate: false,
          lambdas: [this.model.lambda],
          featureSets: [this.model.featureSet],
        });
        this.model = report.model;
      } catch {
        /* keep the previous model */
      }
    }
  }

  // ---------------------------------------------------------------------
  // Head drift
  // ---------------------------------------------------------------------

  private checkHeadDrift(t: number, f: FrameFeatures): void {
    if (!this.headRef) return;
    this.headHistory.push({ t, yaw: f.head.yaw, pitch: f.head.pitch, tz: f.head.tz });
    while (this.headHistory.length && t - this.headHistory[0]!.t > 2000) this.headHistory.shift();
    if (t - this.lastHeadCheck < 500 || this.headHistory.length < 5) return;
    this.lastHeadCheck = t;
    const med = (k: 'yaw' | 'pitch' | 'tz') => median(this.headHistory.map((h) => h[k]));
    const dYaw = Math.abs(med('yaw') - this.headRef.yaw);
    const dPitch = Math.abs(med('pitch') - this.headRef.pitch);
    const refTz = Math.abs(this.headRef.tz) || 1;
    const dTz = Math.abs(med('tz') - this.headRef.tz) / refTz;

    let severity: 'ok' | 'warn' | 'recalibrate' = 'ok';
    const bad = dYaw > HEAD_RECAL_DEG || dPitch > HEAD_RECAL_DEG;
    if (bad) {
      if (!this.headBadSince) this.headBadSince = t;
      severity = t - this.headBadSince > HEAD_RECAL_SUSTAIN_MS ? 'recalibrate' : 'warn';
    } else {
      this.headBadSince = 0;
      if (dYaw > HEAD_WARN_DEG || dPitch > HEAD_WARN_DEG || dTz > 0.15) severity = 'warn';
    }
    if (severity !== this.headSeverity) {
      this.headSeverity = severity;
      this.post({ type: 'HEAD_DRIFT', dYaw, dPitch, dTz, severity });
    }
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function medianHead(fs: FrameFeatures[]): HeadRef {
  return {
    yaw: median(fs.map((f) => f.head.yaw)),
    pitch: median(fs.map((f) => f.head.pitch)),
    roll: median(fs.map((f) => f.head.roll)),
    tz: median(fs.map((f) => f.head.tz)),
  };
}

function emptyGeometry(): WindowGeometry {
  return { screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0, innerWidth: 0, innerHeight: 0, dpr: 1, screenW: 0, screenH: 0 };
}
