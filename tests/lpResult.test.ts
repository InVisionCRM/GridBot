/**
 * Kyle 2026-11-08: the CASHCAT/ETH bot read green for two days while it lost 11% against holding. What was missing:
 * the headline left out what each range move locked in; the move rule weighed only gas and the swap; nothing stopped
 * the bot or told him. These tests pin the fixes: the result as the figure, the loss the move locks in as a cost of
 * the move, a losing streak that holds moves, a loss limit that pauses, the first-loss notice, the day summary, and
 * a swap with no position after it said out loud.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { LpEngine, type LpState } from '../src/server/bot/lpEngine';
import { LP_LOSS_LIMIT } from '../src/market/lp';
import { localDayStart, lpResultToday } from '../src/metrics/feesToday';
import { Ready } from '../src/ui/LpReplay';
import type { ReplayRow } from '../src/market/lpReplay';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { NET } from './helpers/mockChain';

type Ev = { type: string; msg: string; level?: string; notify?: boolean };
const T0 = 1_800_000_000_000;

function world(emit?: (e: Ev) => void) {
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
  let t = T0;
  const store = new MemoryStore<LpState>();
  const lp = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => t, emit: emit as never });
  return { m, pool, lp, at: (ms: number) => { t = T0 + ms; } };
}
const MARKET = 'pulsechain:PLS/DAI#9mm';

describe('the result against holding is the figure (lpEngine.pnl)', () => {
  it('net takes out what the moves locked in; result = equity − holding the deposit at today\'s price; carry is the rest; price is the market on the deposit', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await lp.tick();
    m.movePrice(pool, 1.2); // far out of a ±1% range: the move locks in what the position did
    await lp.tick();
    const s = lp.status(), p = s.pnl!;
    expect(s.reranges).toBe(1);
    expect(p.moveLoss).toBeGreaterThan(0);
    expect(p.net).toBeCloseTo(p.fees - p.gas - p.swapCost - p.moveLoss, 12);
    expect(p.hold).toBeCloseTo(1000, 12); // a quote-only deposit: holding it is worth the same at any price
    expect(p.result).toBeCloseTo(p.equity - p.hold, 12);
    expect(p.carry).toBeCloseTo(p.result - p.net, 12);
    expect(p.price).toBe(0);
    expect(p.result).toBeLessThan(0); // the bot is behind holding
  });
});

describe('the move rule weighs the loss a move locks in, and a losing streak holds every move', () => {
  it('with the cost check on, a position with no fee pace yet does not move; with it off it moves at once', async () => {
    const a = world();
    await a.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5 });
    await a.lp.tick();
    a.m.movePrice(a.pool, 1.2);
    await a.lp.tick();
    expect(a.lp.status().reranges).toBe(0);
    expect(['need-cost', 'cost']).toContain(a.lp.status().hold.wait);
    const b = world();
    await b.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await b.lp.tick();
    b.m.movePrice(b.pool, 1.2);
    await b.lp.tick();
    expect(b.lp.status().reranges).toBe(1);
  });

  it("three moves in the last 24 hours that lost money together hold the next one, even with the cost check off", async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await lp.tick();
    const t = lp.state.startedAt!;
    lp.state.done = [1, 2, 3].map((k) => ({ t: t - k * 3_600_000, action: 'rerange' as const, asked: false, lower: null, upper: null, cost: 0.4, fees: { base: 0, quote: 0.3 }, lockIn: 1 }));
    m.movePrice(pool, 1.2);
    await lp.tick();
    const s = lp.status();
    expect(s.reranges).toBe(0);
    expect(s.hold.wait).toBe('losing');
    expect(s.position).not.toBeNull(); // nothing was taken out
  });

  it('the step log keeps what each move locked in', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await lp.tick();
    m.movePrice(pool, 1.2);
    await lp.tick();
    const move = lp.status().done.find((d: { action: string }) => d.action === 'rerange')!;
    expect(move.lockIn).toBeGreaterThan(0);
    expect(move.lockIn).toBeCloseTo(lp.state.totals.moveLoss, 12);
  });
});

describe('the loss limit pauses the bot; the first loss and each day are told', () => {
  it('pauses with the reason at −3% of what was put in by default; a wider limit keeps it running; a saved bot without the field reads 3%', async () => {
    const events: Ev[] = [];
    const { lp, m, pool } = world((e) => events.push(e));
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, range: { costCheck: false } });
    expect(lp.state.config!.lossLimitPct).toBe(LP_LOSS_LIMIT);
    await lp.tick();
    m.movePrice(pool, 0.8);
    await lp.tick();
    const s = lp.status();
    expect(s.pnl!.result / s.pnl!.hold).toBeLessThan(-0.03);
    expect(s.status).toBe('stopped');
    expect(s.halt).toMatchObject({ what: 'loss-limit' });
    expect(s.halt!.detail).toMatch(/is past the 3\.00% loss limit/);
    expect(events.some((e) => /loss limit/.test(e.msg) && e.notify)).toBe(true);
    // the same fall with room: it keeps running
    const w = world();
    await w.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await w.lp.tick();
    w.m.movePrice(w.pool, 0.8);
    await w.lp.tick();
    expect(w.lp.status().status).toBe('running');
    // a save from before the field: the default applies
    delete (w.lp.state.config as { lossLimitPct?: number }).lossLimitPct;
    await w.lp.tick();
    expect(w.lp.status().status).toBe('stopped');
  });

  it('refuses a loss limit outside 0–50%, at the start and in Settings', async () => {
    const { lp } = world();
    await expect(lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0 })).rejects.toThrow(/between 0% and 50%/);
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000 });
    expect(() => lp.setPolicy({ lossLimitPct: 0.6 })).toThrow(/between 0% and 50%/);
    lp.setPolicy({ lossLimitPct: 0.1 });
    expect(lp.state.config!.lossLimitPct).toBe(0.1);
  });

  it('says once when the result first falls below −0.5% of what was put in, with the parts', async () => {
    const events: Ev[] = [];
    const { lp, m, pool } = world((e) => events.push(e));
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    await lp.tick();
    m.movePrice(pool, 0.8);
    await lp.tick();
    await lp.tick();
    const notes = events.filter((e) => /result −[\d.]+ DAI \(−[\d.]+%\) against holding what was put in\. Fees \+/.test(e.msg));
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe('warn');
    expect(notes[0].notify).toBe(true);
    expect(notes[0].msg).toMatch(/locked in by moves −/);
  });

  it('tells the day before once, from the 5-minute samples: fees, costs, moves, result', async () => {
    const events: Ev[] = [];
    const { lp, m, pool, at } = world((e) => events.push(e));
    const day = localDayStart(T0 + 36 * 3_600_000) - T0; // a midnight comfortably ahead of the start
    at(day - 3 * 3_600_000);
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, lossLimitPct: 0.5, range: { costCheck: false } });
    for (let k = 0; k < 6; k++) { at(day - 3 * 3_600_000 + (k + 1) * 10 * 60_000); await lp.tick(); } // samples inside the day
    m.movePrice(pool, 0.8); at(day - 60 * 60_000); await lp.tick(); // a move that locks in a loss
    at(day - 5 * 60_000); await lp.tick(); // the last sample before midnight
    at(day + 10 * 60_000); await lp.tick(); // the first reading of the new day
    const notes = events.filter((e) => /, yesterday: fees \+/.test(e.msg));
    expect(notes).toHaveLength(1);
    expect(notes[0].msg).toMatch(/costs −[\d.e-]+ \(1 move: swaps, gas and what they locked in\), result −/);
    expect(notes[0].notify).toBe(true);
    at(day + 20 * 60_000); await lp.tick();
    expect(events.filter((e) => /, yesterday: fees/.test(e.msg))).toHaveLength(1); // once a day
  });

  it("a close after the open's swap, with no position opened, says the coins sit in the wallet in that mix", async () => {
    const events: Ev[] = [];
    const { lp } = world((e) => events.push(e));
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000 });
    await lp.tick();
    // what Nov 5 19:52 looked like: swapped for the range, then no position
    lp.state.position = null;
    lp.state.step = { action: 'open', stage: 'mint', tries: 0 };
    lp.state.idle = { base: 34_370.7, quote: 0.949 };
    lp.close();
    const note = events.find((e) => /swapped for a position that never opened/.test(e.msg));
    expect(note).toBeDefined();
    expect(note!.msg).toMatch(/34370\.7 PLS \+ 0\.949000 DAI in that mix/);
    expect(note!.notify).toBe(true);
  });
});

describe("today's figure is the result since midnight, never fees dressed as a result", () => {
  const day = localDayStart(T0);
  const b = (hist: number[][]) => ({ pnl: { fees: 30, gas: 1, swapCost: 2, moveLoss: 10 }, feeHist: hist, startedAt: day - 86_400_000 });
  it('from samples with the cost column: (fees − cost) now − at midnight', () => {
    const r = lpResultToday(b([[day - 60_000, 20, 0, 0, null, 1, 5], [day + 3_600_000, 25, 0, 0, null, 1, 8]]), day)!;
    expect(r.quote).toBeCloseTo((30 - 13) - (20 - 5), 12);
    expect(r.points).toEqual([[day + 3_600_000, (25 - 8) - (20 - 5)]]);
  });
  it('samples from before the cost column give no figure (null), not a fees-only number', () => {
    expect(lpResultToday(b([[day - 60_000, 20], [day + 3_600_000, 25]]), day)).toBeNull();
  });
});

describe('the setup table ranks by the result against holding', () => {
  const row = (bandPct: number, net: number, mix: number): ReplayRow => ({
    bandPct, rerange: true, days: 7, feeCoins: { base: 0, quote: net + 0.1 }, fees: net + 0.1, gas: 0.01, swapCost: 0.09, swapCoins: { base: 0, quote: 0.09 },
    earnedCoins: { base: 0, quote: net }, moves: 20, blocked: 0, inRange: 0.98, moveLoss: mix, openLoss: 0, net, result: net - mix, compounds: 0, taxCost: 0,
    startCoins: { base: 0, quote: 1 }, endCoins: { base: 0, quote: 1 }, priceStart: 1, priceEnd: 1, coinsNow: { base: 0, quote: 1 }, poolShareNow: 0.01,
  });
  it('the ★ goes to the best result, not the highest fees after swaps, and a row whose moves cost more than they earned is said in words', () => {
    const narrow = row(0.01, 0.92, 2.0), wide = row(0.05, 0.46, 0.3); // what the engine gave for Kyle's pool: ±1% earned most and lost most
    const html = renderToStaticMarkup(createElement(Ready, {
      a: { days: 7, from: 0, to: 7 * 86_400, swaps: 100, capital: 3.8, base: 'CASHCAT', quote: 'ETH', gasMove: 0.0001, maxImpact: 0.03, rows: [narrow, wide] } as never,
      band: 0.01, rerange: true, usdPer: null, onPick: () => undefined,
    }));
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(html.indexOf('★')).toBeGreaterThan(html.indexOf('±5'));
    expect(html.indexOf('★')).toBeLessThan(html.indexOf('</tbody>'));
    expect(html.indexOf('±1')).toBeLessThan(html.indexOf('±5')); // the rows keep their order; only the star moved
    expect(text).toMatch(/At ±1% this pool left the range 20 times in 7 days; each move locked in 0\.1 ETH on average, and the fees did not cover it/);
    expect(text).toMatch(/Result/);
  });
});
