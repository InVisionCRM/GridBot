/**
 * Restart paper clean (Kyle, 2026-10-31: "how do I delete all paper traded positions so i can restart clean?"): one
 * reset removes every paper bot, the token trader's paper positions and history, and the Smart trader's paper books.
 * Live bots, live positions and live history come out byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import type { Opportunity } from '../src/market/scan';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';
import { MockChain, NET } from './helpers/mockChain';

setEthUsdSource(() => 2500);
const P0 = 0.00001;
const NOW = 1_800_000_000_000;
const grid = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('bots: every paper grid and trend bot goes, live ones stay byte-identical', () => {
  it('paper bots (running and closed) and the paper value history are removed; live bots and live history are not', async () => {
    const chain = new MockChain(P0);
    const store = new MemoryStore<MultiState>();
    const first = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
    const g1 = await first.add({ mode: 'paper', stable: 'DAI', ...grid });
    const g2 = await first.add({ mode: 'paper', stable: 'USDC', ...grid });
    await first.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', capital: 25, cfg: {} });
    for (let i = 0; i < 4; i++) { chain.setPrice(P0 * (i % 2 ? 1.005 : 0.975)); await first.tickAll(); }
    first.closeGrid(g2);
    // the saved file as it would be with live bots beside them: copies of the paper ones, marked live and stopped
    const s = store.load()!;
    const liveGrid = { ...clone(s.grids.find((b) => b.id === g1)!), id: 'live-grid', mode: 'live' as const, status: 'stopped' as const };
    const liveTrend = { ...clone(s.trends[0]), id: 'live-trend', mode: 'live' as const, status: 'stopped' as const };
    s.grids.push(liveGrid);
    s.trends.push(liveTrend);
    s.portfolio.live = [[NOW, 100, 1, 99]];
    store.save(s);

    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
    const live = clone({ grids: store.load()!.grids.filter((b) => b.mode === 'live'), trends: store.load()!.trends.filter((b) => b.mode === 'live'), portfolio: store.load()!.portfolio.live });
    expect(bot.resetPaper()).toEqual({ grids: 2, trends: 1, lps: 0 });

    const after = store.load()!;
    expect(after.grids.map((b) => b.id)).toEqual(['live-grid']);
    expect(after.trends.map((b) => b.id)).toEqual(['live-trend']);
    expect(after.portfolio.paper).toEqual([]);
    expect({ grids: after.grids, trends: after.trends, portfolio: after.portfolio.live }).toEqual(live);
    // the running set follows: no paper row, the live ones still listed
    expect(bot.overview('paper').bots).toEqual([]);
    expect(bot.overview('live').bots.map((b) => b.id).sort()).toEqual(['live-grid', 'live-trend']);
  });
});

const pool: FreshPool = {
  chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3', token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
  tokenSymbol: 'PEPE', spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
};
const clean: GateInput = {
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
  liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
};

describe('token trader: paper positions and history go, live ones stay byte-identical', () => {
  it('paper positions, trades, Generated, scoreboard records and the paper start are removed; on/off and settings stay', async () => {
    const store = new MemoryStore<TraderState>();
    const t = new TokenTrader({
      store, now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => [pool], assess: async () => clean, resolve: async () => null,
      mark: async (p: Position) => ({ price: p.price * 1.6 }), // a take profit: a paper sell lands in trades and Generated
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
    t.turnOn();
    await t.tick();
    await t.tick();
    const st = (t as unknown as { state: TraderState }).state;
    expect(st.positions.some((p) => p.mode === 'paper')).toBe(true);
    expect(st.trades.some((r) => r.side === 'sell')).toBe(true);
    // live records beside them
    const livePos = { ...clone(st.positions[0]), id: 'live-pos', mode: 'live' as const };
    st.positions.push(livePos);
    st.trades.push({ ...clone(st.trades[0]), mode: 'live', label: 'LIVE/WETH' });
    st.generated!['live:1:0xlive'] = { mode: 'live', chainId: 1, coin: '0xlive', symbol: 'WETH', proceeds: 2, cost: 1, fees: 0, taxes: 0, gasNative: 0.01, closed: 1, fills: 2 };
    st.plays.push({ ...clone(st.plays[0]), play_id: 'live-pos', tx_entry: '0x' + 'cd'.repeat(32) });
    st.startedAt = { ...st.startedAt, live: NOW - 1000 };
    const live = clone({
      positions: st.positions.filter((p) => p.mode === 'live'), trades: st.trades.filter((r) => r.mode === 'live'),
      generated: Object.fromEntries(Object.entries(st.generated!).filter(([, l]) => l.mode === 'live')),
      plays: st.plays.filter((x) => x.tx_entry != null), startedAt: st.startedAt.live, options: st.options, on: st.on,
    });

    const n = t.resetPaper();
    expect(n.positions).toBeGreaterThan(0);
    expect(n.trades).toBeGreaterThan(0);
    const after = store.load()!;
    expect({
      positions: after.positions, trades: after.trades, generated: after.generated, plays: after.plays,
      startedAt: after.startedAt?.live, options: after.options, on: after.on,
    }).toEqual(live);
    expect(after.startedAt).not.toHaveProperty('paper');
    // its paper figures read like a trader that never traded paper
    const fresh = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => [], assess: async () => clean, resolve: async () => null,
    });
    expect(t.status().metrics.mode).toBe('paper');
    expect(t.status().metrics.generated).toEqual(fresh.status().metrics.generated);
    expect(t.status().metrics.generated).toBeNull();
  });
});

/** A legacy market (PLS/DAI) as the scan would show it: a grid that earned */
function opp(swing: number): Opportunity {
  const q = NET.quotes.find((x) => x.symbol === 'DAI')!;
  return {
    chainId: NET.chainId, key: 'DAI', ref: { address: NET.pulsex.wpls, quote: q.address, pool: '' }, label: 'PLS/DAI', spend: 'DAI', stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1e6, usd: 1e6,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2',
  };
}
const view = (at: number, items: Opportunity[]): ScanView => ({ at, chains: [{ chainId: NET.chainId, items, error: null }] });

describe('Smart trader: paper books go with its paper bots; budgets and settings stay; live is untouched', () => {
  function setup(mode: 'paper' | 'live') {
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => NOW });
    const store = new MemoryStore<AutopilotState>();
    const ap = new Autopilot({ bot, store, emit: () => undefined, scan: async () => view(1, [opp(0.3)]), now: () => NOW });
    ap.configure({ mode, options: { ...DEFAULT_OPTIONS, slots: 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
    return { bot, ap, store };
  }

  it('paper: its books are cleared and its bots go with every paper bot; the budget, settings and on stay', async () => {
    const { bot, ap, store } = setup('paper');
    await ap.turnOn();
    await ap.tick();
    expect(ap.state.accounts[0].bots.length).toBe(1);
    const keep = clone({ budgets: store.load()!.budgets, options: store.load()!.options, on: store.load()!.on, mode: store.load()!.mode });
    expect(ap.resetPaper()).toEqual({ accounts: 1 });
    expect(bot.resetPaper().grids).toBe(1);
    const after = store.load()!;
    expect(after.accounts).toEqual([]);
    expect({ budgets: after.budgets, options: after.options, on: after.on, mode: after.mode }).toEqual(keep);
    expect(after.log.at(-1)!.msg).toBe('paper reset: 1 paper book cleared; the next review starts from the budgets');
  });

  it('live: nothing changes', () => {
    const { ap, store } = setup('live');
    const before = JSON.stringify(store.load());
    expect(ap.resetPaper()).toEqual({ accounts: 0 });
    expect(JSON.stringify(store.load())).toBe(before);
  });
});
