/**
 * Typed wrappers around chrome.runtime ports.
 *
 * `connectPort` is used by clients (offscreen, side panel, content script) and
 * reconnects automatically when the service worker restarts. `onPort` is used
 * by the service worker to accept connections by name.
 */
import { browser, type Browser } from 'wxt/browser';

export type Port = Browser.runtime.Port;

export interface ClientPort<TOut> {
  post(msg: TOut): void;
  disconnect(): void;
  readonly connected: boolean;
}

export interface ConnectOptions<TIn> {
  onMessage: (msg: TIn) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Reconnect after the SW drops the port (default true). */
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export function connectPort<TOut, TIn>(name: string, opts: ConnectOptions<TIn>): ClientPort<TOut> {
  let port: Port | null = null;
  let closed = false;
  let connected = false;
  const queue: TOut[] = [];

  const open = () => {
    if (closed) return;
    try {
      port = browser.runtime.connect({ name });
    } catch (err) {
      console.warn(`[ports] connect(${name}) failed`, err);
      scheduleReconnect();
      return;
    }
    connected = true;
    port.onMessage.addListener((m) => opts.onMessage(m as TIn));
    port.onDisconnect.addListener(() => {
      connected = false;
      port = null;
      opts.onDisconnect?.();
      scheduleReconnect();
    });
    opts.onConnect?.();
    while (queue.length && port) port.postMessage(queue.shift());
  };

  const scheduleReconnect = () => {
    if (closed || opts.reconnect === false) return;
    setTimeout(open, opts.reconnectDelayMs ?? 500);
  };

  open();

  return {
    post(msg) {
      if (port && connected) {
        try {
          port.postMessage(msg);
          return;
        } catch {
          connected = false;
        }
      }
      // Buffer a bounded number of messages while reconnecting; drop high-frequency ones.
      if (queue.length < 50) queue.push(msg);
    },
    disconnect() {
      closed = true;
      port?.disconnect();
      port = null;
      connected = false;
    },
    get connected() {
      return connected;
    },
  };
}

export type PortHandler = (port: Port) => void;

/** Service-worker side: dispatch incoming ports by name. */
export function onPort(handlers: Record<string, PortHandler>): void {
  browser.runtime.onConnect.addListener((port) => {
    const h = handlers[port.name];
    if (h) h(port);
    else console.warn('[ports] unknown port', port.name);
  });
}

export function safePost(port: Port | null | undefined, msg: unknown): boolean {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}
