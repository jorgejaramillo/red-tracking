import type { ScreenshotTile, ScrollStopInfo } from '@red-tracking/protocol';
import { browser } from 'wxt/browser';
import { uid } from '../ids';

const MIN_INTERVAL_MS = 650;

/**
 * Rate-limited viewport capture. Coalesces bursts of scroll-stops: only the
 * most recent request is executed once the interval allows it.
 */
export class TileCapturer {
  private lastAt = 0;
  private pending: { info: ScrollStopInfo; sessionId: string; pageVisitId: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly getWindowId: () => number | null,
    private readonly prepare: () => Promise<void>,
    private readonly done: () => void,
    private readonly onTile: (tile: ScreenshotTile) => Promise<void>,
    private readonly onError?: (message: string) => void,
  ) {}

  request(info: ScrollStopInfo, sessionId: string, pageVisitId: string): void {
    this.pending = { info, sessionId, pageVisitId };
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.busy) return;
    const wait = Math.max(0, this.lastAt + MIN_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  private async run(): Promise<void> {
    const job = this.pending;
    this.pending = null;
    if (!job) return;
    const windowId = this.getWindowId();
    if (windowId === null) return;
    this.busy = true;
    try {
      await this.prepare();
      const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
      this.lastAt = Date.now();
      const blob = await (await fetch(dataUrl)).blob();
      const { info } = job;
      await this.onTile({
        id: uid('tile'),
        sessionId: job.sessionId,
        pageVisitId: job.pageVisitId,
        t: info.t,
        scrollX: info.scrollX,
        scrollY: info.scrollY,
        viewportW: info.viewport.w,
        viewportH: info.viewport.h,
        dpr: info.dpr,
        docW: info.docSize.w,
        docH: info.docSize.h,
        stickyRects: info.stickyRects,
        blob,
      });
    } catch (err) {
      // Typical: tab not active, rate limit, or restricted page. Non-fatal.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[rt:sw] capture failed', message);
      this.onError?.(message);
      this.lastAt = Date.now();
    } finally {
      this.done();
      this.busy = false;
      if (this.pending) this.schedule();
    }
  }
}
