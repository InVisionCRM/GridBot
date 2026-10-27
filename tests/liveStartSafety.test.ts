/**
 * Two safety-check rules:
 * 1. The Re-check button hitting an RPC hiccup (transport error, timeout, rate limit, simulation unavailable) marks
 *    the market stale and warns; it does not pause. A re-check after a suspicious event (reverted swap, short fill)
 *    that errors still pauses.
 * 2. A LIVE start needs a fresh safety check that completes: 3 tries, then blocked with a clear reason
 *    (SAFETY_INCOMPLETE). Start anyway goes ahead after that and is audited (who, why blocked). A check that completes
 *    and fails (SAFETY_BLOCKED) has no Start anyway. Paper starts don't check.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { CHAINS, chainByKey } from '../src/live/chains';
import { defaultMarkets, legacyMarkets, type MarketDef, type SafetyReport } from '../src/live/markets';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, LIVE_CHECK_TRIES, SafetyBlocked, SafetyIncomplete, type CustomFile } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { requestStore } from '../src/server/bot/audit';
import { isRpcHiccup } from '../src/server/bot/taxWatch';
import { createApp } from '../src/server/app';
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
const TKN: Tok = { address: '0x00000000000000000000000000000000000b0b09', symbol: 'TKN', decimals: 18 };

const probe = (p: Partial<ProbeResult> = {}): ProbeResult => ({
  stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 100n, transferGot: 100n,
  sellIn: 900n, expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 100_000n, gasSell: 100_000n, ...p,
});
const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];
const measured = (p: Partial<ProbeResult> = {}): SafetyReport => classify({ probe: probe(p), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3', now: 5_000 });
/** The simulation didn't run (eth_call override refused / RPC trouble): nothing measured. */
const inconclusive = (): SafetyReport => ({ ...measured(), risk: 'unknown', liveAllowed: false, simulated: false, reasons: ['simulation unavailable: eth_call state override not supported'] });
const PASS = measured({ gotBuy: 990n });
const FAIL = measured({ stage: 4 }); // a completed check that failed

/** What each hub.inspect call does, in order; the last entry repeats. 'hang' never answers. */
type Step = 'none' | 'throw' | 'rate' | 'hang' | SafetyReport;

interface WorldOpts { store?: MemoryStore<MultiState>; steps?: Step[]; bootCheckMs?: number; tryMs?: number }
function world(shipped: SafetyReport = PASS, o: WorldOpts = {}) {
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
  const hub = new Hub({
    runtimes: [new ChainRuntime(CHAINS[0], pls, null), new ChainRuntime(ETH, eth, noSend)], markets: [...legacyMarkets(NET), ETH_DEF, def],
    legacyNet: NET, custom: new MemoryStore<CustomFile>(), now: () => t, safetyRetryMs: [0, 0], safetyTryTimeoutMs: o.tryMs,
  });
  let steps: Step[] = o.steps ?? ['none'];
  let calls = 0;
  (hub as unknown as { inspect: () => Promise<unknown> }).inspect = async () => {
    const s = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if (s === 'hang') return new Promise(() => {});
    if (s === 'throw') throw Object.assign(new Error('request timeout (code=TIMEOUT)'), { code: 'TIMEOUT' });
    if (s === 'rate') throw new Error('429 Too Many Requests: rate limit exceeded');
    return s === 'none' ? { safety: null, chosen: null } : { safety: s, chosen: {} };
  };
  const store = o.store ?? new MemoryStore<MultiState>();
  const bot = new MultiBot({ net: NET, reader: pls, signer: null, store, log: new Logger(true), hub, now: () => t, bootCheckMs: o.bootCheckMs });
  const set = (...s: Step[]) => { steps = s; calls = 0; };
  return { hub, bot, store, key: def.key, set, calls: () => calls, tick: (ms: number) => { t += ms; } };
}

