/**
 * Session controller (service worker). Owns the session state machine, the
 * port hub between offscreen engine / content script / side panel, screenshot
 * capture and all IndexedDB writes.
 */
import {
  calibrationTargets,
  compareGeometry,
  decodeStudyCode,
  quickTargets,
  shuffle,
  studyMatchPattern,
  studyOrigin,
  validationTargets,
  type Target,
} from '@red-tracking/core';
import {
  PORT_ENGINE,
  PORT_PANEL,
  PORT_TAB,
  type AOI,
  type CalibrationModelRecord,
  type DeviceInfo,
  type EngineStatus,
  type EngineToSw,
  type EnrichedSample,
  type NormPoint,
  type PageVisit,
  type PanelSnapshot,
  type PanelToSw,
  type PauseReason,
  type RuntimeRequest,
  type RuntimeResponse,
  type SampleChunk,
  type ScreenshotTile,
  type ScrollStopInfo,
  type Session,
  type SessionEventKind,
  type SessionState,
  type Study,
  type SwToEngine,
  type SwToPanel,
  type SwToTab,
  type TabToSw,
  type ValidationResult,
  type WindowGeometry,
} from '@red-tracking/protocol';
import { browser, type Browser } from 'wxt/browser';
import { i18n } from '#i18n';
import { getDb, getSetting, setSetting } from '../db';
import { uid } from '../ids';
import { onPort, safePost, type Port } from '../ports';
import { localize, uiLocale } from '../text';
import { extUrl, reportUrl } from '../urls';
import { ChunkBuilder } from './chunks';
import { TileCapturer } from './screenshots';

const CONTENT_SCRIPT_ID = 'rt-content';
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';
const CALIB_DWELL_MS = 1200;
const FACE_LOST_PAUSE_MS = 3000;
const IDLE_ENGINE_STOP_MS = 90_000;
const MAX_CALIB_ATTEMPTS = 3;

interface PersistedState {
  study: Study | null;
  session: Session | null;
  sessionState: SessionState;
  pauseReason?: string;
  targetTabId: number | null;
  windowId: number | null;
  currentPageVisitId: string | null;
  calibration: CalibrationModelRecord | null;
  hostGranted: boolean;
  debugGazeDot: boolean;
  recordedMs: number;
  recordingSince: number | null;
}

type CalibMode = 'full' | 'quick';

export class SessionController {
  private st: PersistedState = {
    study: null,
    session: null,
    sessionState: 'IDLE',
    targetTabId: null,
    windowId: null,
    currentPageVisitId: null,
    calibration: null,
    hostGranted: false,
    debugGazeDot: false,
    recordedMs: 0,
    recordingSince: null,
  };
  private engineStatus: EngineStatus = { state: 'stopped', fps: 0, delegate: null, faceDetected: false, hasModel: false };
  private cameraGranted = false;
  /** Participant-controlled master switch (persisted). */
  private cameraEnabled = true;
  private deviceId: string | null = null;
  private fakeCamera = false;
  private warnings: string[] = [];

  private enginePort: Port | null = null;
  private panelPorts = new Set<Port>();
  private tabPorts = new Map<number, Port>();
  private previewSubscribers = 0;

  private chunks: ChunkBuilder | null = null;
  private currentVisit: PageVisit | null = null;
  private currentViewport = { w: 0, h: 0 };
  private currentGeometry: WindowGeometry | null = null;
  private calibTargets: Target[] = [];
  private calibMode: CalibMode = 'full';
  private calibAttempts = 0;
  private awaitingInstructions = false;
  private faceLostTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private captureResolve: (() => void) | null = null;
  private readonly capturer: TileCapturer;
  private ready: Promise<void>;

