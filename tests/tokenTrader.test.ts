import { describe, expect, it } from 'vitest';
import { TAX_TOLERANCE } from '../src/live/tax';
import { readFileSync } from 'node:fs';
import {
  decideExit, filterFresh, fromDexPair, fromTopPool, gateToken, replay, sizeBuy, splitSell,
  type ExitPos, type FreshPool, type GateInput,
} from '../src/market/tokenTrader';
import { effectiveMinLiquidityUsd, ENFORCED_LIQUIDITY_FLOOR_USD, gateMinLiquidityUsd, shownMinLiquidityUsd } from '../src/market/liquidityFloor';

const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 50_000, minLiquidityUsd: 5_000,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: false,
  holderConcentration: 0.1, recentLiqPull: false, liveAllowed: true, ...o,
});

const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uniswap', kind: 'v2',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
  tokenSymbol: 'NEW', spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 20_000,
  createdAt: 1, source: 'new', quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000, ...o,
});

const pos = (o: Partial<ExitPos> = {}): ExitPos => ({
  entryPrice: 1, price: 1, peak: 1, openedAt: 0, now: 60_000, entryVolume: 1000, volume: 1000,
  entryLiq: 10_000, liq: 10_000, sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1, ...o,
});

describe('fresh-pool filter', () => {
  const now = 100 * 3600_000;
  it('keeps a pool old enough or of unknown age, and skips a young one and V4', () => {
    const r = filterFresh([
      pool({ pool: '0x' + '01'.repeat(20), createdAt: now - 3600_000 }),
      pool({ pool: '0x' + '02'.repeat(20), createdAt: now - 48 * 3600_000 }),
      pool({ pool: '0x' + '03'.repeat(20), createdAt: null }),
      pool({ pool: '0x' + '04'.repeat(20), kind: 'v4', createdAt: now - 48 * 3600_000 }),
    ], { now, minAgeMs: 24 * 3600_000 });
    expect(r.keep.map((p) => p.pool.slice(2, 4))).toEqual(['02', '03']);
    expect(r.skipped.map((s) => s.why).join(' | ')).toMatch(/minimum 24h/);
    expect(r.skipped.map((s) => s.why).join(' | ')).toMatch(/doesn't swap V4/);
  });

  it('drops a duplicate and a pool with no price', () => {
    const a = pool();
    const r = filterFresh([a, { ...a }, pool({ pool: '0x' + '05'.repeat(20), price: 0 })], { now, minAgeMs: 0 });
    expect(r.keep).toHaveLength(1);
    expect(r.skipped.map((s) => s.why)).toEqual(['already seen', 'no price or depth']);
  });
});

describe('safety gate', () => {
  it('blocks a honeypot, a failed sell, a pause, bad decimals, thin liquidity, a mint and a pulled pool in both modes', () => {
    for (const mode of ['paper', 'live'] as const) {
      expect(gateToken(clean({ mode, honeypot: true })).reason).toMatch(/honeypot/);
      expect(gateToken(clean({ mode, sellSimOk: false })).reason).toMatch(/sell simulation/);
      expect(gateToken(clean({ mode, paused: true })).reason).toMatch(/paused/);
      expect(gateToken(clean({ mode, decimals: null })).reason).toMatch(/decimals/);
      expect(gateToken(clean({ mode, liquidityUsd: 100, minLiquidityUsd: 5_000 })).reason).toMatch(/under the/);
      expect(gateToken(clean({ mode, canMint: true })).reason).toMatch(/mint/);
      expect(gateToken(clean({ mode, recentLiqPull: true })).reason).toMatch(/pulled/);
    }
  });

  it('safe blocks a proxy, a blacklist, any tax and a concentrated holder; unknown concentration is not a block', () => {
    expect(gateToken(clean({ proxy: true })).reason).toMatch(/upgradeable/);
    expect(gateToken(clean({ canBlacklist: true })).reason).toMatch(/blacklist/);
    expect(gateToken(clean({ sellTax: TAX_TOLERANCE + 0.01 })).reason).toMatch(/safe allows none/);
    expect(gateToken(clean({ holderConcentration: 0.6 })).reason).toMatch(/one holder/);
    expect(gateToken(clean({ holderConcentration: null })).ok).toBe(true);
    expect(gateToken(clean({ lpUnlocked: null, canPause: null })).ok).toBe(true);
  });

  it('ignores a trade-size impact unless that check is on, then caps it and fails closed when the quote is missing', () => {
    const base = gateToken(clean());
    expect(gateToken(clean({ sizeImpact: 0.2, enforceSizeImpact: false }))).toEqual(base);
    expect(gateToken(clean({ enforceSizeImpact: true, sizeImpact: 0.009 })).ok).toBe(true);
    expect(gateToken(clean({ enforceSizeImpact: true, sizeImpact: 0.01 })).ok).toBe(true);
    expect(gateToken(clean({ enforceSizeImpact: true, sizeImpact: 0.02 })).reason).toMatch(/2\.00% at this size is over the 1\.00%/);
    expect(gateToken(clean({ enforceSizeImpact: true, sizeImpact: null })).reason).toMatch(/could not be verified/);
    expect(gateToken(clean({ risk: 'any', enforceSizeImpact: true, sizeImpact: null })).ok).toBe(false);
    expect(gateToken(clean({ enforceSizeImpact: true, sizeImpact: 0.02, sizeImpactCap: 0.03 })).ok).toBe(true);
  });

  it('medium allows a proxy and a small tax under the cap, and still blocks a pause function and unlocked liquidity', () => {
    expect(gateToken(clean({ risk: 'medium', proxy: true, sellTax: 0.05 })).ok).toBe(true);
    expect(gateToken(clean({ risk: 'medium', canPause: true })).reason).toMatch(/pause/);
    expect(gateToken(clean({ risk: 'medium', lpUnlocked: true })).reason).toMatch(/unlocked/);
    expect(gateToken(clean({ risk: 'medium', sellTax: 0.2 })).reason).toMatch(/over the/);
  });

  it('any blocks only the hard failures, and live still needs the existing classifier', () => {
    expect(gateToken(clean({ risk: 'any', proxy: true, canPause: true, canBlacklist: true, sellTax: 0.05, lpUnlocked: true })).ok).toBe(true);
    expect(gateToken(clean({ mode: 'live', risk: 'any', liveAllowed: false })).reason).toMatch(/does not allow live/);
    expect(gateToken(clean({ mode: 'live', risk: 'any', sellTax: 0.2 })).reason).toMatch(/live cap/);
    const paperTax = gateToken(clean({ mode: 'paper', risk: 'any', sellTax: 0.05 }));
    expect(paperTax.ok).toBe(true);
    expect(paperTax.liveOk).toBe(true);
  });
});

describe('sizing and exits', () => {
  it('sizes under the per-trade limit, the room left in the total, the impact cap and 2% of the pool, and counts buy tax', () => {
    const fit = sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 0, quoteReserve: 1_000_000, usdPerSpend: 1, feeBps: 30, price: 1, maxImpact: 0.03 });
    expect(fit!.usd).toBeCloseTo(100, 4);
    expect(fit!.impact).toBeLessThan(0.01);

    const room = sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 450, quoteReserve: 1_000_000, usdPerSpend: 1, feeBps: 30, price: 1, maxImpact: 0.03 });
    expect(room!.usd).toBeCloseTo(50, 4);

    const thin = sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 0, quoteReserve: 100, usdPerSpend: 1, feeBps: 30, price: 1, maxImpact: 0.03, maxPoolShare: 0.02 });
    expect(thin!.spend).toBeCloseTo(2, 6);
    expect(thin!.why).toMatch(/2%/);

    const taxed = sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 0, quoteReserve: 1_000_000, usdPerSpend: 1, feeBps: 30, buyTax: 0.1, price: 1, maxImpact: 0.03 });
    expect(taxed!.tokens).toBeLessThan(fit!.tokens);
    expect(sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 500, quoteReserve: 1_000_000, usdPerSpend: 1, feeBps: 30, price: 1, maxImpact: 0.03 })).toBeNull();
  });

  it('exits in priority order and splits a sell that would cross the impact cap', () => {
    expect(decideExit(pos()).action).toBe('hold');
    const both = decideExit(pos({ price: 0.5, sellSimOk: false, sellTax: 0.2, liq: 100 }));
    expect(both).toMatchObject({ action: 'sell', frac: 1 });
    expect(both.action === 'sell' && both.why).toMatch(/sell simulation/);
    expect(decideExit(pos({ sellTax: 0.02 })).action === 'sell' && decideExit(pos({ sellTax: 0.02 })).why).toMatch(/tax rose/);
    expect(decideExit(pos({ liq: 5_000 })).why).toMatch(/liquidity down/);
    expect(decideExit(pos({ price: 0.7 })).why).toMatch(/hard stop/);
    expect(decideExit(pos({ price: 1.2, peak: 1.6 })).why).toMatch(/trailing stop/);
    expect(decideExit(pos({ price: 1.2, peak: 1.25 })).action).toBe('hold');
    const tp = decideExit(pos({ price: 1.6 }));
    expect(tp).toMatchObject({ action: 'sell', frac: 1 / 3 });
    expect(tp.action === 'sell' && tp.why).toMatch(/sell a third/);
    const tp2 = decideExit(pos({ price: 2.1, tp1Done: true, remainingFrac: 2 / 3 }));
    expect(tp2).toMatchObject({ action: 'sell', frac: 1 / 3 });
    expect(decideExit(pos({ now: 7 * 3600_000, price: 1.05 })).why).toMatch(/time stop/);
    expect(decideExit(pos({ now: 7 * 3600_000, price: 1.2 })).action).toBe('hold');
    expect(decideExit(pos({ volume: 100, price: 0.99 })).why).toMatch(/volume fell/);
    expect(decideExit(pos({ volume: 100, price: 1.05 })).action).toBe('hold');

    const parts = splitSell(100, 1_000, 30, 0.03);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((s, n) => s + n, 0)).toBeCloseTo(100, 6);
    const room = (0.03 / 0.97) * 1_000 / (1 - 0.003);
    expect(Math.max(...parts)).toBeLessThanOrEqual(room * 1.01);
    expect(splitSell(1, 1_000_000, 30, 0.03)).toEqual([1]);
  });
});

