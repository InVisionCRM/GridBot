/**
 * Token trader launch venues (src/live/venues.ts) and discovery: venue labels map to the DEX that trades them, V4 pools
 * come in (native ETH as the wrapped coin), every chain gets its share of a discovery, and each venue can be switched off.
 */
import { describe, expect, it } from 'vitest';
import { AbiCoder } from 'ethers';
import { CHAINS, chainById } from '../src/live/chains';
import { DOPPLER_HOOK, PONS_V2_HOOK, venueOf, venueHooks, VENUES, ZERO_HOOK } from '../src/live/venues';
import type { TopPool } from '../src/market/scan';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { DISCOVER_EVERY_MS, DISCOVER_PER_CHAIN, dexFor, discover, everyAtMost, venueHookCheck, withPoolFees } from '../src/server/market/tokenFeed';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import type { PoolSniper, SnipeHit } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';

setEthUsdSource(() => 2500);

const HOOD = chainById(4663)!;
const WETH = HOOD.wrappedNative.address.toLowerCase();
const NOW = 1_700_000_000_000;

const row = (o: Partial<TopPool> & { address: string; dex: string }): TopPool => ({
  name: 'NEW / WETH', base: '0x' + '11'.repeat(20), quote: WETH, liquidityUsd: 50_000, volume24Usd: 10_000, tx24: 100,
  change24Pct: 0, createdAt: NOW - 48 * 3600_000, basePriceUsd: 0.01, quotePriceUsd: 2_500, ...o,
} as TopPool);

