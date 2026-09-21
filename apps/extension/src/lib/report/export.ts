/**
 * Session export/import as a zip package. The same layout is what the
 * phase-2 backend ingests.
 */
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { metricsToCsv } from '@red-tracking/core';
import { NO_INDEX, type AOI, type PageVisit, type SampleChunk, type ScreenshotTile, type Session, type SessionEvent } from '@red-tracking/protocol';
import { getDb, type SessionBundle } from '../db';
import { uid } from '../ids';
import type { SessionAnalysis } from './analysis';

export const EXPORT_FORMAT = 'red-tracking/session@1';

export interface ExportExtras {
  /** heatmap PNG per page visit id */
  heatmaps?: Record<string, Blob>;
  replay?: Blob | null;
}

interface SessionJson {
  format: typeof EXPORT_FORMAT;
  exportedAt: number;
  session: Session;
  pageVisits: PageVisit[];
  calibration: (Omit<NonNullable<SessionBundle['calibration']>, 'model'> & { model: { kind: string; lambda: number } }) | null;
  aois: AOI[];
  events: SessionEvent[];
  fixations: SessionAnalysis['visits'][number]['fixations'][];
  metrics: SessionAnalysis['visits'][number]['metrics'][];
  tiles: Omit<ScreenshotTile, 'blob'>[];
  samplesBin: { columns: string[]; dtype: 'float32'; chunks: { pageVisitId: string; count: number; file: string; selectors: string[]; aoiIds: string[] }[] };
}

const COLUMNS = ['t', 'rx', 'ry', 'vx', 'vy', 'px', 'py', 'scrollX', 'scrollY', 'conf', 'yaw', 'pitch', 'flags', 'elIdx', 'aoiIdx'] as const;

export async function buildExportZip(analysis: SessionAnalysis, extras: ExportExtras = {}): Promise<Blob> {
  const { bundle } = analysis;
  const files: Zippable = {};

  const tilesMeta = bundle.tiles.map(({ blob: _blob, ...meta }) => meta);
  const chunkFiles: SessionJson['samplesBin']['chunks'] = [];
  bundle.chunks.forEach((c, i) => {
    const file = `samples/${c.pageVisitId}/${String(i).padStart(4, '0')}.f32`;
    files[file] = chunkToF32(c);
    chunkFiles.push({ pageVisitId: c.pageVisitId, count: c.count, file, selectors: c.selectors, aoiIds: c.aoiIds });
  });

  const json: SessionJson = {
    format: EXPORT_FORMAT,
    exportedAt: Date.now(),
    session: bundle.session,
    pageVisits: bundle.pageVisits,
    calibration: bundle.calibration
      ? { ...bundle.calibration, model: { kind: bundle.calibration.model.kind, lambda: bundle.calibration.model.lambda } }
      : null,
    aois: bundle.aois,
    events: bundle.events,
    fixations: analysis.visits.map((v) => v.fixations),
    metrics: analysis.visits.map((v) => v.metrics),
    tiles: tilesMeta,
    samplesBin: { columns: [...COLUMNS], dtype: 'float32', chunks: chunkFiles },
  };
  files['session.json'] = strToU8(JSON.stringify(json));
  files['samples.csv'] = strToU8(samplesCsv(bundle.chunks));
  files['aoi-metrics.csv'] = strToU8(
    analysis.visits.map((v, i) => `# page_visit ${i + 1}: ${v.visit.url}\n${metricsToCsv(v.metrics)}`).join('\n\n'),
  );

  for (const t of bundle.tiles) {
    files[`tiles/${t.pageVisitId}/${t.id}.jpg`] = new Uint8Array(await t.blob.arrayBuffer());
  }
  for (const [pv, blob] of Object.entries(extras.heatmaps ?? {})) {
    files[`heatmap-${pv}.png`] = new Uint8Array(await blob.arrayBuffer());
  }
  if (extras.replay) files['replay.webm'] = new Uint8Array(await extras.replay.arrayBuffer());

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}

function chunkToF32(c: SampleChunk): Uint8Array {
  const n = c.count;
  const out = new Float32Array(n * COLUMNS.length);
  for (let i = 0; i < n; i++) {
    const o = i * COLUMNS.length;
    out[o] = c.t[i]! - c.tStart; // relative to chunk start to keep float32 precision
    out[o + 1] = c.rx[i]!;
    out[o + 2] = c.ry[i]!;
    out[o + 3] = c.vx[i]!;
    out[o + 4] = c.vy[i]!;
    out[o + 5] = c.px[i]!;
    out[o + 6] = c.py[i]!;
    out[o + 7] = c.scrollX[i]!;
    out[o + 8] = c.scrollY[i]!;
    out[o + 9] = c.conf[i]!;
    out[o + 10] = c.yaw[i]!;
    out[o + 11] = c.pitch[i]!;
    out[o + 12] = c.flags[i]!;
    out[o + 13] = c.elIdx[i]!;
    out[o + 14] = c.aoiIdx[i]!;
  }
  // Prefix with tStart as float64 so the absolute time survives.
  const buf = new ArrayBuffer(8 + out.byteLength);
  new DataView(buf).setFloat64(0, c.tStart, true);
  new Uint8Array(buf, 8).set(new Uint8Array(out.buffer));
  return new Uint8Array(buf);
}

