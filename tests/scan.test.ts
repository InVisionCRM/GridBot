import { describe, expect, it } from 'vitest';
import { bestSetup, bestWay, dailySwing, expectedGrid, expectedLp, GRID_PER_SWING, LP_REPEAT, SETUP_BANDS, SETUP_LEVELS, MIN_SCAN_CANDLES, MIN_SELL_HOURS, NATIVE_EEEE, NATIVE_ZERO, parseTopPools, pickTokens, SCAN_EVERY_MS, SCAN_PAGES, SCAN_RULES, TEST_USD, type TopPool } from '../src/market/scan';
import { DEFAULT_COSTS } from '../src/market/costs';
import { runGridBacktest } from '../src/market/backtest';
import type { Candle } from '../src/market/candles';
import { DailyScanner, localScan, type ScanDeps, type ScanFile } from '../src/server/market/scanner';
import { RECENTER_AFTER_MS, RECENTER_COOLDOWN_MS, recenterAt } from '../src/live/recenter';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { RateLimited } from '../src/server/market/gecko';
import type { MarketDef } from '../src/live/markets';
import { NET, MockChain } from './helpers/mockChain';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const SPEND = [WETH, USDC, USDT];

const pool = (o: Partial<TopPool> & { name: string; base: string; quote: string }): TopPool => ({
  address: `0x${o.name.length.toString(16).padStart(40, '0')}`, dex: 'uniswap_v3', liquidityUsd: 5e6, volume24Usd: 1e6, tx24: 1000, change24Pct: 1, createdAt: null, basePriceUsd: null, quotePriceUsd: null, ...o,
});

describe('parseTopPools (GeckoTerminal /networks/{slug}/pools)', () => {
  it('reads addresses from relationship ids, 24h volume, liquidity, trades and change', () => {
    const rows = parseTopPools({ data: [
      { attributes: { address: '0xABC', name: 'ETH / USDT 0.3%', reserve_in_usd: '96365925.1', volume_usd: { h24: '26787487.5' }, transactions: { h24: { buys: 300, sells: 388 } }, price_change_percentage: { h24: '-0.738' } },
        relationships: { base_token: { data: { id: `eth_${NATIVE_ZERO}` } }, quote_token: { data: { id: 'eth_0xdAC17F958D2ee523a2206206994597C13D831ec7' } }, dex: { data: { id: 'uniswap-v4-ethereum' } } } },
      { attributes: { address: '0xdef', name: 'X / WETH', reserve_in_usd: null, volume_usd: {}, transactions: {}, price_change_percentage: {} }, relationships: {} },
    ] });
    expect(rows[0]).toEqual({ address: '0xabc', name: 'ETH / USDT 0.3%', dex: 'uniswap-v4-ethereum', base: NATIVE_ZERO, quote: USDT, liquidityUsd: 96365925.1, volume24Usd: 26787487.5, tx24: 688, change24Pct: -0.738, createdAt: null, basePriceUsd: null, quotePriceUsd: null });
    expect(rows[1]).toMatchObject({ liquidityUsd: 0, volume24Usd: 0, tx24: 0, change24Pct: null, base: '', quote: '' });
    expect(() => parseTopPools({ status: { error_code: 429 } })).toThrow(/unexpected/);
  });
});

describe('ranking (walk-forward, Oct 2026): grids by swing, liquidity by what it earned', () => {
  it('dailySwing adds up the hourly high-low ranges per day, whichever way the price ended', () => {
    const hour = (h: number, l: number): Candle => ({ t: 0, o: l, h, l, c: h, v: 1 });
    // 48 hours that each range 1% (log): 24 × 1% = 24% a day, up or down alike
    const up = Array.from({ length: 48 }, () => hour(1.01, 1));
    expect(dailySwing(up)).toBeCloseTo(24 * Math.log(1.01), 12);
    expect(dailySwing(up.map((k) => ({ ...k, o: k.h, c: k.l })))).toBeCloseTo(24 * Math.log(1.01), 12);
    expect(() => dailySwing([])).toThrow(/no candles/);
  });
  it('a grid ranks only when it earned last week; liquidity by what it earned after costs', () => {
    const grid = { bandPct: 0.08, gridCount: 20, earnedPct: 0.01, roundTrips: 9, returnPct: -0.05, maxDrawdownPct: 0.1 };
    expect(expectedGrid({ grid, swingPct: 0.3 })).toBeCloseTo(GRID_PER_SWING * 0.3);
    expect(expectedGrid({ grid: null, swingPct: 0.9 })).toBeNull(); // swings a lot, but no grid earned at this size
    const lp = { bandPct: 0.05, earnedPct: 0.02, feesPct: 0.03, inRangePct: 1, poolSharePct: 0.001, returnPct: -0.1 };
    expect(expectedLp({ lp })).toBeCloseTo(LP_REPEAT * 0.02);
    expect(expectedLp({ lp: { ...lp, earnedPct: -0.01 } })).toBeNull(); // lost last week: no estimate
    expect(expectedLp({ lp: null })).toBeNull();
    // the better of the two
    expect(bestWay({ grid, swingPct: 0.3, lp })).toEqual({ how: 'grid', expected: GRID_PER_SWING * 0.3 });
    expect(bestWay({ grid, swingPct: 0.1, lp: { ...lp, earnedPct: 0.05 } })).toEqual({ how: 'lp', expected: LP_REPEAT * 0.05 });
    expect(bestWay({ grid: null, swingPct: 0.3, lp: null })).toBeNull();
  });
});

