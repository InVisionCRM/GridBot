import { describe, expect, it } from 'vitest';
import { capGridEntry, capLpEntry, capSwap, entryCostFraction, impactOf, maxQuoteIn } from '../src/market/poolSize';

describe('pool sizing', () => {
  it('price impact is the fee-adjusted input over the reserve plus that input', () => {
    expect(impactOf(0, 1000, 0.003)).toBe(0);
    expect(impactOf(100, 0, 0.003)).toBe(1);
    const fee = 0.003;
    const inn = 100 * (1 - fee);
    expect(impactOf(100, 1000, fee)).toBeCloseTo(inn / (1000 + inn), 12);
  });

  it('the most you can spend at a 3% cap is cap/(1-cap) of the reserve, after the fee', () => {
    const fee = 0.003;
    expect(maxQuoteIn(10_000, fee, 0.03)).toBeCloseTo((0.03 / 0.97) * 10_000 / (1 - fee), 8);
    expect(maxQuoteIn(10_000, fee, 0)).toBe(0);
  });

  it('a swap is cut by the tighter of the impact cap and the pool-share cap', () => {
    const deep = capSwap({ quoteIn: 100, quoteReserve: 1_000_000, feeBps: 30, maxImpact: 0.03, maxPoolShare: 0.02 });
    expect(deep.why).toBeNull();
    expect(deep.amount).toBe(100);

    const thin = capSwap({ quoteIn: 10_000, quoteReserve: 1_000, feeBps: 100, maxImpact: 0.03, maxPoolShare: 0.5 });
    expect(thin.amount).toBeLessThan(400);
    expect(thin.impact).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(thin.why).toMatch(/price moves/);

    const share = capSwap({ quoteIn: 10_000, quoteReserve: 1_000, feeBps: 30, maxImpact: 0.5, maxPoolShare: 0.02 });
    expect(share.amount).toBeCloseTo(20, 6);
    expect(share.why).toMatch(/2% of the pool/);
  });

  it('a $10k liquidity entry on a shallow active range is cut to 10% of that range, not the headline liquidity', () => {
    // $47.9k reported, but only $5k sits in range. 10% of the pool after the deposit is ~$556, not $10k.
    const fit = capLpEntry({ capital: 10_000, quoteReserve: 50_000, feeBps: 100, maxImpact: 0.03, activeQuote: 5_000 });
    expect(fit.amount).toBeCloseTo((0.1 / 0.9) * 5_000, 4);
    expect(fit.why).toMatch(/active liquidity/);
    expect(fit.amount / (5_000 + fit.amount)).toBeCloseTo(0.1, 6);
  });

  it('an entry swap that would move the price 18% is cut under the 3% cap', () => {
    const fit = capLpEntry({ capital: 10_000, quoteReserve: 1_000, feeBps: 100, maxImpact: 0.03, activeQuote: 1_000_000 });
    expect(fit.amount).toBeLessThan(100);
    expect(fit.impact).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(fit.why).toMatch(/would move the price/);
  });

  it('a grid is sized so the buys that fire at the open fit the same caps', () => {
    const fit = capGridEntry({ capital: 10_000, quoteReserve: 1_000, feeBps: 30, maxImpact: 0.03, gridCount: 10 });
    expect(fit.amount).toBeLessThan(200);
    expect(fit.why).toMatch(/suggested/);
    const deep = capGridEntry({ capital: 1_000, quoteReserve: 1_000_000, feeBps: 30, maxImpact: 0.03, gridCount: 10 });
    expect(deep.amount).toBe(1_000);
    expect(deep.why).toBeNull();
  });

  it('a pool you cannot enter even with a 1% slice is not ranked', () => {
    expect(entryCostFraction({ capital: 10_000, quoteReserve: 1, feeBps: 30, maxImpact: 0.03 })).toBeNull();
    const cost = entryCostFraction({ capital: 1_000, quoteReserve: 1_000_000, feeBps: 30, maxImpact: 0.03, buyTax: 0.01 });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
    expect(cost!).toBeLessThan(0.05);
  });
});
