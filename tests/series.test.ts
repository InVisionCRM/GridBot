import { describe, expect, it } from 'vitest';
import { rangeTone } from '../src/ui/series';

describe('range tone', () => {
  it('calls a price near either edge amber, and outside the band out', () => {
    expect(rangeTone(100, 200, 105, true)).toBe('near');
    expect(rangeTone(100, 200, 190, true)).toBe('near');
    expect(rangeTone(100, 200, 150, true)).toBe('in');
    expect(rangeTone(100, 200, 90, true)).toBe('out');
    expect(rangeTone(100, 200, 150, false)).toBe('out');
  });
});