describe('pickTokens: real activity, something the bot can spend', () => {
  it('drops fake volume, thin pools, few trades, stable/stable and token/token; keeps one pool per token', () => {
    const r = pickTokens([
      pool({ name: 'BIS / WETH', base: '0xb1', quote: WETH, liquidityUsd: 45, volume24Usd: 53e6, tx24: 8 }),
      pool({ name: 'USDC / USDT', base: USDC, quote: USDT, volume24Usd: 1e8 }),
      pool({ name: 'ETH / USDT (V4 native)', base: NATIVE_ZERO, quote: USDT, volume24Usd: 9e7 }),
      pool({ name: 'USDC / ETH (0xEeee)', base: USDC, quote: NATIVE_EEEE, volume24Usd: 8.5e7 }),
      pool({ name: 'cirBTC / WBTC', base: '0xc1', quote: WBTC }),
      pool({ name: 'PONS / USDG', base: '0xd1', quote: USDC, tx24: 19, volume24Usd: 6e7 }),
      pool({ name: 'WASH / USDC', base: '0xe1', quote: USDC, liquidityUsd: 100_000, volume24Usd: 5e6 }),
      pool({ name: 'WBTC / USDT', base: WBTC, quote: USDT, volume24Usd: 3e7 }),
      pool({ name: 'WBTC / WETH', base: WBTC, quote: WETH, volume24Usd: 2e7 }),
      pool({ name: 'USDC / PEPE', base: USDC, quote: '0xf1', volume24Usd: 1e7 }),
    ], SPEND, WETH);
    expect(r.picked.map((p) => [p.pool.name, p.token, p.spend])).toEqual([['WBTC / USDT', WBTC, USDT], ['USDC / PEPE', '0xf1', USDC], ['WASH / USDC', '0xe1', USDC]]);
    expect(r.picked.find((p) => p.pool.name === 'WASH / USDC')!.pool.wash).toBe(true);
    const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.why]));
    expect(why['BIS / WETH']).toMatch(/liquidity \$45 is below \$10,000/);
    expect(why['USDC / USDT']).toBe('both sides are the native coin or stablecoins');
    expect(why['ETH / USDT (V4 native)']).toBe('both sides are the native coin or stablecoins');
    expect(why['USDC / ETH (0xEeee)']).toBe('both sides are the native coin or stablecoins');
    expect(why['cirBTC / WBTC']).toBe('neither side is the native coin or a stablecoin');
    expect(why['PONS / USDG']).toBe('only 19 trades in 24h');
    expect(why['WASH / USDC']).toBeUndefined(); // kept: liquidity is ranked on fees, not this volume
    expect(why['WBTC / WETH']).toBeUndefined(); // same token as a busier pool: tested once
  });

  it('a V4 token/native pool spends the wrapped native, and the count is capped', () => {
    const many = Array.from({ length: SCAN_RULES.maxTokens + 3 }, (_, i) => pool({ name: `T${i} / ETH`, base: `0x${(i + 1).toString(16)}`, quote: NATIVE_ZERO, volume24Usd: 1e6 - i }));
    const r = pickTokens(many, SPEND, WETH);
    expect(r.picked).toHaveLength(SCAN_RULES.maxTokens);
    expect(r.picked.every((p) => p.spend === WETH)).toBe(true);
  });

  it('a pool younger than the minimum age is skipped; an unknown age is kept', () => {
    const now = 1_800_000_000_000;
    const r = pickTokens([
      pool({ name: 'NEW / WETH', base: '0xa1', quote: WETH, createdAt: now - 60 * 60_000 }),
      pool({ name: 'OLD / WETH', base: '0xa2', quote: WETH, createdAt: now - 48 * 3600_000 }),
      pool({ name: 'UNK / WETH', base: '0xa3', quote: WETH, createdAt: null }),
    ], SPEND, WETH, SCAN_RULES, now);
    expect(r.picked.map((p) => p.pool.name)).toEqual(['OLD / WETH', 'UNK / WETH']);
    expect(r.skipped.map((s) => s.why).join(' ')).toMatch(/1h old/);
  });
});

/** Hourly candles swinging ±amp around p0 with a 24 h period. */
function wave(n: number, p0: number, amp: number, drift = 0): Candle[] {
  const out: Candle[] = [];
  let prev = p0;
  for (let i = 0; i < n; i++) {
    const c = p0 * (1 + amp * Math.sin((2 * Math.PI * (i + 1)) / 24)) * (1 + drift) ** i;
    out.push({ t: 1_700_000_000 + i * 3600, o: prev, h: Math.max(prev, c) * 1.001, l: Math.min(prev, c) * 0.999, c, v: 1 });
    prev = c;
  }
  return out;
}
const COSTS = { ...DEFAULT_COSTS, feeBps: 30 };