describe('replay and discovery rows', () => {
  it('a pump takes both profits then the trail; a dump hits the hard stop', () => {
    const hour = 3600_000;
    const pump = replay([
      { t: 0, price: 1, volume: 1000, liq: 100_000 },
      { t: hour, price: 1.6, volume: 1000, liq: 100_000 },
      { t: 2 * hour, price: 2.2, volume: 1000, liq: 100_000 },
      { t: 3 * hour, price: 1.5, volume: 1000, liq: 100_000 },
    ], { spend: 100 });
    expect(pump.buys).toBe(1);
    expect(pump.exits[0]).toMatch(/take profit/);
    expect(pump.exits[1]).toMatch(/take profit/);
    expect(pump.exits.at(-1)).toMatch(/trailing stop/);
    expect(pump.held).toBe(false);
    expect(pump.pnlPct).toBeGreaterThan(0.5);

    const dump = replay([
      { t: 0, price: 1, volume: 1000, liq: 100_000 },
      { t: hour, price: 0.7, volume: 1000, liq: 100_000 },
    ], { spend: 100 });
    expect(dump.exits[0]).toMatch(/hard stop/);
    expect(dump.pnlPct).toBeLessThan(-0.2);
    expect(dump.pnlPct).toBeGreaterThan(-0.4);
  });

  it('reads a token/stable gecko pool and a dexscreener pair, and skips two stables', () => {
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const TOKEN = '0x' + '11'.repeat(20);
    const g = fromTopPool({
      address: '0x' + 'ab'.repeat(20), name: 'NEW / WETH', dex: 'uniswap_v3', base: TOKEN, quote: WETH,
      liquidityUsd: 40_000, volume24Usd: 8_000, createdAt: 10, basePriceUsd: 2, quotePriceUsd: 2000,
    }, { id: 1, spend: [WETH, USDC], kind: 'v3', feeBps: 100 });
    expect(g).toMatchObject({ token: TOKEN, spend: WETH, price: 0.001, usdPerSpend: 2000, feeBps: 100, source: 'new' });
    expect(fromTopPool({
      address: '0x' + 'cd'.repeat(20), name: 'USDC / WETH', dex: 'uniswap_v3', base: USDC, quote: WETH,
      liquidityUsd: 1e6, volume24Usd: 1e6, createdAt: null, basePriceUsd: 1, quotePriceUsd: 2000,
    }, { id: 1, spend: [WETH, USDC] })).toBeNull();

    const d = fromDexPair({
      chainId: 'pulsechain', dexId: 'pulsex', pairAddress: '0x' + 'ef'.repeat(20),
      baseToken: { address: TOKEN, symbol: 'NEW' }, quoteToken: { address: WETH, symbol: 'WPLS' },
      priceNative: '0.5', priceUsd: '0.00002', liquidity: { usd: 20_000 }, volume: { h24: 1000 }, pairCreatedAt: 5,
    }, { id: 369, dexId: 'pulsechain', spend: new Set([WETH]), wrapped: WETH });
    expect(d).toMatchObject({ chainId: 369, token: TOKEN, spend: WETH, price: 0.5, source: 'new' });
    expect(fromDexPair({
      chainId: 'ethereum', dexId: 'uni', pairAddress: '0x' + 'ef'.repeat(20),
      baseToken: { address: TOKEN, symbol: 'NEW' }, quoteToken: { address: WETH, symbol: 'WETH' },
    }, { id: 369, dexId: 'pulsechain', spend: new Set([WETH]), wrapped: WETH })).toBeNull();
  });
});

