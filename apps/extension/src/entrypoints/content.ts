/**
 * Content script injected (at runtime, by the service worker) into the study
 * tab. Owns the in-page overlay, enriches gaze samples with page context and
 * reports page events (scroll-stops, clicks, visibility, geometry, AOIs).
 */
import '../lib/content/overlay.css';
import { i18n } from '#i18n';
import { PORT_TAB, type SessionState, type SwToTab, type TabToSw } from '@red-tracking/protocol';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { compactSelector } from '../lib/content/compact-selector';
import { AoiHarvester } from '../lib/content/dom-aoi';
import { SampleEnricher } from '../lib/content/enrich';
import { startGeometryWatch } from '../lib/content/geometry-watch';
import { Overlay } from '../lib/content/overlay';
import {
  createScrollStopWatcher,
  readDocSize,
  readGeometry,
  readViewport,
} from '../lib/content/scroll-stop';
import { connectPort, type ClientPort } from '../lib/ports';

const TOAST_WARN_MS = 4000;
const TOAST_DONE_MS = 5000;

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    try {
      await start(ctx);
    } catch (err) {
      console.error('[rt:content] failed to start', err);
    }
  },
});

interface TabState {
  session: SessionState;
  pageVisitId: string | null;
  recordingAnnounced: boolean;
  href: string;
}

