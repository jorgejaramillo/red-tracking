/**
 * Turns a stored SessionBundle into per-page-visit analytics (fixations, AOI
 * metrics, summary numbers). Pure computation on top of @red-tracking/core.
 */
import {
  assignFixations,
  computeAoiMetrics,
  detectFixations,
  planStitch,
  samplesFromChunks,
  type GazeSampleLite,
  type StitchPlan,
} from '@red-tracking/core';
import type { AOI, AOIMetrics, Fixation, PageVisit, SampleChunk, ScreenshotTile, Size } from '@red-tracking/protocol';
import type { SessionBundle } from '../db';

export interface VisitAnalysis {
  visit: PageVisit;
  chunks: SampleChunk[];
  tiles: ScreenshotTile[];
  aois: AOI[];
  samples: GazeSampleLite[];
  fixations: Fixation[];
  metrics: AOIMetrics[];
  plan: StitchPlan;
  docSize: Size;
  durationMs: number;
  sampleCount: number;
  validCount: number;
}

export interface SessionAnalysis {
  bundle: SessionBundle;
  visits: VisitAnalysis[];
  totals: {
    durationMs: number;
    samples: number;
    validSamples: number;
    fixations: number;
    meanErrPx: number | null;
    meanErrDeg: number | null;
  };
}

export function analyzeSession(bundle: SessionBundle): SessionAnalysis {
  const visits = bundle.pageVisits.map((visit) => analyzeVisit(bundle, visit));
  const validation = bundle.session.validation ?? bundle.calibration?.validation ?? null;
  return {
    bundle,
    visits,
    totals: {
      durationMs: bundle.session.recordedMs,
      samples: visits.reduce((s, v) => s + v.sampleCount, 0),
      validSamples: visits.reduce((s, v) => s + v.validCount, 0),
      fixations: visits.reduce((s, v) => s + v.fixations.length, 0),
      meanErrPx: validation?.meanErrPx ?? null,
      meanErrDeg: validation?.meanErrDeg ?? null,
    },
  };
}

export function analyzeVisit(bundle: SessionBundle, visit: PageVisit): VisitAnalysis {
  const chunks = bundle.chunks.filter((c) => c.pageVisitId === visit.id);
  const tiles = bundle.tiles.filter((t) => t.pageVisitId === visit.id);
  const aois = bundle.aois.filter((a) => a.pageVisitId === visit.id);
  const samples = samplesFromChunks(chunks);
  const raw = detectFixations(samples, visit.id);
  const fixations = assignFixations(raw, aois);
  const tEnd = visit.tEnd ?? (samples.at(-1)?.t ?? visit.tStart);
  const metrics = computeAoiMetrics(fixations, aois, { tStart: visit.tStart, tEnd }).sort((a, b) => {
    if (a.firstVisitOrder === null && b.firstVisitOrder === null) return b.area - a.area;
    if (a.firstVisitOrder === null) return 1;
    if (b.firstVisitOrder === null) return -1;
    return a.firstVisitOrder - b.firstVisitOrder;
  });
  const plan = planStitch(tiles);
  const docSize: Size = tiles.length
    ? { w: plan.docW, h: plan.docH }
    : { w: Math.max(visit.docSize.w, visit.viewport.w), h: Math.max(visit.docSize.h, visit.viewport.h) };
  return {
    visit,
    chunks,
    tiles,
    aois,
    samples,
    fixations,
    metrics,
    plan,
    docSize,
    durationMs: Math.max(0, tEnd - visit.tStart),
    sampleCount: samples.length,
    validCount: samples.filter((s) => s.valid).length,
  };
}

/** Only AOIs that were looked at or are researcher-defined, for compact tables. */
export function relevantMetrics(metrics: AOIMetrics[], limit = 60): AOIMetrics[] {
  const looked = metrics.filter((m) => m.fixationCount > 0 || m.source === 'study-selector' || m.source === 'data-aoi');
  return looked.slice(0, limit);
}
