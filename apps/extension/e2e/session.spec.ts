import { expect, test } from '@playwright/test';
import { deflateSync, strToU8 } from 'fflate';
import { launchWithExtension, serveFixtures } from './fixtures';

function encodeStudyCode(study: unknown): string {
  const packed = deflateSync(strToU8(JSON.stringify(study)), { level: 9 });
  const b64 = Buffer.from(packed).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'RT1.' + b64;
}

test('full session with the synthetic camera produces a report', async () => {
  const { server, baseUrl } = await serveFixtures();
  const { context, extId } = await launchWithExtension();
  try {
    const code = encodeStudyCode({
      v: 1,
      id: 'st_e2e',
      name: 'E2E shelf',
      targetUrl: `${baseUrl}/shelf.html`,
      instructions: { es: 'Busca un cereal', en: 'Find a cereal' },
      aoiSelectors: [{ label: 'Producto', selector: '.product' }],
      calibration: { points: 9, validationPassPx: 100, validationFailPx: 150, clickRefinement: false },
      showGazeDot: true,
      createdAt: Date.now(),
    });

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.getByPlaceholder(/RT1/).fill(code);
    await panel.getByRole('button', { name: /^(Unirse|Join)$/ }).click();
    await expect(panel.getByText(/Estudio:|Study:/)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(/Cámara activa|Camera active/)).toBeVisible({ timeout: 45_000 });

    const startBtn = panel.getByRole('button', { name: /Iniciar sesión|Start session/ });
    await expect(startBtn).toBeEnabled({ timeout: 30_000 });
    const studyPagePromise = context.waitForEvent('page');
    await startBtn.click();
    const study = await studyPagePromise;
    await study.waitForLoadState('domcontentloaded');

    // Calibration intro card (shadow DOM, open) → start.
    await study.getByRole('button', { name: /^(Iniciar|Start)$/ }).click({ timeout: 30_000 });
    await expect(panel.getByText(/Calibrando|Calibrating/)).toBeVisible({ timeout: 10_000 });

    // Calibration (9 pts) + validation (4 pts) run automatically with the synthetic face.
    await study.getByRole('button', { name: /^(Comenzar|Begin)$/ }).click({ timeout: 120_000 });
    await expect(panel.getByText(/Grabando|Recording/)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(/Precisión|Accuracy/)).toBeVisible();

    // Browse: a few scroll stops so tiles and AOI snapshots are captured.
    for (const y of [350, 800, 1300, 0]) {
      await study.evaluate((yy) => window.scrollTo(0, yy), y);
      await study.waitForTimeout(1200);
    }
    await study.waitForTimeout(2500);

    const reportPromise = context.waitForEvent('page');
    await panel.getByRole('button', { name: /Terminar sesión|End session/ }).click();
    const report = await reportPromise;
    await report.waitForLoadState('domcontentloaded');
    try {
      await expect(report.getByText(/Mapa de calor|Heatmap/)).toBeVisible({ timeout: 45_000 });
    } catch (err) {
      console.log('REPORT URL', report.url());
      console.log('REPORT BODY', (await report.locator('body').innerText()).slice(0, 1500));
      throw err;
    }
    await expect(report.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 });

    const labels = (await report.locator('table tbody tr td:nth-child(2)').allInnerTexts()).join(' | ');
    expect(labels).toMatch(/Producto|Cereal/);

    const counts = await report.evaluate(
      () =>
        new Promise<Record<string, number>>((resolve, reject) => {
          const req = indexedDB.open('redtracking');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const names = ['sessions', 'pageVisits', 'chunks', 'tiles', 'aois', 'events', 'calibrations'];
            const out: Record<string, number> = {};
            const tx = db.transaction(names, 'readonly');
            for (const n of names) {
              const r = tx.objectStore(n).count();
              r.onsuccess = () => (out[n] = r.result);
            }
            const ev = tx.objectStore('events').getAll();
            ev.onsuccess = () => {
              for (const e of ev.result as { kind: string }[]) out['ev:' + e.kind] = (out['ev:' + e.kind] ?? 0) + 1;
            };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    console.log('IDB counts', counts);
    expect(counts['sessions']).toBeGreaterThanOrEqual(1);
    expect(counts['pageVisits']).toBeGreaterThanOrEqual(1);
    expect(counts['calibrations']).toBeGreaterThanOrEqual(1);
    expect(counts['chunks']).toBeGreaterThanOrEqual(1);
    expect(counts['aois']).toBeGreaterThanOrEqual(6);
    expect(counts['tiles']).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
    server.close();
  }
});
