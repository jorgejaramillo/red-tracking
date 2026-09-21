/**
 * One-shot runtime messaging and navigation helpers for extension pages.
 */
import { browser, type PublicPath } from 'wxt/browser';
import type { RuntimeRequest, RuntimeResponse } from '@red-tracking/protocol';

/** Send a `RuntimeRequest` to the service worker; never throws. */
export async function sendRuntime(req: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    const res = await browser.runtime.sendMessage<RuntimeRequest, RuntimeResponse | undefined>(req);
    return res ?? { ok: false, error: 'NO_RESPONSE' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Absolute URL of an extension page. Pages built by other entrypoints
 * (report, privacy) may not exist in the generated `PublicPath` union yet,
 * hence the cast.
 */
export function extensionUrl(path: string): string {
  return browser.runtime.getURL(path as PublicPath);
}

export async function openExtensionPage(path: string): Promise<void> {
  try {
    await browser.tabs.create({ url: extensionUrl(path) });
  } catch (err) {
    console.warn('[ui] tabs.create failed', err);
  }
}

export function openReport(sessionId?: string | null): Promise<void> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  return openExtensionPage(`/report.html${query}`);
}
