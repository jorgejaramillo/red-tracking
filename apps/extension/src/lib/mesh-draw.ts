/**
 * Canvas drawing of a `PreviewFrame` (face mesh, eye contours, iris rings,
 * gaze rays, head-pose axes and blink indicator).
 *
 * Only the MediaPipe connection tables are imported here; no model is loaded.
 * All coordinates are frame pixels: the caller sizes the canvas backing store
 * to `frame.width × frame.height` (see `fitCanvas`) and clears/paints the
 * background (see `clearCanvas` / `drawVideo`) before calling `drawPreview`.
 */
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { PreviewFrame } from '@red-tracking/protocol';

export interface DrawOptions {
  /** Flip horizontally so the participant sees a mirror image. */
  mirror: boolean;
  showMesh: boolean;
  showRays: boolean;
  /** Show the current gaze prediction readout (viewport px) as a small HUD. */
  showGaze: boolean;
}

interface Connection {
  start: number;
  end: number;
}

const LANDMARK_COUNT = 478;
const NOSE_TIP = 1;
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

const COLOR_TESSELATION = 'rgba(80,255,120,0.55)';
const COLOR_OVAL = 'rgba(80,255,120,0.8)';
const COLOR_EYE = 'rgba(150,255,190,0.95)';
const COLOR_IRIS = 'rgba(255,255,255,0.95)';
const COLOR_RAY = 'rgba(255,220,60,0.95)';
const COLOR_AXIS_X = 'rgba(255,90,90,0.95)';
const COLOR_AXIS_Y = 'rgba(90,255,120,0.95)';
const COLOR_AXIS_Z = 'rgba(90,150,255,0.95)';
const COLOR_MUTED = '#8b90a0';
const COLOR_BG = '#000';

const DEFAULT_SIZE = { width: 640, height: 480 } as const;

/**
 * Resize the canvas backing store to the frame size (or a 640×480 fallback
 * when no frame is available). Only touches the canvas when the size changes,
 * because assigning `width`/`height` clears the canvas.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  frame: { width: number; height: number } | null | undefined,
): void {
  const w = frame && frame.width > 0 ? frame.width : DEFAULT_SIZE.width;
  const h = frame && frame.height > 0 ? frame.height : DEFAULT_SIZE.height;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

export function clearCanvas(ctx: CanvasRenderingContext2D, w: number, h: number, fill = COLOR_BG): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Paint a `<video>` element covering the whole canvas (letterboxed by stretch), optionally mirrored. */
export function drawVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  mirror: boolean,
): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  ctx.save();
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
}

/** Main entry: draws mesh, rays, head axes and blink dot for one frame. */
export function drawPreview(ctx: CanvasRenderingContext2D, frame: PreviewFrame, opts: DrawOptions): void {
  const w = frame.width;
  const h = frame.height;
  const lm = frame.lm;
  const hasFace = lm.length >= LANDMARK_COUNT * 2;

  ctx.save();
  if (opts.mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (hasFace) {
    if (opts.showMesh) {
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, COLOR_TESSELATION, 0.6);
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, COLOR_OVAL, 1.2);
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, COLOR_EYE, 1.4);
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, COLOR_EYE, 1.4);
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, COLOR_IRIS, 1.6);
      drawConnections(ctx, lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, COLOR_IRIS, 1.6);
      drawIrisCenter(ctx, lm, LEFT_IRIS_CENTER);
      drawIrisCenter(ctx, lm, RIGHT_IRIS_CENTER);
      if (frame.head) drawHeadAxes(ctx, lm, frame.head, w);
    }
    if (opts.showRays && frame.rays) {
      drawRay(ctx, frame.rays.l);
      drawRay(ctx, frame.rays.r);
    }
  }
  ctx.restore();

  // Screen-fixed overlays (not mirrored).
  if (frame.blink) drawBlinkDot(ctx, w, h);
  if (opts.showGaze && frame.gaze) drawGazeHud(ctx, frame.gaze, w, h);
}

