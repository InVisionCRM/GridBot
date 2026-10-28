/**
 * Boot safety hold (lead's decision): while a live bot waits for its market's safety check after a restart, it keeps
 * watching its exits (stop-loss, take-profit, exit signals, grid sells of what it holds) and may execute them. It makes
 * no new entry, grid buy, follow-the-price reseed or payout. If the check fails, an exit already triggered settles,
 * then the bot stays stopped. A pass releases normal ticking.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import type { TrendEngine } from '../src/server/bot/trend';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ActivityBus } from '../src/server/bot/activity';
import { CandleStore } from '../src/server/market/candleStore';
import { Hub } from '../src/server/chains/hub';
import { SharedNonce, TxGate } from '../src/server/bot/txGate';
import { systemHalt } from '../src/server/bot/audit';
import type { SafetyReport } from '../src/live/markets';
import type { Candle } from '../src/market/candles';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { MockChain, NET } from './helpers/mockChain';

// ── Grid: engine level ─────────────────────────────────────────────────────
const P0 = 0.00001;
const grid = { lowerPrice: P0 * 0.8, upperPrice: P0, gridCount: 10, totalCapitalUsd: 50 };
function gridEngine() {
  const chain = new MockChain(P0);
  const engine = new GridEngine({ net: NET, reader: chain, signer: chain, store: new MemoryStore<BotState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
  return { chain, engine };
}

describe('grid held for the boot safety check', () => {
  it('no grid buys while held: the crossed level goes back to waiting, nothing is sent; a pass releases normal ticking', async () => {
    const { chain, engine } = gridEngine();
    await engine.start({ mode: 'live', ...grid });
    engine.holdForSafety();
    chain.setPrice(P0 * 0.975); // crosses the 0.98·P0 buy level
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(engine.state.trades).toHaveLength(0);
    expect(engine.state.queue).toHaveLength(0);
    expect(engine.state.intervals.every((i) => i.status === 'waitingBuy')).toBe(true);
    // Pass → normal: the same price now buys.
    engine.releaseSafetyHold();
    await engine.tick();
    expect(engine.state.trades.map((t) => t.side)).toEqual(['buy']);
  });

  it('an exit (sell of a held level) fires and executes while held', async () => {
    const { chain, engine } = gridEngine();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.975); await engine.tick(); // bought one level before the restart
    engine.holdForSafety();
    chain.setPrice(P0 * 1.005); await engine.tick();
    expect(engine.state.trades.map((t) => t.side)).toEqual(['buy', 'sell']);
    expect(engine.state.status).toBe('running');
  });

  it('a buy already queued (persisted before the restart) is dropped by the hold, not sent', async () => {
    const { chain, engine } = gridEngine();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.975);
    // Simulate the queue a restart restored: run the evaluation without draining.
    const drain = engine.drain.bind(engine);
    engine.drain = async () => undefined;
    await engine.tick();
    expect(engine.state.queue.map((q) => q.side)).toEqual(['buy']);
    engine.drain = drain;
    engine.holdForSafety();
    expect(engine.state.queue).toHaveLength(0);
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
  });

  it('check fails with a sell already queued: it settles, then the grid stops; no buy after', async () => {
    const { chain, engine } = gridEngine();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.975); await engine.tick();
    engine.holdForSafety();
    chain.setPrice(P0 * 1.005);
    const drain = engine.drain.bind(engine);
    engine.drain = async () => undefined;
    await engine.tick(); // the sell triggers (queued) ...
    engine.drain = drain;
    expect(engine.state.queue.map((q) => q.side)).toEqual(['sell']);
    const halt = systemHalt('safety-pause', 'safety check after restart: LIVE blocked — honeypot', 1);
    engine.settleThenStop(halt); // ... and the check fails before it is sent
    expect(engine.state.status).toBe('running');
    await engine.tick();
    expect(engine.state.trades.map((t) => t.side)).toEqual(['buy', 'sell']); // the exit settled
    expect(engine.state.status).toBe('stopped');
    expect(engine.state.halt).toMatchObject({ what: 'safety-pause', detail: expect.stringMatching(/honeypot/) });
    chain.setPrice(P0 * 0.975);
    await engine.tick();
    expect(engine.state.trades).toHaveLength(2);
  });

  it('check fails with nothing pending: stops at once', async () => {
    const { engine } = gridEngine();
    await engine.start({ mode: 'live', ...grid });
    engine.holdForSafety();
    engine.settleThenStop(systemHalt('safety-pause', 'failed', 1));
    expect(engine.state.status).toBe('stopped');
  });
});

// ── Trend: through MultiBot, then a restart from the saved state ───────────
const H = 3600;
const T0 = Math.floor(1_791_000_000 / H) * H;
const P = 1e-5;
const CFG = { strategy: 'ema' as const, fast: 2, slow: 3, atrPeriod: 2, stopAtr: 1, tpR: 2, trailAtr: 0, cooldownBars: 0, sizePct: 100 };
const setMid = (chain: MockChain, sellSide: number) => chain.setPrice(sellSide / 0.9971);
const probe = (p: Partial<ProbeResult> = {}): ProbeResult => ({
  stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 100n, transferGot: 100n,
  sellIn: 900n, expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 100_000n, gasSell: 100_000n, ...p,
});
const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];
const measured = (p: Partial<ProbeResult> = {}): SafetyReport => classify({ probe: probe(p), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3', now: 5_000 });
const PASS = measured({ gotBuy: 990n });
const FAIL = measured({ stage: 4 });

function run(o: { chain?: MockChain; store?: MemoryStore<MultiState>; candles?: CandleStore; clock?: { ms: number }; safety?: SafetyReport } = {}) {
  const clock = o.clock ?? { ms: (T0 + 10) * 1000 };
  const chain = o.chain ?? new MockChain(P / 0.9971);
  const candles = o.candles ?? new CandleStore(null);
  const store = o.store ?? new MemoryStore<MultiState>();
  const hub = Hub.single(NET, chain, chain, { gate: new TxGate(), nonce: new SharedNonce() });
  (hub as unknown as { o: { safetyRetryMs: number[] } }).o.safetyRetryMs = [0, 0];
  if (o.safety) hub.def('DAI').safety = o.safety; // the market carries a safety report (custom-token style)
  // The check answers when the test says so.
  let answer: (r: SafetyReport) => void = () => undefined;
  let checks = 0;
  (hub as unknown as { inspect: () => Promise<unknown> }).inspect = () => { checks++; return new Promise((res) => { answer = (r) => res({ safety: r, chosen: {} }); }); };
  const activity = new ActivityBus(400, () => clock.ms);
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0, now: () => clock.ms, candles, activity, hub });
  bot.taxWatch.tick = async () => []; // the 30-min tax watcher isn't under test (it would wait on the same check)
  const closeBar = (t: number, k: Omit<Candle, 't' | 'v'>) => {
    clock.ms = (t + H + 10) * 1000;
    candles.merge('DAI', '1h', [{ t, v: 0, ...k }], 'gecko', t + H + 10);
  };
  if (!o.candles) candles.merge('DAI', '1h', Array.from({ length: 10 }, (_, i) => ({ t: T0 - (10 - i) * H, o: P, h: P, l: P, c: P, v: 0 })), 'gecko', T0 + 10);
  const answerWith = async (r: SafetyReport) => { answer(r); await bot.bootSafety; };
  const trend = () => bot.status().trends[0];
  const eng = () => [...(bot as unknown as { trendEngines: Map<string, TrendEngine> }).trendEngines.values()][0];
  return { bot, chain, candles, clock, store, closeBar, answerWith, checks: () => checks, trend, eng };
}

/** A live trend bot, running; `withPosition` = it entered before the app stopped. */
async function beforeRestart(withPosition: boolean) {
  const a = run();
  await a.bot.addTrend({ mode: 'live', quote: 'DAI', tf: '1h', cfg: CFG, capital: 40 });
  await a.bot.tickAll();
  if (withPosition) {
    a.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    setMid(a.chain, 1.1 * P);
    await a.bot.tickAll();
    expect(a.trend().position).not.toBeNull();
  }
  return a;
}
const restart = (a: Awaited<ReturnType<typeof beforeRestart>>, safety = PASS) =>
  run({ chain: a.chain, store: a.store, candles: a.candles, clock: a.clock, safety });

