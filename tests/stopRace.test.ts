import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { ActivityBus } from '../src/server/bot/activity';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { StartStopped } from '../src/server/bot/audit';
import { MockChain, NET } from './helpers/mockChain';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const LNET = NETWORKS.mainnet;
const CH = chainFromNetwork(LNET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: LNET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: LNET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 };

/** A chain whose reads can be held, to land a stop while a start is waiting on the RPC. */
function make() {
  const chain = new MockChain(P0);
  let hold: Promise<void> | null = null;
  let release = () => {};
  let waiting = 0;
  const call = chain.call.bind(chain);
  chain.call = async (tx) => { if (hold) { waiting++; await hold; } return call(tx); };
  const activity = new ActivityBus(400);
  const store = new MemoryStore<MultiState>();
  const bot = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0, activity });
  const holdReads = () => { waiting = 0; hold = new Promise<void>((r) => { release = () => { hold = null; r(); }; }); };
  const untilWaiting = async () => { for (let i = 0; i < 200 && waiting === 0; i++) await new Promise((r) => setImmediate(r)); expect(waiting).toBeGreaterThan(0); };
  return { chain, bot, store, activity, holdReads, untilWaiting, release: () => release() };
}

describe('a stop that lands while a bot is starting wins', () => {
  it('grid: Stop all during add() — the grid is not started, and the refusal is in the activity with the press', async () => {
    const s = make();
    s.holdReads();
    const adding = s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await s.untilWaiting();
    s.bot.stopAll();
    s.release();
    await expect(adding).rejects.toBeInstanceOf(StartStopped);
    expect(s.bot.status().grids.filter((g) => g.status === 'running')).toHaveLength(0);
    const ev = s.activity.recent(400).find((e) => e.type === 'stopped' && /not started/.test(e.msg));
    expect(ev).toBeTruthy();
    expect((ev!.data as { halt: { what: string } }).halt.what).toBe('stop-all');
  });

  it('grid: Stop all during a restart (start of a stopped grid) — it stays stopped with the new halt', async () => {
    const s = make();
    const id = await s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    s.bot.stop(id);
    s.holdReads();
    const starting = s.bot.start(id, { mode: 'paper', stable: 'DAI', ...base });
    await s.untilWaiting();
    s.bot.stopAll();
    s.release();
    await expect(starting).rejects.toBeInstanceOf(StartStopped);
    const g = s.bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('stopped');
    expect(g.halt).toMatchObject({ what: 'stop-all' });
  });

  it('a stop before the start began, or on another chain, does not block it', async () => {
    const s = make();
    s.bot.stopAll();
    await s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    expect(s.bot.status().grids[0].status).toBe('running');
    s.holdReads();
    const adding = s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await s.untilWaiting();
    s.bot.stop(s.bot.status().grids[0].id); // stopping one other bot is not a Stop all
    s.release();
    await expect(adding).resolves.toBeTypeOf('string');
  });

  it('trend: Stop all during addTrend — not started', async () => {
    const s = make();
    s.holdReads();
    const adding = s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { strategy: 'ema', fast: 2, slow: 3, atrPeriod: 2 }, capital: 100 });
    await s.untilWaiting();
    s.bot.stopAll();
    s.release();
    await expect(adding).rejects.toBeInstanceOf(StartStopped);
    expect(s.bot.status().trends.filter((t) => t.status === 'running')).toHaveLength(0);
  });

  it('liquidity: Stop all during addLp — not started', async () => {
    const m = new MultiDexMock();
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(LNET), def], legacyNet: LNET });
    const activity = new ActivityBus(400);
    const bot = new MultiBot({ net: LNET, reader: new MockChain(P0), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub, activity });
    let release = () => {};
    let waiting = 0;
    const hold = new Promise<void>((r) => { release = r; });
    let held = true;
    const call = m.call.bind(m);
    m.call = async (tx: Parameters<typeof m.call>[0]) => { if (held) { waiting++; await hold; } return call(tx); };
    const adding = bot.addLp({ mode: 'paper', market: def.key, bandPct: 0.1, capital: 1000 });
    for (let i = 0; i < 200 && !waiting; i++) await new Promise((r) => setImmediate(r));
    expect(waiting).toBeGreaterThan(0);
    bot.stopAll();
    held = false; release();
    await expect(adding).rejects.toBeInstanceOf(StartStopped);
    expect(bot.status().lps.filter((l) => l.status === 'running')).toHaveLength(0);
    expect(activity.recent(400).some((e) => e.type === 'stopped' && /not started/.test(e.msg))).toBe(true);
    // without a stop, the same start goes through
    await expect(bot.addLp({ mode: 'paper', market: def.key, bandPct: 0.1, capital: 1000 })).resolves.toBeTypeOf('string');
  });

  it('stop hooks hear every Stop all and STOP chain with the audit record', async () => {
    const s = make();
    const heard: [number | null, string][] = [];
    s.bot.stopHooks.push((c, h) => heard.push([c, h.what]));
    s.bot.stopHooks.push(() => { throw new Error('a broken hook does not stop the others'); });
    s.bot.stopAll();
    const chainId = s.bot.hub.def('DAI').chainId;
    s.bot.stopChain(chainId);
    expect(heard).toEqual([[null, 'stop-all'], [chainId, 'chain-stop']]);
  });
});
