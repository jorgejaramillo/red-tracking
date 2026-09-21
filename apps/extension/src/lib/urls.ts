import { browser, type PublicPath } from 'wxt/browser';

/** Extension URL for a bundled page/asset, with optional query parameters. */
export function extUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(browser.runtime.getURL(path as PublicPath));
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

export function reportUrl(sessionId?: string): string {
  return extUrl('/report.html', sessionId ? { session: sessionId } : undefined);
}
