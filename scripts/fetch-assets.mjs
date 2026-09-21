#!/usr/bin/env node
/**
 * Copies the MediaPipe tasks-vision WASM runtime from node_modules and downloads
 * the Face Landmarker model into apps/extension/public so the extension bundles
 * everything locally (MV3 forbids remote code).
 *
 * Idempotent: skips files that already exist with a non-zero size.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extDir = join(root, 'apps', 'extension');
const publicDir = join(extDir, 'public');

const MODEL_URL =
  process.env.RT_FACE_LANDMARKER_URL ??
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function findWasmDir() {
  const candidates = [
    join(extDir, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
    join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function copyWasm() {
  const src = findWasmDir();
  if (!src) {
    console.warn('[fetch-assets] @mediapipe/tasks-vision not installed yet; skipping WASM copy');
    return;
  }
  const dst = join(publicDir, 'mediapipe', 'wasm');
  mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of readdirSync(src)) {
    const from = join(src, f);
    const to = join(dst, f);
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
    n++;
  }
  console.log(`[fetch-assets] WASM runtime → ${dst} (${n} file(s) copied)`);
}

async function downloadModel() {
  const dst = join(publicDir, 'models', 'face_landmarker.task');
  if (existsSync(dst) && statSync(dst).size > 1_000_000) {
    console.log('[fetch-assets] face_landmarker.task already present');
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  console.log(`[fetch-assets] downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading model`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dst, buf);
  console.log(`[fetch-assets] model → ${dst} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

try {
  copyWasm();
  await downloadModel();
} catch (err) {
  console.error('[fetch-assets] failed:', err.message);
  if (process.env.CI) process.exit(1);
}
