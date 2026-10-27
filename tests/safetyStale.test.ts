/**
 * hub.recheck no longer silently keeps the old report (`fresh ?? d.safety`): when a re-check fails or measures nothing,
 * the last known values stay (for display and the taxes quotes use) but are labelled stale, the status / UI / activity
 * log say so, and nothing pauses or stops a bot because of it. Live starts decide on the last known report, as before.
 */
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { CHAINS, chainByKey } from '../src/live/chains';
import { defaultMarkets, legacyMarkets, type MarketDef, type SafetyReport } from '../src/live/markets';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, type CustomFile } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain } from './helpers/mockChain';

const NET = NETWORKS.mainnet;
const ETH = chainByKey('ethereum')!;
const uni = ETH.dexes.find((d) => d.id === 'uniswap-v3')!;
const WETH: Tok = { address: ETH.wrappedNative.address, symbol: 'WETH', decimals: 18 };
const USDCs = ETH.stables.find((s) => s.symbol === 'USDC')!;
const USDC: Tok = { address: USDCs.address, symbol: 'USDC', decimals: 6 };
const ETH_DEF = defaultMarkets().find((m) => m.chainId === 1)!;
const ME = '0x1234567890123456789012345678901234567890';
const TKN: Tok = { address: '0x00000000000000000000000000000000000b0b07', symbol: 'TKN', decimals: 18 };

const probe = (p: Partial<ProbeResult> = {}): ProbeResult => ({
  stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 100n, transferGot: 100n,
  sellIn: 900n, expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 100_000n, gasSell: 100_000n, ...p,
});
const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];
const measured = (p: Partial<ProbeResult> = {}): SafetyReport => classify({ probe: probe(p), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3', now: 5_000 });

type Next = 'none' | 'throw' | SafetyReport;
function world(shipped: SafetyReport = measured({ gotBuy: 990n })) {
  let t = 1_000_000;
  const pls = new MockChain(0.00001), eth = new MultiDexMock();
  [WETH, USDC, TKN].forEach((x) => eth.addToken(x));
  eth.addV3('uniswap-v3', { factory: uni.factory, quoter: uni.quoter! });
  eth.v3Pool('uniswap-v3', WETH, 5_000, USDC, 15_000_000, 500, ETH_DEF.pool.address);
  const pool = eth.v3Pool('uniswap-v3', TKN, 1e6, WETH, 100, 3000);
  eth.gasPrice = 10n ** 7n;
  const def: MarketDef = {
    key: 'ethereum:TKN/ETH', chainId: 1, base: { address: TKN.address, symbol: 'TKN', decimals: 18 }, quote: { address: WETH.address, symbol: 'ETH', decimals: 18, native: true },
    pool: { dex: 'uniswap-v3', kind: 'v3', address: pool, feeBps: 30, feeTier: 3000 }, probe: 1, quoteKind: 'wrapped', candlePool: pool, safety: shipped,
  };
  const noSend = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('test: must not send'); } };
  const hub = new Hub({ runtimes: [new ChainRuntime(CHAINS[0], pls, null), new ChainRuntime(ETH, eth, noSend)], markets: [...legacyMarkets(NET), ETH_DEF, def], legacyNet: NET, custom: new MemoryStore<CustomFile>(), now: () => t });
  const bot = new MultiBot({ net: NET, reader: pls, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub, now: () => t });
  let next: Next = 'none';
  (hub as unknown as { inspect: () => Promise<unknown> }).inspect = async () => {
    if (next === 'throw') throw new Error('request timeout (code=TIMEOUT)');
    return next === 'none' ? { safety: null, chosen: null } : { safety: next, chosen: {} };
  };
  return { hub, bot, key: def.key, set: (n: Next) => { next = n; }, tick: (ms: number) => { t += ms; } };
}

