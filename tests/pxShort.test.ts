/** Small prices on a 390px tile: subscript-zero count, the same significant digits as px(), nothing dropped. */
import { describe, expect, it } from 'vitest';
import { px, pxShort } from '../src/ui/fmt';

const back = (s: string) => {
  // "0.0₅216304" → 0.00000216304
  const m = /^(−?)0\.0([₀-₉]+)(\d+)$/.exec(s);
  if (!m) return Number(s.replace('−', '-'));
  const zeros = Number([...m[2]].map((c) => c.charCodeAt(0) - 0x2080).join(''));
  return Number(`${m[1] ? '-' : ''}0.${'0'.repeat(zeros)}${m[3]}`);
};

describe('pxShort', () => {
  it('counts the zeros after "0.0" as a subscript', () => {
    expect(px(2.1630447772207825e-6)).toBe('0.00000216304');
    expect(pxShort(2.1630447772207825e-6)).toBe('0.0₅216304');
    expect(pxShort(1.722160395598561e-5)).toBe('0.0₄172216');
    expect(pxShort(8.9e-10)).toBe('0.0₉89');
    expect(pxShort(1.2e-12)).toBe('0.0₁₁12');
    expect(pxShort(-5.0938348336569646e-6)).toBe('−0.0₅509383');
  });
  it('keeps px() for prices from 1e-4 up, zero and missing values', () => {
    for (const x of [0.00042695303365252607, 0.0001, 1.5, 2341.0064, 0, null, undefined, Number.NaN]) expect(pxShort(x)).toBe(px(x));
    expect(pxShort(9.9999999e-5)).toBe(px(9.9999999e-5)); // rounds up to 0.0001
  });
  it('is the same number as px(), digit for digit', () => {
    for (const x of [2.1630447772207825e-6, 1.9557600285672565e-6, 5.0938348336569646e-6, 1.722160395598561e-5, 3.3e-8, 7.123456789e-11]) {
      expect(back(pxShort(x))).toBe(Number(x.toPrecision(6)));
      expect(back(pxShort(x))).toBe(Number(px(x)));
    }
  });
  it('is short enough for a phone tile', () => {
    expect(pxShort(2.1630447772207825e-6).length).toBeLessThan(px(2.1630447772207825e-6).length);
  });
});
