import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TREND, MAX_LINES, computeIndicators, lineAt, lineValue, signalAt, validateTrendConfig, type DrawnLine, type TrendConfig,
} from '../src/market/strategy';
import { runTrendBacktest } from '../src/market/backtest';
import type { Candle } from '../src/market/candles';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ActivityBus } from '../src/server/bot/activity';
import { CandleStore } from '../src/server/market/candleStore';
import { MockChain, NET } from './helpers/mockChain';

const H = 3600;
const T0 = Math.floor(1_791_000_000 / H) * H;
const bars = (rows: [number, number, number, number][], t0 = T0): Candle[] => rows.map(([o, h, l, c], i) => ({ t: t0 + i * H, o, h, l, c, v: 1 }));
const line = (o: Partial<DrawnLine> = {}): DrawnLine => ({ id: 'l1', kind: 'level', a: { t: T0, p: 100 }, rule: 'buy_break', ...o });
const cfg = (lines: DrawnLine[], o: Partial<TrendConfig> = {}): TrendConfig => ({ ...DEFAULT_TREND, strategy: 'lines', atrPeriod: 2, lines, ...o });
/** Signal on the last of `k` */
const last = (k: Candle[], c: TrendConfig) => signalAt(computeIndicators(k, c), k, k.length - 1, c);

describe('drawn lines: where a line is', () => {
  it('a level is flat everywhere; a trend line runs through its two points and on to the right', () => {
    const lv = line();
    expect(lineValue(lv, T0 - 50 * H)).toBe(100);
    expect(lineAt(lv, T0 - 50 * H)).toBe(100);
    const tr = line({ kind: 'trend', a: { t: T0, p: 100 }, b: { t: T0 + 10 * H, p: 110 } });
    expect(lineValue(tr, T0 + 5 * H)).toBeCloseTo(105, 12);
    expect(lineValue(tr, T0 + 20 * H)).toBeCloseTo(120, 12);
  });

  it('a trend line only trades from its later point (nobody could have drawn it sooner)', () => {
    const tr = line({ kind: 'trend', a: { t: T0, p: 100 }, b: { t: T0 + 10 * H, p: 110 } });
    expect(lineAt(tr, T0 + 9 * H)).toBeNull();
    expect(lineAt(tr, T0 + 10 * H)).toBeCloseTo(110, 12);
  });
});

describe('drawn lines: each rule on a closed candle', () => {
  it('buy when a candle closes above it — only on the candle that crosses', () => {
    const c = cfg([line({ rule: 'buy_break' })]);
    expect(last(bars([[99, 99.5, 98.5, 99], [99, 101.5, 98.8, 101]]), c)).toMatchObject({ enter: true, exit: false });
    expect(last(bars([[101, 102, 100.5, 101], [101, 102.5, 100.8, 102]]), c).enter).toBe(false); // already above
    expect(last(bars([[99, 99.5, 98.5, 99], [99, 100.5, 98.8, 99.9]]), c).enter).toBe(false); // wick above, closed below
  });

  it('buy when the price dips to it and closes back above (within the touch distance)', () => {
    const c = cfg([line({ rule: 'buy_bounce' })], { lineTouchPct: 0.002 });
    expect(last(bars([[103, 104, 102.5, 103], [103, 103.2, 100.1, 102]]), c).enter).toBe(true); // low 100.1 ≤ 100.2
    expect(last(bars([[103, 104, 102.5, 103], [103, 103.2, 99.2, 101]]), c).enter).toBe(true); // poked through, closed back above
    expect(last(bars([[103, 104, 102.5, 103], [103, 103.2, 100.4, 102]]), c).enter).toBe(false); // never reached it
    expect(last(bars([[103, 104, 102.5, 103], [103, 103.2, 99.0, 99.5]]), c).enter).toBe(false); // closed below: broke it
    expect(last(bars([[98, 99, 97.5, 99], [99, 101, 98.9, 100.5]]), c).enter).toBe(false); // came from below
  });

  it('sell when a candle closes below it; sell when the price reaches it', () => {
    const brk = cfg([line({ rule: 'sell_break' }), line({ id: 'b', a: { t: T0, p: 120 } })]);
    expect(last(bars([[101, 102, 100.5, 101], [101, 101.2, 98.5, 99]]), brk)).toMatchObject({ enter: false, exit: true });
    const reach = cfg([line({ rule: 'sell_reach' }), line({ id: 'b', a: { t: T0, p: 50 } })], { lineTouchPct: 0.002 });
    expect(last(bars([[97, 98, 96.5, 97], [97, 99.9, 96.8, 98]]), reach).exit).toBe(true); // high 99.9 ≥ 99.8
    expect(last(bars([[97, 98, 96.5, 97], [97, 99.5, 96.8, 98]]), reach).exit).toBe(false);
  });

  it('a trend line ignores candles before its second point', () => {
    const tr = line({ kind: 'trend', a: { t: T0 - 10 * H, p: 90 }, b: { t: T0 + 2 * H, p: 102 } });
    // the line is at 100 at T0 and 101 at T0+H: the close crosses it, but the line doesn't exist yet
    expect(last(bars([[99, 99.5, 98.5, 99], [99, 103, 98.8, 102]]), cfg([tr])).enter).toBe(false);
    // from T0+2H on (line 102 → 103): it trades
    expect(last(bars([[101, 101.5, 100.5, 101], [101, 104, 100.8, 103.5]], T0 + 2 * H), cfg([tr])).enter).toBe(true);
  });

  it('the note says which line fired, or how far the nearest one is', () => {
    const c = cfg([line({ rule: 'buy_break' })]);
    expect(last(bars([[99, 99.5, 98.5, 99], [99, 101.5, 98.8, 101]]), c).note).toMatch(/fired line 1 at 100\.00 \(buy when a candle closes above it\)/);
    expect(last(bars([[99, 99.5, 98.5, 99], [99, 99.5, 98.8, 98]]), c).note).toMatch(/nearest line 1 at 100\.00, 2\.04% above/);
  });
});

