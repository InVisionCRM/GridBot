import { describe, expect, it } from 'vitest';
import { bestSetup, MIN_SCAN_CANDLES, MIN_SELL_HOURS, NATIVE_EEEE, NATIVE_ZERO, parseTopPools, pickTokens, SCAN_EVERY_MS, SCAN_RULES, TEST_USD, type TopPool } from '../src/market/scan';
import { DEFAULT_COSTS } from '../src/market/costs';
import type { Candle } from '../src/market/candles';
import { DailyScanner, type ScanDeps, type ScanFile } from '../src/server/market/scanner';
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
  address: `0x${o.name.length.toString(16).padStart(40, '0')}`, dex: 'uniswap_v3', liquidityUsd: 5e6, volume24Usd: 1e6, tx24: 1000, change24Pct: 1, ...o,
});

describe('parseTopPools (GeckoTerminal /networks/{slug}/pools)', () => {
  it('reads addresses from relationship ids, 24h volume, liquidity, trades and change', () => {
    const rows = parseTopPools({ data: [
      { attributes: { address: '0xABC', name: 'ETH / USDT 0.3%', reserve_in_usd: '96365925.1', volume_usd: { h24: '26787487.5' }, transactions: { h24: { buys: 300, sells: 388 } }, price_change_percentage: { h24: '-0.738' } },
        relationships: { base_token: { data: { id: `eth_${NATIVE_ZERO}` } }, quote_token: { data: { id: 'eth_0xdAC17F958D2ee523a2206206994597C13D831ec7' } }, dex: { data: { id: 'uniswap-v4-ethereum' } } } },
      { attributes: { address: '0xdef', name: 'X / WETH', reserve_in_usd: null, volume_usd: {}, transactions: {}, price_change_percentage: {} }, relationships: {} },
    ] });
    expect(rows[0]).toEqual({ address: '0xabc', name: 'ETH / USDT 0.3%', dex: 'uniswap-v4-ethereum', base: NATIVE_ZERO, quote: USDT, liquidityUsd: 96365925.1, volume24Usd: 26787487.5, tx24: 688, change24Pct: -0.738 });
    expect(rows[1]).toMatchObject({ liquidityUsd: 0, volume24Usd: 0, tx24: 0, change24Pct: null, base: '', quote: '' });
    expect(() => parseTopPools({ status: { error_code: 429 } })).toThrow(/unexpected/);
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
    expect(r.picked.map((p) => [p.pool.name, p.token, p.spend])).toEqual([['WBTC / USDT', WBTC, USDT], ['USDC / PEPE', '0xf1', USDC]]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.why]));
    expect(why['BIS / WETH']).toMatch(/liquidity \$45 is below \$50,000/);
    expect(why['USDC / USDT']).toBe('both sides are the native coin or stablecoins');
    expect(why['ETH / USDT (V4 native)']).toBe('both sides are the native coin or stablecoins');
    expect(why['USDC / ETH (0xEeee)']).toBe('both sides are the native coin or stablecoins');
    expect(why['cirBTC / WBTC']).toBe('neither side is the native coin or a stablecoin');
    expect(why['PONS / USDG']).toBe('only 19 trades in 24h');
    expect(why['WASH / USDC']).toBe('volume is 50× its liquidity (looks fake)');
    expect(why['WBTC / WETH']).toBeUndefined(); // same token as a busier pool: tested once
  });

  it('a V4 token/native pool spends the wrapped native, and the count is capped', () => {
    const many = Array.from({ length: SCAN_RULES.maxTokens + 3 }, (_, i) => pool({ name: `T${i} / ETH`, base: `0x${(i + 1).toString(16)}`, quote: NATIVE_ZERO, volume24Usd: 1e6 - i }));
    const r = pickTokens(many, SPEND, WETH);
    expect(r.picked).toHaveLength(SCAN_RULES.maxTokens);
    expect(r.picked.every((p) => p.spend === WETH)).toBe(true);
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

function fakeDeps(o: { candles?: Record<string, Candle[]>; inspectFails?: Record<string, string>; rateLimitOnce?: boolean; http500Once?: boolean } = {}) {
  const ethUsdc = mkt('ethereum:ETH/USDC', tok(WETH, 'ETH', { native: true }), tok(USDC, 'USDC'));
  const store = new MemoryStore<ScanFile>();
  const calls: string[] = [];
  let limited = !!o.rateLimitOnce, http500 = !!o.http500Once;
  const deps: ScanDeps = {
    chains: () => [{ id: 1, name: 'Ethereum', slug: 'eth', wrapped: WETH, spendable: SPEND }],
    existing: () => [ethUsdc],
    inspect: async (_c, token) => {
      if (o.inspectFails?.[token]) throw new Error(o.inspectFails[token]);
      return mkt(`ethereum:${token}/USDT`, tok(token, token.slice(0, 6)), tok(USDT, 'USDT'), { custom: true, safety: { risk: 'low', liveAllowed: true } as MarketDef['safety'] });
    },
    snapshot: async () => ({ spot: 2, quoteReserve: 1e9, plsReserve: 5e8, gasPricePls: 0, feeBps: 30 }),
    usdPerSpend: async () => 1,
    gecko: {
      topPools: async (_n, page) => (page === 1 ? [pool({ name: 'WBTC / USDT', base: WBTC, quote: USDT }), pool({ name: 'DEAD / USDC', base: '0xdead', quote: USDC })] : []),
      ohlcv: async (p, token) => {
        calls.push(`${p}:${token}`);
        if (limited) { limited = false; throw new RateLimited(0); }
        if (http500) { http500 = false; throw new Error('GeckoTerminal HTTP 500'); }
        return o.candles?.[token] ?? wave(168, 2, 0.001);
      },
    },
    store, approval: 'exact', now: () => 1_800_000_000_000,
  };
  return { deps, store, calls };
}

describe('DailyScanner', () => {
  it('tests existing markets and new tokens, ranks by the week\'s result, saves, and says why others were left out', async () => {
    const { deps, store, calls } = fakeDeps({
      candles: { [WETH]: wave(168, 2, 0.03), [WBTC]: wave(168, 2, 0.08) },
      inspectFails: { '0xdead': 'failed the safety check (blocked): honeypot' },
    });
    const sc = new DailyScanner(deps);
    const f = await sc.run();
    const c = f.chains[0];
    expect(c.error).toBeNull();
    expect(c.tested).toBe(2);
    expect(c.picks.map((p) => [p.rank, p.label])).toEqual([[1, `${WBTC.slice(0, 6)}/USDT`], [2, 'ETH/USDC']]);
    const [wbtc, eth] = c.picks;
    // New token → added on "Use this"; existing market → its key.
    expect(wbtc).toMatchObject({ key: null, add: { address: WBTC, quote: USDT, pool: `0xpoolethereum:${WBTC}/USDT` }, risk: 'low', activity: { tx24: 1000 } });
    expect(eth).toMatchObject({ key: 'ethereum:ETH/USDC', add: null, activity: null });
    // Range centred on the price at scan time with the winning width.
    expect(eth.lowerPrice).toBeCloseTo(2 * (1 - eth.bandPct), 6);
    expect(eth.upperPrice).toBeCloseTo(2 * (1 + eth.bandPct), 6);
    expect(eth.test).toMatchObject({ usd: TEST_USD, capital: TEST_USD });
    expect(wbtc.test.returnPct).toBeGreaterThan(eth.test.returnPct);
    // Native base asks GeckoTerminal for the wrapped token's price.
    expect(calls).toContain(`0xpoolethereum:ETH/USDC:${WETH}`);
    expect(c.skipped).toContainEqual({ name: 'DEAD / USDC', why: 'failed the safety check (blocked): honeypot' });
    expect(store.load()!.chains[0].picks).toHaveLength(2);
    expect(sc.status()).toMatchObject({ running: false, nextAt: 1_800_000_000_000 + SCAN_EVERY_MS });
  });

  it('a flat week gives no pick and says so; a 429 is retried once', async () => {
    const { deps } = fakeDeps({ rateLimitOnce: true });
    const c = (await new DailyScanner(deps).run()).chains[0];
    expect(c.picks).toEqual([]);
    expect(c.skipped).toContainEqual({ name: 'ETH/USDC', why: 'no range made money over the last 7 days' });
  });

  it('a GeckoTerminal 5xx is retried once (the real scan lost ETH/USDC to one HTTP 500)', async () => {
    const { deps, calls } = fakeDeps({ http500Once: true, candles: { [WETH]: wave(168, 2, 0.03) } });
    const c = (await new DailyScanner(deps).run()).chains[0];
    expect(c.picks.map((p) => p.label)).toContain('ETH/USDC');
    expect(calls.filter((x) => x.endsWith(WETH))).toHaveLength(2);
  });

  it('reports what it is doing while it runs (shown on Home), and clears it when done', async () => {
    const { deps } = fakeDeps();
    const seen: unknown[] = [];
    const sc = new DailyScanner({ ...deps, snapshot: async (d) => { seen.push(sc.status().progress); return deps.snapshot(d); } });
    await sc.run();
    expect(seen[0]).toEqual({ chain: 'Ethereum', chainNo: 1, chains: 1, phase: 'testing pairs', done: 0, total: 3 }); // ETH/USDC + 2 new tokens
    expect(seen[1]).toMatchObject({ phase: 'testing pairs', done: 1, total: 3 });
    expect(sc.status().progress).toBeNull();
  });

  it('runs one scan at a time', async () => {
    const { deps } = fakeDeps();
    const sc = new DailyScanner(deps);
    const first = sc.run();
    await expect(sc.run()).rejects.toThrow('A scan is already running.');
    await first;
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
    expect(g.trades.length).toBe(trades);
    expect(g.recenter).toMatchObject({ enabled: true, count: 1, aboveSince: null });
    expect(bot.activity.recent(50).some((e) => e.type === 'range' && /moved up/.test(e.msg))).toBe(true);
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
