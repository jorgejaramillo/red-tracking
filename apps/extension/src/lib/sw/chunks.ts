import { NO_INDEX, type EnrichedSample, type SampleChunk } from '@red-tracking/protocol';
import { uid } from '../ids';

const CHUNK_SIZE = 256;

/** Accumulates enriched samples for one page visit and emits columnar chunks. */
export class ChunkBuilder {
  private buffer: EnrichedSample[] = [];

  constructor(
    readonly sessionId: string,
    readonly pageVisitId: string,
    private readonly onChunk: (chunk: SampleChunk) => Promise<void>,
  ) {}

  async add(samples: EnrichedSample[]): Promise<void> {
    for (const s of samples) this.buffer.push(s);
    while (this.buffer.length >= CHUNK_SIZE) {
      const part = this.buffer.splice(0, CHUNK_SIZE);
      await this.onChunk(buildChunk(this.sessionId, this.pageVisitId, part));
    }
  }

  get pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const part = this.buffer.splice(0);
    await this.onChunk(buildChunk(this.sessionId, this.pageVisitId, part));
  }
}

export function buildChunk(sessionId: string, pageVisitId: string, samples: EnrichedSample[]): SampleChunk {
  const n = samples.length;
  const selectors: string[] = [];
  const selIdx = new Map<string, number>();
  const aoiIds: string[] = [];
  const aoiIdx = new Map<string, number>();
  const intern = (table: string[], map: Map<string, number>, v: string | null): number => {
    if (v === null || v === '') return NO_INDEX;
    let i = map.get(v);
    if (i === undefined) {
      i = table.length;
      if (i >= NO_INDEX) return NO_INDEX;
      table.push(v);
      map.set(v, i);
    }
    return i;
  };

  const c: SampleChunk = {
    id: uid('chk'),
    sessionId,
    pageVisitId,
    tStart: samples[0]!.t,
    tEnd: samples[n - 1]!.t,
    count: n,
    t: new Float64Array(n),
    rx: new Float32Array(n),
    ry: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    px: new Float32Array(n),
    py: new Float32Array(n),
    scrollX: new Float32Array(n),
    scrollY: new Float32Array(n),
    conf: new Float32Array(n),
    yaw: new Float32Array(n),
    pitch: new Float32Array(n),
    flags: new Uint8Array(n),
    elIdx: new Uint16Array(n),
    aoiIdx: new Uint16Array(n),
    selectors,
    aoiIds,
  };
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    c.t[i] = s.t;
    c.rx[i] = s.rx;
    c.ry[i] = s.ry;
    c.vx[i] = s.vx;
    c.vy[i] = s.vy;
    c.px[i] = s.px;
    c.py[i] = s.py;
    c.scrollX[i] = s.scrollX;
    c.scrollY[i] = s.scrollY;
    c.conf[i] = s.conf;
    c.yaw[i] = s.yaw;
    c.pitch[i] = s.pitch;
    c.flags[i] = s.flags;
    c.elIdx[i] = intern(selectors, selIdx, s.selector);
    c.aoiIdx[i] = intern(aoiIds, aoiIdx, s.aoiId);
  }
  return c;
}
