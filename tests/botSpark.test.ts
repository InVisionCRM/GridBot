/** The Bots tab line per row (2026-10-31: every token-trader row drew the flat placeholder; Kyle had 28). */
import { describe, expect, it } from 'vitest';
import { botSpark } from '../src/ui/series';

describe('Bots tab lines', () => {
  it('a token-trader position draws its pool price since the buy, every read', () => {
    const marks = Array.from({ length: 120 }, (_, i) => [1_000 + i * 10_000, 0.00004 * (1 + i / 1000)] as [number, number]);
    for (const kind of ['trader', 'sniper']) {
      const pts = botSpark({ kind, marks, usdPerQuote: 2500 });
      expect(pts).toHaveLength(120);
      expect(pts[0]).toBe(0.00004);
      expect(pts.at(-1)).toBeCloseTo(0.00004 * 1.119, 12);
    }
  });
  it('a position with fewer than 2 reads draws the flat placeholder', () => {
    expect(botSpark({ kind: 'trader', marks: [[1, 0.00004]] })).toEqual([0, 0]);
    expect(botSpark({ kind: 'trader' })).toEqual([0, 0]);
  });
  it('grid, trend and liquidity bots still draw their last 48 values in dollars', () => {
    const equityHist = Array.from({ length: 60 }, (_, i) => [i, 100 + i] as [number, number]);
    const pts = botSpark({ kind: 'grid', equityHist, usdPerQuote: 2 });
    expect(pts).toHaveLength(48);
    expect(pts[0]).toBe((100 + 12) * 2);
    expect(pts.at(-1)).toBe((100 + 59) * 2);
  });
});
