/**
 * Closing bots: paper leaves the active list in the request, with no chain reads.
 * Live is marked closing immediately and unwound through the normal price-impact cap and slippage.
 */
import { describe, expect, it } from 'vitest';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { NETWORKS } from '../src/live/networks';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { NET, MockChain } from './helpers/mockChain';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 };

function make(chain = new MockChain(P0), store = new MemoryStore<MultiState>(), signer: MockChain | null = chain) {
  const log = new Logger(true);
  const bot = new MultiBot({ net: NET, reader: chain, signer, store, log, maxRetries: 1, retryDelayMs: 0 });
  return { chain, store, log, bot };
}

function callsOf(chain: { call: (tx: { to: string; data: string }) => Promise<string> }) {
  let n = 0;
  const orig = chain.call.bind(chain);
  chain.call = async (tx: { to: string; data: string }) => { n++; return orig(tx); };
  return { get n() { return n; } };
}

describe('close', () => {
  it('closes several paper bots in the request, with no new chain reads, and keeps their history', async () => {
    const { chain, bot } = make();
    const reads = callsOf(chain);
    const g1 = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const g2 = await bot.add({ mode: 'paper', stable: 'USDC', ...base });
    await bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', capital: 25, cfg: {} });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    const journal = bot.journal({ mode: 'paper' }).length;
    expect(journal).toBeGreaterThan(0);
    const before = reads.n;
    const out = bot.closeAll();
    expect(reads.n).toBe(before);
    expect(out.closing).toBe(0);
    expect(out.closed).toBe(3);
    const st = bot.status();
    expect(st.grids).toHaveLength(2);
    expect(st.trends).toHaveLength(1);
    expect([...st.grids, ...st.trends].every((b) => b.archivedAt != null && b.closing === false)).toBe(true);
    expect(bot.journal({ mode: 'paper' })).toHaveLength(journal);
    const rows = bot.overview('paper').bots;
    expect(rows.map((r) => r.id).sort()).toEqual([g1, g2, ...st.trends.map((t) => t.id)].sort());
    expect(rows.every((r) => r.status === 'closed')).toBe(true);
    // Stop all is still only a pause: a fresh running bot is not archived.
    const still = await bot.add({ mode: 'paper', stable: 'USDT', ...base });
    bot.stopAll();
    const paused = bot.status().grids.find((g) => g.id === still)!;
    expect(paused.status).toBe('stopped');
    expect(paused.archivedAt).toBeNull();
    expect(bot.archiveClosed().archived).toBe(1);
    expect(bot.status().grids.find((g) => g.id === still)!.archivedAt).not.toBeNull();
    expect(bot.overview('paper').bots.some((r) => r.id === still)).toBe(true);
  });

  it('does not re-read price for a stopped grid', async () => {
    const { chain, bot } = make();
    const stopped = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const running = await bot.add({ mode: 'paper', stable: 'USDC', ...base });
    await bot.tickAll();
    const price = bot.status().grids.find((g) => g.id === stopped)!.price;
    bot.stop(stopped);
    chain.setPrice(P0 * 1.05);
    await bot.tickAll();
    expect(bot.status().grids.find((g) => g.id === stopped)!.price).toBe(price);
    expect(bot.status().grids.find((g) => g.id === running)!.price).not.toBe(price);
  });

  it('marks a live close immediately and will not sell through the price-impact cap', async () => {
    const { chain, bot } = make();
    const id = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    expect(bot.status().grids[0].pnl.plsHeld).toBeGreaterThan(0);
    bot.setLimits(id, { maxPriceImpact: 1e-8 });
    const out = bot.closeGrid(id);
    const mid = bot.status().grids[0];
    expect(out).toMatchObject({ closing: true, archived: false });
    expect(mid.closing).toBe(true);
    expect(mid.archivedAt).toBeNull();
    await bot.whenSettled();
    const held = bot.status().grids[0];
    expect(held.closing).toBe(true);
    expect(held.archivedAt).toBeNull();
    expect(held.pnl.plsHeld).toBeGreaterThan(0);
    expect(held.lastError ?? '').toMatch(/price impact/i);
    bot.setLimits(id, { maxPriceImpact: 0.03 });
    await bot.tickAll();
    const done = bot.status().grids[0];
    expect(done.archivedAt).not.toBeNull();
    expect(done.closing).toBe(false);
    expect(done.pnl.plsHeld).toBeLessThan(1e-6);
    expect(done.trades.some((t) => t.side === 'sell' && !t.failed)).toBe(true);
    // The close's sales are cash-outs, not grid round trips (#5): flagged, no round-trip net, not in Generated.
    const outs = done.trades.filter((t) => t.side === 'sell' && !t.failed);
    expect(outs.every((t) => t.closeOut === true && t.roundTripNet == null)).toBe(true);
    expect(done.stats.roundTrips).toBe(0);
    expect(done.stats.closeOuts).toBe(outs.length);
    expect(done.metrics!.generated).toEqual({ DAI: 0 });
  });

  it('marks every live bot closing before a hung quote returns, and archives paper in the same call', async () => {
    const chain = new MockChain(P0);
    let block = false;
    let release: () => void = () => {};
    let held = Promise.resolve();
    const orig = chain.call.bind(chain);
    let calls = 0;
    chain.call = async (tx) => {
      if (block) await held;
      calls++;
      return orig(tx);
    };
    const { bot } = make(chain);
    const a = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    const b = await bot.add({ mode: 'live', stable: 'USDC', ...base });
    const paper = await bot.add({ mode: 'paper', stable: 'USDT', ...base });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    await bot.whenSettled();
    expect(bot.status().grids.find((g) => g.id === a)!.pnl.plsHeld).toBeGreaterThan(0);
    expect(bot.status().grids.find((g) => g.id === b)!.pnl.plsHeld).toBeGreaterThan(0);
    block = true;
    held = new Promise((r) => { release = r; });
    const before = calls;
    const out = bot.closeAll();
    expect(out.closing).toBe(2);
    expect(out.closed).toBe(1);
    const st = bot.status().grids;
    expect(st.find((g) => g.id === a)).toMatchObject({ closing: true, archivedAt: null });
    expect(st.find((g) => g.id === b)).toMatchObject({ closing: true, archivedAt: null });
    expect(st.find((g) => g.id === paper)!.archivedAt).not.toBeNull();
    expect(calls).toBe(before);
    release();
    await bot.whenSettled();
    const after = bot.status().grids;
    expect(after.find((g) => g.id === a)!.archivedAt).not.toBeNull();
    expect(after.find((g) => g.id === b)!.archivedAt).not.toBeNull();
    expect(after.find((g) => g.id === a)!.pnl.plsHeld).toBeLessThan(1e-6);
    expect(after.find((g) => g.id === b)!.pnl.plsHeld).toBeLessThan(1e-6);
  });

  it('loads state saved before closing and archivedAt existed, and still resumes a running bot', async () => {
    const store = new MemoryStore<MultiState>();
    const chain = new MockChain(P0);
    const a = make(chain, store);
    await a.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const saved = store.data!.grids[0] as unknown as Record<string, unknown>;
    delete saved.closing;
    delete saved.archivedAt;
    expect(store.data!.version).toBe(4);
    const b = make(chain, store);
    const g = b.bot.status().grids[0];
    expect(g.status).toBe('running');
    expect(g.closing).toBe(false);
    expect(g.archivedAt).toBeNull();
  });

  it('finishes a paper bot that was saved mid-close without a chain read, and resumes a live close', async () => {
    const store = new MemoryStore<MultiState>();
    const chain = new MockChain(P0);
    const reads = callsOf(chain);
    const a = make(chain, store);
    await a.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const paper = store.data!.grids[0];
    paper.closing = true;
    paper.status = 'running';
    const before = reads.n;
    const reloaded = make(chain, store);
    expect(reads.n).toBe(before);
    expect(reloaded.bot.status().grids[0].closing).toBe(false);
    expect(reloaded.bot.status().grids[0].archivedAt).not.toBeNull();

    const liveStore = new MemoryStore<MultiState>();
    const liveChain = new MockChain(P0);
    const live = make(liveChain, liveStore);
    const id = await live.bot.add({ mode: 'live', stable: 'DAI', ...base });
    liveChain.setPrice(P0 * 0.975);
    await live.bot.tickAll();
    expect(live.bot.status().grids[0].pnl.plsHeld).toBeGreaterThan(0);
    const row = liveStore.data!.grids.find((g) => g.id === id)!;
    row.closing = true;
    row.status = 'running';
    row.queue = [];
    const next = make(liveChain, liveStore);
    expect(next.bot.status().grids[0].closing || next.bot.status().grids[0].archivedAt).toBeTruthy();
    await next.bot.whenSettled();
    const done = next.bot.status().grids[0];
    expect(done.archivedAt).not.toBeNull();
    expect(done.closing).toBe(false);
    expect(done.pnl.plsHeld).toBeLessThan(1e-6);
  });

  it('closes a paper liquidity bot from the last reading, with no further pool read', async () => {
    const CH = chainFromNetwork(NETWORKS.mainnet);
    const dex = CH.dexes.find((d) => d.id === '9mm-v3')!;
    const m = new MultiDexMock();
    const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
    const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex.factory, quoter: dex.quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
    const reads = callsOf(m);
    const bot = new MultiBot({ net: NET, reader: m, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
    const id = await bot.addLp({ mode: 'paper', market: def.key, bandPct: 0.1, capital: 1000 });
    await bot.tickAll();
    expect(bot.status().lps[0].position).not.toBeNull();
    const before = reads.n;
    const out = bot.closeLp(id);
    expect(reads.n).toBe(before);
    expect(out).toMatchObject({ closing: false, archived: true });
    const st = bot.status().lps[0];
    expect(st).toMatchObject({ status: 'closed', position: null, step: null, closing: false });
    expect(st.archivedAt).not.toBeNull();
    expect(bot.overview('paper').bots.some((r) => r.id === id && r.status === 'closed')).toBe(true);
  });
});