describe('venues', () => {
  it('Robinhood V4 allows exactly the three verified launcher hooks', () => {
    expect(venueHooks(4663).map((h) => h.toLowerCase()).sort()).toEqual(
      ['0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544', '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', '0xee588bcf2bd3e658f5160489f4199d1851bbf0cc'],
    );
    expect(HOOD.dexes.find((d) => d.id === 'uniswap-v4')!.hookAllowlist).toEqual(venueHooks(4663));
    // every venue's DEX exists on its chain
    for (const v of VENUES) if ('dex' in v.via) expect(chainById(v.chainId)!.dexes.some((d) => d.id === (v.via as { dex: string }).dex), v.id).toBe(true);
  });

  it('a GeckoTerminal label trades on the DEX its venue names; a curve or an unknown DEX has none', () => {
    expect(dexFor(HOOD, 'pons-dot-family')).toMatchObject({ dex: { id: 'uniswap-v3' }, venue: 'pons-v1' });
    expect(dexFor(HOOD, 'uniswap-v4-robinhood')).toMatchObject({ dex: { id: 'uniswap-v4' }, venue: 'uniswap-v4' });
    expect(dexFor(HOOD, 'bankr-robinhood')).toMatchObject({ dex: { id: 'uniswap-v4' }, venue: 'bankr' });
    expect(dexFor(HOOD, 'uniswap-v3-robinhood')).toMatchObject({ dex: { id: 'uniswap-v3' }, venue: null });
    expect(dexFor(HOOD, 'pons-v2')).toBeNull();
    expect(dexFor(HOOD, 'aero-slipstream-robinhood')).toBeNull();
    expect(venueOf(1, 'pons-dot-family')).toBeNull(); // venues are per chain
  });

  it("a venue's V4 pool must trade through that venue's own hook; Uniswap V4 means no hook", () => {
    expect(() => venueHookCheck({ venue: 'bankr', pool: '0xid' }, DOPPLER_HOOK)).not.toThrow();
    expect(() => venueHookCheck({ venue: 'bankr', pool: '0xid' }, PONS_V2_HOOK)).toThrow(/not Bankr's/);
    expect(() => venueHookCheck({ venue: 'uniswap-v4', pool: '0xid' }, ZERO_HOOK)).not.toThrow();
    expect(() => venueHookCheck({ venue: 'uniswap-v4', pool: '0xid' }, DOPPLER_HOOK)).toThrow();
    expect(() => venueHookCheck({ venue: 'long-xyz', pool: '0xid' }, null)).toThrow();
    expect(() => venueHookCheck({ venue: 'pons-v1', pool: '0xa' }, null)).not.toThrow(); // a V3 pool has no hook
    expect(() => venueHookCheck({ pool: '0xa' }, null)).not.toThrow();
  });
});

describe('discovery', () => {
  const id = (n: number) => '0x' + n.toString(16).padStart(64, '0');
  const pulse = CHAINS.find((c) => c.id === 369)!;

  it('every chain gets its share (the first chain used to fill a 40-row cap); V4 rows come in with native ETH as WETH', async () => {
    const pulseRows = Array.from({ length: 40 }, (_, i) => row({ address: '0x' + (i + 1).toString(16).padStart(40, 'a'), dex: 'pulsex-v2', quote: pulse.wrappedNative.address.toLowerCase(), name: 'NEW / WPLS', quotePriceUsd: 0.00002 }));
    const hoodRows = [
      row({ address: id(1), dex: 'uniswap-v4-robinhood', quote: '0x0000000000000000000000000000000000000000' }),
      row({ address: '0x' + 'cd'.repeat(20), dex: 'pons-dot-family' }),
      row({ address: '0x' + 'ce'.repeat(20), dex: 'aero-slipstream-robinhood' }), // a DEX this app doesn't trade
    ];
    const rts = [pulse, HOOD].map((cfg) => ({ tradable: true, cfg, reader: { call: async () => AbiCoder.defaultAbiCoder().encode(['uint256', 'int24', 'uint24', 'uint24'], [1n << 96n, 0, 0, 10000]) } }));
    const hub = { runtimes: () => rts, rt: (cid: number) => rts.find((r) => r.cfg.id === cid)! };
    const gecko = {
      newPools: async (slug: string) => (slug === 'pulsechain' ? pulseRows : slug === 'robinhood' ? hoodRows : []),
      trendingPools: async () => [],
    };
    const out = await discover(hub as never, gecko as never);
    expect(out.filter((p) => p.chainId === 369)).toHaveLength(DISCOVER_PER_CHAIN);
    const v4 = out.find((p) => p.pool === id(1))!;
    expect(v4).toMatchObject({ chainId: 4663, kind: 'v4', venue: 'uniswap-v4', spend: WETH, feeBps: 100 });
    // Pons V1 is a Uniswap V3 pool: its fee() is read like any V3 pool's (the fake reader answers 10000 = 1 %)
    expect(out.find((p) => p.pool === '0x' + 'cd'.repeat(20))).toMatchObject({ kind: 'v3', venue: 'pons-v1' });
    expect(out.some((p) => p.pool === '0x' + 'ce'.repeat(20))).toBe(false);
  });

  it("a V4 pool's fee is StateView's lpFee; an uninitialized V4 pool is dropped", async () => {
    const v4 = HOOD.dexes.find((d) => d.id === 'uniswap-v4')!;
    const p = { chainId: 4663, pool: id(9) } as FreshPool;
    const slot0 = (sqrt: bigint, fee: number) => AbiCoder.defaultAbiCoder().encode(['uint160', 'int24', 'uint24', 'uint24'], [sqrt, 0, 0, fee]);
    expect(await withPoolFees([p], () => ({ call: async () => slot0(1n << 96n, 2500) }), () => v4)).toMatchObject([{ kind: 'v4', feeBps: 25 }]);
    expect(await withPoolFees([p], () => ({ call: async () => slot0(0n, 2500) }), () => v4)).toEqual([]);
  });
});

describe('token trader with venues', () => {
  const clean: GateInput = {
    mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
    buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
    canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
    holderConcentration: null, recentLiqPull: false, liveAllowed: true,
  };
  let n = 0;
  const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
    chainId: 4663, pool: '0x' + (++n).toString(16).padStart(64, '0'), dex: 'uniswap-v4-robinhood', kind: 'v4', venue: 'uniswap-v4',
    token: '0x' + n.toString(16).padStart(40, '1'), spend: WETH, tokenSymbol: `T${n}`, spendSymbol: 'WETH',
    liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
    quoteReserve: 16, tokenReserve: 4_000_000, feeBps: 100, price: 0.000004, usdPerSpend: 2_500, ...o,
  });
  const make = (o: { discover: () => Promise<FreshPool[]>; assess?: (p: FreshPool) => Promise<GateInput>; hits?: SnipeHit[]; now?: () => number }) => new TokenTrader({
    store: new MemoryStore<TraderState>(), now: o.now ?? (() => NOW),
    sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: o.hits ?? [], notes: [] }) } as unknown as PoolSniper,
    discover: o.discover, assess: o.assess ?? (async () => clean), resolve: async () => null,
  });

  it('buys a V4 pool (it used to be refused as "this app doesn\'t swap V4")', async () => {
    const t = make({ discover: async () => [pool()] });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600 });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(1);
  });

  it('a switched-off venue is skipped with its name; an unknown venue or a non-boolean is refused', async () => {
    const t = make({ discover: async () => [pool({ venue: 'bankr', dex: 'bankr-robinhood' })] });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, venues: { bankr: false } });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().feed[0].why).toBe('Bankr is switched off');
    expect(() => t.configure({ venues: { nope: true } })).toThrow(/Unknown venue/);
    expect(() => t.configure({ venues: { bankr: 'yes' as never } })).toThrow(/on or off/);
  });

  it("one pool whose safety check throws is skipped with the reason; the others in the round still get bought", async () => {
    const bad = pool(), good = pool();
    const t = make({ discover: async () => [bad, good], assess: async (p) => { if (p.pool === bad.pool) throw new Error('Pool not found'); return clean; } });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600 });
    t.turnOn();
    await t.tick();
    expect(t.status().positions.map((p) => p.pool)).toEqual([good.pool]);
    expect(t.status().feed.some((f) => f.pool === bad.pool && /safety check failed: Pool not found/.test(f.why))).toBe(true);
  });

  it('GeckoTerminal is read for new pools at most every 2 minutes (the trader asks every 20 s tick)', async () => {
    let calls = 0, now = NOW;
    const read = everyAtMost(async () => { calls++; return [1]; }, DISCOVER_EVERY_MS, () => now);
    expect(await read()).toEqual([1]);
    now += 20_000;
    expect(await read()).toEqual([]);
    now += DISCOVER_EVERY_MS;
    expect(await read()).toEqual([1]);
    expect(calls).toBe(2);
  });

  it("sniper V4 creations it can't buy are not counted as found or filtered", async () => {
    const hit = { chainId: 1, dex: 'uniswap-v4', kind: 'v4', pool: '0x' + 'ee'.repeat(32), token0: '0x0', token1: '0x' + '22'.repeat(20), fee: 3000, blockNumber: 1, at: NOW, skip: "this app doesn't swap V4" } as SnipeHit;
    const t = make({ discover: async () => [], hits: [hit, hit, hit] });
    t.configure({ perTradeUsd: 100, totalUsd: 500, sniper: { on: true } as never });
    t.turnOn();
    await t.tick();
    expect(t.status().funnel).toMatchObject({ scouted: 0, rules: 0 });
  });
});