describe('hub.recheck: a failed or empty re-check marks the report stale instead of silently keeping it', () => {
  it('no report: last known values returned, labelled stale; one transition event; cleared by the next measured check', async () => {
    const { hub, key } = world();
    const stale: string[] = [], fresh: string[] = [];
    hub.onSafetyStale = (k) => stale.push(k);
    hub.onSafetyFresh = (k) => fresh.push(k);
    const before = hub.def(key).safety!;
    const r = await hub.recheck(key);
    expect({ ...r, stale: undefined }).toEqual({ ...before, stale: undefined });
    expect(r.liveAllowed).toBe(true);
    expect(r.stale).toEqual({ since: 1_000_000, lastTry: 1_000_000, why: 'the re-check found no usable pool' });
    expect(hub.def(key).safety).toBe(r);
    const r2 = await hub.recheck(key, { keepMeasured: true });
    expect(r2.stale!.since).toBe(1_000_000); // still the first failure
    expect(stale).toEqual([key]); // announced once per run of failures
    expect(fresh).toEqual([]);
  });

  it('a measured re-check replaces the stale report and clears the label', async () => {
    const { hub, key, set } = world();
    const fresh: string[] = [];
    hub.onSafetyFresh = (k) => fresh.push(k);
    await hub.recheck(key);
    const m = measured();
    set(m);
    expect(await hub.recheck(key)).toBe(m);
    expect(hub.def(key).safety!.stale).toBeUndefined();
    expect(fresh).toEqual([key]);
  });

  it('a thrown re-check marks it stale and re-throws (callers unchanged)', async () => {
    const { hub, key, set } = world();
    set('throw');
    await expect(hub.recheck(key)).rejects.toThrow(/TIMEOUT/);
    expect(hub.def(key).safety!.stale!.why).toMatch(/re-check failed: request timeout/);
    expect(hub.def(key).safety!.liveAllowed).toBe(true);
  });
});

describe('Stale never pauses or stops a bot', () => {
  for (const [name, n] of [['returns nothing', 'none'], ['throws', 'throw']] as const) {
    it(`scheduled check that ${name}: running bots keep running; status, market list and activity say stale`, async () => {
      const { bot, key, set, tick } = world();
      const spot = await bot.hub.quoter(key).getPrice();
      const id = await bot.add({ mode: 'paper', stable: key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 50 });
      expect(bot.status().grids.find((g) => g.id === id)!.status).toBe('running');
      set(n);
      tick(60 * 60_000);
      const [c] = await bot.taxWatch.tick();
      expect(c).toMatchObject({ blocked: false, paused: 0 });
      const st = bot.status();
      expect(st.grids.find((g) => g.id === id)!.status).toBe('running');
      expect(st.grids.find((g) => g.id === id)!.halt ?? null).toBeNull();
      expect(st.safetyStale).toEqual([expect.objectContaining({ key, label: bot.hub.label(key) })]);
      expect(st.marketList.find((m) => m.key === key)!.safetyStale).toBeTruthy();
      expect(st.marketList.find((m) => m.key === key)!.liveAllowed).toBe(true);
      const msgs = bot.activity.recent().map((e) => e.msg);
      expect(msgs.some((m) => /safety report is STALE/.test(m))).toBe(true);
    });
  }

  it('a check after a suspicious event or a manual re-check that returns nothing does not pause either', async () => {
    const { bot, key, set } = world();
    const spot = await bot.hub.quoter(key).getPrice();
    const id = await bot.add({ mode: 'paper', stable: key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 50 });
    set('none');
    expect(await bot.taxWatch.suspect(key, 'swap reverted')).toMatchObject({ blocked: false, paused: 0 });
    const r = await bot.recheckMarket(key);
    expect(r.stale).toBeTruthy();
    expect(bot.status().grids.find((g) => g.id === id)!.status).toBe('running');
    expect(bot.activity.recent().some((e) => /measured nothing.*bots keep running/.test(e.msg))).toBe(true);
  });
});

describe('Live start with a stale report: decided on the last known report, as before', () => {
  it('last known passing → not blocked by safety (and warns it is stale)', async () => {
    const outcomes: string[] = [];
    for (const n of ['none', 'throw'] as const) {
      const { bot, key, set } = world();
      set(n);
      const spot = await bot.hub.quoter(key).getPrice();
      const p = { mode: 'live' as const, stable: key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 0.001 };
      const res = await bot.add(p).then((id) => ({ id }), (e: Error) => ({ e }));
      if ('e' in res) expect(res.e.message).not.toMatch(/LIVE blocked/);
      else bot.stopAll();
      outcomes.push('e' in res ? res.e.message : 'started');
      expect(bot.hub.def(key).safety!.stale).toBeTruthy();
    }
    expect(outcomes).toEqual(['started', 'started']);
  });

  it('last known failing → still blocked', async () => {
    const { bot, key, set } = world(measured({ stage: 4 }));
    expect(bot.hub.def(key).safety!.liveAllowed).toBe(false);
    set('none');
    const spot = await bot.hub.quoter(key).getPrice();
    await expect(bot.add({ mode: 'live', stable: key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 0.001 })).rejects.toThrow(/LIVE blocked/);
  });
});