describe('trend bot held for the boot safety check', () => {
  it('a stop-loss exit fires and executes while held', async () => {
    const a = await beforeRestart(true);
    const b = restart(a);
    expect(b.bot.status().safetyChecking).toEqual([b.trend().id]);
    setMid(b.chain, 1.0 * P); // below the stop
    await b.bot.tickAll();
    const t = b.trend();
    expect(t.position).toBeNull();
    expect(t.trades[0]).toMatchObject({ side: 'sell', reason: 'stop' });
    expect(t.status).toBe('running');
    await b.answerWith(PASS);
  });

  it('no new entry while held (the signal is filtered, nothing bought); a pass releases normal ticking', async () => {
    const a = await beforeRestart(false);
    const b = restart(a);
    const sent = b.chain.sent.length;
    b.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P }); // an entry cross
    setMid(b.chain, 1.1 * P);
    await b.bot.tickAll();
    expect(b.trend().position).toBeNull();
    expect(b.chain.sent.length).toBe(sent);
    expect(b.trend().signals.some((x) => x.kind === 'filtered' && /held until the safety check/.test(x.note))).toBe(true);
    // Pass → released: the next entry signal is taken.
    await b.answerWith(PASS);
    expect(b.bot.status().safetyChecking).toEqual([]);
    b.closeBar(T0 + H, { o: 1.1 * P, h: 1.1 * P, l: 0.9 * P, c: 0.9 * P });
    b.closeBar(T0 + 2 * H, { o: 0.9 * P, h: 1.2 * P, l: 0.9 * P, c: 1.2 * P });
    setMid(b.chain, 1.2 * P);
    await b.bot.tickAll();
    expect(b.trend().position).not.toBeNull();
    expect(b.trend().trades[0]).toMatchObject({ side: 'buy', reason: 'entry' });
  });

  it('an exit triggered while the check is failing settles, then the bot stays stopped', async () => {
    const a = await beforeRestart(true);
    // The app stopped right after the stop-loss triggered: the exit is in the saved queue, not yet sent.
    const s = a.store.load()!;
    const t0 = s.trends[0];
    t0.queue = [{ id: 'q-stop', side: 'sell', reason: 'stop', amount: t0.position!.pls, triggerPrice: 1.0 * P, createdAt: a.clock.ms }];
    a.store.save(s);
    const b = restart(a);
    expect(b.trend().queue.map((q) => q.side)).toEqual(['sell']); // kept by the hold (an exit)
    await b.answerWith(FAIL);
    expect(b.trend().status).toBe('running'); // still settling its exit
    expect(b.bot.activity.recent().some((e) => e.level === 'error' && /safety check after restart/.test(e.msg))).toBe(true);
    setMid(b.chain, 1.0 * P);
    await b.bot.tickAll();
    const t = b.trend();
    expect(t.trades[0]).toMatchObject({ side: 'sell', reason: 'stop' }); // the exit settled
    expect(t.position).toBeNull();
    expect(t.status).toBe('stopped');
    expect(t.halt).toMatchObject({ what: 'safety-pause', origin: 'system', detail: expect.stringMatching(/safety check after restart: LIVE blocked/) });
    // Stays stopped: a new entry signal is not taken.
    const n = t.trades.length;
    b.closeBar(T0 + H, { o: P, h: P, l: 0.9 * P, c: 0.9 * P });
    b.closeBar(T0 + 2 * H, { o: 0.9 * P, h: 1.2 * P, l: 0.9 * P, c: 1.2 * P });
    setMid(b.chain, 1.2 * P);
    await b.bot.tickAll();
    expect(b.trend().trades).toHaveLength(n);
    expect(b.trend().status).toBe('stopped');
  });

  it('a failing check with no exit pending stops the bot at once (position kept, nothing sold)', async () => {
    const a = await beforeRestart(true);
    const b = restart(a);
    const sent = b.chain.sent.length;
    await b.answerWith(FAIL);
    expect(b.trend().status).toBe('stopped');
    expect(b.trend().position).not.toBeNull();
    expect(b.chain.sent.length).toBe(sent);
  });

  it('a manual Stop while held, then a failing check: the hand stop stands', async () => {
    const a = await beforeRestart(true);
    const b = restart(a);
    b.bot.stopTrend(b.trend().id);
    await b.answerWith(FAIL);
    expect(b.trend().status).toBe('stopped');
    expect(b.trend().halt).toMatchObject({ what: 'bot-stop' });
    expect(b.eng().safetyHold).toBeNull();
  });
});