  constructor() {
    this.capturer = new TileCapturer(
      () => this.st.windowId,
      () => this.prepareCapture(),
      () => this.sendTab({ type: 'CAPTURE_DONE' }),
      (tile) => this.storeTile(tile),
      (message) => {
        this.log('error', { capture: message });
        const w = i18n.t('panel.capture_failed', [message.slice(0, 80)]);
        if (!this.warnings.includes(w)) {
          this.warnings.push(w);
          this.broadcastSnapshot();
        }
      },
    );
    this.registerListeners();
    this.ready = this.init();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  private async init(): Promise<void> {
    this.cameraGranted = await getSetting('cameraGranted', false);
    this.deviceId = await getSetting<string | null>('deviceId', null);
    this.cameraEnabled = await getSetting('cameraEnabled', true);
    this.fakeCamera = (await getSetting('fakeCamera', false)) || import.meta.env.WXT_FAKE_CAMERA === '1';
    if (this.fakeCamera) this.cameraGranted = true;
    this.st.debugGazeDot = await getSetting('debugGazeDot', false);
    const saved = (await browser.storage.session.get('state'))['state'] as PersistedState | undefined;
    if (saved) this.st = { ...this.st, ...saved };
    if (!this.st.study) {
      const db = await getDb();
      const studies = await db.getAllFromIndex('studies', 'byCreated');
      const activeId = await getSetting<string | null>('activeStudyId', null);
      this.st.study = studies.find((s) => s.id === activeId) ?? null;
    }
    if (this.cameraGranted && (this.isSessionActive() || this.previewSubscribers > 0)) {
      void this.ensureEngine();
    }
    if (this.isSessionActive() && this.st.targetTabId !== null) {
      // SW restarted mid-session: the content script/engine ports will reconnect on their own.
      this.log('state', { recovered: this.st.sessionState });
    }
    this.updateActionBadge();
  }

  private registerListeners(): void {
    onPort({
      [PORT_ENGINE]: (p) => this.attachEngine(p),
      [PORT_PANEL]: (p) => this.attachPanel(p),
      [PORT_TAB]: (p) => this.attachTab(p),
    });

    browser.runtime.onMessage.addListener((msg: RuntimeRequest, sender, sendResponse) => {
      void this.ready.then(() => this.handleRuntime(msg, sender)).then(
        (data) => sendResponse({ ok: true, data } satisfies RuntimeResponse),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies RuntimeResponse),
      );
      return true;
    });

    browser.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') void this.openOnboarding();
    });

    browser.action.onClicked.addListener(async (tab) => {
      await this.ready;
      // While a session runs the toolbar icon is the "stop" button (works with the side panel closed).
      if (this.isSessionActive()) {
        await this.finalize('action-click');
        return;
      }
      if (!this.cameraGranted) {
        await this.openOnboarding();
        return;
      }
      if (tab.windowId !== undefined) {
        try {
          await browser.sidePanel.open({ windowId: tab.windowId });
        } catch (err) {
          console.warn('[rt:sw] sidePanel.open failed', err);
        }
      }
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      this.tabPorts.delete(tabId);
      if (tabId === this.st.targetTabId && this.isSessionActive()) void this.finalize('tab-closed');
    });

    browser.tabs.onActivated.addListener(({ tabId }) => {
      if (!this.isSessionActive() || this.st.targetTabId === null) return;
      if (tabId !== this.st.targetTabId) this.pause('wrong-tab');
      else if (this.st.sessionState === 'PAUSED' && this.st.pauseReason === 'wrong-tab') this.resume();
    });

    browser.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId !== this.st.targetTabId || !change.url || !this.st.study) return;
      try {
        if (new URL(change.url).origin !== studyOrigin(this.st.study)) {
          this.pause('wrong-tab');
          this.sendPanels({ type: 'ERROR', message: i18n.t('overlay.wrong_tab') });
        }
      } catch {
        /* ignore */
      }
    });
  }

  // ---------------------------------------------------------------------
  // Ports
  // ---------------------------------------------------------------------

  private attachEngine(port: Port): void {
    this.enginePort = port;
    port.onMessage.addListener((m) => void this.onEngine(m as EngineToSw));
    port.onDisconnect.addListener(() => {
      if (this.enginePort === port) this.enginePort = null;
      this.engineStatus = { ...this.engineStatus, state: 'stopped', fps: 0 };
      this.broadcastSnapshot();
    });
    // (Re)start the camera and restore the model after an engine (re)connect.
    void this.ready.then(() => {
      if (this.enginePort !== port) return;
      if (!this.cameraEnabled) {
        this.sendEngine({ type: 'ENGINE_STOP' });
        return;
      }
      this.sendEngine({ type: 'ENGINE_START', deviceId: this.deviceId ?? undefined, fake: this.fakeCamera ? { fixture: 'synthetic' } : undefined });
      if (this.st.calibration) this.sendEngine({ type: 'LOAD_MODEL', record: this.st.calibration });
      if (this.previewSubscribers > 0) this.sendEngine({ type: 'PREVIEW_SUBSCRIBE', fps: 15 });
    });
  }

  private attachPanel(port: Port): void {
    this.panelPorts.add(port);
    let subscribed = false;
    port.onMessage.addListener((m) => {
      const msg = m as PanelToSw;
      if (msg.type === 'PREVIEW_SUBSCRIBE' && !subscribed) {
        subscribed = true;
        this.previewSubscribers++;
      } else if (msg.type === 'PREVIEW_UNSUBSCRIBE' && subscribed) {
        subscribed = false;
        this.previewSubscribers = Math.max(0, this.previewSubscribers - 1);
      }
      void this.ready.then(() => this.onPanel(msg, port));
    });
    port.onDisconnect.addListener(() => {
      this.panelPorts.delete(port);
      if (subscribed) this.previewSubscribers = Math.max(0, this.previewSubscribers - 1);
      this.updatePreviewSubscription();
      this.scheduleIdleStop();
    });
    this.clearIdleStop();
    void this.ready.then(() => safePost(port, { type: 'SNAPSHOT', snapshot: this.snapshot() } satisfies SwToPanel));
  }

  private attachTab(port: Port): void {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) {
      port.disconnect();
      return;
    }
    this.tabPorts.set(tabId, port);
    port.onMessage.addListener((m) => void this.ready.then(() => this.onTab(m as TabToSw, tabId)));
    port.onDisconnect.addListener(() => {
      if (this.tabPorts.get(tabId) === port) this.tabPorts.delete(tabId);
    });
  }

  private sendEngine(msg: SwToEngine): void {
    safePost(this.enginePort, msg);
  }

  private sendTab(msg: SwToTab): void {
    if (this.st.targetTabId === null) return;
    safePost(this.tabPorts.get(this.st.targetTabId), msg);
  }

  private sendPanels(msg: SwToPanel): void {
    for (const p of this.panelPorts) safePost(p, msg);
  }

  private broadcastSnapshot(): void {
    this.sendPanels({ type: 'SNAPSHOT', snapshot: this.snapshot() });
    void this.persist();
  }

  private snapshot(): PanelSnapshot {
    return {
      sessionState: this.st.sessionState,
      pauseReason: this.st.pauseReason,
      study: this.st.study,
      session: this.st.session,
      engine: this.engineStatus,
      validation: this.st.session?.validation ?? null,
      calibration: this.st.calibration,
      recordedMs: this.recordedMs(),
      cameraGranted: this.cameraGranted,
      cameraEnabled: this.cameraEnabled,
      deviceId: this.deviceId,
      hostGranted: this.st.hostGranted,
      targetTabId: this.st.targetTabId,
      warnings: this.warnings,
      debugGazeDot: this.st.debugGazeDot,
    };
  }

  private async persist(): Promise<void> {
    try {
      await browser.storage.session.set({ state: this.st });
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // Engine lifecycle
  // ---------------------------------------------------------------------

  private async ensureEngine(): Promise<void> {
    if (!this.cameraEnabled) return;
    if (!this.cameraGranted && !this.fakeCamera) return;
    const has = await browser.offscreen.hasDocument();
    if (!has) {
      const url = extUrl('/offscreen.html', this.fakeCamera ? { fake: '1' } : undefined);
      try {
        await browser.offscreen.createDocument({
          url,
          reasons: ['USER_MEDIA'],
          justification: 'Runs on-device face landmark detection on the webcam stream for gaze estimation.',
        });
      } catch (err) {
        // Another call may have created it concurrently.
        if (!(await browser.offscreen.hasDocument())) throw err;
      }
    } else if (this.enginePort && this.engineStatus.state === 'stopped') {
      this.sendEngine({ type: 'ENGINE_START', deviceId: this.deviceId ?? undefined, fake: this.fakeCamera ? { fixture: 'synthetic' } : undefined });
    }
  }

  private updatePreviewSubscription(): void {
    if (this.previewSubscribers > 0) {
      this.clearIdleStop();
      void this.ensureEngine().then(() => this.sendEngine({ type: 'PREVIEW_SUBSCRIBE', fps: 15 }));
    } else {
      this.sendEngine({ type: 'PREVIEW_UNSUBSCRIBE' });
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleStop();
    if (this.previewSubscribers > 0 || this.isSessionActive()) return;
    this.idleTimer = setTimeout(async () => {
      if (this.previewSubscribers > 0 || this.isSessionActive()) return;
      this.sendEngine({ type: 'ENGINE_STOP' });
      try {
        if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument();
      } catch {
        /* ignore */
      }
    }, IDLE_ENGINE_STOP_MS);
  }

  private clearIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ---------------------------------------------------------------------
  // Runtime (one-shot) requests
  // ---------------------------------------------------------------------

  private async handleRuntime(msg: RuntimeRequest, sender: Browser.runtime.MessageSender): Promise<unknown> {
    switch (msg.type) {
      case 'PERMISSION_GRANTED': {
        this.cameraGranted = true;
        this.cameraEnabled = true;
        await setSetting('cameraEnabled', true);
        this.deviceId = msg.deviceId;
        await setSetting('cameraGranted', true);
        await setSetting('deviceId', msg.deviceId);
        await this.ensureEngine();
        if (this.enginePort) this.sendEngine({ type: 'ENGINE_START', deviceId: msg.deviceId ?? undefined, fake: this.fakeCamera ? { fixture: 'synthetic' } : undefined });
        this.broadcastSnapshot();
        return null;
      }
      case 'OPEN_SIDE_PANEL': {
        const windowId = sender.tab?.windowId ?? (await browser.windows.getCurrent()).id;
        if (windowId !== undefined) await browser.sidePanel.open({ windowId });
        return null;
      }
      case 'OPEN_ONBOARDING':
        await this.openOnboarding();
        return null;
      case 'GET_SNAPSHOT':
        return this.snapshot();
      case 'JOIN_STUDY':
        await this.joinStudy(msg.code);
        return this.st.study;
      case 'OPEN_REPORT':
        await browser.tabs.create({ url: reportUrl(msg.sessionId) });
        return null;
    }
  }

  private async openOnboarding(): Promise<void> {
    await browser.tabs.create({ url: extUrl('/onboarding.html') });
  }

  // ---------------------------------------------------------------------
  // Panel messages
  // ---------------------------------------------------------------------

  private async onPanel(msg: PanelToSw, port: Port): Promise<void> {
    switch (msg.type) {
      case 'GET_SNAPSHOT':
        safePost(port, { type: 'SNAPSHOT', snapshot: this.snapshot() } satisfies SwToPanel);
        break;
      case 'PREVIEW_SUBSCRIBE':
      case 'PREVIEW_UNSUBSCRIBE':
        this.updatePreviewSubscription();
        break;
      case 'JOIN_STUDY':
        try {
          await this.joinStudy(msg.code);
        } catch (err) {
          safePost(port, { type: 'ERROR', message: i18n.t('panel.study_invalid') } satisfies SwToPanel);
          console.warn('[rt:sw] join failed', err);
        }
        break;
      case 'LEAVE_STUDY':
        if (!this.isSessionActive()) {
          this.st.study = null;
          await setSetting('activeStudyId', null);
          this.broadcastSnapshot();
        }
        break;
      case 'START_SESSION':
        await this.startSession(msg.hostGranted);
        break;
      case 'STOP_SESSION':
        await this.finalize('user');
        break;
      case 'RECALIBRATE':
        if (this.isSessionActive() && this.currentVisit) {
          this.pauseRecording();
          await this.beginCalibration('full');
        }
        break;
      case 'RESUME_SESSION':
        if (this.st.sessionState === 'PAUSED') this.resume();
        break;
      case 'SET_DEBUG_GAZE_DOT':
        this.st.debugGazeDot = msg.visible;
        await setSetting('debugGazeDot', msg.visible);
        if (this.st.sessionState === 'RECORDING') this.sendTab({ type: 'GAZE_DOT', visible: this.gazeDotVisible() });
        this.broadcastSnapshot();
        break;
      case 'SET_CAMERA_ENABLED':
        await this.setCameraEnabled(msg.enabled);
        break;
      case 'ENGINE_RESTART':
        if (!this.cameraEnabled) break;
        if (msg.deviceId) {
          this.deviceId = msg.deviceId;
          await setSetting('deviceId', msg.deviceId);
        }
        this.sendEngine({ type: 'ENGINE_STOP' });
        this.sendEngine({ type: 'ENGINE_START', deviceId: this.deviceId ?? undefined, fake: this.fakeCamera ? { fixture: 'synthetic' } : undefined });
        break;
    }
  }

  /** Master switch from the side panel: off = end any session, stop the camera, close the offscreen document. */
  private async setCameraEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.cameraEnabled) return;
    this.cameraEnabled = enabled;
    await setSetting('cameraEnabled', enabled);
    if (!enabled) {
      if (this.isSessionActive()) await this.finalize('camera-off');
      this.clearIdleStop();
      this.sendEngine({ type: 'ENGINE_STOP' });
      this.engineStatus = { ...this.engineStatus, state: 'stopped', fps: 0, faceDetected: false };
      try {
        if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument();
      } catch {
        /* ignore */
      }
      this.enginePort = null;
    } else {
      await this.ensureEngine();
      if (this.enginePort) {
        this.sendEngine({ type: 'ENGINE_START', deviceId: this.deviceId ?? undefined, fake: this.fakeCamera ? { fixture: 'synthetic' } : undefined });
        if (this.previewSubscribers > 0) this.sendEngine({ type: 'PREVIEW_SUBSCRIBE', fps: 15 });
      }
    }
    this.broadcastSnapshot();
  }

  private async joinStudy(code: string): Promise<void> {
    const study = decodeStudyCode(code);
    const db = await getDb();
    await db.put('studies', study);
    await setSetting('activeStudyId', study.id);
    this.st.study = study;
    this.warnings = [];
    if (this.st.sessionState === 'DONE' || this.st.sessionState === 'ERROR') this.st.sessionState = 'IDLE';
    this.broadcastSnapshot();
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  private isSessionActive(): boolean {
    return ['CALIBRATING', 'VALIDATING', 'RECORDING', 'PAUSED', 'FINALIZING'].includes(this.st.sessionState);
  }

  /** Toolbar icon badge + tooltip reflect the session so the participant can stop it from the toolbar. */
  private updateActionBadge(): void {
    const state = this.st.sessionState;
    let text = '';
    let color = '#e63c32';
    let title = i18n.t('ext_name');
    switch (state) {
      case 'RECORDING':
        text = 'REC';
        title = i18n.t('panel.action_stop_title');
        break;
      case 'PAUSED':
        text = 'II';
        color = '#f2b134';
        title = i18n.t('panel.action_stop_title');
        break;
      case 'CALIBRATING':
      case 'VALIDATING':
        text = 'CAL';
        color = '#3b82f6';
        title = i18n.t('panel.action_stop_title');
        break;
      case 'FINALIZING':
        text = '…';
        color = '#8b90a0';
        break;
    }
    void browser.action.setBadgeText({ text }).catch(() => undefined);
    void browser.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
    void browser.action.setBadgeTextColor?.({ color: '#ffffff' })?.catch(() => undefined);
    void browser.action.setTitle({ title }).catch(() => undefined);
  }

  private setState(state: SessionState, reason?: PauseReason | string): void {
    this.st.sessionState = state;
    this.st.pauseReason = reason;
    if (this.st.session) this.st.session.state = state;
    this.updateActionBadge();
    this.log('state', { state, reason });
    this.sendTab({ type: 'SESSION_STATE', state, reason, pageVisitId: this.st.currentPageVisitId ?? undefined });
    this.broadcastSnapshot();
  }

  private async startSession(hostGranted: boolean): Promise<void> {
    const study = this.st.study;
    if (!study) return;
    if (this.isSessionActive()) return;
    if (!hostGranted) {
      this.sendPanels({ type: 'ERROR', message: i18n.t('panel.host_permission_denied') });
      return;
    }
    if (!this.cameraGranted && !this.fakeCamera) {
      this.sendPanels({ type: 'ERROR', message: i18n.t('panel.camera_needed') });
      return;
    }
    this.st.hostGranted = true;
    this.clearIdleStop();
    await this.ensureEngine();

    const pattern = studyMatchPattern(study);
    await this.registerContentScript(pattern);

    const participantId = await this.participantId();
    const session: Session = {
      id: uid('ses'),
      studyId: study.id,
      study,
      participantId,
      state: 'READY',
      createdAt: Date.now(),
      device: await this.deviceInfo(),
      pageVisitIds: [],
      recordedMs: 0,
    };
    const db = await getDb();
    await db.put('sessions', session);
    this.st.session = session;
    this.st.recordedMs = 0;
    this.st.recordingSince = null;
    this.st.calibration = null;
    this.st.currentPageVisitId = null;
    this.currentVisit = null;
    this.chunks = null;
    this.calibAttempts = 0;
    this.warnings = [];
    this.sendEngine({ type: 'CLEAR_MODEL' });

    const tab = await browser.tabs.create({ url: study.targetUrl, active: true });
    this.st.targetTabId = tab.id ?? null;
    this.st.windowId = tab.windowId ?? null;
    // State becomes CALIBRATING once the content script reports TAB_READY.
    this.setState('CALIBRATING');
  }

  private async registerContentScript(pattern: string): Promise<void> {
    try {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      if (existing.length) await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch {
      /* none registered */
    }
    await browser.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: [CONTENT_SCRIPT_FILE],
        matches: [pattern],
        runAt: 'document_idle',
        persistAcrossSessions: false,
      },
    ]);
  }

  /** Drop the broad host grant needed by captureVisibleTab once the session is over. */
  private async releaseHostPermissions(): Promise<void> {
    if (import.meta.env.WXT_E2E === '1') return; // e2e builds grant it via the manifest
    try {
      await browser.permissions.remove({ origins: ['<all_urls>'] });
    } catch {
      /* ignore */
    }
  }

  private async unregisterContentScript(): Promise<void> {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch {
      /* ignore */
    }
  }

  private async participantId(): Promise<string> {
    let id = await getSetting<string | null>('participantId', null);
    if (!id) {
      id = uid('p');
      await setSetting('participantId', id);
    }
    return id;
  }

  private async deviceInfo(): Promise<DeviceInfo> {
    const info: DeviceInfo = {
      ua: navigator.userAgent,
      platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? 'unknown',
      screenW: 0,
      screenH: 0,
      dpr: 1,
      language: uiLocale(),
    };
    return info;
  }

  // ---------------------------------------------------------------------
  // Tab messages
  // ---------------------------------------------------------------------

  private async onTab(msg: TabToSw, tabId: number): Promise<void> {
    if (tabId !== this.st.targetTabId) return; // ignore stray tabs
    switch (msg.type) {
      case 'TAB_READY':
        await this.onTabReady(msg);
        break;
      case 'CALIB_POINT_SHOWN':
        this.sendEngine(this.st.sessionState === 'VALIDATING'
          ? { type: 'VALIDATE_POINT_SHOWN', index: msg.index, vx: msg.vx, vy: msg.vy, t: msg.t }
          : { type: 'CALIB_POINT_SHOWN', index: msg.index, vx: msg.vx, vy: msg.vy, t: msg.t });
        break;
      case 'CALIB_POINT_DONE':
        this.sendEngine(this.st.sessionState === 'VALIDATING'
          ? { type: 'VALIDATE_POINT_DONE', index: msg.index }
          : { type: 'CALIB_POINT_DONE', index: msg.index });
        break;
      case 'CALIB_SEQUENCE_DONE':
        if (msg.mode === 'calibration') this.sendEngine({ type: 'CALIB_FIT' });
        else this.sendEngine({ type: 'VALIDATE_FINISH' });
        break;
      case 'CALIB_CANCELLED':
        this.sendEngine({ type: 'CALIB_CANCEL' });
        if (this.st.calibration) {
          // Cancelled a recalibration → go back to recording with the old model.
          this.sendEngine({ type: 'LOAD_MODEL', record: this.st.calibration });
          this.startRecording();
        } else {
          await this.finalize('user');
        }
        break;
      case 'INSTRUCTIONS_ACK':
        if (this.awaitingInstructions) {
          this.awaitingInstructions = false;
          this.startRecording();
        }
        break;
      case 'SAMPLES_BATCH':
        await this.onSamples(msg.pageVisitId, msg.samples);
        break;
      case 'SCROLL_STOP':
        this.onScrollStop(msg.info);
        break;
      case 'GEOMETRY_CHANGED':
        await this.onGeometryChanged(msg.after);
        break;
      case 'AOIS':
        await this.onAois(msg.pageVisitId, msg.aois);
        break;
      case 'CLICK':
        this.log('click', { t: msg.t, px: msg.px, py: msg.py, selector: msg.selector });
        if (this.st.study?.calibration.clickRefinement && this.st.sessionState === 'RECORDING') {
          this.sendEngine({ type: 'CLICK_LABEL', t: msg.t, vx: msg.vx, vy: msg.vy });
        }
        break;
      case 'VISIBILITY':
        if (!this.isSessionActive()) break;
        if (msg.hidden) this.pause('tab-hidden');
        else if (this.st.sessionState === 'PAUSED' && this.st.pauseReason === 'tab-hidden') this.resume();
        break;
      case 'CAPTURE_READY':
        this.captureResolve?.();
        this.captureResolve = null;
        break;
      case 'STOP_REQUESTED':
        await this.finalize('user');
        break;
    }
  }

  private async onTabReady(msg: Extract<TabToSw, { type: 'TAB_READY' }>): Promise<void> {
    if (!this.st.session) return;
    this.currentViewport = msg.viewport;
    this.currentGeometry = msg.geometry;
    if (this.st.session.device.screenW === 0) {
      this.st.session.device = { ...this.st.session.device, screenW: msg.geometry.screenW, screenH: msg.geometry.screenH, dpr: msg.geometry.dpr };
    }
    const narrow = msg.viewport.w < 900 || msg.viewport.h < 500;
    const narrowMsg = i18n.t('panel.narrow_viewport');
    if (narrow && !this.warnings.includes(narrowMsg)) this.warnings.push(narrowMsg);
    if (!narrow) this.warnings = this.warnings.filter((w) => w !== narrowMsg);
    const sameVisit = this.currentVisit && this.currentVisit.url === msg.url && !this.currentVisit.tEnd;
    if (!sameVisit) await this.openPageVisit(msg.url, msg.title, msg.viewport, msg.docSize);

    switch (this.st.sessionState) {
      case 'CALIBRATING':
        if (!this.st.calibration || this.calibTargets.length === 0) await this.beginCalibration('full');
        else this.pushCalibrationOverlay();
        break;
      case 'VALIDATING':
        if (this.awaitingInstructions) this.showInstructions();
        else this.beginValidation();
        break;
      case 'RECORDING':
      case 'PAUSED':
        // Navigation inside the study site: keep recording on the new page.
        this.sendTab({ type: 'SESSION_STATE', state: this.st.sessionState, reason: this.st.pauseReason, pageVisitId: this.st.currentPageVisitId ?? undefined });
        this.sendTab({ type: 'GAZE_DOT', visible: this.gazeDotVisible() });
        this.sendTab({ type: 'HARVEST_AOIS', selectors: this.st.study?.aoiSelectors ?? [] });
        break;
      default:
        break;
    }
  }

  private async openPageVisit(url: string, title: string, viewport: { w: number; h: number }, docSize: { w: number; h: number }): Promise<void> {
    await this.closePageVisit();
    const session = this.st.session!;
    const visit: PageVisit = { id: uid('pv'), sessionId: session.id, url, title, tStart: Date.now(), viewport, docSize };
    const db = await getDb();
    await db.put('pageVisits', visit);
    session.pageVisitIds.push(visit.id);
    await db.put('sessions', session);
    this.currentVisit = visit;
    this.st.currentPageVisitId = visit.id;
    this.chunks = new ChunkBuilder(session.id, visit.id, (c) => this.storeChunk(c));
    this.log('page-visit', { url, title });
    void this.persist();
  }

  private async closePageVisit(): Promise<void> {
    if (!this.currentVisit) return;
    await this.chunks?.flush();
    this.currentVisit.tEnd = Date.now();
    const db = await getDb();
    await db.put('pageVisits', this.currentVisit);
    this.currentVisit = null;
    this.chunks = null;
  }

  // ---------------------------------------------------------------------
  // Calibration & validation
  // ---------------------------------------------------------------------

  private async beginCalibration(mode: CalibMode): Promise<void> {
    if (!this.st.session || !this.st.study || !this.currentGeometry) return;
    this.calibMode = mode;
    const vp = this.currentViewport;
    const targets = mode === 'quick' ? quickTargets(vp) : calibrationTargets(this.st.study.calibration.points, vp);
    this.calibTargets = shuffle(targets);
    this.awaitingInstructions = false;
    this.sendEngine({
      type: 'CALIB_BEGIN',
      sessionId: this.st.session.id,
      targets: this.calibTargets,
      geometry: this.currentGeometry,
      reusePreviousWeight: mode === 'quick' ? 0.5 : undefined,
    });
    if (this.st.sessionState !== 'CALIBRATING') this.setState('CALIBRATING');
    this.pushCalibrationOverlay();
  }

  private pushCalibrationOverlay(): void {
    this.sendTab({ type: 'OVERLAY_SHOW_TARGETS', mode: 'calibration', points: this.normalize(this.calibTargets), dwellMs: CALIB_DWELL_MS });
  }

  private beginValidation(): void {
    if (!this.st.study) return;
    const targets = shuffle(validationTargets(this.currentViewport));
    this.sendEngine({
      type: 'VALIDATE_BEGIN',
      targets,
      passPx: this.st.study.calibration.validationPassPx,
      failPx: this.st.study.calibration.validationFailPx,
    });
    this.setState('VALIDATING');
    this.sendTab({ type: 'OVERLAY_SHOW_TARGETS', mode: 'validation', points: this.normalize(targets), dwellMs: CALIB_DWELL_MS });
  }

  private normalize(targets: Target[]): NormPoint[] {
    const { w, h } = this.currentViewport;
    return targets.map((t) => ({ index: t.index, nx: w ? t.vx / w : 0.5, ny: h ? t.vy / h : 0.5 }));
  }

  private showInstructions(): void {
    const study = this.st.study;
    if (!study) return;
    this.awaitingInstructions = true;
    const locale = study.locale ?? uiLocale();
    this.sendTab({
      type: 'OVERLAY_INSTRUCTIONS',
      title: i18n.t('overlay.instructions_title'),
      body: localize(study.instructions, locale),
      buttonLabel: i18n.t('overlay.instructions_start'),
    });
  }

  // ---------------------------------------------------------------------
  // Engine messages
  // ---------------------------------------------------------------------

  private async onEngine(msg: EngineToSw): Promise<void> {
    switch (msg.type) {
      case 'ENGINE_STATUS':
        this.engineStatus = msg.status;
        this.broadcastSnapshot();
        break;
      case 'PING':
        break;
      case 'PREVIEW':
        this.sendPanels({ type: 'PREVIEW', frame: msg.frame });
        break;
      case 'GAZE':
        if (this.st.sessionState === 'RECORDING' || this.st.sessionState === 'PAUSED' || this.st.debugGazeDot) {
          this.sendTab({ type: 'GAZE', gaze: msg.gaze });
        }
        break;
      case 'CALIB_PROGRESS':
        this.sendTab({ type: 'CALIB_PROGRESS', index: msg.index, validFrames: msg.validFrames, needed: msg.needed });
        this.sendPanels({ type: 'CALIB_PROGRESS', index: msg.index, validFrames: msg.validFrames, needed: msg.needed });
        break;
      case 'CALIB_RESULT':
        await this.onCalibResult(msg);
        break;
      case 'VALIDATION_RESULT':
        await this.onValidationResult(msg.result, msg.record);
        break;
      case 'FACE_LOST':
        this.sendTab({ type: 'FACE_LOST' });
        if (this.st.sessionState === 'RECORDING' && !this.faceLostTimer) {
          this.faceLostTimer = setTimeout(() => {
            this.faceLostTimer = null;
            if (this.st.sessionState === 'RECORDING') this.pause('face-lost');
          }, FACE_LOST_PAUSE_MS);
        }
        this.log('face-lost');
        break;
      case 'FACE_FOUND':
        this.sendTab({ type: 'FACE_FOUND' });
        if (this.faceLostTimer) clearTimeout(this.faceLostTimer);
        this.faceLostTimer = null;
        if (this.st.sessionState === 'PAUSED' && this.st.pauseReason === 'face-lost') this.resume();
        this.log('face-found');
        break;
      case 'HEAD_DRIFT':
        this.sendPanels({ type: 'HEAD_DRIFT', severity: msg.severity });
        this.log('head-drift', { dYaw: msg.dYaw, dPitch: msg.dPitch, dTz: msg.dTz, severity: msg.severity });
        break;
    }
  }

  private async onCalibResult(msg: Extract<EngineToSw, { type: 'CALIB_RESULT' }>): Promise<void> {
    if (!msg.ok) {
      this.calibAttempts++;
      if (msg.repeatIndices?.length && this.calibAttempts < MAX_CALIB_ATTEMPTS) {
        this.sendTab({ type: 'OVERLAY_REPEAT_TARGETS', indices: msg.repeatIndices });
        return;
      }
      if (this.calibAttempts < MAX_CALIB_ATTEMPTS) {
        await this.beginCalibration(this.calibMode);
        return;
      }
      this.warnings.push(msg.error ?? 'CALIBRATION_FAILED');
      this.sendPanels({ type: 'ERROR', message: i18n.t('panel.validation_fail') });
      this.sendTab({ type: 'OVERLAY_HIDE' });
      if (this.st.calibration) {
        this.sendEngine({ type: 'LOAD_MODEL', record: this.st.calibration });
        this.startRecording();
      } else {
        this.setState('ERROR', msg.error);
      }
      return;
    }
    this.calibAttempts = 0;
    const record = msg.record!;
    await this.storeCalibration(record);
    this.log('calibration', { trainRmsePx: record.trainRmsePx, points: record.points.length, mode: this.calibMode });
    if (this.calibMode === 'quick') {
      this.sendTab({ type: 'OVERLAY_HIDE' });
      this.startRecording();
      return;
    }
    this.beginValidation();
  }

  private async onValidationResult(result: ValidationResult, record: CalibrationModelRecord): Promise<void> {
    await this.storeCalibration(record);
    if (this.st.session) {
      this.st.session.validation = result;
      const db = await getDb();
      await db.put('sessions', this.st.session);
    }
    this.log('validation', result);
    this.sendPanels({ type: 'VALIDATION_RESULT', result });
    if (result.verdict === 'fail' && this.calibAttempts < MAX_CALIB_ATTEMPTS - 1) {
      this.calibAttempts++;
      this.sendTab({ type: 'OVERLAY_MESSAGE', text: i18n.t('panel.validation_fail'), kind: 'warn', ttlMs: 2500 });
      setTimeout(() => void this.beginCalibration('full'), 800);
      return;
    }
    if (result.verdict !== 'pass') this.warnings.push(`validation:${result.verdict}:${Math.round(result.meanErrPx)}px`);
    this.sendTab({ type: 'OVERLAY_HIDE' });
    if (this.st.recordedMs > 0 || this.st.recordingSince) {
      // Recalibration during a session: resume directly.
      this.startRecording();
    } else {
      this.showInstructions();
    }
  }

  private async storeCalibration(record: CalibrationModelRecord): Promise<void> {
    this.st.calibration = record;
    const db = await getDb();
    await db.put('calibrations', record);
    if (this.st.session) {
      this.st.session.calibrationId = record.id;
      await db.put('sessions', this.st.session);
    }
    void this.persist();
  }

  // ---------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------

  private gazeDotVisible(): boolean {
    return !!this.st.study?.showGazeDot || this.st.debugGazeDot;
  }

  private startRecording(): void {
    if (!this.st.session) return;
    if (!this.st.session.startedAt) this.st.session.startedAt = Date.now();
    this.st.recordingSince = Date.now();
    this.setState('RECORDING');
    this.sendTab({ type: 'GAZE_DOT', visible: this.gazeDotVisible() });
    this.sendTab({ type: 'HARVEST_AOIS', selectors: this.st.study?.aoiSelectors ?? [] });
    this.armDurationTimer();
  }

  private pauseRecording(): void {
    if (this.st.recordingSince) {
      this.st.recordedMs += Date.now() - this.st.recordingSince;
      this.st.recordingSince = null;
    }
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
  }

  private pause(reason: PauseReason): void {
    if (this.st.sessionState !== 'RECORDING') return;
    this.pauseRecording();
    this.setState('PAUSED', reason);
    this.sendTab({ type: 'GAZE_DOT', visible: false });
  }

  private resume(): void {
    if (this.st.sessionState !== 'PAUSED') return;
    if (this.faceLostTimer) clearTimeout(this.faceLostTimer);
    this.faceLostTimer = null;
    this.startRecording();
  }

  private recordedMs(): number {
    return this.st.recordedMs + (this.st.recordingSince ? Date.now() - this.st.recordingSince : 0);
  }

  private armDurationTimer(): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    const dur = this.st.study?.durationSec;
    if (!dur) return;
    const remaining = dur * 1000 - this.recordedMs();
    if (remaining <= 0) {
      void this.finalize('duration');
      return;
    }
    this.durationTimer = setTimeout(() => void this.finalize('duration'), remaining);
  }

  private async onSamples(pageVisitId: string, samples: EnrichedSample[]): Promise<void> {
    if (this.st.sessionState !== 'RECORDING' && this.st.sessionState !== 'PAUSED') return;
    if (!this.chunks || this.chunks.pageVisitId !== pageVisitId) return;
    const prefixed = samples.map((s) => (s.aoiId ? { ...s, aoiId: `${pageVisitId}:${s.aoiId}` } : s));
    await this.chunks.add(prefixed);
    const dur = this.st.study?.durationSec;
    if (dur && this.recordedMs() >= dur * 1000) await this.finalize('duration');
  }

  private onScrollStop(info: ScrollStopInfo): void {
    if (this.st.sessionState !== 'RECORDING' || !this.st.session || !this.currentVisit) return;
    this.currentViewport = info.viewport;
    if (info.docSize.w > this.currentVisit.docSize.w || info.docSize.h > this.currentVisit.docSize.h) {
      this.currentVisit.docSize = info.docSize;
      void getDb().then((db) => db.put('pageVisits', this.currentVisit!));
    }
    this.log('scroll-stop', { scrollX: info.scrollX, scrollY: info.scrollY });
    this.capturer.request(info, this.st.session.id, this.currentVisit.id);
  }

  private prepareCapture(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.captureResolve = null;
        resolve();
      }, 300);
      this.captureResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.sendTab({ type: 'PREPARE_CAPTURE' });
    });
  }

  private async onGeometryChanged(after: WindowGeometry): Promise<void> {
    this.currentGeometry = after;
    this.currentViewport = { w: after.innerWidth, h: after.innerHeight };
    const cal = this.st.calibration;
    if (!cal || !this.isSessionActive()) return;
    const change = compareGeometry(cal.geometry, after);
    this.log('geometry', { change, after });
    if (change.kind === 'moved') {
      this.sendEngine({ type: 'SET_OFFSET', dx: -change.dx, dy: -change.dy });
      this.log('offset', { dx: -change.dx, dy: -change.dy });
    } else if (change.kind === 'changed' && (this.st.sessionState === 'RECORDING' || this.st.sessionState === 'PAUSED')) {
      this.pause('geometry');
      this.sendTab({ type: 'OVERLAY_MESSAGE', text: i18n.t('overlay.geometry_changed'), kind: 'warn', ttlMs: 2500 });
      setTimeout(() => void this.beginCalibration('quick'), 900);
    }
  }

  private async onAois(pageVisitId: string, aois: AOI[]): Promise<void> {
    if (!this.st.session) return;
    const db = await getDb();
    const tx = db.transaction('aois', 'readwrite');
    for (const a of aois) {
      const id = `${pageVisitId}:${a.id}`;
      const existing = await tx.store.get(id);
      const rects = existing ? [...existing.rects, ...a.rects].slice(-40) : a.rects;
      await tx.store.put({ ...a, id, sessionId: this.st.session.id, pageVisitId, rects });
    }
    await tx.done;
  }

  private async storeChunk(chunk: SampleChunk): Promise<void> {
    const db = await getDb();
    await db.put('chunks', chunk);
  }

  private async storeTile(tile: ScreenshotTile): Promise<void> {
    const db = await getDb();
    await db.put('tiles', tile);
  }

  private log(kind: SessionEventKind, data?: unknown): void {
    const sessionId = this.st.session?.id;
    if (!sessionId) return;
    void getDb().then((db) => db.add('events', { sessionId, t: Date.now(), kind, data }));
  }

  // ---------------------------------------------------------------------
  // Finalisation
  // ---------------------------------------------------------------------

  private async finalize(reason: string): Promise<void> {
    if (!this.st.session || this.st.sessionState === 'FINALIZING' || this.st.sessionState === 'DONE') return;
    this.pauseRecording();
    this.setState('FINALIZING', reason);
    this.sendTab({ type: 'OVERLAY_HIDE' });
    this.sendTab({ type: 'GAZE_DOT', visible: false });
    try {
      await this.closePageVisit();
      const session = this.st.session;
      session.endedAt = Date.now();
      session.recordedMs = this.st.recordedMs;
      session.state = 'DONE';
      const db = await getDb();
      await db.put('sessions', session);
    } catch (err) {
      console.error('[rt:sw] finalize failed', err);
    }
    await this.unregisterContentScript();
    await this.releaseHostPermissions();
    this.sendEngine({ type: 'CLEAR_MODEL' });
    const sessionId = this.st.session.id;
    this.setState('DONE', reason);
    this.sendTab({ type: 'OVERLAY_MESSAGE', text: i18n.t('overlay.session_done'), kind: 'success', ttlMs: 5000 });
    this.sendPanels({ type: 'SESSION_DONE', sessionId });
    await browser.tabs.create({ url: reportUrl(sessionId) });

    this.st.calibration = null;
    this.st.targetTabId = null;
    this.st.windowId = null;
    this.st.currentPageVisitId = null;
    this.st.recordingSince = null;
    this.calibTargets = [];
    this.awaitingInstructions = false;
    this.broadcastSnapshot();
    this.scheduleIdleStop();
  }
}
