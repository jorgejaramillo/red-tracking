/**
 * Domain types shared by every context of red-tracking
 * (extension service worker, offscreen engine, content script, UIs, backend).
 *
 * Everything here must be JSON-serialisable unless explicitly noted
 * (SampleChunk / ScreenshotTile use typed arrays and Blobs and are stored in
 * IndexedDB only, never sent over chrome.runtime messaging).
 */

export type Locale = 'es' | 'en';

/** A string, or a per-locale string. */
export type LocalizedText = string | Partial<Record<Locale, string>>;

export type SessionState =
  | 'IDLE'
  | 'READY'
  | 'CALIBRATING'
  | 'VALIDATING'
  | 'RECORDING'
  | 'PAUSED'
  | 'FINALIZING'
  | 'DONE'
  | 'ERROR';

export type PauseReason = 'face-lost' | 'tab-hidden' | 'geometry' | 'user' | 'wrong-tab';

// ---------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------

export interface StudyAoiSelector {
  label: string;
  selector: string;
}

export interface StudyCalibrationConfig {
  /** Number of calibration targets. */
  points: 9 | 13;
  /** Mean validation error (CSS px) at or below which calibration passes. */
  validationPassPx: number;
  /** Above this the calibration fails and must be repeated. Between pass and fail = warning. */
  validationFailPx: number;
  /** Refine the model with participant clicks during recording. */
  clickRefinement: boolean;
}

export interface Study {
  /** Schema version of the study payload (for study codes). */
  v: 1;
  id: string;
  /** Short human code (phase 2) — in phase 1 the code IS the encoded payload. */
  code?: string;
  name: string;
  targetUrl: string;
  instructions: LocalizedText;
  /** Auto-stop after this many seconds of recording. Omit = manual stop. */
  durationSec?: number;
  aoiSelectors: StudyAoiSelector[];
  calibration: StudyCalibrationConfig;
  consentText?: LocalizedText;
  /** Show the live gaze dot to the participant while recording (debug / demos). */
  showGazeDot: boolean;
  locale?: Locale;
  createdAt: number;
  /** Researcher contact shown in the consent screen. */
  researcher?: string;
}

export const DEFAULT_CALIBRATION: StudyCalibrationConfig = {
  points: 9,
  validationPassPx: 100,
  validationFailPx: 150,
  clickRefinement: false,
};

// ---------------------------------------------------------------------------
// Geometry / device
// ---------------------------------------------------------------------------

