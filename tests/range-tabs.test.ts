import { describe, expect, it } from 'vitest';
import { RANGES, rangeLocked } from '../src/v2/range-tabs';

describe('range tabs', () => {
  it('greys out every short range when the series has no timestamps', () => {
    expect(RANGES.filter((key) => rangeLocked(key, false))).toEqual(['1H', '1D', '1W', '1M']);
    expect(rangeLocked('ALL', false)).toBe(false);
    expect(RANGES.every((key) => !rangeLocked(key, true))).toBe(true);
  });
});
