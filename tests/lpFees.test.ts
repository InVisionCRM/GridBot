import { describe, expect, it } from 'vitest';
import { feeHuman, feePace, feesBetween, feesFromGrowth } from '../src/market/lpFees';
import { lpRemovable, mintInBytecode, MINT_SELECTOR } from '../src/market/tokenChecks';

describe('on-chain fee pace', () => {
  it('turns a fee-growth delta into token units, then into a volume scale', () => {
    const liq = 1n << 80n;
    const growth = 5n << 40n;
    const raw = feesFromGrowth(liq, 0n, growth);
    expect(raw).toBe(liq * growth / (1n << 128n));
    expect(feesFromGrowth(liq, growth, growth)).toBe(0n);
    expect(feeHuman(1_500_000n, 6)).toBeCloseTo(1.5, 9);

    const hour = 3600_000;
    const pace = feePace({ feesUsd: 100, windowMs: 24 * hour, feeBps: 100, candleVolumeUsd: 50_000 });
    expect(pace).toMatchObject({ feesUsd: 100, volumeUsd: 10_000, scale: 0.2 });
    expect(feePace({ feesUsd: 0, windowMs: 24 * hour, feeBps: 100, candleVolumeUsd: 50_000 })!.scale).toBe(0);
    expect(feePace({ feesUsd: 1, windowMs: 1000, feeBps: 100, candleVolumeUsd: 1 })).toBeNull();
    expect(feePace({ feesUsd: 1, windowMs: 20 * 24 * hour, feeBps: 100, candleVolumeUsd: 1 })).toBeNull();
  });

  it('fees between two readings use the smaller liquidity and ignore a window under an hour', () => {
    const liq = 1n << 80n;
    const growth = 5n << 40n;
    const raw = feesFromGrowth(liq, 0n, growth);
    const human = feeHuman(raw, 6);
    const day = feesBetween({
      atThen: 0, now: 24 * 3600_000, liquidityThen: liq, liquidityNow: liq * 2n,
      g0Then: 0n, g0Now: growth, g1Then: 0n, g1Now: 0n, dec0: 6, dec1: 18, usd0: 2, usd1: 1,
    });
    expect(day).toEqual({ feesUsd: human * 2, windowMs: 24 * 3600_000 });
    expect(feesBetween({
      atThen: 0, now: 1000, liquidityThen: liq, liquidityNow: liq,
      g0Then: 0n, g0Now: growth, g1Then: 0n, g1Now: 0n, dec0: 6, dec1: 18, usd0: 1, usd1: 1,
    })).toBeNull();
  });
});

describe('cheap token checks', () => {
  it('sees mint(address,uint256) in bytecode and treats unknown code as unknown', () => {
    expect(mintInBytecode(null)).toBeNull();
    expect(mintInBytecode('0x')).toBeNull();
    expect(mintInBytecode('0x60806040')).toBe(false);
    expect(mintInBytecode('0x6080' + MINT_SELECTOR + '60')).toBe(true);
  });

  it('locked liquidity is burned; an owner holding most of the LP can pull it', () => {
    expect(lpRemovable(1000n, 950n, 10n)).toBe(false);
    expect(lpRemovable(1000n, 100n, 600n)).toBe(true);
    expect(lpRemovable(1000n, 100n, 200n)).toBeNull();
    expect(lpRemovable(0n, 0n, 0n)).toBeNull();
  });
});
