/**
 * Side-panel port client (also used by the onboarding environment check).
 *
 * Wraps `connectPort` and, on every (re)connection — including after the
 * service worker was asleep — requests a fresh snapshot and re-subscribes to
 * preview frames. Callbacks are plain functions so callers can update Svelte
 * runes (`$state`) from them.
 */
import { PORT_PANEL, type PanelToSw, type SwToPanel } from '@red-tracking/protocol';
import { connectPort, type ClientPort } from '../ports';

/** Payload of `CALIB_PROGRESS`, kept by the UIs to render calibration progress. */
export interface CalibProgress {
  index: number;
  validFrames: number;
  needed: number;
}

export interface PanelClientOptions {
  onMessage: (msg: SwToPanel) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Preview frames per second requested on each (re)connect; 0 disables the preview. Default 15. */
  previewFps?: number;
  /** Request `GET_SNAPSHOT` on each (re)connect. Default true. */
  requestSnapshot?: boolean;
}

export class PanelClient {
  private port: ClientPort<PanelToSw> | null = null;
  private previewFps: number;
  private destroyed = false;

  constructor(private readonly opts: PanelClientOptions) {
    this.previewFps = opts.previewFps ?? 15;
  }

  get connected(): boolean {
    return this.port?.connected ?? false;
  }

  connect(): void {
    if (this.port || this.destroyed) return;
    this.port = connectPort<PanelToSw, SwToPanel>(PORT_PANEL, {
      onMessage: (msg) => {
        if (!this.destroyed) this.opts.onMessage(msg);
      },
      // `connectPort` invokes onConnect synchronously before returning the
      // port object, so defer until `this.port` is assigned.
      onConnect: () => queueMicrotask(() => this.handleConnect()),
      onDisconnect: () => this.opts.onDisconnect?.(),
    });
  }

  send(msg: PanelToSw): void {
    if (this.destroyed) return;
    this.port?.post(msg);
  }

  subscribePreview(fps: number): void {
    this.previewFps = fps;
    if (fps > 0) this.send({ type: 'PREVIEW_SUBSCRIBE', fps });
  }

  unsubscribePreview(): void {
    if (this.previewFps > 0) this.send({ type: 'PREVIEW_UNSUBSCRIBE' });
    this.previewFps = 0;
  }

  /** Unsubscribe from the preview and close the port. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribePreview();
    this.destroyed = true;
    this.port?.disconnect();
    this.port = null;
  }

  private handleConnect(): void {
    if (this.destroyed || !this.port) return;
    if (this.opts.requestSnapshot !== false) this.send({ type: 'GET_SNAPSHOT' });
    if (this.previewFps > 0) this.send({ type: 'PREVIEW_SUBSCRIBE', fps: this.previewFps });
    this.opts.onConnect?.();
  }
}