async function gridParams(bot: MultiBot, key: string) {
  const spot = await bot.hub.quoter(key).getPrice();
  return { stable: key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 0.001 };
}
const asButton = <T>(fn: () => Promise<T>) => requestStore.run({ origin: 'localhost', endpoint: 'POST /api/bot/grids', ua: 'test-browser', from: 'start-anyway' }, fn);
const caught = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

describe('1. Re-check button: an RPC hiccup marks the market stale and warns; it does not pause', () => {
  it('isRpcHiccup: transport / timeout / rate limit / simulation unavailable yes; a revert or a plain bug no', () => {
    expect(isRpcHiccup(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }))).toBe(true);
    expect(isRpcHiccup(Object.assign(new Error('bad response'), { code: 'SERVER_ERROR' }))).toBe(true);
    expect(isRpcHiccup(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRpcHiccup(new Error('simulation unavailable'))).toBe(true);
    expect(isRpcHiccup(Object.assign(new Error('execution reverted: TRANSFER_FAILED'), { code: 'CALL_EXCEPTION', reason: 'TRANSFER_FAILED', data: '0x08c379a0' }))).toBe(false);
    expect(isRpcHiccup(new Error('cannot read properties of undefined'))).toBe(false);
  });

  for (const [name, step] of [['times out', 'throw'], ['is rate limited', 'rate'], ['cannot run the simulation', inconclusive()]] as const) {
    it(`manual re-check that ${name}: bots keep running, report kept and labelled stale, warning shown`, async () => {
      const { bot, key, set } = world();
      const id = await bot.add({ mode: 'paper', ...(await gridParams(bot, key)) });
      set(step);
      const r = await bot.recheckMarket(key);
      expect(r.risk).toBe(PASS.risk); // the last measured report, not the inconclusive one
      expect(r.liveAllowed).toBe(true);
      expect(r.stale).toBeTruthy();
      const g = bot.status().grids.find((x) => x.id === id)!;
      expect(g.status).toBe('running');
      expect(g.halt ?? null).toBeNull();
      expect(bot.status().safetyStale).toEqual([expect.objectContaining({ key })]);
      const evs = bot.activity.recent();
      expect(evs.some((e) => e.level === 'warn' && /bots keep running/.test(e.msg))).toBe(true);
      expect(evs.some((e) => /paused/.test(e.msg) && e.level === 'error')).toBe(false);
    });
  }

  it('a re-check after a suspicious event (reverted swap / short fill) that errors still pauses', async () => {
    for (const ev of ['swap reverted', 'fill short of the post-tax quote']) {
      const { bot, key, set } = world();
      const id = await bot.add({ mode: 'paper', ...(await gridParams(bot, key)) });
      set('throw');
      expect(await bot.taxWatch.suspect(key, ev)).toMatchObject({ blocked: true, paused: 1 });
      const g = bot.status().grids.find((x) => x.id === id)!;
      expect(g.status).toBe('stopped');
      expect(g.halt).toMatchObject({ what: 'safety-pause', origin: 'system' });
      expect(bot.activity.recent().some((e) => /tax re-check FAILED after/.test(e.msg))).toBe(true);
    }
  });

  it('a suspicious-event check that cannot run the simulation still pauses (unchanged)', async () => {
    const { bot, key, set } = world();
    const id = await bot.add({ mode: 'paper', ...(await gridParams(bot, key)) });
    set(inconclusive());
    expect(await bot.taxWatch.suspect(key, 'swap reverted')).toMatchObject({ blocked: true });
    expect(bot.status().grids.find((x) => x.id === id)!.status).toBe('stopped');
  });

  it('a manual re-check that measures a real problem still pauses', async () => {
    const { bot, key, set } = world();
    const id = await bot.add({ mode: 'paper', ...(await gridParams(bot, key)) });
    set(FAIL);
    const r = await bot.recheckMarket(key);
    expect(r.liveAllowed).toBe(false);
    expect(bot.status().grids.find((x) => x.id === id)!.status).toBe('stopped');
  });
});

