import { describe, expect, it } from 'vitest';
import { detectFixations, samplesFromChunks, type GazeSampleLite } from '../src/fixations';
import { SampleFlag, type SampleChunk } from '@red-tracking/protocol';
import { seededRng } from '../src/geometry';

function sequence(): GazeSampleLite[] {
  const rng = seededRng(4);
  const out: GazeSampleLite[] = [];
  let t = 0;
  const jitter = () => (rng() - 0.5) * 20;
  const fix = (x: number, y: number, ms: number) => {
    for (let k = 0; k < ms / 33; k++) {
      out.push({ t, x: x + jitter(), y: y + jitter(), valid: true });
      t += 33;
    }
  };
  const saccade = (x0: number, y0: number, x1: number, y1: number) => {
    for (let k = 1; k <= 3; k++) {
      out.push({ t, x: x0 + ((x1 - x0) * k) / 4, y: y0 + ((y1 - y0) * k) / 4, valid: true });
      t += 33;
    }
  };
  fix(200, 200, 600);
  saccade(200, 200, 900, 300);
  fix(900, 300, 400);
  saccade(900, 300, 500, 800);
  fix(500, 800, 900);
  return out;
}

describe('detectFixations (I-DT)', () => {
  it('finds the three planted fixations with sane durations and centroids', () => {
    const fx = detectFixations(sequence(), 'pv1');
    expect(fx.length).toBe(3);
    expect(fx[0]!.px).toBeCloseTo(200, -2);
    expect(fx[0]!.py).toBeCloseTo(200, -2);
    expect(fx[1]!.px).toBeCloseTo(900, -2);
    expect(fx[2]!.py).toBeCloseTo(800, -2);
    expect(fx[0]!.durationMs).toBeGreaterThan(450);
    expect(fx[0]!.durationMs).toBeLessThan(750);
    expect(fx[2]!.durationMs).toBeGreaterThan(750);
    for (const f of fx) expect(f.pageVisitId).toBe('pv1');
  });

  it('ignores invalid samples and short glances', () => {
    const s: GazeSampleLite[] = [];
    for (let i = 0; i < 2; i++) s.push({ t: i * 33, x: 100, y: 100, valid: true });
    for (let i = 2; i < 40; i++) s.push({ t: i * 33, x: 100, y: 100, valid: false });
    expect(detectFixations(s, 'pv')).toHaveLength(0);
  });

  it('merges two fixations split by a brief gap at the same place', () => {
    const s: GazeSampleLite[] = [];
    let t = 0;
    for (let i = 0; i < 10; i++, t += 33) s.push({ t, x: 300, y: 300, valid: true });
    t += 60; // brief blink gap
    for (let i = 0; i < 10; i++, t += 33) s.push({ t, x: 305, y: 302, valid: true });
    const fx = detectFixations(s, 'pv');
    expect(fx).toHaveLength(1);
    expect(fx[0]!.nSamples).toBe(20);
  });
});

describe('samplesFromChunks', () => {
  it('flattens chunks in time order and applies validity flags', () => {
    const mk = (tStart: number, flags: number[]): SampleChunk => {
      const n = flags.length;
      return {
        id: 'c' + tStart, sessionId: 's', pageVisitId: 'pv', tStart, tEnd: tStart + n * 33, count: n,
        t: Float64Array.from(flags.map((_, i) => tStart + i * 33)),
        rx: new Float32Array(n), ry: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n),
        px: Float32Array.from(flags.map(() => 10)), py: Float32Array.from(flags.map(() => 20)),
        scrollX: new Float32Array(n), scrollY: new Float32Array(n), conf: new Float32Array(n).fill(1),
        yaw: new Float32Array(n), pitch: new Float32Array(n), flags: Uint8Array.from(flags),
        elIdx: new Uint16Array(n), aoiIdx: new Uint16Array(n), selectors: [], aoiIds: [],
      };
    };
    const out = samplesFromChunks([mk(1000, [0, SampleFlag.Blink]), mk(0, [0])]);
    expect(out.map((s) => s.t)).toEqual([0, 1000, 1033]);
    expect(out.map((s) => s.valid)).toEqual([true, true, false]);
  });
});