function f32ToChunk(bytes: Uint8Array, meta: SessionJson['samplesBin']['chunks'][number], sessionId: string): SampleChunk {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tStart = dv.getFloat64(0, true);
  const f = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 8, bytes.byteOffset + bytes.byteLength));
  const n = meta.count;
  const c: SampleChunk = {
    id: uid('chk'), sessionId, pageVisitId: meta.pageVisitId, tStart, tEnd: tStart, count: n,
    t: new Float64Array(n), rx: new Float32Array(n), ry: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n),
    px: new Float32Array(n), py: new Float32Array(n), scrollX: new Float32Array(n), scrollY: new Float32Array(n), conf: new Float32Array(n),
    yaw: new Float32Array(n), pitch: new Float32Array(n), flags: new Uint8Array(n), elIdx: new Uint16Array(n), aoiIdx: new Uint16Array(n),
    selectors: meta.selectors, aoiIds: meta.aoiIds,
  };
  for (let i = 0; i < n; i++) {
    const o = i * COLUMNS.length;
    c.t[i] = tStart + f[o]!;
    c.rx[i] = f[o + 1]!; c.ry[i] = f[o + 2]!; c.vx[i] = f[o + 3]!; c.vy[i] = f[o + 4]!;
    c.px[i] = f[o + 5]!; c.py[i] = f[o + 6]!; c.scrollX[i] = f[o + 7]!; c.scrollY[i] = f[o + 8]!;
    c.conf[i] = f[o + 9]!; c.yaw[i] = f[o + 10]!; c.pitch[i] = f[o + 11]!; c.flags[i] = f[o + 12]!;
    c.elIdx[i] = f[o + 13]!; c.aoiIdx[i] = f[o + 14]!;
  }
  c.tEnd = c.t[n - 1] ?? tStart;
  return c;
}

export function samplesCsv(chunks: SampleChunk[]): string {
  const rows = ['page_visit_id,t,rx,ry,vx,vy,px,py,scroll_x,scroll_y,conf,yaw,pitch,flags,selector,aoi_id'];
  for (const c of chunks) {
    for (let i = 0; i < c.count; i++) {
      const sel = c.elIdx[i] === NO_INDEX ? '' : c.selectors[c.elIdx[i]!] ?? '';
      const aoi = c.aoiIdx[i] === NO_INDEX ? '' : c.aoiIds[c.aoiIdx[i]!] ?? '';
      rows.push([
        c.pageVisitId, c.t[i], r1(c.rx[i]!), r1(c.ry[i]!), r1(c.vx[i]!), r1(c.vy[i]!), r1(c.px[i]!), r1(c.py[i]!),
        r1(c.scrollX[i]!), r1(c.scrollY[i]!), c.conf[i]!.toFixed(2), r1(c.yaw[i]!), r1(c.pitch[i]!), c.flags[i],
        csvEsc(sel), csvEsc(aoi),
      ].join(','));
    }
  }
  return rows.join('\n');
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toString();
const csvEsc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Import a package produced by buildExportZip into IndexedDB. Returns the new session id. */
export async function importZip(file: Blob): Promise<string> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = entries['session.json'];
  if (!raw) throw new Error('session.json missing');
  const json = JSON.parse(strFromU8(raw)) as SessionJson;
  if (json.format !== EXPORT_FORMAT) throw new Error(`Unsupported format ${json.format}`);

  const db = await getDb();
  const session: Session = { ...json.session, id: json.session.id };
  // Avoid clobbering a local session with the same id.
  if (await db.get('sessions', session.id)) session.id = uid('ses');
  const remap = (pv: string) => pv; // page visit ids are unique enough (uuid)

  await db.put('sessions', { ...session, pageVisitIds: json.pageVisits.map((p) => p.id) });
  for (const pv of json.pageVisits) await db.put('pageVisits', { ...pv, id: remap(pv.id), sessionId: session.id });
  for (const a of json.aois) await db.put('aois', { ...a, sessionId: session.id });
  for (const e of json.events) await db.add('events', { sessionId: session.id, t: e.t, kind: e.kind, data: e.data });
  for (const meta of json.samplesBin.chunks) {
    const bytes = entries[meta.file];
    if (bytes) await db.put('chunks', f32ToChunk(bytes, meta, session.id));
  }
  for (const t of json.tiles) {
    const bytes = entries[`tiles/${t.pageVisitId}/${t.id}.jpg`];
    if (!bytes) continue;
    await db.put('tiles', { ...t, sessionId: session.id, blob: new Blob([bytes], { type: 'image/jpeg' }) });
  }
  return session.id;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