describe('2. A LIVE start needs a fresh, completed safety check', () => {
  it('passes on a fresh measured check: starts, one try, no override recorded', async () => {
    const { bot, key, set, calls } = world();
    set(PASS);
    const id = await bot.add({ mode: 'live', ...(await gridParams(bot, key)) });
    expect(calls()).toBe(1);
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('running');
    expect(g.startOverride).toBeNull();
    bot.stopAll();
  });

  it('retries: two hiccups then a pass → starts on the third try', async () => {
    const { bot, key, set, calls } = world();
    set('throw', 'rate', PASS);
    const id = await bot.add({ mode: 'live', ...(await gridParams(bot, key)) });
    expect(calls()).toBe(3);
    expect(bot.status().grids.find((x) => x.id === id)!.status).toBe('running');
    bot.stopAll();
  });

  for (const [name, step] of [['throws', 'throw'], ['returns no report', 'none'], ['cannot run the simulation', inconclusive()]] as const) {
    it(`a check that ${name} on every try: ${LIVE_CHECK_TRIES} tries, then blocked with a clear reason; no bot left behind`, async () => {
      const { bot, key, set, calls } = world();
      set(step);
      const e = await caught(bot.add({ mode: 'live', ...(await gridParams(bot, key)) }));
      expect(calls()).toBe(3);
      expect(e).toBeInstanceOf(SafetyIncomplete);
      expect((e as SafetyIncomplete).code).toBe('SAFETY_INCOMPLETE');
      expect((e as SafetyIncomplete).canStartAnyway).toBe(true);
      expect(e!.message).toMatch(/LIVE blocked — couldn't complete the safety check for .* after 3 tries .*you can Start anyway/);
      expect(bot.status().grids).toHaveLength(0);
      expect(bot.hub.def(key).safety!.risk).toBe(PASS.risk); // the measured report is kept (stale), not replaced
    });
  }

  it('Start anyway (after a confirm in the page) starts the bot and is audited: who pressed it and why it was blocked', async () => {
    const { bot, key, set, calls } = world();
    set('throw');
    const p = { mode: 'live' as const, ...(await gridParams(bot, key)) };
    await expect(bot.add(p)).rejects.toBeInstanceOf(SafetyIncomplete);
    set('throw');
    const id = await asButton(() => bot.add({ ...p, startAnyway: true }));
    expect(calls()).toBe(3); // still tried 3 times first
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('running');
    expect(g.startOverride).toMatchObject({
      what: 'button', detail: 'Start anyway button', origin: 'localhost', endpoint: 'POST /api/bot/grids', ua: 'test-browser',
      blockedBy: expect.stringMatching(/timeout/), tries: 3, lastKnownRisk: PASS.risk,
    });
    const ev = bot.activity.recent().find((e) => /Start anyway/.test(e.msg))!;
    expect(ev).toMatchObject({ level: 'warn', notify: true, data: { startOverride: expect.objectContaining({ blockedBy: expect.stringMatching(/timeout/) }) } });
    bot.stopAll();
  });

  it('startAnyway is ignored when the check completes and passes (no override recorded)', async () => {
    const { bot, key, set } = world();
    set(PASS);
    const id = await bot.add({ mode: 'live', ...(await gridParams(bot, key)), startAnyway: true });
    expect(bot.status().grids.find((x) => x.id === id)!.startOverride).toBeNull();
    bot.stopAll();
  });

  it('a check that completes and says blocked stays blocked: Start anyway cannot bypass it', async () => {
    const { bot, key, set } = world();
    set(FAIL);
    const p = { mode: 'live' as const, ...(await gridParams(bot, key)) };
    const e = await caught(bot.add(p));
    expect(e).toBeInstanceOf(SafetyBlocked);
    expect((e as SafetyBlocked).code).toBe('SAFETY_BLOCKED');
    expect(e!.message).toMatch(/LIVE blocked/);
    set(FAIL);
    await expect(asButton(() => bot.add({ ...p, startAnyway: true }))).rejects.toBeInstanceOf(SafetyBlocked);
    // A fail found on a later try counts too.
    set('throw', FAIL);
    await expect(asButton(() => bot.add({ ...p, startAnyway: true }))).rejects.toBeInstanceOf(SafetyBlocked);
    expect(bot.status().grids).toHaveLength(0);
  });

  it('conservative rule: no live start (not even Start anyway) for a token never checked to a pass or that last failed', async () => {
    for (const shipped of [inconclusive(), FAIL]) {
      const { bot, key, set } = world(shipped);
      set('throw');
      const p = { mode: 'live' as const, ...(await gridParams(bot, key)) };
      await expect(bot.add(p)).rejects.toMatchObject({ code: 'SAFETY_INCOMPLETE', canStartAnyway: false });
      set('throw');
      const e = await caught(asButton(() => bot.add({ ...p, startAnyway: true })));
      expect(e).toBeInstanceOf(SafetyIncomplete);
      expect((e as SafetyIncomplete).canStartAnyway).toBe(false);
      expect(e!.message).toMatch(/never passed a safety check/);
      expect(bot.status().grids).toHaveLength(0);
    }
  });

  it('paper starts are unchanged: no safety check, no block, no override', async () => {
    const { bot, key, set, calls } = world();
    set('throw');
    const id = await bot.add({ mode: 'paper', ...(await gridParams(bot, key)) });
    expect(calls()).toBe(0);
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('running');
    expect(g.startOverride ?? null).toBeNull();
  });

  it('trend bots: blocked after 3 tries, Start anyway audited; paper unchanged', async () => {
    const { bot, key, set, calls } = world();
    set('throw');
    const p = { mode: 'live' as const, quote: key, tf: '1h' as const, capital: 0.001 };
    await expect(bot.addTrend(p)).rejects.toBeInstanceOf(SafetyIncomplete);
    expect(calls()).toBe(3);
    set('throw');
    const id = await asButton(() => bot.addTrend({ ...p, startAnyway: true }));
    const t = bot.status().trends.find((x) => x.id === id)!;
    expect(t.status).toBe('running');
    expect(t.startOverride).toMatchObject({ detail: 'Start anyway button', origin: 'localhost', blockedBy: expect.stringMatching(/timeout/) });
    bot.stopAll();
    set(FAIL);
    await expect(asButton(() => bot.addTrend({ ...p, startAnyway: true }))).rejects.toBeInstanceOf(SafetyBlocked);
    set('throw');
    const pid = await bot.addTrend({ ...p, mode: 'paper' });
    expect(calls()).toBe(0);
    expect(bot.status().trends.find((x) => x.id === pid)!.status).toBe('running');
  });
});

describe('2b. liquidity bots follow the same rule', () => {
  it('LP: blocked after 3 tries, Start anyway audited, a real fail not bypassable', async () => {
    const { bot, key, set, calls } = world();
    set('throw');
    const p = { mode: 'live' as const, market: key, bandPct: 0.1, capital: 0.001 };
    await expect(bot.addLp(p)).rejects.toBeInstanceOf(SafetyIncomplete);
    expect(calls()).toBe(3);
    expect(bot.status().lps ?? []).toHaveLength(0);
    set('throw');
    const id = await asButton(() => bot.addLp({ ...p, startAnyway: true }));
    const lp = bot.status().lps.find((x: { id: string }) => x.id === id)!;
    expect(lp.startOverride).toMatchObject({ detail: 'Start anyway button', origin: 'localhost', blockedBy: expect.stringMatching(/timeout/) });
    bot.stopAll();
    set(FAIL);
    await expect(asButton(() => bot.addLp({ ...p, startAnyway: true }))).rejects.toBeInstanceOf(SafetyBlocked);
  });
});

const asResume = <T>(fn: () => Promise<T>) => requestStore.run({ origin: 'gateway-owner', endpoint: 'POST /api/bot/grids/:id/resume', ua: 'phone', from: null }, fn);

describe('3. Resume of a stopped LIVE bot runs the same fresh check (3 tries)', () => {
  /** A live grid, trend and LP on the market, started on a passing check, then stopped. */
  async function stoppedLive(shipped: SafetyReport = PASS) {
    const w = world(shipped);
    w.set(PASS);
    const g = await w.bot.add({ mode: 'live', ...(await gridParams(w.bot, w.key)) });
    const t = await w.bot.addTrend({ mode: 'live', quote: w.key, tf: '1h', capital: 0.001 });
    const l = await w.bot.addLp({ mode: 'live', market: w.key, bandPct: 0.1, capital: 0.001 });
    w.bot.stopAll();
    const st = () => w.bot.status();
    const bots = {
      grid: { resume: () => w.bot.resume(g), get: () => st().grids.find((x) => x.id === g)! },
      trend: { resume: () => w.bot.resumeTrend(t), get: () => st().trends.find((x) => x.id === t)! },
      lp: { resume: () => w.bot.resumeLp(l), get: () => st().lps.find((x: { id: string }) => x.id === l)! },
    };
    return { ...w, bots };
  }

  it('check passes → resumes; one try; no override', async () => {
    const w = await stoppedLive();
    for (const [, b] of Object.entries(w.bots)) {
      w.set(PASS);
      await b.resume();
      expect(w.calls()).toBe(1);
      expect(b.get().status).toBe('running');
      expect(b.get().startOverride ?? null).toBeNull();
    }
  });

  it('check completes and fails → resume refused with the reasons (grid, trend, LP); the bot stays stopped', async () => {
    const w = await stoppedLive();
    for (const [, b] of Object.entries(w.bots)) {
      w.set('throw', FAIL);
      const e = await caught(b.resume());
      expect(e).toBeInstanceOf(SafetyBlocked);
      expect(e!.message).toMatch(/LIVE blocked — .* safety \w+: /);
      expect(b.get().status).toBe('stopped');
    }
  });

  it("check can't complete (3 tries) → resumes on the last passing report, marked stale, audited + activity warning; no button needed", async () => {
    const w = await stoppedLive();
    for (const [kind, b] of Object.entries(w.bots)) {
      w.set('throw');
      await asResume(() => b.resume());
      expect(w.calls()).toBe(3);
      expect(b.get().status).toBe('running');
      expect(b.get().startOverride).toMatchObject({ kind: 'resume', what: 'resume', origin: 'gateway-owner', endpoint: 'POST /api/bot/grids/:id/resume', ua: 'phone', blockedBy: expect.stringMatching(/timeout/), tries: 3 });
      expect(w.hub.def(w.key).safety!.stale).toBeTruthy();
      expect(w.bot.status().safetyStale).toEqual([expect.objectContaining({ key: w.key })]);
      const ev = w.bot.activity.recent().filter((e) => /resumed on the last passing safety report/.test(e.msg)).at(-1)!;
      expect(ev, kind).toMatchObject({ level: 'warn', notify: true, data: { startOverride: expect.objectContaining({ kind: 'resume' }) } });
      w.bot.stopAll();
    }
  });

  it("can't complete and there is no passing report (never passed / last failed) → resume refused", async () => {
    const w = await stoppedLive();
    // The stored report is replaced by a measured fail, then the RPC goes away.
    w.set(FAIL);
    await w.bot.recheckMarket(w.key).catch(() => undefined);
    for (const [, b] of Object.entries(w.bots)) {
      w.set('throw');
      await expect(b.resume()).rejects.toBeInstanceOf(SafetyIncomplete);
      expect(b.get().status).toBe('stopped');
    }
  });

  it('paper resume is unchanged: no check', async () => {
    const w = world();
    const id = await w.bot.add({ mode: 'paper', ...(await gridParams(w.bot, w.key)) });
    w.bot.stopAll();
    w.set('throw');
    await w.bot.resume(id);
    expect(w.calls()).toBe(0);
    expect(w.bot.status().grids[0].status).toBe('running');
  });

  it('a hung RPC is cut off per try: the resume answers instead of hanging', async () => {
    const w = world(PASS, { tryMs: 30 });
    w.set(PASS);
    const id = await w.bot.add({ mode: 'live', ...(await gridParams(w.bot, w.key)) });
    w.bot.stopAll();
    w.set('hang');
    const t0 = Date.now();
    await w.bot.resume(id);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(w.bot.status().grids[0].startOverride).toMatchObject({ kind: 'resume', blockedBy: expect.stringMatching(/timed out/) });
    w.bot.stopAll();
  });
});

describe('4. App restart: live bots restored as running follow the resume rule, held until their check answers', () => {
  /** A store with a live grid, trend and LP running on the market (written by a first app run). */
  async function savedRunning() {
    const w = world();
    w.set(PASS);
    await w.bot.add({ mode: 'live', ...(await gridParams(w.bot, w.key)) });
    await w.bot.addTrend({ mode: 'live', quote: w.key, tf: '1h', capital: 0.001 });
    await w.bot.addLp({ mode: 'live', market: w.key, bandPct: 0.1, capital: 0.001 });
    await w.bot.bootSafety;
    const st = w.bot.status();
    expect([...st.grids, ...st.trends, ...st.lps].map((b) => b.status)).toEqual(['running', 'running', 'running']);
    return w.store;
  }
  const all = (bot: MultiBot) => { const st = bot.status(); return [...st.grids, ...st.trends, ...st.lps] as { id: string; status: string; halt?: unknown; startOverride?: unknown }[]; };

  it('boot check passes → all keep running, one check for the market', async () => {
    const store = await savedRunning();
    const w = world(PASS, { store, steps: [PASS] });
    await w.bot.bootSafety;
    expect(w.calls()).toBe(1); // one check per market, not per bot
    expect(all(w.bot).map((b) => b.status)).toEqual(['running', 'running', 'running']);
    expect(w.bot.status().safetyChecking).toEqual([]);
  });

  it('boot check completes and fails → none is resumed: all stopped with the reasons (safety pause), notifying alert', async () => {
    const store = await savedRunning();
    const w = world(PASS, { store, steps: ['throw', FAIL] });
    await w.bot.bootSafety;
    for (const b of all(w.bot)) {
      expect(b.status).toBe('stopped');
      expect(b.halt).toMatchObject({ what: 'safety-pause', origin: 'system', detail: expect.stringMatching(/safety check after restart: LIVE blocked/) });
    }
    expect(w.bot.activity.recent().some((e) => e.level === 'error' && e.notify && /safety check after restart/.test(e.msg))).toBe(true);
  });

  it("boot check can't complete → keep running on the last passing report, stale, audited (kind 'boot', the app) with a warning", async () => {
    const store = await savedRunning();
    const w = world(PASS, { store, steps: ['throw'] });
    await w.bot.bootSafety;
    expect(w.calls()).toBe(3);
    for (const b of all(w.bot)) {
      expect(b.status).toBe('running');
      expect(b.startOverride).toMatchObject({ kind: 'boot', what: 'boot', origin: 'system', blockedBy: expect.stringMatching(/timeout/) });
    }
    expect(w.bot.status().safetyStale).toEqual([expect.objectContaining({ key: w.key })]);
    expect(w.bot.activity.recent().filter((e) => e.level === 'warn' && e.notify && /safety check after restart couldn't complete/.test(e.msg))).toHaveLength(3);
    // The audit is saved: a second restart (check passes) still shows it until the bot is restarted or resumed.
    const again = world(PASS, { store, steps: [PASS] });
    await again.bot.bootSafety;
    expect(all(again.bot).every((b) => (b.startOverride as { kind?: string })?.kind === 'boot')).toBe(true);
  });

  it("boot check can't complete and the last report isn't a pass → stopped, not resumed", async () => {
    const store = await savedRunning();
    const w = world(FAIL, { store, steps: ['throw'] });
    await w.bot.bootSafety;
    for (const b of all(w.bot)) expect(b.status).toBe('stopped');
  });

  it('boot never gets stuck: a hung RPC is cut off by the boot deadline; bots are held (exits only / LP not ticked) until then', async () => {
    const store = await savedRunning();
    const w = world(PASS, { store, steps: ['hang'], bootCheckMs: 150, tryMs: 10_000 });
    const ids = all(w.bot).map((b) => b.id);
    expect(w.bot.status().safetyChecking.sort()).toEqual([...ids].sort());
    // While held, grid and trend bots tick for exits only (tests/bootHoldExits.test.ts); the liquidity bot (no
    // stop / take-profit exits) isn't ticked unless it has a tx to settle.
    const grids = [...(w.bot as unknown as { engines: Map<string, { tick: () => Promise<void>; safetyHold: unknown }> }).engines.values()];
    const trends = [...(w.bot as unknown as { trendEngines: Map<string, { tick: () => Promise<void>; safetyHold: unknown }> }).trendEngines.values()];
    const lps = [...(w.bot as unknown as { lpEngines: Map<string, { tick: () => Promise<void> }> }).lpEngines.values()];
    expect([...grids, ...trends].map((e) => e.safetyHold)).toEqual(['exits', 'exits']);
    let ticked = 0, lpTicked = 0;
    for (const e of [...grids, ...trends]) e.tick = async () => { ticked++; };
    for (const e of lps) e.tick = async () => { lpTicked++; };
    await w.bot.tickAll();
    expect([ticked, lpTicked]).toEqual([2, 0]);
    const t0 = Date.now();
    await w.bot.bootSafety;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(w.bot.status().safetyChecking).toEqual([]);
    for (const b of all(w.bot)) {
      expect(b.status).toBe('running');
      expect(b.startOverride).toMatchObject({ kind: 'boot', blockedBy: expect.stringMatching(/timed out|out of time/) });
    }
    expect([...grids, ...trends].map((e) => e.safetyHold)).toEqual([null, null]); // released
    await w.bot.tickAll();
    expect([ticked, lpTicked]).toEqual([4, 1]);
  });

  it('paper bots and stopped live bots are not checked at boot', async () => {
    const w0 = world();
    const id = await w0.bot.add({ mode: 'paper', ...(await gridParams(w0.bot, w0.key)) });
    w0.set(PASS);
    const lid = await w0.bot.add({ mode: 'live', ...(await gridParams(w0.bot, w0.key)) });
    w0.bot.stop(lid);
    const w = world(PASS, { store: w0.store, steps: ['throw'] });
    await w.bot.bootSafety;
    expect(w.calls()).toBe(0);
    expect(w.bot.status().grids.find((g) => g.id === id)!.status).toBe('running');
  });
});

describe('API: the block reason and code reach the page; Start anyway is a body flag plus the button name', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });
  const post = (port: number, path: string, body: unknown, from?: string) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': 'api-test', ...(from ? { 'x-gridbot-from': from } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });

  it('SAFETY_INCOMPLETE (canStartAnyway) → Start anyway starts and records the request; SAFETY_BLOCKED has no bypass', async () => {
    const { bot, key, set } = world();
    const server = http.createServer(createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000 }));
    servers.push(server);
    const port = await new Promise<number>((res) => server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port)));
    const body = { mode: 'live', ...(await gridParams(bot, key)) };
    set('throw');
    const a = await post(port, '/api/bot/grids', body);
    expect(a.status).toBe(400);
    expect(a.json).toMatchObject({ code: 'SAFETY_INCOMPLETE', canStartAnyway: true, error: expect.stringMatching(/couldn't complete the safety check/) });
    set('throw');
    const b = await post(port, '/api/bot/grids', { ...body, startAnyway: true }, 'start-anyway');
    expect(b.status).toBe(200);
    const g = bot.status().grids.find((x) => x.id === b.json.id)!;
    expect(g.startOverride).toMatchObject({ detail: 'Start anyway button', origin: 'localhost', endpoint: 'POST /api/bot/grids', ua: 'api-test' });
    bot.stopAll();
    set(FAIL);
    const c = await post(port, '/api/bot/grids', { ...body, startAnyway: true }, 'start-anyway');
    expect(c.status).toBe(400);
    expect(c.json).toMatchObject({ code: 'SAFETY_BLOCKED', canStartAnyway: false });
  });
});
