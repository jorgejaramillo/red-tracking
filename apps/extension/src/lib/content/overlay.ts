/**
 * Shadow-DOM overlay shown inside the participant's tab: calibration /
 * validation targets, intro and instructions cards, toasts and the gaze dot.
 *
 * The host is `position: fixed; inset: 0` with `pointer-events: none`; the page
 * stays interactive except while a target sequence or a card is displayed.
 * Styles live in ./overlay.css (injected by WXT with cssInjectionMode 'ui').
 */
import { i18n } from '#i18n';
import type { NormPoint } from '@red-tracking/protocol';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';

export type TargetMode = 'calibration' | 'validation';
export type ToastKind = 'info' | 'warn' | 'error' | 'success';

export interface OverlayEvents {
  onPointShown(index: number, vx: number, vy: number, t: number): void;
  onPointDone(index: number): void;
  onSequenceDone(mode: TargetMode): void;
  onCancelled(): void;
  onInstructionsAck(): void;
}

const VALIDATION_CARD_MS = 1200;
const PROGRESS_GRACE_MS = 800;
const BETWEEN_POINTS_MS = 250;
const TOAST_DEFAULT_TTL_MS = 3000;
const FACE_FOUND_TTL_MS = 1500;
const MAX_TOASTS = 4;
const CAPTURE_FALLBACK_MS = 120;
const REATTACH_CHECK_MS = 2000;

interface RunToken {
  cancelled: boolean;
  /** Wakes the wait currently in progress so cancellation is immediate. */
  wake: (() => void) | null;
}

interface SequenceSpec {
  mode: TargetMode;
  points: NormPoint[];
  dwellMs: number;
}

type BlockReason = 'sequence' | 'card';

export class Overlay {
  static async mount(ctx: ContentScriptContext, events: OverlayEvents): Promise<Overlay> {
    const overlay = new Overlay(ctx, events);
    const ui = await createShadowRootUi(ctx, {
      name: 'rt-overlay',
      position: 'inline',
      anchor: () => document.body ?? document.documentElement,
      // Open so that automated tests (Playwright) can reach the calibration UI.
      mode: 'open',
      onMount: (container, shadow, host) => {
        overlay.attach(container, shadow, host);
      },
    });
    ui.mount();
    overlay.installGlobalListeners();
    return overlay;
  }

  private root!: HTMLElement;
  private shadow!: ShadowRoot;
  private hostEl!: HTMLElement;
  private backdrop!: HTMLElement;
  private label!: HTMLElement;
  private targetLayer!: HTMLElement;
  private card!: HTMLElement;
  private cardTitle!: HTMLElement;
  private cardBody!: HTMLElement;
  private cardBtn!: HTMLButtonElement;
  private toasts!: HTMLElement;
  private gaze!: HTMLElement;

  private blockReasons = new Set<BlockReason>();
  private active: RunToken | null = null;
  private lastRun: SequenceSpec | null = null;
  private progressDone = new Set<number>();
  private progressWaiters = new Map<number, () => void>();
  private cardClickHandler: (() => void) | null = null;
  private faceLostDismiss: (() => void) | null = null;
  private gazeVisible = false;

  private constructor(
    private readonly ctx: ContentScriptContext,
    private readonly events: OverlayEvents,
  ) {}

  get host(): HTMLElement {
    return this.hostEl;
  }

