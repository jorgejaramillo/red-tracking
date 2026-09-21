import { describe, expect, it } from 'vitest';
import { coverage, planStitch, type TileMeta } from '../src/stitch';

const tile = (id: string, t: number, scrollY: number, extra: Partial<TileMeta> = {}): TileMeta => ({
  id, t, scrollX: 0, scrollY, viewportW: 1200, viewportH: 800, dpr: 2, docW: 1200, docH: 3000,
  stickyRects: [{ x: 0, y: 0, w: 1200, h: 80 }], ...extra,
});

describe('planStitch', () => {
  it('places tiles at their scroll offsets and masks sticky headers except on the top tile', () => {
    const plan = planStitch([tile('b', 2, 800), tile('a', 1, 0), tile('c', 3, 2200)]);
    expect(plan.canvasW).toBe(1200);
    expect(plan.canvasH).toBe(3000);
    expect(plan.scale).toBe(1);
    expect(plan.ops.map((o) => o.tileId)).toEqual(['a', 'b', 'c']);
    expect(plan.ops[0]!.masks).toHaveLength(0);
    expect(plan.ops[1]!.dy).toBe(800);
    expect(plan.ops[1]!.masks[0]).toEqual({ x: 0, y: 800, w: 1200, h: 80 });
  });

  it('scales down pages taller than maxDim', () => {
    const plan = planStitch([tile('a', 1, 0, { docH: 40000 })], { maxDim: 16384 });
    expect(plan.canvasH).toBeLessThanOrEqual(16384);
    expect(plan.scale).toBeCloseTo(16384 / 40000, 6);
    expect(plan.ops[0]!.dh).toBeCloseTo(800 * plan.scale, 6);
  });

  it('reports vertical coverage', () => {
    const plan = planStitch([tile('a', 1, 0), tile('b', 2, 2200)]);
    expect(coverage(plan)).toBeCloseTo(1600 / 3000, 3);
  });

  it('handles no tiles', () => {
    expect(planStitch([]).ops).toHaveLength(0);
  });
});