describe('drawn lines: validation', () => {
  it('needs a line that buys, real points and known rules; other strategies are unaffected', () => {
    expect(validateTrendConfig(cfg([]))).toContain('Draw at least one line that buys.');
    expect(validateTrendConfig(cfg([line({ rule: 'sell_break' })]))).toContain('Draw at least one line that buys.');
    expect(validateTrendConfig(cfg([line()]))).toEqual([]);
    expect(validateTrendConfig(cfg([line({ kind: 'trend' })])).join()).toMatch(/two points at different times/);
    expect(validateTrendConfig(cfg([line({ kind: 'trend', b: { t: T0, p: 101 } })])).join()).toMatch(/two points at different times/);
    expect(validateTrendConfig(cfg([line({ a: { t: T0, p: 0 } })])).join()).toMatch(/price above 0/);
    expect(validateTrendConfig(cfg([line({ rule: 'yolo' as never })])).join()).toMatch(/unknown rule/);
    expect(validateTrendConfig(cfg(Array.from({ length: MAX_LINES + 1 }, (_, i) => line({ id: `l${i}` }))))).toContain(`at most ${MAX_LINES} lines`);
    expect(validateTrendConfig({ ...DEFAULT_TREND })).toEqual([]);
  });
});

describe('drawn lines: backtest', () => {
  // 10 quiet candles around 100, a breakout above the 105 resistance, a run up, then a close below the 98 support
  const k = bars([
    ...Array.from({ length: 10 }, (_, i): [number, number, number, number] => [100, 101, 99, i % 2 ? 100.5 : 99.5]),
    [100, 106.5, 99.8, 106], // closes above 105 → buy at the next open
    [106, 109, 105.5, 108],
    [108, 112, 107.5, 111],
    [111, 111.5, 104, 104.5],
    [104.5, 105, 97, 97.5], // closes below 98 → sell at the next open
    [97.5, 98, 96, 96.5],
    [96.5, 97, 95.5, 96],
  ]);
  const c = cfg([line({ id: 'r', a: { t: T0, p: 105 }, rule: 'buy_break' }), line({ id: 's', a: { t: T0, p: 98 }, rule: 'sell_break' })], { stopAtr: 5, tpR: 0, cooldownBars: 0, minEdgePct: 0 });

  it('buys the open after the close above, sells the open after the close below, and says lines are hindsight', () => {
    const r = runTrendBacktest(k, c, '1h', { capital: 1000, costs: { feeBps: 30, pool: null, gasPricePls: 0, approval: 'exact', slippageBps: 0 } });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entryT: k[11].t, entryPrice: k[11].o, exitT: k[15].t, exitPrice: k[15].o, reason: 'signal' });
    expect(r.notes.join(' ')).toMatch(/drawn today, knowing what the price did/);
  });

  it('no look-ahead: changing later candles never changes the trade decided before them', () => {
    const base = runTrendBacktest(k, c, '1h', { capital: 1000, costs: { feeBps: 30, pool: null, gasPricePls: 0, approval: 'exact', slippageBps: 0 } });
    const alt = runTrendBacktest([...k.slice(0, 12), ...k.slice(12).map((x) => ({ ...x, o: x.o * 3, h: x.h * 3, l: x.l * 3, c: x.c * 3 }))], c, '1h', { capital: 1000, costs: { feeBps: 30, pool: null, gasPricePls: 0, approval: 'exact', slippageBps: 0 } });
    expect(alt.trades[0].entryT).toBe(base.trades[0].entryT);
    expect(alt.trades[0].entryPrice).toBe(base.trades[0].entryPrice);
  });
});