describe('bestSetup: replay the week through the grid backtester', () => {
  it('a pair that swings ±6% a day earns; the winner beats every other setup tried', () => {
    const s = bestSetup(wave(168, 1, 0.06), COSTS, 1000)!;
    expect(s).not.toBeNull();
    expect(s.returnPct).toBeGreaterThan(0);
    expect(s.roundTrips).toBeGreaterThan(5);
    expect(s.days).toBeCloseTo(167 / 24, 5);
  });

  it(`one price spike is not a pattern: a single wick through several levels has no pick (needs sells in ${MIN_SELL_HOURS} different hours)`, () => {
    const flat = (wicks: number[]): Candle[] => Array.from({ length: 168 }, (_, i) => ({ t: 1_700_000_000 + i * 3600, o: 1, h: 1.0005, l: wicks.includes(i) ? 0.9 : 0.9995, c: 1, v: 1 }));
    expect(bestSetup(flat([40]), COSTS, 1000)).toBeNull();
    // The same wick on three different days is a pattern.
    expect(bestSetup(flat([40, 90, 140]), COSTS, 1000)).not.toBeNull();
  });

  it('a falling pair that still swings: its trades earned, so it has a setup, chosen by what they earned (the total return was negative)', () => {
    const k = wave(168, 1, 0.04, -0.0008); // −12.6% over the week, ±4% a day
    const s = bestSetup(k, COSTS, 1000)!;
    expect(s).not.toBeNull();
    expect(s.earnedPct).toBeGreaterThan(0);
    expect(s.returnPct).toBeLessThan(0);
    for (const bandPct of SETUP_BANDS) for (const gridCount of SETUP_LEVELS) {
      const r = runGridBacktest(k, { lowerPrice: k[0].o * (1 - bandPct), upperPrice: k[0].o * (1 + bandPct), gridCount, capital: 1000 }, '1h', COSTS);
      if (new Set(r.trades.map((t) => t.exitT)).size >= MIN_SELL_HOURS) expect(s.earnedPct).toBeGreaterThanOrEqual(r.metrics.earned / 1000);
    }
  });

  it('a pair that only falls has no setup that made money', () => {
    expect(bestSetup(wave(168, 1, 0.002, -0.004), COSTS, 1000)).toBeNull();
  });

  it(`needs ${MIN_SCAN_CANDLES} hourly candles`, () => {
    expect(() => bestSetup(wave(MIN_SCAN_CANDLES - 1, 1, 0.06), COSTS, 1000)).toThrow(/need 72/);
  });
});

const tok = (address: string, symbol: string, extra: Partial<MarketDef['base']> = {}) => ({ address, symbol, decimals: 18, ...extra });
const mkt = (key: string, base: MarketDef['base'], quote: MarketDef['quote'], o: Partial<MarketDef> = {}): MarketDef => ({
  key, chainId: 1, base, quote, pool: { dex: 'uniswap-v3', kind: 'v3', address: `0xpool${key}`, feeBps: 30 }, probe: 1, quoteKind: 'stable', ...o,
});
const NOW = 1_800_000_000_000;
const LAST_CLOSED = Math.floor(NOW / 1000 / 3600) * 3600 - 3600;

function fakeDeps(o: { candles?: Record<string, Candle[]>; stored?: Record<string, Candle[]>; unsafe?: string[]; rateLimitOnce?: boolean; http500Once?: boolean; lpUnverified?: string[]; fullPages?: boolean } = {}) {
  const ethUsdc = mkt('ethereum:ETH/USDC', tok(WETH, 'ETH', { native: true }), tok(USDC, 'USDC'));
  const store = new MemoryStore<ScanFile>();
  const calls: string[] = [];
  let limited = !!o.rateLimitOnce, http500 = !!o.http500Once;
  const deps: ScanDeps = {
    chains: () => [{ id: 1, name: 'Ethereum', slug: 'eth', wrapped: WETH, spendable: SPEND, dexes: ['uniswap_v3', 'uniswap_v2'], lpDexes: ['uniswap-v3'] }],
    existing: () => [ethUsdc],
    inspect: async (_c, token) => {
      const safety = o.unsafe?.includes(token)
        ? { risk: 'blocked', liveAllowed: false, reasons: ['Honeypot: the simulated sell reverted.'] }
        : { risk: 'low', liveAllowed: true, reasons: ['Simulated buy, transfer and sell matched quotes exactly.'] };
      return mkt(`ethereum:${token}/USDT`, tok(token, token.slice(0, 6)), tok(USDT, 'USDT'), { custom: true, safety: safety as MarketDef['safety'] });
    },
    snapshot: async () => ({ spot: 2, quoteReserve: 1e9, plsReserve: 5e8, gasPricePls: 0, feeBps: 30 }),
    storedHourly: (d) => o.stored?.[d.key] ?? [],
    lpShare: async (d) => { if (o.lpUnverified?.includes(d.key)) throw new Error('Uniswap V3: not verified'); return 0.75; },
    usdPerSpend: async () => 1,
    gecko: {
      topPools: async (n, dex, page = 1) => {
        calls.push(`top:${n}/${dex}/${page}`);
        if (dex === 'uniswap_v3') {
          // a full page (20 rows) means there may be more; page 1 holds the real pools
          const filler = Array.from({ length: o.fullPages ? 20 : 0 }, (_, i) => pool({ name: `F${page}-${i} / USDC`, base: USDC, quote: USDT, volume24Usd: 1 }));
          return page === 1 ? [pool({ name: 'WBTC / USDT', base: WBTC, quote: USDT }), ...filler].slice(0, Math.max(1, filler.length)) : filler;
        }
        return [pool({ name: 'DEAD / USDC', base: '0xdead', quote: USDC })];
      },
      ohlcv: async (p, token) => {
        calls.push(`${p}:${token}`);
        if (limited) { limited = false; throw new RateLimited(0); }
        if (http500) { http500 = false; throw new Error('GeckoTerminal HTTP 500'); }
        // ending at the last closed hour, like GeckoTerminal's answer
        const k = o.candles?.[token] ?? wave(168, 2, 0.001);
        return k.map((x, i) => ({ ...x, t: LAST_CLOSED - (k.length - 1 - i) * 3600 }));
      },
    },
    store, approval: 'exact', now: () => NOW,
  };
  return { deps, store, calls };
}

