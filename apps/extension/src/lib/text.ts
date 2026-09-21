import type { Locale, LocalizedText } from '@red-tracking/protocol';
import { browser } from 'wxt/browser';

export function uiLocale(): Locale {
  try {
    const lang = browser.i18n.getUILanguage();
    return lang.toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'es';
  }
}

export function localize(text: LocalizedText | undefined, locale: Locale): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.es ?? text.en ?? Object.values(text).find((v) => typeof v === 'string') ?? '';
}

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
