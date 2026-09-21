/**
 * Turns GAZE points (viewport px) into EnrichedSample objects with page
 * coordinates, the element under the gaze (compact selector, ≤ 10 lookups/s,
 * cached per 8×8 px page cell) and the AOI hit, then ships them in batches.
 */
import { SampleFlag, type EnrichedSample, type GazePoint } from '@red-tracking/protocol';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { compactSelector } from './compact-selector';

const FLUSH_MS = 500;
const LOOKUP_MIN_INTERVAL_MS = 100;
const CELL_PX = 8;
const CELL_CACHE_MAX = 4096;
const CELL_CACHE_TTL_MS = 5000;

export interface EnricherOptions {
  /** True for elements belonging to our own overlay (never reported). */
  isOverlayElement: (el: Element) => boolean;
  aoiIdAt: (px: number, py: number) => string | null;
  /** Called with a non-empty batch. */
  onBatch: (samples: EnrichedSample[]) => void;
}

export class SampleEnricher {
  private buffer: EnrichedSample[] = [];
  private lastLookupAt = 0;
  private lastSelector: string | null = null;
  private cellCache = new Map<string, string | null>();
  private cellCacheBornAt = Date.now();
  private selectorByEl = new WeakMap<Element, string>();

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly opts: EnricherOptions,
  ) {
    ctx.setInterval(() => this.flush(), FLUSH_MS);
  }

  push(gaze: GazePoint): void {
    try {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const px = gaze.vx + scrollX;
      const py = gaze.vy + scrollY;
      const flags = gaze.blink ? SampleFlag.Blink : 0;
      const selector = this.selectorAt(gaze.vx, gaze.vy, px, py);
      const aoiId = this.opts.aoiIdAt(px, py);
      this.buffer.push({ ...gaze, px, py, scrollX, scrollY, flags, selector, aoiId });
    } catch (err) {
      console.error('[rt:content] enrich failed', err);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.opts.onBatch(batch);
    } catch (err) {
      console.error('[rt:content] batch flush failed', err);
    }
  }

  /** Drop buffered samples and caches (SPA navigation). */
  reset(): void {
    this.buffer = [];
    this.cellCache.clear();
    this.lastSelector = null;
    this.lastLookupAt = 0;
  }

  private selectorAt(vx: number, vy: number, px: number, py: number): string | null {
    const now = Date.now();
    if (now - this.cellCacheBornAt > CELL_CACHE_TTL_MS || this.cellCache.size > CELL_CACHE_MAX) {
      this.cellCache.clear();
      this.cellCacheBornAt = now;
    }
    const key = `${Math.floor(px / CELL_PX)},${Math.floor(py / CELL_PX)}`;
    const cached = this.cellCache.get(key);
    if (cached !== undefined) return cached;
    if (now - this.lastLookupAt < LOOKUP_MIN_INTERVAL_MS) return this.lastSelector;

    this.lastLookupAt = now;
    const selector = this.lookup(vx, vy);
    this.cellCache.set(key, selector);
    this.lastSelector = selector;
    return selector;
  }

  private lookup(vx: number, vy: number): string | null {
    if (vx < 0 || vy < 0 || vx >= window.innerWidth || vy >= window.innerHeight) return null;
    let el: Element | null = null;
    try {
      el = document.elementFromPoint(vx, vy);
    } catch {
      return null;
    }
    if (!el || this.opts.isOverlayElement(el)) return null;
    if (el === document.documentElement || el === document.body) return el.tagName.toLowerCase();
    let sel = this.selectorByEl.get(el);
    if (sel === undefined) {
      sel = compactSelector(el);
      this.selectorByEl.set(el, sel);
    }
    return sel;
  }
}