describe('DailyScanner: opportunities', () => {
  it('tests the app\'s markets and new tokens both ways, keeps every safety level, measures the swing, and saves', async () => {
    const { deps, store, calls } = fakeDeps({ candles: { [WETH]: wave(168, 2, 0.03), [WBTC]: wave(168, 2, 0.08) }, unsafe: ['0xdead'] });
    const sc = new DailyScanner(deps);
    const f = await sc.run();
    const c = f.chains[0];
    expect(c.error).toBeNull();
    expect(c.tested).toBe(3);
    // the app's markets first, then new tokens as found
    expect(c.items.map((x) => x.label)).toEqual(['ETH/USDC', `${WBTC.slice(0, 6)}/USDT`, '0xdead/USDT']);
    const [eth, wbtc, dead] = c.items;
    // New token → added on "Try it"; existing market → its key.
    expect(wbtc).toMatchObject({ key: null, ref: { address: WBTC, quote: USDT, pool: `0xpoolethereum:${WBTC}/USDT` }, risk: 'low', liveAllowed: true, activity: { tx24: 1000 } });
    expect(eth).toMatchObject({ key: 'ethereum:ETH/USDC', ref: { address: WETH, quote: USDC, pool: '0xpoolethereum:ETH/USDC' }, activity: null, kind: 'v3', capital: TEST_USD, usd: TEST_USD });
    // a token that fails the safety check is shown with why, paper only
    expect(dead).toMatchObject({ risk: 'blocked', liveAllowed: false, riskWhy: 'Honeypot: the simulated sell reverted.' });
    // both ways, ranked by the better of the two
    for (const x of [wbtc, eth]) {
      expect(x.grid!.earnedPct).toBeGreaterThan(0);
      expect(x.lp!.feesPct).toBeGreaterThan(0);
    }
    // ±8% a day swings more than ±3%: it ranks first among grids
    expect(wbtc.swingPct).toBeGreaterThan(eth.swingPct);
    expect(expectedGrid(wbtc)!).toBeGreaterThan(expectedGrid(eth)!);
    expect(wbtc.swingPct).toBeCloseTo(dailySwing(wave(168, 2, 0.08)), 9);
    // Only the DEXes this app trades are read (not the chain-wide list, which on Robinhood is mostly Uniswap V4).
    expect(calls.filter((x) => x.startsWith('top:'))).toEqual(['top:eth/uniswap_v3/1', 'top:eth/uniswap_v2/1']);
    // Native base asks GeckoTerminal for the wrapped token's price.
    expect(calls).toContain(`0xpoolethereum:ETH/USDC:${WETH}`);
    expect(store.load()).toMatchObject({ version: 4, chains: [{ items: [{}, {}, {}] }] });
    expect(sc.status()).toMatchObject({ running: false, nextAt: NOW + SCAN_EVERY_MS });
  });

  it(`reads up to ${SCAN_PAGES} pages of each DEX's busiest pools; a short page is the last`, async () => {
    const { deps, calls } = fakeDeps({ fullPages: true });
    await new DailyScanner(deps).run();
    expect(calls.filter((x) => x.startsWith('top:eth/uniswap_v3/'))).toHaveLength(SCAN_PAGES);
    expect(calls.filter((x) => x.startsWith('top:eth/uniswap_v2/'))).toEqual(['top:eth/uniswap_v2/1']);
  });

  it('a quiet pool\'s candles skip hours without trades: the week is the last 7 days, filled, not the last 168 candles', async () => {
    // a trade every 2 hours for 14 days: the price was 1 until 8 days ago and 2 since
    const k: Candle[] = Array.from({ length: 168 }, (_, i) => {
      const t = LAST_CLOSED - (167 - i) * 7200, p = t >= LAST_CLOSED - 8 * 86_400 ? 2 : 1;
      return { t, o: p, h: p, l: p, c: p, v: 1 };
    });
    const { deps } = fakeDeps();
    const odd = { ...deps, gecko: { ...deps.gecko, ohlcv: async () => k } };
    const eth = (await new DailyScanner(odd).run()).chains[0].items.find((x) => x.label === 'ETH/USDC')!;
    expect(eth.movePct).toBe(0); // the last 168 candles would start 14 days back, at 1: +100%
  });

  it('a calm week: no grid earned, and it says why; a 429 is retried once', async () => {
    const { deps } = fakeDeps({ rateLimitOnce: true });
    const eth = (await new DailyScanner(deps).run()).chains[0].items.find((x) => x.label === 'ETH/USDC')!;
    expect(eth.grid).toBeNull();
    expect(eth.gridWhy).toMatch(/^no grid earned from its trades this week \(price [+-]\d+\.\d%\)$/);
  });

  it('one-off prints in a thin pool are clipped before testing: four 25% wicks in a calm week earn no grid', async () => {
    const spiky = wave(168, 2, 0.001).map((k, i) => ([20, 60, 100, 140].includes(i) ? { ...k, l: k.l * 0.75 } : k));
    // As printed, the wicks look like a pattern (sells in 4 different hours) and would rank
    expect(bestSetup(spiky, COSTS, 1000)).not.toBeNull();
    const { deps } = fakeDeps({ candles: { [WBTC]: spiky } });
    const wbtc = (await new DailyScanner(deps).run()).chains[0].items.find((x) => x.label === `${WBTC.slice(0, 6)}/USDT`)!;
    expect(wbtc.grid).toBeNull();
  });

  it('a GeckoTerminal 5xx is retried once (the real scan lost ETH/USDC to one HTTP 500)', async () => {
    const { deps, calls } = fakeDeps({ http500Once: true, candles: { [WETH]: wave(168, 2, 0.03) } });
    const c = (await new DailyScanner(deps).run()).chains[0];
    expect(c.items.find((x) => x.label === 'ETH/USDC')!.grid).not.toBeNull();
    expect(calls.filter((x) => x.endsWith(WETH))).toHaveLength(2);
  });

  it('reports what it is doing while it runs, and clears it when done', async () => {
    const { deps } = fakeDeps();
    const seen: unknown[] = [];
    const sc = new DailyScanner({ ...deps, snapshot: async (d) => { seen.push(sc.status().progress); return deps.snapshot(d); } });
    await sc.run();
    expect(seen[0]).toEqual({ chain: 'Ethereum', chainNo: 1, chains: 1, phase: 'testing pairs', done: 0, total: 3 }); // ETH/USDC + 2 new tokens
    expect(seen[1]).toMatchObject({ phase: 'testing pairs', done: 1, total: 3 });
    expect(sc.status().progress).toBeNull();
  });

  it('a first scan shows each pool as soon as it is tested; a re-scan keeps the earlier list until the chain is done', async () => {
    const { deps, store } = fakeDeps();
    const shown: number[] = [];
    const sc = new DailyScanner({ ...deps, snapshot: async (d) => { shown.push(sc.status().chains[0]?.items.length ?? -1); return deps.snapshot(d); } });
    await sc.run();
    expect(shown).toEqual([0, 1, 2]); // before each of the 3 pools: the ones already tested
    const again: number[] = [];
    const sc2 = new DailyScanner({ ...deps, store, snapshot: async (d) => { again.push(sc2.status().chains[0].items.length); return deps.snapshot(d); } });
    await sc2.run();
    expect(again).toEqual([3, 3, 3]); // yesterday's 3 until today's are all in
    expect(sc2.status().chains[0].items).toHaveLength(3);
  });

  it('a market in the app reuses its saved hourly candles when they cover the week (no GeckoTerminal request)', async () => {
    const week = wave(168, 2, 0.03).map((x, i) => ({ ...x, t: LAST_CLOSED - (167 - i) * 3600 }));
    const { deps, calls } = fakeDeps({ stored: { 'ethereum:ETH/USDC': week } });
    const c = (await new DailyScanner(deps).run()).chains[0];
    expect(calls.some((x) => x.endsWith(WETH))).toBe(false);
    expect(c.items.find((x) => x.label === 'ETH/USDC')!.grid).not.toBeNull();
    // Too old to cover the week up to the last 2 hours → fetched as before.
    const stale = fakeDeps({ stored: { 'ethereum:ETH/USDC': week.map((x) => ({ ...x, t: x.t - 3 * 3600 })) } });
    await new DailyScanner(stale.deps).run();
    expect(stale.calls.some((x) => x.endsWith(WETH))).toBe(true);
  });

  it('a V2 pool: only the grid is tested, a liquidity bot can\'t run there', async () => {
    const { deps } = fakeDeps({ candles: { [WETH]: wave(168, 2, 0.03) } });
    const v2 = { ...deps, existing: () => deps.existing(1).map((d) => ({ ...d, pool: { ...d.pool, dex: 'uniswap-v2', kind: 'v2' as const } })) };
    const eth = (await new DailyScanner(v2).run()).chains[0].items.find((x) => x.label === 'ETH/USDC')!;
    expect(eth).toMatchObject({ kind: 'v2', lp: null, lpWhy: expect.stringMatching(/needs a V3 pool/) });
    expect(eth.grid).not.toBeNull();
    expect(expectedLp(eth)).toBeNull();
  });

  it('a V3 pool on a DEX without a verified position manager: grid only, and it says so', async () => {
    const { deps } = fakeDeps({ candles: { [WETH]: wave(168, 2, 0.03) } });
    const cake = { ...deps, existing: () => deps.existing(1).map((d) => ({ ...d, pool: { ...d.pool, dex: 'pancakeswap-v3' } })) };
    const eth = (await new DailyScanner(cake).run()).chains[0].items.find((x) => x.label === 'ETH/USDC')!;
    expect(eth).toMatchObject({ kind: 'v3', lp: null, lpWhy: expect.stringMatching(/no verified position manager/) });
  });

  it('an unverified fee share leaves the liquidity side empty and says why; the grid still runs', async () => {
    const { deps } = fakeDeps({ candles: { [WETH]: wave(168, 2, 0.03) }, lpUnverified: ['ethereum:ETH/USDC'] });
    const eth = (await new DailyScanner(deps).run()).chains[0].items.find((x) => x.label === 'ETH/USDC')!;
    expect(eth).toMatchObject({ lp: null, lpWhy: 'Uniswap V3: not verified' });
    expect(eth.grid).not.toBeNull();
  });

  it('tests with the size you choose, keeps it for the daily scans after, and refuses nonsense', async () => {
    const { deps } = fakeDeps({ candles: { [WETH]: wave(168, 2, 0.03) } });
    const sc = new DailyScanner(deps);
    expect(sc.status().testUsd).toBe(TEST_USD);
    const f = await sc.run(25_000);
    expect(f.testUsd).toBe(25_000);
    expect(f.chains[0].items.find((x) => x.label === 'ETH/USDC')).toMatchObject({ usd: 25_000, capital: 25_000 });
    expect((await sc.run()).testUsd).toBe(25_000);
    expect(new DailyScanner(deps).status().testUsd).toBe(25_000); // saved
    await expect(sc.run(5)).rejects.toThrow(/from \$10 to \$10,000,000/);
    await expect(sc.run(Number.NaN)).rejects.toThrow(/dollar amount/);
  });

  it('a saved scan from before (3 picks a chain, ranked with the price move) is dropped; its test size is kept', () => {
    const { deps, store } = fakeDeps();
    store.save({ version: 2, at: 123, testUsd: 5000, chains: [{ picks: [] }] } as unknown as ScanFile);
    expect(new DailyScanner(deps).status()).toMatchObject({ at: null, chains: [], testUsd: 5000 });
  });

  it('a saved scan from version 3 keeps its pools: addresses from the market (in the app) or from `add` (not yet); a removed market is dropped', () => {
    const { deps, store } = fakeDeps();
    const item = (o: Record<string, unknown>) => ({ chainId: 1, label: 'X', spend: 'USDC', stack: 'X', dex: 'uniswap-v3', kind: 'v3', feeBps: 30, ...o });
    store.save({ version: 3, at: 123, testUsd: 1000, feeMarks: { keep: { at: 1, g0: '1', g1: '2', liquidity: '3' } }, chains: [{ chainId: 1, name: 'Ethereum', at: 123, tested: 3, skipped: [], error: null, items: [
      item({ key: 'ethereum:ETH/USDC', add: null }), item({ key: null, add: { address: WBTC, quote: USDT, pool: '0xp' } }), item({ key: 'ethereum:GONE/USDC', add: null }),
    ] }] } as unknown as ScanFile);
    const st = new DailyScanner(deps).status();
    expect(st).toMatchObject({ version: 4, at: 123 });
    expect(new DailyScanner(deps)['file'].feeMarks).toEqual({ keep: { at: 1, g0: '1', g1: '2', liquidity: '3' } });
    expect(st.chains[0].items.map((o) => [o.key, o.ref])).toEqual([
      ['ethereum:ETH/USDC', { address: WETH, quote: USDC, pool: '0xpoolethereum:ETH/USDC' }], [null, { address: WBTC, quote: USDT, pool: '0xp' }],
    ]);
    expect(st.chains[0].items[0]).not.toHaveProperty('add');
  });

  it("is read with this app's market keys, found by the pool's addresses (a friend's copy reads its host's scan)", async () => {
    const { deps } = fakeDeps();
    await new DailyScanner(deps).run();
    const sc = new DailyScanner(deps);
    // this app has ETH/USDC under another key, and WBTC/USDT (new in the scan) is in it now
    const keys: Record<string, string> = { '0xpoolethereum:ETH/USDC': 'ethereum:ETH/USDC#2', [`0xpoolethereum:${WBTC}/USDT`]: 'ethereum:WBTC/USDT' };
    const local = localScan({ marketFor: (_c, _d, ref) => keys[ref.pool] ?? null }, sc);
    const items = (await local.status()).chains[0].items;
    expect(items.map((o) => o.key)).toEqual(['ethereum:ETH/USDC#2', 'ethereum:WBTC/USDT', null]);
  });

  it('a wash pool is not a grid, and liquidity waits until fees are measured on-chain', async () => {
    const WASH = '0x' + 'ab'.repeat(20);
    const { deps } = fakeDeps({ candles: { [WASH]: wave(168, 2, 0.03) } });
    deps.gecko.topPools = async (_n, dex) => dex === 'uniswap_v3'
      ? [pool({ name: 'WASH / USDC', base: WASH, quote: USDC, liquidityUsd: 100_000, volume24Usd: 5e6, tx24: 800 })]
      : [];
    const item = (await new DailyScanner(deps).run()).chains[0].items.find((x) => x.wash);
    expect(item).toMatchObject({ grid: null });
    expect(item!.gridWhy).toMatch(/wash/);
    expect(item!.lp).toBeNull();
    expect(item!.lpWhy).toMatch(/weren't measured/);
    // no evidence either way: the smart trader neither opens it nor retires a bot on it
    expect(item!.lpFailed).toBe(true);
  });

  it('a wash pool measured to have paid no fees is evidence: not ranked for liquidity, and not marked as untested', async () => {
    const WASH = '0x' + 'ce'.repeat(20);
    const { deps } = fakeDeps({ candles: { [WASH]: wave(168, 2, 0.03) } });
    deps.gecko.topPools = async (_n, dex) => dex === 'uniswap_v3'
      ? [pool({ name: 'WASH / USDC', base: WASH, quote: USDC, liquidityUsd: 100_000, volume24Usd: 5e6, tx24: 800 })]
      : [];
    const item = (await new DailyScanner({ ...deps, feePace: async () => ({ scale: 0 }) }).run()).chains[0].items.find((x) => x.wash);
    expect(item!.lp).toBeNull();
    expect(item!.lpWhy).toMatch(/paid no fees/);
    expect(item!.lpFailed).toBeUndefined();
  });

  it('a wash pool whose on-chain fees were measured is ranked for liquidity, still not as a grid', async () => {
    const WASH = '0x' + 'cd'.repeat(20);
    const { deps } = fakeDeps({ candles: { [WASH]: wave(168, 2, 0.03) } });
    deps.gecko.topPools = async (_n, dex) => dex === 'uniswap_v3'
      ? [pool({ name: 'WASH / USDC', base: WASH, quote: USDC, liquidityUsd: 100_000, volume24Usd: 5e6, tx24: 800 })]
      : [];
    const item = (await new DailyScanner({ ...deps, feePace: async () => ({ scale: 0.1 }) }).run()).chains[0].items.find((x) => x.wash);
    expect(item!.grid).toBeNull();
    expect(item!.feeScale).toBe(0.1);
    expect(item!.lp).not.toBeNull();
    expect(item!.lp!.feesPct).toBeGreaterThan(0);
  });

  it('fees in USD over a window scale the candles, and the fee mark survives the save', async () => {
    const WASH = '0x' + 'ef'.repeat(20);
    const { deps, store } = fakeDeps({ candles: { [WASH]: wave(168, 2, 0.03) } });
    store.save({ version: 4, at: null, testUsd: 1000, chains: [], feeMarks: { keep: { at: 1, g0: '1', g1: '2', liquidity: '3' } } });
    deps.gecko.topPools = async (_n, dex) => dex === 'uniswap_v3'
      ? [pool({ name: 'WASH / USDC', base: WASH, quote: USDC, liquidityUsd: 100_000, volume24Usd: 5e6, tx24: 800 })]
      : [];
    const item = (await new DailyScanner({ ...deps, feePace: async () => ({ feesUsd: 30, windowMs: 48 * 3600_000 }) }).run()).chains[0].items.find((x) => x.wash);
    expect(item!.feeScale).toBeGreaterThan(0);
    expect(item!.lp).not.toBeNull();
    expect(store.load()!.feeMarks!.keep.g0).toBe('1');
  });

  it('runs one scan at a time', async () => {
    const { deps } = fakeDeps();
    const sc = new DailyScanner(deps);
    const first = sc.run();
    await expect(sc.run()).rejects.toThrow('A scan is already running.');
    await first;
  });
});

describe("A scanned pool in this app (Hub.marketFor)", () => {
  it("is the market on that pool (or, its pool switched since the scan, the market for the same coins), turned to spend the scanned coin; null when the coins aren't in the app", () => {
    const chain = new MockChain(0.00001);
    const hub = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) }).hub;
    const d = hub.def('DAI'), ref = { address: d.base.address, quote: d.quote.address, pool: d.pool.address };
    expect(hub.marketFor(d.chainId, d.pool.dex, ref)).toBe('DAI'); // PLS spending DAI
    expect(hub.marketFor(d.chainId, d.pool.dex, { ...ref, address: d.quote.address, quote: d.base.address })).toBe('DAI~'); // DAI spending PLS
    expect(hub.marketFor(d.chainId, d.pool.dex, { ...ref, address: '0x' + '1'.repeat(40) })).toBeNull();
    expect(hub.marketFor(d.chainId, 'some-other-dex', ref)).toBe('DAI'); // the market moved to another pool since the scan
  });
});

