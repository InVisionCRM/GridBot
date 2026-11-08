import { describe, expect, it } from 'vitest';
import { lpDay } from '../src/metrics/lpDay';
import { localDayStart } from '../src/metrics/feesToday';

const H = 3_600_000, M5 = 5 * 60_000;
const DAY = localDayStart(Date.UTC(2026, 10, 4, 12));
const NOW = DAY + 17 * H + 30 * 60_000; // 17:30 local

/**
 * A bot started `startH` hours before midnight earning `rate(t)` quote an hour (half in each coin at price 2), the pool
 * paying its LPs 10× what the bot earns, sampled every 5 minutes up to `NOW`.
 */
function bot(o: { startH?: number; rate?: (t: number) => number; feeRate?: unknown; done?: unknown[]; noHistBefore?: number } = {}) {
  const start = DAY - (o.startH ?? 40) * H;
  const rate = o.rate ?? (() => 1);
  const hist: number[][] = [];
  let f = 0;
  const at = (t: number) => { let x = 0; for (let s = start; s < t; s += M5) x += (rate(s) * Math.min(M5, t - s)) / H; return x; };
  for (let t = start; t < NOW; t += M5) {
    f = at(t);
    if (o.noHistBefore == null || t >= o.noHistBefore) hist.push([t, f, f / 4, f / 2, 10 * f, 2, 0]); // …, price, cost (none here)
  }
  const live = at(NOW);
  return {
    kind: 'lp', startedAt: start, price: 2, value: 1000, feeHist: hist, poolFees: 10 * live,
    pnl: { fees: live, feeCoins: { base: live / 4, quote: live / 2 }, gas: 0, swapCost: 0, moveLoss: 0 },
    lpFeeRate: o.feeRate === undefined ? { rate: 0.003 } : o.feeRate, done: o.done ?? [], position: null,
  };
}

describe("a liquidity bot's day (server-side, local hours)", () => {
  it('fees per hour today from the 5-minute samples; the current hour so far; the hours to come empty', () => {
    const d = lpDay(bot(), NOW)!;
    expect(d.dayStart).toBe(DAY);
    expect(d.hours).toHaveLength(24);
    expect(d.hours[0].t).toBe(DAY);
    for (const h of d.hours.slice(0, 17)) expect(h.fees).toBeCloseTo(1, 9);
    expect(d.hours[17].fees).toBeCloseTo(0.5, 9); // 17:00–17:30
    expect(d.hours.slice(18).every((h) => h.future && h.fees == null)).toBe(true);
    // the hours add up to today, Home's figure
    expect(d.hours.reduce((a, h) => a + (h.fees ?? 0), 0)).toBeCloseTo(d.today!, 9);
    expect(d.today).toBeCloseTo(17.5, 9);
    // per coin, the pool's LP fees and the trading that paid them (fees ÷ the LP fee rate)
    expect(d.hours[3]).toMatchObject({ price: 2, moves: 0 });
    expect(d.hours[3].feeBase).toBeCloseTo(0.25, 9);
    expect(d.hours[3].feeQuote).toBeCloseTo(0.5, 9);
    expect(d.hours[3].poolFees).toBeCloseTo(10, 9);
    expect(d.hours[3].volume).toBeCloseTo(10 / 0.003, 6);
  });

  it('today vs yesterday by now: yesterday from midnight to this time of day', () => {
    // 2 an hour until 06:00 today, then 1 an hour
    const d = lpDay(bot({ rate: (t) => (t < DAY + 6 * H ? 2 : 1) }), NOW)!;
    expect(d.yesterdayByNow).toBeCloseTo(35, 6); // yesterday 00:00–17:30 at 2 an hour
    expect(d.today).toBeCloseTo(12 + 11.5, 6);
  });

  it('a bot started today: no yesterday to compare; the hours before it started earned nothing (not "no reading")', () => {
    const d = lpDay(bot({ startH: -15 }), NOW)!; // started 15:00 today
    expect(d.yesterdayByNow).toBeNull();
    expect(d.hours[10].fees).toBe(0);
    expect(d.hours[16].fees).toBeCloseTo(1, 9);
  });

  it("the pool's last 24 hours: its LP fees, its volume, this bot's share; the volume left out with the reason when the fee rate can't be read", () => {
    const d = lpDay(bot(), NOW)!;
    expect(d.pool!.hours).toBe(24);
    expect(d.pool!.lpFees).toBeCloseTo(240, 6);
    expect(d.pool!.volume).toBeCloseTo(240 / 0.003, 3);
    expect(d.pool!.share).toBeCloseTo(0.1, 9);
    const no = lpDay(bot({ feeRate: { error: 'protocol fee encoding isn\'t verified' } }), NOW)!;
    expect(no.pool).toMatchObject({ volume: null, volumeError: "protocol fee encoding isn't verified" });
    expect(no.hours[2].volume).toBeNull();
  });

  it('a history that starts after midnight (an older bot): hours before it read as no reading, never as zero', () => {
    const d = lpDay(bot({ noHistBefore: DAY + 9 * H }), NOW)!;
    expect(d.hours[3].fees).toBeNull();
    expect(d.hours[9].fees).toBeCloseTo(1, 9);
    expect(d.yesterdayByNow).toBeNull();
  });

  it("today's ranges from the step log: the one open at midnight, each move, a compound inside a range joined; today's steps newest first", () => {
    const done = [
      { t: DAY + 13 * H, action: 'rerange', asked: false, lower: 3, upper: 4, cost: 0.2, fees: { base: 0, quote: 0 } },
      { t: DAY + 11 * H, action: 'compound', asked: false, lower: null, upper: null, cost: 0.1, fees: { base: 1, quote: 1 } },
      { t: DAY + 4 * H, action: 'rerange', asked: true, lower: 2, upper: 3, cost: 0.3, fees: { base: 0, quote: 0 } },
      { t: DAY - 5 * H, action: 'open', asked: true, lower: 1, upper: 2, cost: 0.5, fees: { base: 0, quote: 0 } },
    ];
    const d = lpDay(bot({ done }), NOW)!;
    expect(d.ranges).toEqual([
      { from: DAY, to: DAY + 4 * H, lower: 1, upper: 2 },
      { from: DAY + 4 * H, to: DAY + 13 * H, lower: 2, upper: 3 },
      { from: DAY + 13 * H, to: NOW, lower: 3, upper: 4 },
    ]);
    expect(d.moves.map((x) => x.action)).toEqual(['rerange', 'compound', 'rerange']);
    expect(d.hours[4].moves).toBe(1);
    expect(d.hours[11].moves).toBe(0); // a compound is not a range move
    // closed at 15:00: the range ends there
    const closed = lpDay(bot({ done: [{ t: DAY + 15 * H, action: 'close', asked: true, lower: null, upper: null, cost: 0.1, fees: { base: 0, quote: 0 } }, ...done] }), NOW)!;
    expect(closed.ranges.at(-1)).toEqual({ from: DAY + 13 * H, to: DAY + 15 * H, lower: 3, upper: 4 });
    // today's prices: every sample since midnight, then now
    expect(d.prices[0][0]).toBe(DAY);
    expect(d.prices.at(-1)).toEqual([NOW, 2]);
  });
});
