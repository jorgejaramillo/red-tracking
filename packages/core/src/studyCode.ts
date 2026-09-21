import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { DEFAULT_CALIBRATION, type Study } from '@red-tracking/protocol';

export const STUDY_CODE_PREFIX = 'RT1.';

/** Compress + base64url-encode a study so it can be shared as a code or URL fragment. */
export function encodeStudyCode(study: Study): string {
  const json = JSON.stringify(study);
  const packed = deflateSync(strToU8(json), { level: 9 });
  return STUDY_CODE_PREFIX + toBase64Url(packed);
}

export function decodeStudyCode(code: string): Study {
  const trimmed = code.trim();
  if (!trimmed.startsWith(STUDY_CODE_PREFIX)) throw new Error('INVALID_PREFIX');
  const bytes = fromBase64Url(trimmed.slice(STUDY_CODE_PREFIX.length));
  let json: string;
  try {
    json = strFromU8(inflateSync(bytes));
  } catch {
    throw new Error('CORRUPT_CODE');
  }
  return validateStudy(JSON.parse(json));
}

export function isStudyCode(text: string): boolean {
  return text.trim().startsWith(STUDY_CODE_PREFIX);
}

/** Structural validation + defaults. Throws Error('INVALID_STUDY: <field>') on failure. */
export function validateStudy(input: unknown): Study {
  if (typeof input !== 'object' || input === null) throw new Error('INVALID_STUDY: root');
  const s = input as Record<string, unknown>;
  const str = (k: string, required = true): string => {
    const v = s[k];
    if (typeof v !== 'string' || (required && v.length === 0)) throw new Error(`INVALID_STUDY: ${k}`);
    return v;
  };
  const targetUrl = str('targetUrl');
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('INVALID_STUDY: targetUrl');
  }
  const instructions = s['instructions'];
  if (typeof instructions !== 'string' && (typeof instructions !== 'object' || instructions === null)) {
    throw new Error('INVALID_STUDY: instructions');
  }
  const aoiSelectors = Array.isArray(s['aoiSelectors']) ? s['aoiSelectors'] : [];
  for (const a of aoiSelectors) {
    if (typeof a !== 'object' || a === null || typeof (a as { selector?: unknown }).selector !== 'string') {
      throw new Error('INVALID_STUDY: aoiSelectors');
    }
  }
  const cal = (typeof s['calibration'] === 'object' && s['calibration']) || {};
  const c = cal as Partial<Study['calibration']>;
  const points = c.points === 13 ? 13 : 9;
  return {
    v: 1,
    id: str('id'),
    code: typeof s['code'] === 'string' ? s['code'] : undefined,
    name: str('name'),
    targetUrl,
    instructions: instructions as Study['instructions'],
    durationSec: typeof s['durationSec'] === 'number' && s['durationSec'] > 0 ? s['durationSec'] : undefined,
    aoiSelectors: aoiSelectors.map((a) => ({
      label: String((a as { label?: unknown }).label ?? (a as { selector: string }).selector),
      selector: (a as { selector: string }).selector,
    })),
    calibration: {
      points,
      validationPassPx: typeof c.validationPassPx === 'number' ? c.validationPassPx : DEFAULT_CALIBRATION.validationPassPx,
      validationFailPx: typeof c.validationFailPx === 'number' ? c.validationFailPx : DEFAULT_CALIBRATION.validationFailPx,
      clickRefinement: c.clickRefinement === true,
    },
    consentText: s['consentText'] as Study['consentText'],
    showGazeDot: s['showGazeDot'] === true,
    locale: s['locale'] === 'en' ? 'en' : s['locale'] === 'es' ? 'es' : undefined,
    createdAt: typeof s['createdAt'] === 'number' ? s['createdAt'] : Date.now(),
    researcher: typeof s['researcher'] === 'string' ? s['researcher'] : undefined,
  };
}

/** Origin (scheme + host + port) of the study's target URL, used for host permissions. */
export function studyOrigin(study: Study): string {
  return new URL(study.targetUrl).origin;
}

/** Match pattern for chrome.permissions / registerContentScripts. */
export function studyMatchPattern(study: Study): string {
  const u = new URL(study.targetUrl);
  return `${u.protocol}//${u.host}/*`;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