async function start(ctx: ContentScriptContext): Promise<void> {
  const state: TabState = {
    session: 'IDLE',
    pageVisitId: null,
    recordingAnnounced: false,
    href: location.href,
  };

  let port: ClientPort<TabToSw> | null = null;
  const post = (msg: TabToSw) => {
    try {
      port?.post(msg);
    } catch (err) {
      console.error('[rt:content] post failed', msg.type, err);
    }
  };

  const overlay = await Overlay.mount(ctx, {
    onPointShown: (index, vx, vy, t) => post({ type: 'CALIB_POINT_SHOWN', index, vx, vy, t }),
    onPointDone: (index) => post({ type: 'CALIB_POINT_DONE', index }),
    onSequenceDone: (mode) => post({ type: 'CALIB_SEQUENCE_DONE', mode }),
    onCancelled: () => post({ type: 'CALIB_CANCELLED' }),
    onInstructionsAck: () => post({ type: 'INSTRUCTIONS_ACK' }),
  });
  const isOverlayEl = (el: Element) => overlay.contains(el);

  const aois = new AoiHarvester(ctx, {
    getPageVisitId: () => state.pageVisitId,
    isExcluded: isOverlayEl,
    onAois: (pageVisitId, list) => post({ type: 'AOIS', pageVisitId, aois: list }),
  });

  const enricher = new SampleEnricher(ctx, {
    isOverlayElement: isOverlayEl,
    aoiIdAt: (px, py) => aois.hitTest(px, py),
    onBatch: (samples) => {
      if (state.pageVisitId) post({ type: 'SAMPLES_BATCH', pageVisitId: state.pageVisitId, samples });
    },
  });

  const scrollStop = createScrollStopWatcher(ctx, {
    isExcluded: isOverlayEl,
    onStop: (info) => {
      post({ type: 'SCROLL_STOP', info });
      aois.request();
    },
  });
  ctx.addEventListener(window, 'load', () => aois.request());

  const geometry = startGeometryWatch(ctx, (before, after) => post({ type: 'GEOMETRY_CHANGED', before, after }));

  const sendTabReady = () => {
    enricher.flush();
    post({
      type: 'TAB_READY',
      url: location.href,
      title: safeTitle(),
      geometry: readGeometry(),
      docSize: readDocSize(),
      viewport: readViewport(),
    });
    // The SW now holds this geometry; future GEOMETRY_CHANGED diffs start from it.
    geometry.rebase();
    scrollStop.kickoff();
  };

  // SPA navigation → new PageVisit on the SW side.
  const onNavigated = () => {
    enricher.flush();
    enricher.reset();
    aois.reset();
    // Samples are attributed to the new visit only once the SW tells us its id.
    state.pageVisitId = null;
    sendTabReady();
  };
  const checkLocation = () => {
    if (location.href === state.href) return;
    state.href = location.href;
    onNavigated();
  };
  const scheduleLocationCheck = () => {
    ctx.setTimeout(checkLocation, 0);
  };
  ctx.addEventListener(window, 'popstate', scheduleLocationCheck);
  ctx.addEventListener(window, 'hashchange', scheduleLocationCheck);
  ctx.addEventListener(window, 'wxt:locationchange', scheduleLocationCheck);
  patchHistory(ctx, scheduleLocationCheck);

  ctx.addEventListener(
    document,
    'click',
    (e: MouseEvent) => {
      try {
        if (overlay.contains(e.target)) return;
        const vx = Math.round(e.clientX);
        const vy = Math.round(e.clientY);
        const target = e.target instanceof Element ? e.target : null;
        post({
          type: 'CLICK',
          t: Date.now(),
          vx,
          vy,
          px: vx + Math.round(window.scrollX),
          py: vy + Math.round(window.scrollY),
          selector: target ? compactSelector(target) : null,
        });
      } catch (err) {
        console.error('[rt:content] click handler failed', err);
      }
    },
    { capture: true, passive: true },
  );

  ctx.addEventListener(document, 'visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    if (hidden) enricher.flush();
    post({ type: 'VISIBILITY', hidden });
  });
  ctx.addEventListener(window, 'pagehide', () => enricher.flush());

  const onSessionState = (msg: Extract<SwToTab, { type: 'SESSION_STATE' }>) => {
    if (msg.pageVisitId && msg.pageVisitId !== state.pageVisitId) {
      enricher.flush();
      state.pageVisitId = msg.pageVisitId;
      aois.request();
    }
    const prev = state.session;
    state.session = msg.state;
    if (prev === 'RECORDING' && msg.state !== 'RECORDING') enricher.flush();

    switch (msg.state) {
      case 'IDLE':
      case 'READY':
        state.recordingAnnounced = false;
        break;
      case 'RECORDING':
        if (!state.recordingAnnounced) {
          state.recordingAnnounced = true;
          overlay.toast(i18n.t('overlay.recording_started'), 'success');
        }
        // Capture the initial view even if the participant never scrolls
        // (the SW only stores tiles while RECORDING, so earlier scroll-stops were dropped).
        if (prev !== 'RECORDING') scrollStop.kickoff();
        break;
      case 'PAUSED':
        if (msg.reason === 'wrong-tab') overlay.toast(i18n.t('overlay.wrong_tab'), 'warn', TOAST_WARN_MS);
        else if (msg.reason === 'geometry') overlay.toast(i18n.t('overlay.geometry_changed'), 'warn', TOAST_WARN_MS);
        break;
      case 'DONE':
        overlay.toast(i18n.t('overlay.session_done'), 'info', TOAST_DONE_MS);
        break;
      default:
        break;
    }
  };

  const handle = (msg: SwToTab) => {
    switch (msg.type) {
      case 'OVERLAY_SHOW_TARGETS':
        overlay.showTargets(msg.mode, msg.points, msg.dwellMs);
        break;
      case 'OVERLAY_REPEAT_TARGETS':
        overlay.repeatTargets(msg.indices);
        break;
      case 'OVERLAY_HIDE':
        overlay.hide();
        break;
      case 'OVERLAY_MESSAGE':
        overlay.toast(msg.text, msg.kind, msg.ttlMs ?? undefined);
        break;
      case 'OVERLAY_INSTRUCTIONS':
        overlay.showInstructions(msg.title || i18n.t('overlay.instructions_title'), msg.body, msg.buttonLabel);
        break;
      case 'SESSION_STATE':
        onSessionState(msg);
        break;
      case 'GAZE':
        overlay.moveGazeDot(msg.gaze.vx, msg.gaze.vy);
        if (state.session === 'RECORDING' && state.pageVisitId) enricher.push(msg.gaze);
        break;
      case 'GAZE_DOT':
        overlay.setGazeDotVisible(msg.visible);
        break;
      case 'HARVEST_AOIS':
        aois.setStudySelectors(msg.selectors ?? []);
        aois.request(true);
        break;
      case 'CALIB_PROGRESS':
        overlay.reportProgress(msg.index, msg.validFrames, msg.needed);
        break;
      case 'PREPARE_CAPTURE':
        void overlay.prepareCapture().then(() => post({ type: 'CAPTURE_READY' }));
        break;
      case 'CAPTURE_DONE':
        overlay.captureDone();
        break;
      case 'FACE_LOST':
        overlay.showFaceLost();
        break;
      case 'FACE_FOUND':
        overlay.showFaceFound();
        break;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  };

  port = connectPort<TabToSw, SwToTab>(PORT_TAB, {
    onMessage: (msg) => {
      try {
        handle(msg);
      } catch (err) {
        console.error('[rt:content] message handler failed', (msg as { type?: string })?.type, err);
      }
    },
    // onConnect fires synchronously inside connectPort(), before `port` is assigned.
    onConnect: () => queueMicrotask(sendTabReady),
  });

  ctx.onInvalidated(() => {
    try {
      enricher.flush();
      port?.disconnect();
    } catch {
      /* extension is going away */
    }
  });
}

function safeTitle(): string {
  try {
    return document.title ?? '';
  } catch {
    return '';
  }
}

/**
 * Best-effort hook on history.pushState/replaceState. Content scripts live in
 * an isolated world, so this only observes calls made from this world; the
 * page's own calls are caught by `wxt:locationchange` (Navigation API) and
 * popstate/hashchange.
 */
function patchHistory(ctx: ContentScriptContext, onChange: () => void): void {
  const h = window.history;
  const origPush = h.pushState;
  const origReplace = h.replaceState;
  const wrap = (orig: typeof h.pushState) =>
    function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = orig.apply(this, args);
      onChange();
      return result;
    };
  try {
    h.pushState = wrap(origPush);
    h.replaceState = wrap(origReplace);
  } catch {
    return;
  }
  ctx.onInvalidated(() => {
    try {
      h.pushState = origPush;
      h.replaceState = origReplace;
    } catch {
      /* ignore */
    }
  });
}