  /** True for our host element or anything inside the shadow root. */
  contains(target: EventTarget | Element | null | undefined): boolean {
    if (!target || !(target instanceof Node)) return false;
    if (target === this.hostEl || this.hostEl.contains(target)) return true;
    try {
      return target.getRootNode() === this.shadow;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Target sequences
  // ---------------------------------------------------------------------------

  showTargets(mode: TargetMode, points: NormPoint[], dwellMs: number): void {
    this.cancelSequence(false);
    this.hideCard();
    const spec: SequenceSpec = { mode, points: points.slice(), dwellMs: Math.max(200, dwellMs || 1200) };
    this.lastRun = spec;
    void this.runSequence(spec, true);
  }

  repeatTargets(indices: number[]): void {
    if (!this.lastRun) return;
    const wanted = new Set(indices);
    const points = this.lastRun.points.filter((p) => wanted.has(p.index));
    if (points.length === 0) {
      this.events.onSequenceDone(this.lastRun.mode);
      return;
    }
    this.cancelSequence(false);
    this.toast(i18n.t('overlay.repeat_points'), 'info', 2500);
    void this.runSequence({ ...this.lastRun, points }, false);
  }

  reportProgress(index: number, validFrames: number, needed: number): void {
    if (validFrames < needed) return;
    this.progressDone.add(index);
    const wake = this.progressWaiters.get(index);
    if (wake) {
      this.progressWaiters.delete(index);
      wake();
    }
  }

  /** Abort a running sequence; `notify` sends CALIB_CANCELLED to the caller. */
  cancelSequence(notify: boolean): void {
    const token = this.active;
    if (!token) return;
    token.cancelled = true;
    this.active = null;
    this.teardownSequence();
    token.wake?.();
    if (notify) this.events.onCancelled();
  }

  private async runSequence(spec: SequenceSpec, intro: boolean): Promise<void> {
    const token: RunToken = { cancelled: false, wake: null };
    this.active = token;
    this.progressDone.clear();
    this.progressWaiters.clear();
    this.setBlocking('sequence', true);
    this.show(this.backdrop);
    this.backdrop.classList.remove('rt-backdrop--soft');

    try {
      if (intro) {
        if (spec.mode === 'calibration') {
          await this.showCardAndWaitClick(
            i18n.t('overlay.calibration_title'),
            i18n.t('overlay.calibration_intro'),
            i18n.t('common.start'),
            token,
          );
        } else {
          this.showCard(i18n.t('overlay.validation_title'), i18n.t('overlay.validation_intro'), null);
          await this.sleep(VALIDATION_CARD_MS, token);
        }
        if (token.cancelled) return;
        this.hideCard();
      }

      const n = spec.points.length;
      for (let i = 0; i < n; i++) {
        const p = spec.points[i]!;
        const vx = Math.round(p.nx * window.innerWidth);
        const vy = Math.round(p.ny * window.innerHeight);
        this.progressDone.delete(p.index);
        this.showTarget(vx, vy, spec.dwellMs, i + 1, n);
        this.events.onPointShown(p.index, vx, vy, Date.now());

        await this.sleep(spec.dwellMs, token);
        if (token.cancelled) return;
        await this.waitProgress(p.index, PROGRESS_GRACE_MS, token);
        if (token.cancelled) return;

        this.events.onPointDone(p.index);
        this.hideTarget();
        if (i < n - 1) {
          await this.sleep(BETWEEN_POINTS_MS, token);
          if (token.cancelled) return;
        }
      }

      this.active = null;
      this.teardownSequence();
      this.events.onSequenceDone(spec.mode);
    } catch (err) {
      console.error('[rt:content] target sequence failed', err);
      if (this.active === token) {
        this.active = null;
        this.teardownSequence();
      }
    }
  }

  private showTarget(vx: number, vy: number, dwellMs: number, i: number, n: number): void {
    this.hideTarget();
    const target = document.createElement('div');
    target.className = 'rt-target';
    target.style.transform = `translate3d(${vx}px, ${vy}px, 0)`;
    const ring = document.createElement('div');
    ring.className = 'rt-ring';
    ring.style.setProperty('--rt-dwell', `${dwellMs}ms`);
    const dot = document.createElement('div');
    dot.className = 'rt-dot';
    target.append(ring, dot);
    this.targetLayer.appendChild(target);
    this.label.textContent = i18n.t('overlay.calibration_progress', [i, n]);
    this.show(this.label);
  }

  private hideTarget(): void {
    while (this.targetLayer.firstChild) this.targetLayer.removeChild(this.targetLayer.firstChild);
  }

  private teardownSequence(): void {
    this.hideTarget();
    this.hide_(this.label);
    this.hideCard();
    if (!this.blockReasons.has('card')) this.hide_(this.backdrop);
    this.setBlocking('sequence', false);
    this.progressWaiters.clear();
  }

  private sleep(ms: number, token: RunToken): Promise<void> {
    return new Promise((resolve) => {
      if (token.cancelled) return resolve();
      const id = this.ctx.setTimeout(() => {
        token.wake = null;
        resolve();
      }, ms);
      token.wake = () => {
        clearTimeout(id);
        token.wake = null;
        resolve();
      };
    });
  }

  private waitProgress(index: number, timeoutMs: number, token: RunToken): Promise<void> {
    if (this.progressDone.has(index)) return Promise.resolve();
    return new Promise((resolve) => {
      if (token.cancelled) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(id);
        this.progressWaiters.delete(index);
        token.wake = null;
        resolve();
      };
      const id = this.ctx.setTimeout(finish, timeoutMs);
      this.progressWaiters.set(index, finish);
      token.wake = finish;
    });
  }

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------

  showInstructions(title: string, body: string, buttonLabel: string): void {
    this.setBlocking('card', true);
    this.show(this.backdrop);
    if (!this.active) this.backdrop.classList.add('rt-backdrop--soft');
    this.showCard(title, body, buttonLabel || i18n.t('overlay.instructions_start'), () => {
      this.hideCard();
      this.setBlocking('card', false);
      if (!this.active) this.hide_(this.backdrop);
      this.events.onInstructionsAck();
    });
  }

  private showCardAndWaitClick(title: string, body: string, button: string, token: RunToken): Promise<void> {
    return new Promise((resolve) => {
      if (token.cancelled) return resolve();
      const finish = () => {
        token.wake = null;
        resolve();
      };
      token.wake = finish;
      this.showCard(title, body, button, finish);
      this.cardBtn.focus({ preventScroll: true });
    });
  }

  private showCard(title: string, body: string, button: string | null, onClick?: () => void): void {
    this.cardTitle.textContent = title;
    while (this.cardBody.firstChild) this.cardBody.removeChild(this.cardBody.firstChild);
    for (const para of body.split(/\r?\n/)) {
      const text = para.trim();
      if (!text) continue;
      const p = document.createElement('p');
      p.textContent = text;
      this.cardBody.appendChild(p);
    }
    this.cardClickHandler = onClick ?? null;
    if (button) {
      this.cardBtn.textContent = button;
      this.show(this.cardBtn);
    } else {
      this.hide_(this.cardBtn);
    }
    this.show(this.card);
  }

  private hideCard(): void {
    this.cardClickHandler = null;
    this.hide_(this.card);
    this.backdrop.classList.remove('rt-backdrop--soft');
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  /** Show a toast; ttlMs <= 0 keeps it until the returned dismiss() is called. */
  toast(text: string, kind: ToastKind = 'info', ttlMs: number = TOAST_DEFAULT_TTL_MS): () => void {
    const el = document.createElement('div');
    el.className = `rt-toast rt-toast--${kind}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > MAX_TOASTS) this.toasts.firstElementChild?.remove();
    this.ctx.requestAnimationFrame(() => el.classList.add('rt-toast--in'));

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.remove('rt-toast--in');
      this.ctx.setTimeout(() => el.remove(), 200);
    };
    if (ttlMs > 0) this.ctx.setTimeout(dismiss, ttlMs);
    return dismiss;
  }

  showFaceLost(): void {
    if (this.faceLostDismiss) return;
    this.faceLostDismiss = this.toast(i18n.t('overlay.face_lost'), 'warn', 0);
  }

  showFaceFound(): void {
    if (!this.faceLostDismiss) return;
    this.faceLostDismiss();
    this.faceLostDismiss = null;
    this.toast(i18n.t('overlay.face_found'), 'success', FACE_FOUND_TTL_MS);
  }

  private clearToasts(): void {
    this.faceLostDismiss = null;
    while (this.toasts.firstChild) this.toasts.removeChild(this.toasts.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Gaze dot
  // ---------------------------------------------------------------------------

  setGazeDotVisible(visible: boolean): void {
    this.gazeVisible = visible;
    this.gaze.classList.toggle('rt-hidden', !visible);
  }

  moveGazeDot(vx: number, vy: number): void {
    if (!this.gazeVisible) return;
    this.gaze.style.transform = `translate3d(${Math.round(vx)}px, ${Math.round(vy)}px, 0)`;
  }

  // ---------------------------------------------------------------------------
  // Visibility control
  // ---------------------------------------------------------------------------

  /** OVERLAY_HIDE: sequence UI, cards and toasts go away; the gaze dot is untouched. */
  hide(): void {
    this.cancelSequence(false);
    this.hideCard();
    this.setBlocking('card', false);
    this.hide_(this.backdrop);
    this.clearToasts();
  }

  /** Hide every visual and resolve once the page has painted without them. */
  prepareCapture(): Promise<void> {
    this.root.style.visibility = 'hidden';
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.ctx.requestAnimationFrame(() => this.ctx.requestAnimationFrame(finish));
      // rAF does not run in hidden documents; never leave the SW waiting.
      this.ctx.setTimeout(finish, CAPTURE_FALLBACK_MS);
    });
  }

  captureDone(): void {
    this.root.style.visibility = '';
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attach(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): void {
    this.root = container;
    this.shadow = shadow;
    this.hostEl = host;
    container.className = 'rt-root';
    while (container.firstChild) container.removeChild(container.firstChild);

    this.backdrop = this.el('div', 'rt-backdrop rt-hidden');
    this.label = this.el('div', 'rt-label rt-hidden');
    this.targetLayer = this.el('div', 'rt-targets');

    this.card = this.el('div', 'rt-card rt-hidden');
    this.card.setAttribute('role', 'dialog');
    this.cardTitle = this.el('h2', 'rt-card-title');
    this.cardBody = this.el('div', 'rt-card-body');
    this.cardBtn = document.createElement('button');
    this.cardBtn.type = 'button';
    this.cardBtn.className = 'rt-card-btn';
    this.cardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const handler = this.cardClickHandler;
      this.cardClickHandler = null;
      handler?.();
    });
    this.card.append(this.cardTitle, this.cardBody, this.cardBtn);

    this.toasts = this.el('div', 'rt-toasts');
    this.gaze = this.el('div', 'rt-gaze rt-hidden');

    container.append(this.backdrop, this.targetLayer, this.label, this.card, this.toasts, this.gaze);
  }

  private installGlobalListeners(): void {
    this.ctx.addEventListener(
      window,
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.active) {
          e.preventDefault();
          e.stopPropagation();
          this.cancelSequence(true);
        }
      },
      { capture: true },
    );
    // Some SPAs replace <body> children wholesale; put the host back if it drops out.
    this.ctx.setInterval(() => {
      try {
        if (!this.hostEl.isConnected) (document.body ?? document.documentElement).appendChild(this.hostEl);
      } catch (err) {
        console.error('[rt:content] overlay re-attach failed', err);
      }
    }, REATTACH_CHECK_MS);
  }

  private setBlocking(reason: BlockReason, on: boolean): void {
    if (on) this.blockReasons.add(reason);
    else this.blockReasons.delete(reason);
    if (this.blockReasons.size > 0) this.root.setAttribute('data-block', '');
    else this.root.removeAttribute('data-block');
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  private show(node: HTMLElement): void {
    node.classList.remove('rt-hidden');
  }

  private hide_(node: HTMLElement): void {
    node.classList.add('rt-hidden');
  }
}
