/**
 * Polls the window geometry (position, size, DPR) so the service worker can
 * tell "window moved" (silent gaze offset) from "viewport changed" (recalibrate).
 */
import type { WindowGeometry } from '@red-tracking/protocol';
import { compareGeometry } from '@red-tracking/core';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { readGeometry } from './scroll-stop';

const POLL_MS = 500;

export interface GeometryWatch {
  current(): WindowGeometry;
  /** Adopt the current geometry as the new baseline without emitting a change. */
  rebase(): void;
}

export function startGeometryWatch(
  ctx: ContentScriptContext,
  onChange: (before: WindowGeometry, after: WindowGeometry) => void,
): GeometryWatch {
  let prev = readGeometry();

  const check = () => {
    try {
      const now = readGeometry();
      if (compareGeometry(prev, now).kind === 'same') return;
      const before = prev;
      prev = now;
      onChange(before, now);
    } catch (err) {
      console.error('[rt:content] geometry check failed', err);
    }
  };

  ctx.setInterval(check, POLL_MS);
  ctx.addEventListener(window, 'resize', check, { passive: true });

  return {
    current: () => prev,
    rebase: () => {
      prev = readGeometry();
    },
  };
}
