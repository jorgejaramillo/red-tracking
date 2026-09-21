/**
 * Small presentation helpers shared by the side panel and onboarding UIs.
 */
import { i18n } from '#i18n';
import type { EnvironmentCheck, LocalizedText } from '@red-tracking/protocol';

/** Known environment hint keys emitted by `assessEnvironment` (core/env.ts) → i18n keys. */
const ENV_HINT_KEYS = {
  no_face: 'env.no_face',
  too_far: 'env.too_far',
  too_close: 'env.too_close',
  too_dark: 'env.too_dark',
  too_bright: 'env.too_bright',
  unstable: 'env.unstable',
  face_ok: 'env.face_ok',
} as const;

type EnvHintKey = (typeof ENV_HINT_KEYS)[keyof typeof ENV_HINT_KEYS];

/** Escape hatch for keys that are only known at runtime (unknown hints). */
const tDynamic = i18n.t as unknown as (key: string) => string;

/** `env_too_far` → localized text (`env.too_far`). Unknown hints fall back to the dynamic key. */
export function envHintText(hint: string): string {
  const short = hint.replace(/^env_/, '');
  const key = (ENV_HINT_KEYS as Record<string, EnvHintKey | undefined>)[short];
  if (key) return i18n.t(key);
  return tDynamic(`env.${short}`);
}

export interface EnvHintLine {
  /** Source hint id (`env_too_far`), stable key for keyed lists. */
  key: string;
  text: string;
  ok: boolean;
}

/** Hint lines for an environment check; an OK environment yields a single green "face ok" line. */
export function envHintLines(env: EnvironmentCheck | null | undefined): EnvHintLine[] {
  if (!env) return [];
  if (env.ok) return [{ key: 'env_face_ok', text: i18n.t('env.face_ok'), ok: true }];
  return env.hints
    .map((h) => ({ key: h, text: envHintText(h), ok: false }))
    .filter((l) => l.text.length > 0);
}

/** 83 000 ms → "01:23"; hours roll into the minutes column. */
export function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Resolve a `LocalizedText` for the browser UI language (es/en), falling back to any value. */
export function localized(text: LocalizedText | undefined, lang: string = navigator.language): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  const primary = lang.toLowerCase().startsWith('en') ? 'en' : 'es';
  return text[primary] ?? text.es ?? text.en ?? '';
}
