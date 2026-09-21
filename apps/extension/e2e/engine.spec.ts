/**
 * Real engine smoke test: MediaPipe WASM must load under the MV3 CSP inside the
 * hidden offscreen document and the frame loop must run at camera rate.
 * Chromium's fake camera shows a synthetic pattern (no face), so we only assert
 * that the engine is running with a healthy fps and a delegate.
 */
import { expect, test } from '@playwright/test';
import { launchWithExtension } from './fixtures';

// `chrome` exists inside the extension page where the evaluate() callback runs.
declare const chrome: { runtime: { sendMessage(msg: unknown, cb: (res: never) => void): void } };

test('offscreen engine loads MediaPipe and processes frames', async () => {
  const { context, extId } = await launchWithExtension();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/onboarding.html`);

    // Consent → camera (prompt auto-accepted by --use-fake-ui-for-media-stream).
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: /^(Continuar|Continue)$/ }).click();
    await page.getByRole('button', { name: /Activar cámara|Turn on camera/ }).click();
    await expect(page.getByText(/Cámara activada|Camera enabled/)).toBeVisible({ timeout: 20_000 });

    // Poll the service worker snapshot until the engine reports running.
    const snapshot = await page.evaluate(
      () =>
        new Promise<{ engine: { state: string; fps: number; delegate: string | null; modelLoadMs?: number; error?: string } }>((resolve, reject) => {
          const started = Date.now();
          const tick = () => {
            chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' }, (res: { ok: boolean; data?: { engine: { state: string; fps: number; delegate: string | null } } }) => {
              const eng = res?.data?.engine;
              if (eng && eng.state === 'running' && eng.fps > 10) return resolve(res.data as never);
              if (eng && (eng.state === 'error' || eng.state === 'no-camera')) return reject(new Error(JSON.stringify(eng)));
              if (Date.now() - started > 60_000) return reject(new Error('timeout: ' + JSON.stringify(eng)));
              setTimeout(tick, 500);
            });
          };
          tick();
        }),
    );
    console.log('engine snapshot', snapshot.engine);
    expect(snapshot.engine.state).toBe('running');
    expect(snapshot.engine.fps).toBeGreaterThan(10);
    expect(['GPU', 'CPU']).toContain(snapshot.engine.delegate);
  } finally {
    await context.close();
  }
});