/** Placeholder painted when no face is present: dim layer, dashed head outline and a caption. */
export function drawNoFace(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(20,22,28,0.55)';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const rx = Math.min(w, h) * 0.22;
  const ry = rx * 1.3;
  ctx.strokeStyle = 'rgba(139,144,160,0.45)';
  ctx.lineWidth = Math.max(1, h / 240);
  ctx.setLineDash([h / 40, h / 60]);
  ctx.beginPath();
  ctx.ellipse(cx, cy - ry * 0.1, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const fontPx = Math.max(12, Math.round(h * 0.05));
  ctx.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = COLOR_MUTED;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + ry + fontPx * 1.2, w * 0.9);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function point(lm: number[], index: number): [number, number] | null {
  const x = lm[index * 2];
  const y = lm[index * 2 + 1];
  if (x === undefined || y === undefined) return null;
  return [x, y];
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  lm: number[],
  connections: Connection[],
  color: string,
  width: number,
): void {
  ctx.beginPath();
  for (const c of connections) {
    const a = point(lm, c.start);
    const b = point(lm, c.end);
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawIrisCenter(ctx: CanvasRenderingContext2D, lm: number[], index: number): void {
  const p = point(lm, index);
  if (!p) return;
  ctx.beginPath();
  ctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2);
  ctx.fillStyle = COLOR_IRIS;
  ctx.fill();
}

function drawRay(ctx: CanvasRenderingContext2D, ray: [number, number, number, number]): void {
  ctx.beginPath();
  ctx.moveTo(ray[0], ray[1]);
  ctx.lineTo(ray[2], ray[3]);
  ctx.strokeStyle = COLOR_RAY;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ray[2], ray[3], 3, 0, Math.PI * 2);
  ctx.fillStyle = COLOR_RAY;
  ctx.fill();
}

/**
 * Three short axes anchored at the nose tip, rotated by yaw/pitch/roll (degrees)
 * and projected orthographically. Approximate; it is only a visual cue.
 */
function drawHeadAxes(
  ctx: CanvasRenderingContext2D,
  lm: number[],
  head: { yaw: number; pitch: number; roll: number },
  frameWidth: number,
): void {
  const nose = point(lm, NOSE_TIP);
  if (!nose) return;
  const len = Math.max(18, frameWidth * 0.08);
  const rad = Math.PI / 180;
  const cy = Math.cos(head.yaw * rad);
  const sy = Math.sin(head.yaw * rad);
  const cp = Math.cos(head.pitch * rad);
  const sp = Math.sin(head.pitch * rad);
  const cr = Math.cos(head.roll * rad);
  const sr = Math.sin(head.roll * rad);

  // R = Rz(roll) · Ry(yaw) · Rx(pitch); we only need the rotated unit axes.
  const rotate = (v: [number, number, number]): [number, number, number] => {
    // Rx(pitch)
    const x1 = v[0];
    const y1 = v[1] * cp - v[2] * sp;
    const z1 = v[1] * sp + v[2] * cp;
    // Ry(yaw)
    const x2 = x1 * cy + z1 * sy;
    const y2 = y1;
    const z2 = -x1 * sy + z1 * cy;
    // Rz(roll)
    const x3 = x2 * cr - y2 * sr;
    const y3 = x2 * sr + y2 * cr;
    return [x3, y3, z2];
  };

  const axes: { v: [number, number, number]; color: string }[] = [
    { v: [1, 0, 0], color: COLOR_AXIS_X },
    { v: [0, -1, 0], color: COLOR_AXIS_Y },
    { v: [0, 0, -1], color: COLOR_AXIS_Z },
  ];
  ctx.lineWidth = 2;
  for (const axis of axes) {
    const r = rotate(axis.v);
    ctx.beginPath();
    ctx.moveTo(nose[0], nose[1]);
    // Image y grows downwards, so flip the projected y.
    ctx.lineTo(nose[0] + r[0] * len, nose[1] - r[1] * len);
    ctx.strokeStyle = axis.color;
    ctx.stroke();
  }
}

function drawBlinkDot(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 110);
  const r = Math.max(5, Math.min(w, h) * 0.018);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(w - r * 3, r * 3, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(230,60,50,${pulse.toFixed(3)})`;
  ctx.fill();
  ctx.restore();
}

function drawGazeHud(
  ctx: CanvasRenderingContext2D,
  gaze: { vx: number; vy: number },
  w: number,
  h: number,
): void {
  const fontPx = Math.max(11, Math.round(h * 0.035));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = 'rgba(255,220,60,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(gaze.vx)}, ${Math.round(gaze.vy)}`, fontPx * 0.6, h - fontPx * 0.5, w * 0.5);
  ctx.restore();
}
