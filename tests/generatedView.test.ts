/** The UI's reading of Generated (src/ui/generatedView.ts) over the shared module (src/shared/generated.ts, from #48). */
import { describe, expect, it } from 'vitest';
import { formatTokenSum, formatTokens, generatedInQuote, generatedOf, generatedPct, generatedPctNote, generatedValueInQuote, investedOf, quoteSymbolOf, sharedTotals, sumTokens } from '../src/ui/generatedView';
import { estimates } from '../src/shared/generated';

const lp = {
  kind: 'lp', base: 'SPY', quote: 'USDG', price: 771.33, startValue: 34_000, config: { capital: 34_000 },
  pnl: { feeCoins: { base: 0.0531, quote: 22.37 }, gas: 0.05, swapCost: 32.97, moveLoss: 874.18, net: -866, price: -12.4 },
};
const grid = { kind: 'grid', quoteSym: 'USDG', config: { totalCapitalUsd: 2_000 }, pnl: { realized: 0.0925, unrealized: -0.0177 } };
const trend = { kind: 'trend', quoteSym: 'USDG', capital: 1_000, pnl: { realized: 61.5, unrealized: -4.2 } };

describe('generatedOf', () => {
  it('LP: the fee coins, with gas, swap costs and range-move losses out of the quote side (#48 definition)', () => {
    const g = generatedOf(lp)!;
    expect(g.basis).toBe('lp-fee-coins');
    expect(g.tokens[0]).toEqual({ symbol: 'SPY', amount: 0.0531 });
    expect(g.tokens[1].symbol).toBe('USDG');
    expect(g.tokens[1].amount).toBeCloseTo(22.37 - (0.05 + 32.97 + 874.18), 9);
  });
  it('LP without fee coins: the engine net in the quote coin', () => {
    const g = generatedOf({ ...lp, pnl: { net: 12.5 } })!;
    expect(g).toEqual({ tokens: [{ symbol: 'USDG', amount: 12.5 }], basis: 'lp-net' });
  });
  it('grid and trend: pnl.realized in the quote coin, never the unrealized price move', () => {
    expect(generatedOf(grid)).toEqual({ tokens: [{ symbol: 'USDG', amount: 0.0925 }], basis: 'grid-realized' });
    expect(generatedOf(trend)).toEqual({ tokens: [{ symbol: 'USDG', amount: 61.5 }], basis: 'trend-realized' });
  });
  it('a grid that has generated nothing: an empty list, not "+0"', () => {
    expect(generatedOf({ ...grid, pnl: { realized: 0 } })).toEqual({ tokens: [], basis: 'grid-realized' });
  });
  it('token trader, sniper, or no pnl: none', () => {
    expect(generatedOf({ kind: 'trader', pnlUsd: 5, spent: 10 })).toBeNull();
    expect(generatedOf({ kind: 'grid' })).toBeNull();
  });
});

describe('investedOf / generatedPct / quoteSymbolOf', () => {
  it('reads what was put in per kind', () => {
    expect(investedOf(grid)).toEqual({ symbol: 'USDG', amount: 2_000 });
    expect(investedOf(trend)).toEqual({ symbol: 'USDG', amount: 1_000 });
    expect(investedOf(lp)).toEqual({ symbol: 'USDG', amount: 34_000 });
    expect(investedOf({ kind: 'trader', stable: 'PLS', spent: 1e6 })).toEqual({ symbol: 'PLS', amount: 1e6 });
  });
  it('share: from the Generated tokens (LP base part at the pool price), never the engine net; grid and trend from realized', () => {
    const genQuote = 0.0531 * 771.33 + (22.37 - (0.05 + 32.97 + 874.18));
    expect(generatedValueInQuote(lp)).toBeCloseTo(genQuote, 9);
    expect(generatedPct(lp)).toBeCloseTo(genQuote / 34_000, 12);
    // a stale or different engine net does not move it (the NVDA LP still: net +412 on ~−1.4 USDG generated)
    expect(generatedPct({ ...lp, pnl: { ...lp.pnl, net: 412 } })).toBeCloseTo(genQuote / 34_000, 12);
    // no pool price: no share rather than a guess
    expect(generatedPct({ ...lp, price: null })).toBeNull();
    expect(generatedPctNote(lp)).toMatch(/SPY part of Generated is valued in USDG at the pool's price now/);
    expect(generatedPct(trend)).toBeCloseTo(0.0615, 12);
    expect(generatedPct({ ...trend, capital: 0 })).toBeNull();
  });
  it('quote symbol', () => {
    expect(quoteSymbolOf(lp)).toBe('USDG');
    expect(quoteSymbolOf(grid)).toBe('USDG');
    expect(generatedInQuote(generatedOf(lp))).toBeNull();
    expect(generatedInQuote(generatedOf(grid))).toBe(0.0925);
  });
});

describe('sums and text', () => {
  it('adds by coin; shared totals keep only coins two or more bots count in', () => {
    const a = [{ symbol: 'SPY', amount: 1 }, { symbol: 'USDG', amount: 2 }];
    const b = [{ symbol: 'USDG', amount: 3 }];
    expect(sumTokens([a, b, null])).toEqual([{ symbol: 'SPY', amount: 1 }, { symbol: 'USDG', amount: 5 }]);
    expect(sharedTotals([a, b])).toEqual([{ symbol: 'USDG', amount: 5 }]);
  });
  it('formats without any dollar sign', () => {
    expect(formatTokens([{ symbol: 'SPY', amount: 0.02 }, { symbol: 'USDG', amount: 26.1 }], false)).toBe('0.02 SPY + 26.1 USDG');
    expect(formatTokens([{ symbol: 'SPY', amount: 0.0531 }, { symbol: 'USDG', amount: -884.83 }])).toBe('+0.0531 SPY · −884.83 USDG');
    expect(formatTokens([{ symbol: 'USDG', amount: 34_000 }], false)).toBe('34,000 USDG');
    expect(formatTokens([])).toBe('—');
    expect(formatTokenSum([{ symbol: 'SPY', amount: 0.02 }, { symbol: 'USDG', amount: 26.1 }])).toBe('0.02 SPY + 26.1 USDG');
    expect(formatTokenSum([{ symbol: 'NVDA', amount: 0.00016568 }, { symbol: 'USDG', amount: -1.4052 }], 5)).toBe('0.00016568 NVDA − 1.4052 USDG');
    expect(formatTokenSum([{ symbol: 'USDG', amount: -3 }])).toBe('−3 USDG');
    expect(formatTokenSum([])).toBe('—');
  });
  it('the shared module is framework-free: no imports at all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/shared/generated.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import\b/m);
  });
});

describe('estimates from Generated (shared)', () => {
  const D = 86_400;
  it('none under a day', () => {
    expect(estimates([{ symbol: 'SPY', amount: 1 }], 23 * 3600).h24).toBeNull();
  });
  it('per token over 1, 7 and 365 days', () => {
    const e = estimates([{ symbol: 'SPY', amount: 0.04 }, { symbol: 'USDG', amount: 52.2 }], 2 * D);
    expect(e.h24![0].amount).toBeCloseTo(0.02, 12);
    expect(e.h24![1].amount).toBeCloseTo(26.1, 9);
    expect(e.d7![1].amount).toBeCloseTo(182.7, 9);
    expect(e.d365![0].amount).toBeCloseTo(7.3, 9);
  });
});