describe('liquidity floor', () => {
  it('defaults to the old floor of 0, so the $50,000 flag does nothing while it is off', () => {
    expect(effectiveMinLiquidityUsd({})).toBe(0);
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 0, enforceLiquidityFloor: false })).toBe(0);
    expect(gateMinLiquidityUsd({ source: 'new' }, 0, {})).toBe(0);
    expect(shownMinLiquidityUsd({ effectiveMinLiquidityUsd: 0 })).toBe(0);
  });

  it('honors a custom floor, and a reported 0 does not replace it', () => {
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 10_000, enforceLiquidityFloor: false })).toBe(10_000);
    expect(gateMinLiquidityUsd({ source: 'new' }, 0, { minLiquidityUsd: 10_000 })).toBe(10_000);
    expect(gateMinLiquidityUsd({ source: 'trending' }, 25_000, { minLiquidityUsd: 10_000 })).toBe(25_000);
  });

  it('the $50,000 flag raises a lower floor and does not lower a higher one', () => {
    expect(ENFORCED_LIQUIDITY_FLOOR_USD).toBe(50_000);
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 0, enforceLiquidityFloor: true })).toBe(50_000);
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 10_000, enforceLiquidityFloor: true })).toBe(50_000);
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 80_000, enforceLiquidityFloor: true })).toBe(80_000);
    expect(effectiveMinLiquidityUsd({ minLiquidityUsd: 80_000, enforceLiquidityFloor: false })).toBe(80_000);
    expect(gateMinLiquidityUsd({ source: 'snipe' }, 0, { sniperMinLiquidityUsd: 5_000 })).toBe(5_000);
    expect(gateMinLiquidityUsd({ source: 'snipe' }, 0, { enforceLiquidityFloor: true, sniperMinLiquidityUsd: 5_000 })).toBe(50_000);
    expect(gateMinLiquidityUsd({ source: 'snipe' }, 0, { enforceLiquidityFloor: true, sniperMinLiquidityUsd: 80_000 })).toBe(80_000);
  });

  it('the desk shows the floor in force', () => {
    expect(shownMinLiquidityUsd({ effectiveMinLiquidityUsd: 50_000 })).toBe(50_000);
    expect(shownMinLiquidityUsd({ effectiveMinLiquidityUsd: 12_000 })).toBe(12_000);
    const panel = readFileSync(new URL('../src/ui/TokenTrader.tsx', import.meta.url), 'utf8');
    expect(panel.match(/shownMinLiquidityUsd\(t\)/g)).toEqual(['shownMinLiquidityUsd(t)']);
    expect(panel).toContain('ENFORCED_LIQUIDITY_FLOOR_USD.toLocaleString');
  });
});
