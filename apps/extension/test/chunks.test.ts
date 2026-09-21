import { describe, expect, it } from 'vitest';
import { NO_INDEX, type EnrichedSample } from '@red-tracking/protocol';
import { buildChunk, ChunkBuilder } from '../src/lib/sw/chunks';

const sample = (i: number, extra: Partial<EnrichedSample> = {}): EnrichedSample => ({
  t: 1000 + i * 33, rx: i, ry: i * 2, vx: i + 0.5, vy: i * 2 + 0.5, conf: 1, blink: false, yaw: 1, pitch: -1, roll: 0, tz: -40,
  px: i + 10, py: i * 2 + 20, scrollX: 0, scrollY: 10, flags: 0, selector: i % 2 ? '#a' : null, aoiId: i % 3 ? 'aoi_x' : null, ...extra,
});

describe('buildChunk', () => {
  it('interns selectors and AOI ids and preserves values', () => {
    const c = buildChunk('s1', 'pv1', [sample(0), sample(1), sample(2)]);
    expect(c.count).toBe(3);
    expect(c.tStart).toBe(1000);
    expect(c.tEnd).toBe(1066);
    expect(Array.from(c.px)).toEqual([10, 11, 12]);
    expect(c.selectors).toEqual(['#a']);
    expect(c.aoiIds).toEqual(['aoi_x']);
    expect(Array.from(c.elIdx)).toEqual([NO_INDEX, 0, NO_INDEX]);
    expect(Array.from(c.aoiIdx)).toEqual([NO_INDEX, 0, 0]);
  });
});

describe('ChunkBuilder', () => {
  it('emits 256-sample chunks and flushes the remainder', async () => {
    const out: number[] = [];
    const b = new ChunkBuilder('s', 'pv', async (c) => void out.push(c.count));
    await b.add(Array.from({ length: 300 }, (_, i) => sample(i)));
    expect(out).toEqual([256]);
    expect(b.pending).toBe(44);
    await b.flush();
    expect(out).toEqual([256, 44]);
    await b.flush();
    expect(out).toEqual([256, 44]);
  });
});