describe('drawn lines: live trend bot', () => {
  const P = 1e-5;
  function setup() {
    const clock = { ms: (T0 + 10) * 1000 };
    const chain = new MockChain(P / 0.9971);
    const candles = new CandleStore(null);
    const activity = new ActivityBus(400, () => clock.ms);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 0, retryDelayMs: 0, now: () => clock.ms, candles, activity });
    candles.merge('DAI', '1h', Array.from({ length: 10 }, (_, i) => ({ t: T0 - (10 - i) * H, o: P, h: P, l: P, c: P, v: 0 })), 'gecko', T0 + 10);
    const closeBar = (t: number, k: Omit<Candle, 't' | 'v'>) => { clock.ms = (t + H + 10) * 1000; candles.merge('DAI', '1h', [{ t, v: 0, ...k }], 'gecko', t + H + 10); };
    return { bot, chain, closeBar, activity };
  }
  const LIVE = (lines: DrawnLine[]) => ({ ...cfg(lines), stopAtr: 1, tpR: 2, cooldownBars: 0, sizePct: 100 });

  it('buys when a closed candle breaks above your resistance; lines can be changed while it runs', async () => {
    const s = setup();
    const res = line({ a: { t: T0 - 5 * H, p: 1.05 * P }, rule: 'buy_break' });
    const id = await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: LIVE([res]), capital: 100 });
    await s.bot.tickAll();
    expect(s.bot.status().trends[0].position).toBeNull();
    s.closeBar(T0, { o: P, h: 1.1 * P, l: P, c: 1.1 * P });
    s.chain.setPrice((1.1 * P) / 0.9971);
    await s.bot.tickAll();
    const t = s.bot.status().trends.find((x) => x.id === id)!;
    expect(t.position).not.toBeNull();
    expect(t.lastNote).toMatch(/fired line 1/);

    const sup = line({ id: 's', a: { t: T0 - 5 * H, p: 1.08 * P }, rule: 'sell_break' });
    s.bot.setTrendLines(id, [res, sup]);
    expect(s.bot.status().trends[0].cfg.lines).toHaveLength(2);
    expect(s.activity.recent(50).some((e) => /2 lines in effect from the next 1h candle/.test(e.msg))).toBe(true);
    s.closeBar(T0 + H, { o: 1.1 * P, h: 1.1 * P, l: 1.07 * P, c: 1.075 * P }); // closes below the new support line
    s.chain.setPrice((1.075 * P) / 0.9971);
    await s.bot.tickAll();
    await s.bot.tickAll();
    const after = s.bot.status().trends[0];
    expect(after.position).toBeNull();
    expect(after.trades[0]).toMatchObject({ side: 'sell', reason: 'signal' }); // newest first
    expect(after.lastNote).toMatch(/fired line 2 at .*sell when a candle closes below it/);
  });

  it('refuses lines that never buy, and line edits on a bot that trades something else', async () => {
    const s = setup();
    const id = await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: LIVE([line({ a: { t: T0, p: 1.05 * P } })]), capital: 100 });
    expect(() => s.bot.setTrendLines(id, [line({ rule: 'sell_break', a: { t: T0, p: P } })])).toThrow('Draw at least one line that buys.');
    await expect(s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: LIVE([]), capital: 100 })).rejects.toThrow('Draw at least one line that buys.');
    const ema = await s.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: { strategy: 'ema', fast: 2, slow: 3, atrPeriod: 2 }, capital: 100 });
    expect(() => s.bot.setTrendLines(ema, [line()])).toThrow("This bot doesn't trade on drawn lines.");
  });
});
