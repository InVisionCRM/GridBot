import { describe, expect, it } from 'vitest';
import { humanAmount } from '../src/live/amount';
import { amountsForLiquidity, sqrtPriceAt } from '../src/live/v3Liquidity';
import {
  assemblePortfolio, bigRatio, feeGrowthInside, feeLabelOf, formatTokenAmount, formatUsdAmount, formatUsdChip,
  isDustAmount, rawPrice1Per0, sqrtPriceX96AtTick, uncollectedRaw, usdFromOther, v2Share, v3TokenAmounts, Q96,
  type BotRef,
} from '../src/live/holdingsMath';

describe('sqrt price at a tick', () => {
  it('is 2^96 at tick 0, and the price tracks 1.0001^tick', () => {
    expect(sqrtPriceX96AtTick(0)).toBe(Q96);
    for (const tick of [-100_000, -1, 1, 1_000, 198637]) {
      const s = Number(sqrtPriceX96AtTick(tick)) / 2 ** 96;
      const want = sqrtPriceAt(tick);
      expect(Math.abs(s - want) / want).toBeLessThan(1e-9);
    }
  });
});

describe('V3 liquidity → token amounts', () => {
  const tickLower = -1200, tickUpper = 1200, L = 10n ** 18n;

  it('is entirely token0 below the range and entirely token1 above it', () => {
    const below = v3TokenAmounts({ liquidity: L, sqrtPriceX96: sqrtPriceX96AtTick(-5_000), tick: -5_000, tickLower, tickUpper });
    expect(below.range).toBe('below');
    expect(below.amount1).toBe(0n);
    expect(below.amount0 > 0n).toBe(true);

    const above = v3TokenAmounts({ liquidity: L, sqrtPriceX96: sqrtPriceX96AtTick(5_000), tick: 5_000, tickLower, tickUpper });
    expect(above.range).toBe('above');
    expect(above.amount0).toBe(0n);
    expect(above.amount1 > 0n).toBe(true);
  });

  it('holds both tokens inside the range, and the upper tick itself is out', () => {
    const tick = 200;
    const sqrt = sqrtPriceX96AtTick(tick);
    const got = v3TokenAmounts({ liquidity: L, sqrtPriceX96: sqrt, tick, tickLower, tickUpper });
    expect(got.range).toBe('in');
    expect(got.amount0 > 0n).toBe(true);
    expect(got.amount1 > 0n).toBe(true);
    const s = Number(sqrt) / 2 ** 96;
    const exp = amountsForLiquidity(s, sqrtPriceAt(tickLower), sqrtPriceAt(tickUpper), Number(L));
    expect(Math.abs(Number(got.amount0) - exp.amount0) / exp.amount0).toBeLessThan(1e-6);
    expect(Math.abs(Number(got.amount1) - exp.amount1) / exp.amount1).toBeLessThan(1e-6);

    const edge = v3TokenAmounts({ liquidity: L, sqrtPriceX96: sqrtPriceX96AtTick(tickUpper), tick: tickUpper, tickLower, tickUpper });
    expect(edge.range).toBe('above');
    expect(edge.amount0).toBe(0n);
  });

  it('stays exact for a liquidity value a float cannot hold', () => {
    const huge = v3TokenAmounts({ liquidity: 10n ** 40n, sqrtPriceX96: sqrtPriceX96AtTick(-10), tick: -10, tickLower: 0, tickUpper: 60 });
    expect(huge.range).toBe('below');
    expect(huge.amount1).toBe(0n);
    expect(huge.amount0 > 10n ** 20n).toBe(true);
  });

  it('zero liquidity is an empty position that still knows which side of the range it is on', () => {
    const z = v3TokenAmounts({ liquidity: 0n, sqrtPriceX96: sqrtPriceX96AtTick(0), tick: 0, tickLower: -10, tickUpper: 10 });
    expect(z).toMatchObject({ amount0: 0n, amount1: 0n, range: 'in' });
  });
});

describe('V2 LP share', () => {
  it('is the wallet’s fraction of the reserves, rounded down', () => {
    expect(v2Share(1n, 4n, 100n, 40n)).toEqual({ amount0: 25n, amount1: 10n });
    expect(v2Share(1n, 3n, 10n, 10n)).toEqual({ amount0: 3n, amount1: 3n });
    expect(v2Share(0n, 100n, 5n, 5n)).toEqual({ amount0: 0n, amount1: 0n });
    expect(v2Share(5n, 0n, 5n, 5n)).toEqual({ amount0: 0n, amount1: 0n });
  });
});

describe('uncollected fees', () => {
  it('adds growth since the snapshot to tokens already owed', () => {
    const inside = feeGrowthInside({ tick: 0, tickLower: -10, tickUpper: 10, global: 1_000n, lowerOutside: 100n, upperOutside: 50n });
    expect(inside).toBe(850n);
    const below = feeGrowthInside({ tick: -20, tickLower: -10, tickUpper: 10, global: 1_000n, lowerOutside: 100n, upperOutside: 50n });
    expect(below).toBe(50n);
    expect(uncollectedRaw(5n, 850n, 800n, 0n)).toBe(5n);
    expect(uncollectedRaw(5n, inside, 800n, 2n ** 128n)).toBe(5n + 50n);
  });
});

