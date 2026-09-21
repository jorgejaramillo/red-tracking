import type { AOI, AOIMetrics, AOIRectSnapshot, Fixation, Rect } from '@red-tracking/protocol';

const SOURCE_PRIORITY: Record<AOI['source'], number> = {
  'study-selector': 0,
  manual: 0,
  'data-aoi': 1,
  'auto-image': 2,
  'auto-heading': 3,
  'auto-link': 4,
};

/** Rect snapshot closest in time to `t`. */
export function rectAt(aoi: AOI, t: number): AOIRectSnapshot | null {
  if (aoi.rects.length === 0) return null;
  let best = aoi.rects[0]!;
  let bd = Math.abs(best.t - t);
  for (const r of aoi.rects) {
    const d = Math.abs(r.t - t);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function area(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/**
 * Assign each fixation to at most one AOI. When several AOIs contain the point,
 * researcher-defined AOIs win, then the smallest one (most specific).
 */
export function assignFixations(fixations: Fixation[], aois: AOI[]): Fixation[] {
  return fixations.map((f) => {
    let best: AOI | null = null;
    let bestRect: Rect | null = null;
    for (const a of aois) {
      if (a.pageVisitId !== f.pageVisitId) continue;
      const r = rectAt(a, f.tStart);
      if (!r || !contains(r, f.px, f.py)) continue;
      if (!best || !bestRect) {
        best = a;
        bestRect = r;
        continue;
      }
      const pa = SOURCE_PRIORITY[a.source], pb = SOURCE_PRIORITY[best.source];
      if (pa < pb || (pa === pb && area(r) < area(bestRect))) {
        best = a;
        bestRect = r;
      }
    }
    return { ...f, aoiId: best ? best.id : null };
  });
}

export interface MetricsOptions {
  /** AOIs whose smaller side is below this are flagged as below tracker resolution. */
  minSidePx?: number;
}

/**
 * Per-AOI metrics from AOI-assigned fixations of one page visit.
 * `tStart`/`tEnd` bound the visit (for TTFF and % of time).
 */
export function computeAoiMetrics(
  fixations: Fixation[],
  aois: AOI[],
  visit: { tStart: number; tEnd: number },
  opts: MetricsOptions = {},
): AOIMetrics[] {
  const minSide = opts.minSidePx ?? 120;
  const totalMs = Math.max(1, visit.tEnd - visit.tStart);
  const sorted = fixations.slice().sort((a, b) => a.tStart - b.tStart);

  const byAoi = new Map<string, Fixation[]>();
  for (const f of sorted) {
    if (!f.aoiId) continue;
    let arr = byAoi.get(f.aoiId);
    if (!arr) byAoi.set(f.aoiId, (arr = []));
    arr.push(f);
  }

  // Visit order: rank of first fixation.
  const firstSeen: { id: string; t: number }[] = [];
  for (const [id, fx] of byAoi) firstSeen.push({ id, t: fx[0]!.tStart });
  firstSeen.sort((a, b) => a.t - b.t);
  const order = new Map(firstSeen.map((e, i) => [e.id, i + 1]));

  // Visits = runs of consecutive fixations in the same AOI.
  const visits = new Map<string, number>();
  let prev: string | null = null;
  for (const f of sorted) {
    const id = f.aoiId ?? null;
    if (id && id !== prev) visits.set(id, (visits.get(id) ?? 0) + 1);
    prev = id;
  }

  return aois.map((a) => {
    const fx = byAoi.get(a.id) ?? [];
    const dwell = fx.reduce((s, f) => s + f.durationMs, 0);
    const r = a.rects[0] ?? { x: 0, y: 0, w: 0, h: 0, t: 0 };
    const v = visits.get(a.id) ?? 0;
    return {
      aoiId: a.id,
      label: a.label,
      source: a.source,
      ttffMs: fx.length ? fx[0]!.tStart - visit.tStart : null,
      dwellMs: dwell,
      fixationCount: fx.length,
      visitCount: v,
      firstVisitOrder: order.get(a.id) ?? null,
      revisits: Math.max(0, v - 1),
      pctSessionTime: dwell / totalMs,
      belowResolution: Math.min(r.w, r.h) < minSide,
      area: area(r),
    };
  });
}

export function metricsToCsv(rows: AOIMetrics[]): string {
  const head = [
    'aoi_id', 'label', 'source', 'ttff_ms', 'dwell_ms', 'fixations', 'visits', 'first_visit_order',
    'revisits', 'pct_time', 'below_resolution', 'area_px2',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((m) =>
    [
      m.aoiId, m.label, m.source, m.ttffMs, m.dwellMs, m.fixationCount, m.visitCount, m.firstVisitOrder,
      m.revisits, m.pctSessionTime.toFixed(4), m.belowResolution ? 1 : 0, Math.round(m.area),
    ].map(esc).join(','),
  );
  return [head.join(','), ...lines].join('\n');
}
