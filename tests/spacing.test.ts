import { describe, expect, it } from 'vitest';
import { analyzeSpacing, MAX_GRID_COUNT, ROUND_TRIP_FEE, validateGridParams } from '../src/live/spacing';

describe('spacing vs PulseX round-trip fee', () => {
  it('round-trip fee ≈ 0.579%', () => {
    expect(ROUND_TRIP_FEE).toBeCloseTo(0.00579141, 6);
  });
  it('±10% ×10 clears fees; dense ×40 on ±5% does not', () => {
    const p = 0.00001;
    const wide = analyzeSpacing(p * 0.9, p * 1.1, 10);
    expect(wide.clearsFees).toBe(true);
    expect(wide.warning).toBeNull();
    const tight = analyzeSpacing(p * 0.95, p * 1.05, 40);
    expect(tight.clearsFees).toBe(false);
    expect(tight.warning).toMatch(/round-trip/);
  });
  it('gridCount capped at 50', () => {
    expect(validateGridParams(1, 2, 51, 10)).toEqual(expect.arrayContaining([expect.stringMatching(/2–50/)]));
    expect(validateGridParams(1, 2, MAX_GRID_COUNT, 10)).toEqual([]);
  });
});
