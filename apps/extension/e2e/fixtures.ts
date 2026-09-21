import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const EXT_DIR = resolve(here, '..', process.env.RT_EXT_DIR ?? '.output-e2e', 'chrome-mv3');
export const FIXTURES_DIR = resolve(here, '..', '..', '..', 'fixtures');

export async function launchWithExtension(): Promise<{ context: BrowserContext; sw: Worker; extId: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--no-first-run',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  if (process.env.RT_E2E_LOGS) {
    sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));
    context.on('page', (p) => {
      p.on('console', (m) => console.log(`[page ${p.url().slice(0, 60)}]`, m.type(), m.text()));
      p.on('pageerror', (e) => console.log(`[pageerror ${p.url().slice(0, 60)}]`, e.message));
    });
  }
  return { context, sw, extId };
}

/** Serves fixtures/pages/*.html on a random port. */
export async function serveFixtures(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const file = join(FIXTURES_DIR, 'pages', (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'shelf.html');
    try {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(readFileSync(file));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}
