import { describe, expect, it } from 'vitest';
import type { Study } from '@red-tracking/protocol';
import { decodeStudyCode, encodeStudyCode, isStudyCode, studyMatchPattern, studyOrigin, validateStudy } from '../src/studyCode';

const study: Study = {
  v: 1, id: 'st_1', name: 'Cereal shelf', targetUrl: 'https://www.exito.com/mercado/cereales',
  instructions: { es: 'Busca un cereal para el desayuno', en: 'Find a breakfast cereal' },
  durationSec: 180, aoiSelectors: [{ label: 'Product card', selector: '.product-card' }],
  calibration: { points: 9, validationPassPx: 100, validationFailPx: 150, clickRefinement: false },
  showGazeDot: false, createdAt: 1_700_000_000_000, locale: 'es',
};

describe('study codes', () => {
  it('round-trips through encode/decode', () => {
    const code = encodeStudyCode(study);
    expect(isStudyCode(code)).toBe(true);
    expect(code).toMatch(/^RT1\.[A-Za-z0-9_-]+$/);
    expect(decodeStudyCode(code)).toEqual(study);
  });
  it('rejects garbage', () => {
    expect(() => decodeStudyCode('hello')).toThrow('INVALID_PREFIX');
    expect(() => decodeStudyCode('RT1.!!!!')).toThrow();
  });
  it('validates required fields and applies defaults', () => {
    expect(() => validateStudy({ ...study, targetUrl: 'ftp://x' })).toThrow('targetUrl');
    expect(() => validateStudy({ ...study, name: '' })).toThrow('name');
    const s = validateStudy({ id: 'a', name: 'b', targetUrl: 'https://a.com', instructions: 'x' });
    expect(s.calibration.points).toBe(9);
    expect(s.calibration.validationPassPx).toBe(100);
    expect(s.aoiSelectors).toEqual([]);
  });
  it('derives origin and match pattern', () => {
    expect(studyOrigin(study)).toBe('https://www.exito.com');
    expect(studyMatchPattern(study)).toBe('https://www.exito.com/*');
  });
});
