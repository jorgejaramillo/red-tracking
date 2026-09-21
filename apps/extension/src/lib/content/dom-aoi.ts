/**
 * AOI (area of interest) harvesting from the live DOM.
 *
 * Candidates, in priority order: study selectors → `[data-aoi]` → images →
 * headings → links/buttons. Rects are PAGE coordinates (viewport rect + scroll).
 * The service worker merges the per-scroll-stop snapshots by AOI id, so each
 * harvest only carries the current rect. The harvester also keeps the latest
 * rects locally so samples can be tagged with an `aoiId` without a round trip.
 */
import type { AOI, AOISource, Rect } from '@red-tracking/protocol';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { compactSelector } from './compact-selector';

export interface StudySelector {
  label: string;
  selector: string;
}

const MAX_AOIS = 400;
const MAX_AUTO_CANDIDATES = 600;
const MAX_MATCHES_PER_QUERY = 1500;
const MAX_STUDY_MATCHES = 50;
const MAX_LABEL = 60;
const MIN_IMAGE_SIDE = 60;
const MIN_LINK_SIDE = 40;
const HARVEST_THROTTLE_MS = 1000;

const SOURCE_PRIORITY: Record<AOISource, number> = {
  'study-selector': 0,
  manual: 0,
  'data-aoi': 1,
  'auto-image': 2,
  'auto-heading': 3,
  'auto-link': 4,
};

const AUTO_SOURCES: ReadonlySet<AOISource> = new Set(['auto-image', 'auto-heading', 'auto-link']);

interface Candidate {
  el: Element;
  source: AOISource;
  label: string;
  selector: string;
  rect: Rect;
}

type ExcludeFn = (el: Element) => boolean;

/** Stable id per (source, selector): `aoi_` + FNV-1a 32-bit hex. */
export function aoiIdFor(source: AOISource, selector: string): string {
  return `aoi_${fnv1a(`${source}|${selector}`)}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function harvestAois(
  studySelectors: StudySelector[],
  pageVisitId: string,
  isExcluded: ExcludeFn = () => false,
): AOI[] {
  const t = Date.now();
  const sx = window.scrollX;
  const sy = window.scrollY;
  const seen = new Set<Element>();
  const out: Candidate[] = [];

  const measure = (el: Element): Rect | null => {
    try {
      if (seen.has(el) || isExcluded(el)) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
      return {
        x: Math.round(r.left + sx),
        y: Math.round(r.top + sy),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    } catch {
      return null;
    }
  };

  const push = (el: Element, source: AOISource, label: string, selector: string, rect: Rect) => {
    seen.add(el);
    out.push({ el, source, label, selector, rect });
  };

  // (a) study selectors
  for (const { label, selector } of studySelectors) {
    const matches = queryAll(selector, MAX_STUDY_MATCHES);
    const visible: { el: Element; rect: Rect }[] = [];
    for (const el of matches) {
      const rect = measure(el);
      if (rect) visible.push({ el, rect });
    }
    visible.forEach(({ el, rect }, k) => {
      const multi = visible.length > 1;
      push(
        el,
        'study-selector',
        multi ? `${label} #${k + 1}` : label,
        multi ? safeCompactSelector(el) : selector,
        rect,
      );
    });
  }

  // (b) data-aoi
  for (const el of queryAll('[data-aoi]')) {
    const rect = measure(el);
    if (!rect) continue;
    const value = cleanText(el.getAttribute('data-aoi') ?? '') || 'aoi';
    const attrSel = `[data-aoi="${value.replace(/["\\]/g, '\\$&')}"]`;
    push(el, 'data-aoi', value, isUnique(attrSel) ? attrSel : safeCompactSelector(el), rect);
  }

  // (c)–(e) automatic candidates
  const auto: Candidate[] = [];
  for (const el of queryAll('img, picture, [role="img"], svg')) {
    const rect = measure(el);
    if (!rect || rect.w < MIN_IMAGE_SIDE || rect.h < MIN_IMAGE_SIDE) continue;
    seen.add(el);
    auto.push({ el, source: 'auto-image', label: imageLabel(el), selector: safeCompactSelector(el), rect });
  }
  for (const el of queryAll('h1, h2, h3, h4')) {
    const text = cleanText(el.textContent ?? '');
    if (!text) continue;
    const rect = measure(el);
    if (!rect) continue;
    seen.add(el);
    auto.push({ el, source: 'auto-heading', label: text, selector: safeCompactSelector(el), rect });
  }
  for (const el of queryAll('a, button, [role="button"]')) {
    const rect = measure(el);
    if (!rect || rect.w < MIN_LINK_SIDE || rect.h < MIN_LINK_SIDE) continue;
    seen.add(el);
    const label =
      cleanText(el.textContent ?? '') ||
      cleanText(el.getAttribute('aria-label') ?? '') ||
      cleanText(el.getAttribute('title') ?? '') ||
      (el.tagName === 'A' ? 'link' : 'button');
    auto.push({ el, source: 'auto-link', label, selector: safeCompactSelector(el), rect });
  }

  out.push(...dropContained(auto.slice(0, MAX_AUTO_CANDIDATES)));

  const aois: AOI[] = [];
  const ids = new Set<string>();
  for (const c of out) {
    if (aois.length >= MAX_AOIS) break;
    const id = aoiIdFor(c.source, c.selector);
    if (ids.has(id)) continue;
    ids.add(id);
    aois.push({
      id,
      sessionId: '',
      pageVisitId,
      label: c.label,
      source: c.source,
      selector: c.selector,
      rects: [{ t, ...c.rect }],
    });
  }
  return aois;
}

