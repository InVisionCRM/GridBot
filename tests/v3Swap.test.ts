import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, HARD_CAPS } from '../src/live/limits';
import { amountToUnits } from '../src/live/decimals';
import type { MarketDef } from '../src/live/markets';
import { v3ActiveRangeOut, v3AmountImpact, v3ExactIn } from '../src/live/v3Swap';
import { DEFAULT_TRADER } from '../src/server/bot/tokenTrader';
import { depthAt } from '../src/server/dex/safety';
import type { DexAdapter } from '../src/server/dex/types';

const wide = { sqrtLower: 1, sqrtUpper: 1.2, liquidity: 1_000_000 };
const thin = { sqrtLower: 0.5, sqrtUpper: 1, liquidity: 1_000 };
const sqrtPrice = 1.01;
const feePips = 3000;

describe('V3 tick walk', () => {
  it('matches constant-product math while the trade stays inside the active range', () => {
    const amountIn = 1_000;
    const walked = v3ExactIn({ ranges: [thin, wide], sqrtPrice, amountIn, feePips, zeroForOne: true });
    const cp = v3ActiveRangeOut(sqrtPrice, wide.liquidity, amountIn, feePips, true);
    expect(walked.crossed).toBe(0);
    expect(walked.amountOut).toBeCloseTo(cp, 4);
    const impact = v3AmountImpact(amountIn, walked.amountOut, sqrtPrice, feePips, true);
    expect(impact).toBeLessThan(0.01);
  });

  it('charges more impact once the trade leaves the active range than constant-product math does', () => {
    const amountIn = 2_000_000;
    const walked = v3ExactIn({ ranges: [thin, wide], sqrtPrice, amountIn, feePips, zeroForOne: true });
    const cp = v3ActiveRangeOut(sqrtPrice, wide.liquidity, amountIn, feePips, true);
    expect(walked.crossed).toBeGreaterThan(0);
    expect(walked.amountOut).toBeLessThan(cp);
    const walkImpact = v3AmountImpact(amountIn, walked.amountOut, sqrtPrice, feePips, true);
    const cpImpact = v3AmountImpact(amountIn, cp, sqrtPrice, feePips, true);
    expect(walkImpact).toBeGreaterThan(cpImpact);
    expect(walkImpact).toBeGreaterThan(0.01);
    expect(cpImpact).toBeLessThan(walkImpact);
  });
});

describe('existing impact caps', () => {
  it('keeps the 3% sizing cap, the 5% hard cap, and depth quotes at $100, $500 and $1000', async () => {
    expect(DEFAULT_TRADER.maxImpact).toBe(0.03);
    expect(DEFAULT_TRADER.enforceSizeImpact).toBe(false);
    expect(DEFAULT_TRADER.sizeImpactCap).toBe(0.01);
    expect(DEFAULT_LIMITS.maxPriceImpact).toBe(0.03);
    expect(HARD_CAPS.maxPriceImpact).toBe(0.05);
    const amounts: bigint[] = [];
    const ad = {
      quote: async (_p: unknown, _a: unknown, _b: unknown, amount: bigint) => {
        amounts.push(amount);
        return { amountOut: 1n, impact: 0.01 };
      },
    };
    const m = {
      pool: { dex: 'x', kind: 'v3', address: '0x' + 'ab'.repeat(20), feeBps: 30 },
      quote: { address: '0x' + '11'.repeat(20), symbol: 'W', decimals: 18 },
      base: { address: '0x' + '22'.repeat(20), symbol: 'T', decimals: 18 },
    } as MarketDef;
    const rows = await depthAt(ad as unknown as DexAdapter, m, 1, 1);
    expect(rows.map((r) => r.usd)).toEqual([100, 500, 1000]);
    const want = [100, 500, 1000].flatMap((n) => [amountToUnits(n, 18).toString(), amountToUnits(n, 18).toString()]);
    expect(amounts.map(String).sort()).toEqual([...want].sort());
  });
});
