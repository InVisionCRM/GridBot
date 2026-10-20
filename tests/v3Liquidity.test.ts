import { describe, expect, it } from 'vitest';
import { alignTick, amountsForLiquidity, feesOwed, liquidityForAmounts, Q128, sqrtPriceAt, tickAtPrice } from '../src/live/v3Liquidity';

describe('ticks ↔ prices', () => {
  it('matches the tick live pools report for their √price (read 2026-10-18)', () => {
    const tickOf = (sqrtPriceX96: bigint) => { const s = Number(sqrtPriceX96) / 2 ** 96; return tickAtPrice(s * s); };
    expect(tickOf(3850190383614278318148612n)).toBe(-198650); // Robinhood ETH/USDG 0.01%
    expect(tickOf(1629417751998552853705324386867915n)).toBe(198637); // Ethereum WETH/USDC 0.05%
    expect(tickOf(180044028148541107276158607n)).toBe(-121744); // 9mm WPLS/DAI 0.25%
  });
  it('round-trips and aligns outward to the spacing', () => {
    expect(sqrtPriceAt(0)).toBe(1);
    expect(tickAtPrice(sqrtPriceAt(1234) ** 2 * (1 + 1e-12))).toBe(1234);
    expect(alignTick(-198653, 10, 'down')).toBe(-198660);
    expect(alignTick(-198653, 10, 'up')).toBe(-198650);
    expect(alignTick(887272, 60, 'up')).toBe(887220); // never past the usable max
  });
});

describe('liquidity ↔ amounts', () => {
  const sa = sqrtPriceAt(-1000), sb = sqrtPriceAt(1000), s = sqrtPriceAt(200);
  it('a position funded by amounts holds those amounts back (the binding side exactly)', () => {
    const L = liquidityForAmounts(s, sa, sb, 1e18, 5e18);
    const a = amountsForLiquidity(s, sa, sb, L);
    expect(a.amount0 <= 1e18 * (1 + 1e-12) && a.amount1 <= 5e18 * (1 + 1e-12)).toBe(true);
    expect(Math.max(a.amount0 / 1e18, a.amount1 / 5e18)).toBeCloseTo(1, 12);
  });
  it('below the range it is all token0, above all token1', () => {
    expect(amountsForLiquidity(sqrtPriceAt(-2000), sa, sb, 1e6)).toMatchObject({ amount1: 0 });
    expect(amountsForLiquidity(sqrtPriceAt(2000), sa, sb, 1e6)).toMatchObject({ amount0: 0 });
  });
});

describe('fees (exact uint256 math, like the pool)', () => {
  it('owed = Δcounter × L / 2^128', () => {
    expect(feesOwed(3n * Q128, Q128, 10n)).toBe(20n);
    expect(feesOwed(1n, 2n ** 256n - 1n, Q128)).toBe(2n); // wrapped Δ = 2
  });
});