describe('dollar cross from a pool price', () => {
  it('prices the other token from a known side', () => {
    const raw = rawPrice1Per0(sqrtPriceX96AtTick(0));
    expect(raw).toBeCloseTo(1, 8);
    // equal decimals, price 1: the other side is the same dollar price
    expect(usdFromOther(2, raw, 18, 18, 0)).toBeCloseTo(2, 6);
    // USDC is 6 decimals, WETH 18. raw token1 per token0 of 1e12 means 1 USDC per 1 WETH when token0 is WETH... 
    // human1 per human0 = raw * 10^(dec0-dec1). If token0 is USDC (6) and token1 is WETH (18), a raw of 1e12 is 1e12 * 10^(6-18) = 0.001 WETH per USDC? Let's just check the formula inverts.
    const usd1 = usdFromOther(1, 2, 18, 6, 0);
    expect(usd1).toBeCloseTo(1 / (2 * 10 ** (18 - 6)), 12);
    expect(usdFromOther(usd1!, 2, 18, 6, 1)).toBeCloseTo(1, 6);
    expect(bigRatio(2n * 10n ** 18n, 10n ** 18n)).toBeCloseTo(2, 8);
  });
});

describe('dust and small-number formatting', () => {
  it('does not print scientific notation for a tiny balance', () => {
    expect(formatTokenAmount(9.3e-10)).toBe('0.00000000093');
    expect(formatTokenAmount(9.3e-10)).not.toMatch(/e/i);
    expect(formatTokenAmount(0.00005485)).toBe('0.00005485');
    expect(formatTokenAmount(0.3385)).toBe('0.3385');
    expect(formatTokenAmount(7_518_000)).toBe('7.518M');
    expect(formatTokenAmount(31_210)).toBe('31.21K');
    expect(formatTokenAmount(0)).toBe('0');
    expect(formatUsdAmount(116.5)).toBe('$116.50');
    expect(formatUsdAmount(116.5)).not.toMatch(/e/i);
    expect(formatUsdChip(84_300)).toBe('$84.3k');
    expect(humanAmount(9.3e-10)).toBe('0.00000000093');
    expect(humanAmount(9.3e-10)).not.toMatch(/e/i);
    expect(humanAmount(0.0123456)).toBe('0.01235');
  });

  it('treats under $0.01 as dust, and an unpriced speck as dust, but not a real unpriced balance', () => {
    expect(isDustAmount(0.009, 1_000_000)).toBe(true);
    expect(isDustAmount(0.01, 1)).toBe(false);
    expect(isDustAmount(null, 9.3e-10)).toBe(true);
    expect(isDustAmount(null, 2)).toBe(false);
  });
});

describe('portfolio assembly', () => {
  const grid: BotRef = { id: 'g1', kind: 'grid', name: 'Grid HEX/PLS', status: 'running', mode: 'live' };
  const chain = { id: 369, name: 'PulseChain', short: 'PLS', color: '#e040fb', address: '0xabc' };

  it('counts liquidity and fees on top of the wallet, and treats bot grids as a slice of the wallet', () => {
    const coin = (amount: number, usdEach: number | null, symbol: string, address: string | null) =>
      ({ chainId: 369, address, symbol, decimals: 18, amount, usdEach });
    const snap = assemblePortfolio({
      address: '0x416800000000000000000000000000000000309d',
      at: 1, hasSigner: true, chains: [chain], errors: [],
      wallet: [
        { ...coin(100, 1, 'PLS', null), bots: [{ bot: grid, amount: 40 }] },
        { ...coin(9.3e-10, null, 'MORB', '0xmor'), bots: [] },
      ],
      positions: [{
        chainId: 369, kind: 'v3', dexName: '9mm V3', pool: '0xpool', feeLabel: '0.25%', tokenId: '5', range: 'in',
        token0: coin(10, 1, 'WPLS', '0xwpls'), token1: coin(5, 1, 'DAI', '0xdai'),
        fee0: coin(1, 1, 'WPLS', '0xwpls'), fee1: coin(0.5, 1, 'DAI', '0xdai'),
        bot: null, stranded: true, idleNote: null, leftover: false,
      }],
    });
    expect(snap.walletUsd).toBe(100);
    expect(snap.botsUsd).toBe(40);
    expect(snap.freeUsd).toBe(60);
    expect(snap.lpUsd).toBe(15);
    expect(snap.feesUsd).toBe(1.5);
    expect(snap.netWorthUsd).toBe(116.5);
    expect(snap.freeUsd + snap.botsUsd + snap.lpUsd + snap.feesUsd).toBe(snap.netWorthUsd);
    expect(snap.overdrawn).toBe(false);
    expect(snap.wallet.find((w) => w.coin.symbol === 'MORB')?.dust).toBe(true);
    expect(snap.netWorthExDustUsd).toBe(116.5);
    expect(snap.positions[0]).toMatchObject({ stranded: true, range: 'in', usd: 15 });
    expect(snap.fees[0].usd).toBe(1.5);
    expect(snap.bots[0].bot.name).toBe('Grid HEX/PLS');
    expect(snap.chains[0].usd).toBe(116.5);
  });

  it('does not let bot books inflate net worth past the wallet', () => {
    const snap = assemblePortfolio({
      address: '0x1', at: 1, hasSigner: true, chains: [chain], errors: [],
      wallet: [{ chainId: 369, address: null, symbol: 'PLS', decimals: 18, amount: 100, usdEach: 1, bots: [{ bot: grid, amount: 150 }] }],
      positions: [],
    });
    expect(snap.netWorthUsd).toBe(100);
    expect(snap.botsUsd).toBe(100);
    expect(snap.freeUsd).toBe(0);
    expect(snap.overdrawn).toBe(true);
    expect(snap.bots[0].usd).toBe(150);
  });

  it('labels a fee tier without dumping a raw integer', () => {
    expect(feeLabelOf('v3', 500)).toBe('0.05%');
    expect(feeLabelOf('v3', 3000)).toBe('0.3%');
    expect(feeLabelOf('v2', 29)).toBe('0.29%');
  });
});
