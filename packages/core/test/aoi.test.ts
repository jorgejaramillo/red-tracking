import { describe, expect, it } from 'vitest';
import type { AOI, Fixation } from '@red-tracking/protocol';
import { assignFixations, computeAoiMetrics, metricsToCsv } from '../src/aoi';

const aoi = (id: string, x: number, y: number, w: number, h: number, source: AOI['source'] = 'auto-image'): AOI => ({
  id, sessionId: 's', pageVisitId: 'pv', label: id.toUpperCase(), source, selector: '#' + id,
  rects: [{ t: 0, x, y, w, h }],
});
const fix = (tStart: number, dur: number, px: number, py: number): Fixation => ({
  pageVisitId: 'pv', tStart, tEnd: tStart + dur, durationMs: dur, px, py, dispersion: 10, nSamples: 5, aoiId: null,
});

describe('AOI assignment and metrics', () => {
  const aois = [aoi('a', 0, 0, 400, 300), aoi('b', 500, 0, 400, 300), aoi('c', 0, 400, 400, 300)];

  it('computes TTFF, dwell, visit order and revisits', () => {
    const fixations = assignFixations(
      [fix(1000, 3000, 100, 100), fix(4100, 3000, 600, 100), fix(7200, 3000, 100, 500), fix(10300, 500, 120, 120)],
      aois,
    );
    const m = computeAoiMetrics(fixations, aois, { tStart: 0, tEnd: 12000 });
    const byId = Object.fromEntries(m.map((r) => [r.aoiId, r]));
    expect(byId['a']!.ttffMs).toBe(1000);
    expect(byId['b']!.ttffMs).toBe(4100);
    expect(byId['c']!.ttffMs).toBe(7200);
    expect(byId['a']!.firstVisitOrder).toBe(1);
    expect(byId['b']!.firstVisitOrder).toBe(2);
    expect(byId['c']!.firstVisitOrder).toBe(3);
    expect(byId['a']!.dwellMs).toBe(3500);
    expect(byId['a']!.visitCount).toBe(2);
    expect(byId['a']!.revisits).toBe(1);
    expect(byId['b']!.fixationCount).toBe(1);
    expect(byId['a']!.pctSessionTime).toBeCloseTo(3500 / 12000, 6);
    expect(byId['a']!.belowResolution).toBe(false);
  });

  it('prefers researcher AOIs, then the smallest containing AOI', () => {
    const big = aoi('big', 0, 0, 1000, 1000);
    const small = aoi('small', 100, 100, 50, 50);
    const study = aoi('study', 0, 0, 1000, 1000, 'study-selector');
    const f = assignFixations([fix(0, 100, 120, 120)], [big, small]);
    expect(f[0]!.aoiId).toBe('small');
    const g = assignFixations([fix(0, 100, 120, 120)], [big, small, study]);
    expect(g[0]!.aoiId).toBe('study');
  });

  it('flags AOIs smaller than the tracker resolution and never-looked AOIs', () => {
    const tiny = aoi('tiny', 0, 0, 60, 60);
    const m = computeAoiMetrics([], [tiny], { tStart: 0, tEnd: 1000 });
    expect(m[0]!.belowResolution).toBe(true);
    expect(m[0]!.ttffMs).toBeNull();
    expect(m[0]!.firstVisitOrder).toBeNull();
  });

  it('exports CSV with a header and escapes commas', () => {
    const a = aoi('x', 0, 0, 300, 300);
    a.label = 'Cereal, crunchy';
    const csv = metricsToCsv(computeAoiMetrics([], [a], { tStart: 0, tEnd: 1000 }));
    const lines = csv.split('\n');
    expect(lines[0]!.startsWith('aoi_id,label')).toBe(true);
    expect(lines[1]!).toContain('"Cereal, crunchy"');
  });
});
