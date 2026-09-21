/**
 * Message protocol between extension contexts.
 *
 * Transport:
 *  - Long-lived ports (chrome.runtime.connect) named PORT_ENGINE (offscreen ↔ SW),
 *    PORT_PANEL (side panel ↔ SW) and PORT_TAB (content script ↔ SW).
 *  - One-shot chrome.runtime.sendMessage for request/response (RuntimeRequest).
 *
 * All payloads are JSON (no typed arrays, Blobs or Dates). Timestamps are Date.now() ms.
 */
import type {
  AOI,
  CalibrationModelRecord,
  EngineStatus,
  EnrichedSample,
  GazePoint,
  NormPoint,
  PauseReason,
  PreviewFrame,
  Rect,
  Session,
  SessionState,
  Size,
  Study,
  ValidationResult,
  WindowGeometry,
} from './types';

export const PORT_ENGINE = 'rt:engine';
export const PORT_PANEL = 'rt:panel';
export const PORT_TAB = 'rt:tab';

// ---------------------------------------------------------------------------
// Offscreen engine ↔ service worker
// ---------------------------------------------------------------------------

export type EngineToSw =
  | { type: 'ENGINE_STATUS'; status: EngineStatus }
  | { type: 'PING' }
  | { type: 'CALIB_PROGRESS'; index: number; validFrames: number; needed: number }
  | {
      type: 'CALIB_RESULT';
      ok: boolean;
      record?: CalibrationModelRecord;
      error?: string;
      /** Points with too few valid frames that must be repeated. */
      repeatIndices?: number[];
    }
  | { type: 'VALIDATION_RESULT'; result: ValidationResult; record: CalibrationModelRecord }
  | { type: 'GAZE'; gaze: GazePoint }
  | { type: 'FACE_LOST' }
  | { type: 'FACE_FOUND' }
  | {
      type: 'HEAD_DRIFT';
      dYaw: number;
      dPitch: number;
      dTz: number;
      severity: 'warn' | 'recalibrate' | 'ok';
    }
  | { type: 'PREVIEW'; frame: PreviewFrame };

export type SwToEngine =
  | { type: 'ENGINE_START'; deviceId?: string; fake?: { fixture: string } }
  | { type: 'ENGINE_STOP' }
  | {
      type: 'CALIB_BEGIN';
      sessionId: string;
      targets: { index: number; vx: number; vy: number }[];
      geometry: WindowGeometry;
      /** Reuse samples of the previous model with this weight (quick recalibration). */
      reusePreviousWeight?: number;
    }
  | { type: 'CALIB_POINT_SHOWN'; index: number; vx: number; vy: number; t: number }
  | { type: 'CALIB_POINT_DONE'; index: number }
  | { type: 'CALIB_FIT' }
  | { type: 'CALIB_CANCEL' }
  | {
      type: 'VALIDATE_BEGIN';
      targets: { index: number; vx: number; vy: number }[];
      passPx: number;
      failPx: number;
    }
  | { type: 'VALIDATE_POINT_SHOWN'; index: number; vx: number; vy: number; t: number }
  | { type: 'VALIDATE_POINT_DONE'; index: number }
  | { type: 'VALIDATE_FINISH' }
  | { type: 'SET_OFFSET'; dx: number; dy: number }
  | { type: 'CLICK_LABEL'; t: number; vx: number; vy: number }
  | { type: 'LOAD_MODEL'; record: CalibrationModelRecord }
  | { type: 'CLEAR_MODEL' }
  | { type: 'PREVIEW_SUBSCRIBE'; fps: number }
  | { type: 'PREVIEW_UNSUBSCRIBE' };

// ---------------------------------------------------------------------------
// Content script ↔ service worker
// ---------------------------------------------------------------------------

export interface ScrollStopInfo {
  t: number;
  scrollX: number;
  scrollY: number;
  docSize: Size;
  viewport: Size;
  dpr: number;
  stickyRects: Rect[];
}

export type TabToSw =
  | {
      type: 'TAB_READY';
      url: string;
      title: string;
      geometry: WindowGeometry;
      docSize: Size;
      viewport: Size;
    }
  | { type: 'CALIB_POINT_SHOWN'; index: number; vx: number; vy: number; t: number }
  | { type: 'CALIB_POINT_DONE'; index: number }
  | { type: 'CALIB_SEQUENCE_DONE'; mode: 'calibration' | 'validation' }
  | { type: 'CALIB_CANCELLED' }
  | { type: 'SAMPLES_BATCH'; pageVisitId: string; samples: EnrichedSample[] }
  | { type: 'SCROLL_STOP'; info: ScrollStopInfo }
  | { type: 'GEOMETRY_CHANGED'; before: WindowGeometry; after: WindowGeometry }
  | { type: 'AOIS'; pageVisitId: string; aois: AOI[] }
  | { type: 'CLICK'; t: number; vx: number; vy: number; px: number; py: number; selector: string | null }
  | { type: 'VISIBILITY'; hidden: boolean }
  | { type: 'CAPTURE_READY' }
  | { type: 'INSTRUCTIONS_ACK' }
  | { type: 'STOP_REQUESTED' };