export interface WindowGeometry {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  screenW: number;
  screenH: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeviceInfo {
  ua: string;
  platform: string;
  screenW: number;
  screenH: number;
  dpr: number;
  language: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  studyId?: string;
  /** Snapshot of the study at session start (studies can change later). */
  study?: Study;
  /** Random UUID generated per install; not linked to identity. */
  participantId: string;
  state: SessionState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  device: DeviceInfo;
  calibrationId?: string;
  validation?: ValidationResult;
  pageVisitIds: string[];
  /** Total recorded (non-paused) time in ms, maintained by the service worker. */
  recordedMs: number;
  error?: string;
  uploaded?: { at: number; remoteId: string };
}

export interface PageVisit {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  tStart: number;
  tEnd?: number;
  viewport: Size;
  docSize: Size;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Target position normalised to the viewport (0..1). */
export interface NormPoint {
  index: number;
  nx: number;
  ny: number;
}

export interface CalibrationPointRecord {
  index: number;
  vx: number;
  vy: number;
  nFrames: number;
}

export interface HeadRef {
  yaw: number;
  pitch: number;
  roll: number;
  tz: number;
}

/** Plain-JSON serialisation of a fitted ridge model. */
export interface SerializedRidgeModel {
  kind: 'ridge-poly2';
  featureVersion: 1;
  /** Which feature mapping the weights apply to (see core/poly.ts). */
  featureSet: string;
  nFeatures: number;
  mean: number[];
  /** Fixed per-feature scales used for standardisation (not data-driven std). */
  std: number[];
  wx: number[];
  wy: number[];
  lambda: number;
}

export interface CalibrationModelRecord {
  id: string;
  sessionId: string;
  createdAt: number;
  model: SerializedRidgeModel;
  points: CalibrationPointRecord[];
  geometry: WindowGeometry;
  headRef: HeadRef;
  offset: { dx: number; dy: number };
  trainRmsePx: number;
  /** Leave-one-point-out cross-validation error of the chosen model, px. */
  cvRmsePx?: number;
  validation?: ValidationResult;
  /** Fit diagnostics (feature set, λ, candidates, per-point feature medians, camera size). */
  diag?: CalibrationDiag;
}

export interface CalibrationDiag {
  featureSet: string;
  lambda: number;
  trainRmsePx: number;
  cvRmsePx: number | null;
  nSamples: number;
  candidates: { featureSet: string; lambda: number; cvRmsePx: number }[];
  points: { pointIndex: number; vx: number; vy: number; nFrames: number; iris: number[]; head: number[] }[];
  camera: { width: number; height: number; fps: number; delegate: string | null };
  viewport: { w: number; h: number };
}

export interface ValidationPointResult {
  index: number;
  vx: number;
  vy: number;
  predX: number;
  predY: number;
  errPx: number;
  nFrames: number;
}

export interface ValidationResult {
  meanErrPx: number;
  meanErrDeg: number;
  biasX: number;
  biasY: number;
  perPoint: ValidationPointResult[];
  /** 'pass' | 'warn' | 'fail' per the study thresholds. */
  verdict: 'pass' | 'warn' | 'fail';
}

// ---------------------------------------------------------------------------
// Gaze samples
// ---------------------------------------------------------------------------

export const SampleFlag = {
  Blink: 1,
  FaceLost: 2,
  OffsetApplied: 4,
  Paused: 8,
} as const;

/** One prediction emitted by the gaze engine (viewport coordinates of the target tab). */
export interface GazePoint {
  t: number;
  /** Raw (unsmoothed) prediction, viewport CSS px. */
  rx: number;
  ry: number;
  /** Smoothed prediction, viewport CSS px. */
  vx: number;
  vy: number;
  /** 0..1 confidence heuristic (face presence score, EAR, head pose within range). */
  conf: number;
  blink: boolean;
  yaw: number;
  pitch: number;
  roll: number;
  tz: number;
}

/** A GazePoint enriched by the content script with page context. */
export interface EnrichedSample extends GazePoint {
  px: number;
  py: number;
  scrollX: number;
  scrollY: number;
  flags: number;
  selector: string | null;
  aoiId: string | null;
}

/**
 * Columnar storage of samples (IndexedDB only — typed arrays survive
 * structured clone but NOT chrome.runtime messaging).
 */
export interface SampleChunk {
  id: string;
  sessionId: string;
  pageVisitId: string;
  tStart: number;
  tEnd: number;
  count: number;
  t: Float64Array;
  rx: Float32Array;
  ry: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  px: Float32Array;
  py: Float32Array;
  scrollX: Float32Array;
  scrollY: Float32Array;
  conf: Float32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  flags: Uint8Array;
  /** Index into `selectors`; 0xFFFF = none. */
  elIdx: Uint16Array;
  /** Index into `aoiIds`; 0xFFFF = none. */
  aoiIdx: Uint16Array;
  selectors: string[];
  aoiIds: string[];
}

export const NO_INDEX = 0xffff;

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export interface ScreenshotTile {
  id: string;
  sessionId: string;
  pageVisitId: string;
  t: number;
  scrollX: number;
  scrollY: number;
  viewportW: number;
  viewportH: number;
  dpr: number;
  docW: number;
  docH: number;
  /** Viewport-relative rects of position:fixed/sticky elements at capture time. */
  stickyRects: Rect[];
  /** JPEG blob (IndexedDB only). */
  blob: Blob;
}

// ---------------------------------------------------------------------------
// AOIs, fixations, metrics
// ---------------------------------------------------------------------------

export type AOISource =
  | 'study-selector'
  | 'data-aoi'
  | 'auto-image'
  | 'auto-heading'
  | 'auto-link'
  | 'manual';

export interface AOIRectSnapshot extends Rect {
  /** Time of the scroll-stop when this rect (page coordinates) was measured. */
  t: number;
}

export interface AOI {
  id: string;
  sessionId: string;
  pageVisitId: string;
  label: string;
  source: AOISource;
  selector: string;
  rects: AOIRectSnapshot[];
}

export interface Fixation {
  pageVisitId: string;
  tStart: number;
  tEnd: number;
  durationMs: number;
  px: number;
  py: number;
  dispersion: number;
  nSamples: number;
  aoiId: string | null;
}

export interface AOIMetrics {
  aoiId: string;
  label: string;
  source: AOISource;
  /** Time to first fixation from page visit start, ms. null = never looked at. */
  ttffMs: number | null;
  dwellMs: number;
  fixationCount: number;
  visitCount: number;
  firstVisitOrder: number | null;
  revisits: number;
  pctSessionTime: number;
  /** Smallest side of the AOI is below tracker resolution → interpret with care. */
  belowResolution: boolean;
  area: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SessionEventKind =
  | 'state'
  | 'click'
  | 'scroll-stop'
  | 'geometry'
  | 'face-lost'
  | 'face-found'
  | 'head-drift'
  | 'offset'
  | 'page-visit'
  | 'calibration'
  | 'validation'
  | 'error';

export interface SessionEvent {
  id?: number;
  sessionId: string;
  t: number;
  kind: SessionEventKind;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Engine / preview
// ---------------------------------------------------------------------------

export type EngineState = 'stopped' | 'starting' | 'running' | 'no-camera' | 'error';
export type Delegate = 'GPU' | 'CPU' | 'fake';

export interface EngineStatus {
  state: EngineState;
  fps: number;
  delegate: Delegate | null;
  faceDetected: boolean;
  modelLoadMs?: number;
  error?: string;
  hasModel: boolean;
}

/** Downsampled landmark frame for drawing the mesh in the side panel. */
export interface PreviewFrame {
  t: number;
  width: number;
  height: number;
  /** 478 landmarks as flat [x0,y0,x1,y1,...] integer pixel coords in the frame; empty when no face. */
  lm: number[];
  /** Eye centre → gaze ray end, per eye, in frame pixels. null when no face. */
  rays: { l: [number, number, number, number]; r: [number, number, number, number] } | null;
  /** Head pose in degrees. */
  head: { yaw: number; pitch: number; roll: number; tz: number } | null;
  ear: [number, number] | null;
  blink: boolean;
  /** Current gaze prediction in viewport px (null before calibration). */
  gaze: { vx: number; vy: number } | null;
  fps: number;
  /** Environment assessment (updated ~2×/s); null while starting. */
  env: EnvironmentCheck | null;
}

export interface EnvironmentCheck {
  faceDetected: boolean;
  /** Face width relative to the frame width; 0.2–0.5 is comfortable. */
  faceScale: number;
  /** 0..255 mean luma of the frame. */
  brightness: number;
  /** Std-dev of EAR over the last second (stability). */
  earJitter: number;
  ok: boolean;
  hints: string[];
}
