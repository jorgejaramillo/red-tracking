/**
 * Scroll-stop detection and the page measurements the service worker needs to
 * stitch screenshots: scroll offset, document size, viewport, DPR and the
 * viewport-relative rects of fixed/sticky elements (headers, nav bars).
 */
import type { Rect, ScrollStopInfo, Size, WindowGeometry } from '@red-tracking/protocol';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const SCROLL_DEBOUNCE_MS = 350;
const RESIZE_DEBOUNCE_MS = 350;
const KICKOFF_DELAY_MS = 600;
const MIN_STICKY_AREA = 400;
const MAX_STICKY_RECTS = 20;
const MAX_STICKY_CANDIDATES = 600;
/** Elements covering more of the viewport than this are backdrops, not headers. */
const MAX_STICKY_VIEWPORT_FRACTION = 0.8;

const STICKY_CANDIDATE_SELECTOR = [
  'header',
  'nav',
  'footer',
  'aside',
  '[class*="sticky" i]',
  '[class*="fixed" i]',
  '[class*="header" i]',
  '[class*="navbar" i]',
  '[class*="topbar" i]',
  '[id*="header" i]',
  '[id*="nav" i]',
].join(',');

export type ExcludeFn = (el: Element) => boolean;

export function readGeometry(): WindowGeometry {
  return {
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
  };
}

export function readViewport(): Size {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function readDocSize(): Size {
  const de = document.documentElement;
  const body = document.body;
  const w = Math.max(de?.scrollWidth ?? 0, body?.scrollWidth ?? 0, window.innerWidth);
  const h = Math.max(de?.scrollHeight ?? 0, body?.scrollHeight ?? 0, window.innerHeight);
  return { w, h };
}

/**
 * Viewport-relative rects of `position: fixed | sticky` elements that intersect
 * the viewport. Only a cheap, bounded set of candidates is examined.
 */
export function collectStickyRects(isExcluded: ExcludeFn = () => false): Rect[] {
  const out: Rect[] = [];
  try {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxArea = vw * vh * MAX_STICKY_VIEWPORT_FRACTION;
    const seen = new Set<Element>();
    const candidates: Element[] = [];

    const add = (el: Element | null) => {
      if (!el || seen.has(el) || candidates.length >= MAX_STICKY_CANDIDATES) return;
      if (isExcluded(el)) return;
      seen.add(el);
      candidates.push(el);
    };
    const addWithChildren = (el: Element) => {
      add(el);
      for (const child of Array.from(el.children)) add(child);
    };

    if (document.body) for (const child of Array.from(document.body.children)) add(child);
    for (const el of Array.from(document.querySelectorAll(STICKY_CANDIDATE_SELECTOR))) addWithChildren(el);

    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const right = Math.min(vw, r.right);
      const bottom = Math.min(vh, r.bottom);
      const w = right - x;
      const h = bottom - y;
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area <= MIN_STICKY_AREA || area > maxArea) continue;
      out.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      if (out.length >= MAX_STICKY_RECTS) break;
    }
  } catch (err) {
    console.error('[rt:content] collectStickyRects failed', err);
  }
  return out;
}

export function readScrollStopInfo(isExcluded?: ExcludeFn): ScrollStopInfo {
  return {
    t: Date.now(),
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    docSize: readDocSize(),
    viewport: readViewport(),
    dpr: window.devicePixelRatio || 1,
    stickyRects: collectStickyRects(isExcluded),
  };
}

export interface ScrollStopWatcherOptions {
  onStop: (info: ScrollStopInfo) => void;
  isExcluded?: ExcludeFn;
}

export interface ScrollStopWatcher {
  /** Schedule a scroll-stop shortly after (used right after TAB_READY). */
  kickoff(): void;
  /** Emit immediately (cancels any pending debounce). */
  fireNow(): void;
}

export function createScrollStopWatcher(
  ctx: ContentScriptContext,
  opts: ScrollStopWatcherOptions,
): ScrollStopWatcher {
  let timer: number | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = () => {
    clear();
    if (ctx.isInvalid) return;
    try {
      opts.onStop(readScrollStopInfo(opts.isExcluded));
    } catch (err) {
      console.error('[rt:content] scroll-stop handler failed', err);
    }
  };

  const schedule = (delay: number) => {
    clear();
    timer = ctx.setTimeout(fire, delay);
  };

  ctx.addEventListener(window, 'scroll', () => schedule(SCROLL_DEBOUNCE_MS), { passive: true });
  ctx.addEventListener(window, 'resize', () => schedule(RESIZE_DEBOUNCE_MS), { passive: true });
  ctx.addEventListener(window, 'load', () => schedule(KICKOFF_DELAY_MS));

  return {
    kickoff: () => schedule(KICKOFF_DELAY_MS),
    fireNow: fire,
  };
}
