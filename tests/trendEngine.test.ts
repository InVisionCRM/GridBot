import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ActivityBus } from '../src/server/bot/activity';
import { CandleStore } from '../src/server/market/candleStore';
import type { Candle } from '../src/market/candles';
import { MockChain, NET } from './helpers/mockChain';

const H = 3600;
const T0 = Math.floor(1_791_000_000 / H) * H;
const P = 1e-5;
const CFG = { strategy: 'ema' as const, fast: 2, slow: 3, atrPeriod: 2, stopAtr: 1, tpR: 2, trailAtr: 0, cooldownBars: 0, sizePct: 100 };

function setup(o: { store?: MemoryStore<MultiState>; chain?: MockChain; candles?: CandleStore; signer?: boolean; clock?: { ms: number } } = {}) {
  const clock = o.clock ?? { ms: (T0 + 10) * 1000 };
  const chain = o.chain ?? new MockChain(P / 0.9971);
  const candles = o.candles ?? new CandleStore(null);
  const activity = new ActivityBus(400, () => clock.ms);
  const store = o.store ?? new MemoryStore<MultiState>();
  const bot = new MultiBot({ net: NET, reader: chain, signer: o.signer ? chain : null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0, now: () => clock.ms, candles, activity });
  const events = () => activity.recent(400).map((e) => e.type);
  /** add one closed 1h candle at bucket t and move the clock past its close */
  const closeBar = (t: number, k: Omit<Candle, 't' | 'v'>) => {
    clock.ms = (t + H + 10) * 1000;
    candles.merge('DAI', '1h', [{ t, v: 0, ...k }], 'gecko', t + H + 10);
  };
  /** 10 flat closed bars before T0 */
  candles.merge('DAI', '1h', Array.from({ length: 10 }, (_, i) => ({ t: T0 - (10 - i) * H, o: P, h: P, l: P, c: P, v: 0 })), 'gecko', T0 + 10);
  return { bot, chain, candles, clock, store, activity, events, closeBar };
}

const setMid = (chain: MockChain, sellSide: number) => chain.setPrice(sellSide / 0.9971);