export type SwToTab =
  | {
      type: 'OVERLAY_SHOW_TARGETS';
      mode: 'calibration' | 'validation';
      points: NormPoint[];
      /** ms the target is displayed. */
      dwellMs: number;
    }
  | { type: 'OVERLAY_REPEAT_TARGETS'; indices: number[] }
  | { type: 'OVERLAY_HIDE' }
  | { type: 'OVERLAY_MESSAGE'; text: string; kind: 'info' | 'warn' | 'error' | 'success'; ttlMs?: number }
  | { type: 'OVERLAY_INSTRUCTIONS'; title: string; body: string; buttonLabel: string }
  | { type: 'SESSION_STATE'; state: SessionState; reason?: PauseReason | string; pageVisitId?: string }
  | { type: 'GAZE'; gaze: GazePoint }
  | { type: 'GAZE_DOT'; visible: boolean }
  | { type: 'HARVEST_AOIS'; selectors: { label: string; selector: string }[] }
  | { type: 'CALIB_PROGRESS'; index: number; validFrames: number; needed: number }
  | { type: 'PREPARE_CAPTURE' }
  | { type: 'CAPTURE_DONE' }
  | { type: 'FACE_LOST' }
  | { type: 'FACE_FOUND' };

// ---------------------------------------------------------------------------
// Side panel ↔ service worker
// ---------------------------------------------------------------------------

export interface PanelSnapshot {
  sessionState: SessionState;
  pauseReason?: PauseReason | string;
  study: Study | null;
  session: Session | null;
  engine: EngineStatus;
  validation: ValidationResult | null;
  /** Last calibration record (weights are tiny), for diagnostics/copy. */
  calibration: CalibrationModelRecord | null;
  recordedMs: number;
  cameraGranted: boolean;
  /** Participant switch: false = camera and tracking off (offscreen document closed). */
  cameraEnabled: boolean;
  deviceId: string | null;
  hostGranted: boolean;
  targetTabId: number | null;
  warnings: string[];
  debugGazeDot: boolean;
}

export type PanelToSw =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'JOIN_STUDY'; code: string }
  | { type: 'LEAVE_STUDY' }
  | { type: 'START_SESSION'; hostGranted: boolean }
  | { type: 'STOP_SESSION' }
  | { type: 'RECALIBRATE' }
  | { type: 'RESUME_SESSION' }
  | { type: 'PREVIEW_SUBSCRIBE'; fps: number }
  | { type: 'PREVIEW_UNSUBSCRIBE' }
  | { type: 'SET_DEBUG_GAZE_DOT'; visible: boolean }
  | { type: 'SET_CAMERA_ENABLED'; enabled: boolean }
  | { type: 'ENGINE_RESTART'; deviceId?: string };

export type SwToPanel =
  | { type: 'SNAPSHOT'; snapshot: PanelSnapshot }
  | { type: 'PREVIEW'; frame: PreviewFrame }
  | { type: 'CALIB_PROGRESS'; index: number; validFrames: number; needed: number }
  | { type: 'VALIDATION_RESULT'; result: ValidationResult }
  | { type: 'HEAD_DRIFT'; severity: 'warn' | 'recalibrate' | 'ok' }
  | { type: 'ERROR'; message: string }
  | { type: 'SESSION_DONE'; sessionId: string };

// ---------------------------------------------------------------------------
// One-shot request/response (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export type RuntimeRequest =
  | { type: 'PERMISSION_GRANTED'; deviceId: string | null }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'OPEN_ONBOARDING' }
  | { type: 'GET_SNAPSHOT' }
  | { type: 'JOIN_STUDY'; code: string }
  | { type: 'OPEN_REPORT'; sessionId: string };

export type RuntimeResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type AnyMessage =
  | EngineToSw
  | SwToEngine
  | TabToSw
  | SwToTab
  | PanelToSw
  | SwToPanel
  | RuntimeRequest;

export function isMessage<T extends { type: string }>(
  msg: unknown,
  type: T['type'],
): msg is T {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === type;
}