describe('Auto-recenter: follows the price up only', () => {
  const P0 = 0.00001;
  function make() {
    let t = 1_800_000_000_000;
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => t });
    return { chain, bot, at: (ms: number) => { t = 1_800_000_000_000 + ms; } };
  }
  const grid = (bot: MultiBot, id: string) => bot.status().grids.find((g) => g.id === id)!;

  it(`moves the range up after ${RECENTER_AFTER_MS / 3600_000}h above it, same width/levels/amount, keeps the trades`, async () => {
    const { chain, bot, at } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30, recenter: true });
    chain.setPrice(P0 * 0.97); await bot.tickAll(); // buys
    chain.setPrice(P0 * 1.15); await bot.tickAll(); // sells everything on the way up, now above the range
    const before = grid(bot, id);
    expect(before.config.upperPrice).toBeCloseTo(P0 * 1.1, 12);
    const trades = before.trades.length;
    expect(trades).toBeGreaterThan(0);

    at(RECENTER_AFTER_MS - 60_000); await bot.tickAll();
    expect(grid(bot, id).config.upperPrice).toBeCloseTo(P0 * 1.1, 12);

    at(RECENTER_AFTER_MS + 60_000); await bot.tickAll();
    const g = grid(bot, id);
    const px = g.price;
    expect(g.config.lowerPrice).toBeCloseTo(px * 0.9, 9);
    expect(g.config.upperPrice).toBeCloseTo(px * 1.1, 9);
    expect(g.config).toMatchObject({ gridCount: 10, totalCapitalUsd: 30 });
    // the trades carry over; the new levels above the price got their coins from one start-up buy
    expect(g.trades.length).toBe(trades + 1);
    expect(g.trades[0]).toMatchObject({ side: 'buy', seed: [5, 6, 7, 8, 9] });
    expect(g.recenter).toMatchObject({ enabled: true, count: 1, aboveSince: null });
    expect(bot.activity.recent(50).some((e) => e.type === 'range' && /moved up/.test(e.msg))).toBe(true);
  });

  it('a close asked while the range is being moved wins: no move, no start-up buy', async () => {
    const { chain, bot, at } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30, recenter: true });
    chain.setPrice(P0 * 0.97); await bot.tickAll();
    chain.setPrice(P0 * 1.15); await bot.tickAll();
    const trades = grid(bot, id).trades.length;
    at(RECENTER_AFTER_MS + 60_000);
    // the move reads its costs (gridEconomics → market()); the close arrives during that read
    const q = bot.hub.quoter('DAI'), market = q.market.bind(q);
    let asked = false;
    q.market = async () => { const m = await market(); if (!asked) { asked = true; bot.closeGrid(id); } return m; };
    await bot.tickAll();
    expect(asked).toBe(true);
    const g = grid(bot, id);
    expect(g.trades.length).toBe(trades);
    expect(g.config!.upperPrice).toBeCloseTo(P0 * 1.1, 12);
  });

  it(`at most once per ${RECENTER_COOLDOWN_MS / 3600_000}h`, async () => {
    const { chain, bot, at } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30, recenter: true });
    chain.setPrice(P0 * 1.15); await bot.tickAll();
    at(RECENTER_AFTER_MS + 1); await bot.tickAll();
    expect(grid(bot, id).recenter.count).toBe(1);
    chain.setPrice(P0 * 1.5); await bot.tickAll();
    at(RECENTER_AFTER_MS * 2 + 2); await bot.tickAll();
    expect(grid(bot, id).recenter.count).toBe(1);
    at(RECENTER_AFTER_MS + 1 + RECENTER_COOLDOWN_MS); await bot.tickAll();
    expect(grid(bot, id).recenter.count).toBe(2);
    expect(grid(bot, id).config.upperPrice).toBeCloseTo(grid(bot, id).price * 1.1, 9);
  });

  it('never moves down, and is off unless turned on', async () => {
    const { chain, bot, at } = make();
    const on = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30, recenter: true });
    const off = await bot.add({ mode: 'paper', stable: 'USDC', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 });
    chain.setPrice(P0 * 0.8); await bot.tickAll();
    at(RECENTER_AFTER_MS * 5); await bot.tickAll();
    expect(grid(bot, on).config.lowerPrice).toBeCloseTo(P0 * 0.9, 12);
    expect(grid(bot, on).recenter.count).toBe(0);
    expect(grid(bot, off).recenter.enabled).toBe(false);
    chain.setPrice(P0 * 1.3, 'USDC'); await bot.tickAll();
    at(RECENTER_AFTER_MS * 10); await bot.tickAll();
    expect(grid(bot, off).config.upperPrice).toBeCloseTo(P0 * 1.1, 12);
  });

  it('setRecenter turns it on or off for a running grid and survives a restart', async () => {
    const { bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 });
    bot.setRecenter(id, true);
    expect(grid(bot, id).recenter.enabled).toBe(true);
    bot.stop(id);
    await bot.start(id, { mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.8, upperPrice: P0 * 1.2, gridCount: 10, totalCapitalUsd: 30 });
    expect(grid(bot, id).recenter.enabled).toBe(true);
    bot.setRecenter(id, false);
    expect(grid(bot, id).recenter.enabled).toBe(false);
  });
});

describe('recenterAt: when the range will move (shown on the grid page)', () => {
  it('2 h after the price went above, but not sooner than 6 h after the last move', () => {
    expect(recenterAt({ enabled: false, aboveSince: 1000, lastAt: null, count: 0 })).toBeNull();
    expect(recenterAt({ enabled: true, aboveSince: null, lastAt: null, count: 0 })).toBeNull();
    expect(recenterAt({ enabled: true, aboveSince: 1000, lastAt: null, count: 0 })).toBe(1000 + RECENTER_AFTER_MS);
    expect(recenterAt({ enabled: true, aboveSince: 1000, lastAt: 500, count: 1 })).toBe(500 + RECENTER_COOLDOWN_MS);
  });
});