describe('TrendEngine', () => {
  it('enters on a closed-candle EMA cross (next close after start), once per candle', async () => {
    const s = setup();
    const id = await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].position).toBeNull(); // the pre-start candle is never acted on
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    const t = s.bot.status().trends.find((x) => x.id === id)!;
    expect(t.position).not.toBeNull();
    expect(t.cash).toBeCloseTo(0, 9);
    expect(t.position!.risk.stop).toBeCloseTo(t.position!.risk.entry - 0.5 * P * 0.1 * 1, 12); // ATR(2) = 0.5 × 1e-6
    expect(t.position!.risk.tp).toBeCloseTo(t.position!.risk.entry + 2 * (t.position!.risk.entry - t.position!.risk.stop), 12);
    expect(t.trades).toHaveLength(1);
    expect(t.trades[0]).toMatchObject({ side: 'buy', reason: 'entry', paper: true });
    expect(s.events()).toEqual(expect.arrayContaining(['started', 'signal', 'queued', 'filled']));
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].trades).toHaveLength(1);
  });

  it('ATR stop exits on the poll price; realized PnL includes fees and gas; cooldown applies', async () => {
    const s = setup();
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { ...CFG, cooldownBars: 3 }, capital: 100 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    setMid(s.chain, 1.0 * P);
    await s.bot.tickAll();
    const t = s.bot.status().trends[0];
    expect(t.position).toBeNull();
    expect(t.trades[0]).toMatchObject({ side: 'sell', reason: 'stop' });
    expect(t.trades[0].realizedPnlUsd).toBeLessThan(0);
    expect(t.cash).toBeCloseTo(100 + t.trades[0].realizedPnlUsd + t.trades[0].gasUsd + t.trades[1].gasUsd, 6);
    expect(t.pnl.equity).toBeCloseTo(100 + t.pnl.realized, 9);
    // new cross right after: inside cooldown → ignored
    s.closeBar(T0 + H, { o: P, h: P, l: 0.9 * P, c: 0.9 * P });
    s.closeBar(T0 + 2 * H, { o: 0.9 * P, h: 1.2 * P, l: 0.9 * P, c: 1.2 * P });
    setMid(s.chain, 1.2 * P);
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].position).toBeNull();
    expect(s.bot.status().trends[0].signals.some((x) => x.kind === 'cooldown')).toBe(true);
  });

  it('take-profit at R multiple, and trailing stop moves on closed candles', async () => {
    const s = setup();
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    setMid(s.chain, 1.25 * P);
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].trades[0]).toMatchObject({ side: 'sell', reason: 'tp' });
    expect(s.bot.status().trends[0].trades[0].realizedPnlUsd).toBeGreaterThan(0);

    const u = setup();
    await u.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { ...CFG, tpR: 0, trailAtr: 1 }, capital: 100 });
    u.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(u.chain, 1.1 * P);
    await u.bot.tickAll();
    const stop0 = u.bot.status().trends[0].position!.risk.stop;
    u.closeBar(T0 + H, { o: 1.1 * P, h: 1.3 * P, l: 1.1 * P, c: 1.25 * P });
    setMid(u.chain, 1.25 * P);
    await u.bot.tickAll();
    const pos = u.bot.status().trends[0].position!;
    expect(pos.risk.stop).toBeGreaterThan(stop0);
    expect(pos.risk.stop).toBeCloseTo(1.3 * P - pos.risk.atr, 12);
    expect(u.events()).toContain('stop_moved');
    setMid(u.chain, pos.risk.stop * 0.99);
    await u.bot.tickAll();
    expect(u.bot.status().trends[0].trades[0]).toMatchObject({ side: 'sell', reason: 'trail' });
  });

  it('cost gate blocks entries whose expected move does not clear costs + margin', async () => {
    const s = setup();
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { ...CFG, minEdgePct: 0.3 }, capital: 100 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    const t = s.bot.status().trends[0];
    expect(t.position).toBeNull();
    expect(t.blocked).toBe(1);
    expect(t.signals[0].note).toMatch(/costs/);
    expect(s.events()).toContain('blocked');
  });

  it('persists open position + stops and resumes after restart', async () => {
    const s = setup();
    const id = await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    const before = s.bot.status().trends[0].position!;
    expect(s.store.data!.version).toBe(3);
    // "restart": new orchestrator over the same state + candle files
    const r = setup({ store: s.store, chain: s.chain, candles: s.candles, clock: s.clock });
    const t = r.bot.status().trends.find((x) => x.id === id)!;
    expect(t.status).toBe('running');
    expect(t.position!.risk).toEqual(before.risk);
    expect(t.position!.pls).toBe(before.pls);
    setMid(r.chain, 0.95 * P);
    await r.bot.tickAll();
    expect(r.bot.status().trends[0].trades[0]).toMatchObject({ side: 'sell', reason: 'stop' });
  });

  it('inventory: trend bot sells only its own PLS and spends only its own cash; grids are untouched', async () => {
    const s = setup();
    const gid = await s.bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.5 * P, upperPrice: 1.5 * P, gridCount: 10, totalCapitalUsd: 200 });
    await s.bot.tickAll();
    const gridTradesBefore = s.bot.status().grids[0].trades.length;
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { ...CFG, sizePct: 40 }, capital: 50 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    const t = s.bot.status().trends[0];
    expect(t.trades[t.trades.length - 1].stableAmount).toBeCloseTo(20, 6); // 40% of its 50, not of the wallet/grids
    expect(t.cash).toBeCloseTo(30, 6);
    const pls = t.position!.pls;
    setMid(s.chain, 0.9 * P);
    await s.bot.tickAll();
    const sold = s.bot.status().trends[0].trades.find((x) => x.side === 'sell')!;
    expect(sold.plsAmount).toBeCloseTo(pls, 4);
    const g = s.bot.status().grids.find((x) => x.id === gid)!;
    expect(g.trades.every((x) => x.intervalIndex >= 0)).toBe(true);
    expect(g.trades.length).toBeGreaterThanOrEqual(gridTradesBefore);
  });

  it('live: wallet must cover all allocations', async () => {
    const s = setup({ signer: true });
    s.chain.setBal('DAI', 1000);
    await s.bot.addTrend({ mode: 'live', quote: 'DAI', tf: '1h', cfg: CFG, capital: 600 });
    await expect(s.bot.addTrend({ mode: 'live', quote: 'DAI', tf: '1h', cfg: CFG, capital: 600 })).rejects.toThrow(/does not cover/);
    const al = s.bot.allocations();
    expect(al.rows.find((r) => r.token === 'DAI')).toMatchObject({ allocated: 600, wallet: 1000, ok: true });
    s.chain.setBal('DAI', 500);
    await (s.bot as unknown as { refreshWallet(f: boolean): Promise<void> }).refreshWallet(true);
    expect(s.bot.allocations().ok).toBe(false);
    expect(s.bot.status().trends).toHaveLength(1);
  });

  it('KILL ALL stops grids and trend bots; nothing trades afterwards', async () => {
    const s = setup();
    await s.bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.5 * P, upperPrice: 1.5 * P, gridCount: 10, totalCapitalUsd: 200 });
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    s.bot.stopAll();
    const st = s.bot.status();
    expect(st.grids.every((g) => g.status === 'stopped')).toBe(true);
    expect(st.trends.every((t) => t.status === 'stopped')).toBe(true);
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].trades).toHaveLength(0);
    expect(s.activity.recent().some((e) => e.type === 'stopped' && /KILL ALL/.test(e.msg))).toBe(true);
  });

  it('alerts fire on the edge only; journal CSV + overview include both bot kinds', async () => {
    const s = setup();
    s.bot.addAlert({ type: 'price_above', pair: 'DAI', value: 1.05 * P, repeat: true });
    await s.bot.tickAll();
    expect(s.activity.recent().filter((e) => e.type === 'alert')).toHaveLength(0);
    setMid(s.chain, 1.1 * P);
    await s.bot.tickAll(); await s.bot.tickAll();
    expect(s.activity.recent().filter((e) => e.type === 'alert')).toHaveLength(1);
    setMid(s.chain, P); await s.bot.tickAll();
    setMid(s.chain, 1.1 * P); await s.bot.tickAll();
    expect(s.activity.recent().filter((e) => e.type === 'alert')).toHaveLength(2);
    expect(() => s.bot.addAlert({ type: 'rsi_above', pair: 'DAI', value: 150 })).toThrow();

    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    await s.bot.tickAll();
    const rows = s.bot.journal({ kind: 'trend' });
    expect(rows.length).toBe(1);
    const csv = MultiBot.journalCsv(rows);
    expect(csv.split('\n')[0]).toBe('time,botId,kind,bot,pair,mode,side,reason,pls,quote,price,fee,gas,pnl,pnlUsd,slippagePct,tx,failed');
    expect(csv).toContain(',trend,');
    const ov = s.bot.overview();
    expect(ov.bots).toHaveLength(1);
    expect(ov.totals.capitalUsd).toBeGreaterThan(0);
    expect(ov.allocation.map((a) => a.asset)).toContain('PLS');
  });

  it('portfolio period change and drawdown exclude capital added by starting a new bot', async () => {
    const s = setup();
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    await s.bot.tickAll(); // snapshot 1: $100 allocated
    s.clock.ms += 61_000;
    await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 200 });
    await s.bot.tickAll(); // snapshot 2: $300 allocated, no trades
    const ov = s.bot.overview();
    expect(ov.totals.capitalUsd).toBeCloseTo(300, 6);
    expect(ov.periods.all.equityChange).toBeCloseTo(0, 2); // not +$200
    expect(ov.periods.today.equityChange).toBeCloseTo(0, 2);
    expect(ov.portfolio).toHaveLength(2);
    expect(ov.portfolio[0][1]).toBeCloseTo(300, 2); // drawn at today's capital
    expect(ov.portfolioDrawdown).toBeCloseTo(0, 6);
  });
});