/** Remove auto candidates whose rect lies fully inside another auto candidate's rect. */
function dropContained(auto: Candidate[]): Candidate[] {
  const keep: Candidate[] = [];
  for (let i = 0; i < auto.length; i++) {
    const a = auto[i]!;
    let contained = false;
    for (let j = 0; j < auto.length && !contained; j++) {
      if (i === j) continue;
      const b = auto[j]!;
      if (!rectContains(b.rect, a.rect)) continue;
      // Identical rects: keep the earlier (higher-priority) one only.
      const identical = rectContains(a.rect, b.rect);
      if (!identical || j < i) contained = true;
    }
    if (!contained) keep.push(a);
  }
  return keep;
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function queryAll(selector: string, limit = MAX_MATCHES_PER_QUERY): Element[] {
  try {
    const list = document.querySelectorAll(selector);
    const n = Math.min(list.length, limit);
    const arr: Element[] = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = list[i]!;
    return arr;
  } catch {
    return [];
  }
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function safeCompactSelector(el: Element): string {
  try {
    return compactSelector(el);
  } catch {
    return el.tagName.toLowerCase();
  }
}

function cleanText(s: string, max = MAX_LABEL): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function imageLabel(el: Element): string {
  const direct =
    cleanText(el.getAttribute('alt') ?? '') ||
    cleanText(el.getAttribute('aria-label') ?? '') ||
    cleanText(el.getAttribute('title') ?? '');
  if (direct) return direct;
  try {
    const inner = el.querySelector('img[alt], title');
    const innerText = inner ? cleanText(inner.getAttribute('alt') ?? inner.textContent ?? '') : '';
    if (innerText) return innerText;
    const scope = el.closest('figure, article, section, li, [class*="card" i], [class*="product" i]');
    const heading = scope?.querySelector('h1, h2, h3, h4, h5, h6, figcaption');
    const text = heading ? cleanText(heading.textContent ?? '') : '';
    if (text) return text;
  } catch {
    /* ignore */
  }
  return 'image';
}

// ---------------------------------------------------------------------------
// Harvester: throttling + latest rects for sample enrichment
// ---------------------------------------------------------------------------

interface LatestRect {
  rect: Rect;
  priority: number;
  area: number;
}

export interface AoiHarvesterOptions {
  getPageVisitId: () => string | null;
  isExcluded?: ExcludeFn;
  onAois: (pageVisitId: string, aois: AOI[]) => void;
}

export class AoiHarvester {
  private studySelectors: StudySelector[] = [];
  private latest = new Map<string, LatestRect>();
  private lastRunAt = 0;
  private pending: number | null = null;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly opts: AoiHarvesterOptions,
  ) {}

  setStudySelectors(selectors: StudySelector[]): void {
    this.studySelectors = selectors.filter((s) => s && typeof s.selector === 'string' && s.selector.trim());
  }

  /** Harvest now (HARVEST_AOIS) or as soon as the 1 s throttle allows (scroll-stop, load). */
  request(immediate = false): void {
    if (this.ctx.isInvalid) return;
    if (immediate) {
      this.clearPending();
      this.run();
      return;
    }
    if (this.pending !== null) return;
    const wait = Math.max(0, this.lastRunAt + HARVEST_THROTTLE_MS - Date.now());
    this.pending = this.ctx.setTimeout(() => {
      this.pending = null;
      this.run();
    }, wait);
  }

  /** AOI id at a page coordinate; researcher-defined AOIs win, then the smallest. */
  hitTest(px: number, py: number): string | null {
    let bestId: string | null = null;
    let bestPriority = Infinity;
    let bestArea = Infinity;
    for (const [id, { rect, priority, area }] of this.latest) {
      if (px < rect.x || py < rect.y || px >= rect.x + rect.w || py >= rect.y + rect.h) continue;
      if (priority < bestPriority || (priority === bestPriority && area < bestArea)) {
        bestId = id;
        bestPriority = priority;
        bestArea = area;
      }
    }
    return bestId;
  }

  /** Forget harvested rects (SPA navigation). Study selectors are kept. */
  reset(): void {
    this.clearPending();
    this.latest.clear();
    this.lastRunAt = 0;
  }

  private clearPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  private run(): void {
    this.lastRunAt = Date.now();
    const pageVisitId = this.opts.getPageVisitId();
    if (!pageVisitId) return;
    let aois: AOI[];
    try {
      aois = harvestAois(this.studySelectors, pageVisitId, this.opts.isExcluded);
    } catch (err) {
      console.error('[rt:content] AOI harvest failed', err);
      return;
    }
    this.latest.clear();
    for (const a of aois) {
      const rect = a.rects[0];
      if (!rect) continue;
      this.latest.set(a.id, {
        rect,
        priority: SOURCE_PRIORITY[a.source],
        area: Math.max(0, rect.w) * Math.max(0, rect.h),
      });
    }
    this.opts.onAois(pageVisitId, aois);
  }
}
