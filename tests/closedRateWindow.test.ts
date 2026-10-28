/** Rates, estimates and APR of a stopped / closed bot span start → stop, not start → now. Running bots unchanged. */
import { describe, expect, it } from 'vitest';
import { botFacts, historyEnd, DAY_MS } from '../src/ui/deskStats';

const now = 1_800_000_000_000;
const H = 3_600_000;
const grid = (p: Record<string, unknown> = {}) => ({
  kind: 'grid', id: 'g', startedAt: now - 10 * DAY_MS, usdPerQuote: 1,
  config: { totalCapitalUsd: 100, lowerPrice: 10, upperPrice: 20, gridCount: 10 },
  pnl: { realized: 4, unrealized: 6 }, stats: { roundTrips: 2, wins: 1, totalFees: 0, totalGas: 0 }, moveCount: 5,
  ...p,
});

describe('history window of a stopped / closed bot', () => {
  it('a running bot runs to now (unchanged)', () => {
    const f = botFacts(grid({ status: 'running', priceAt: now - 2 * DAY_MS }), now);
    expect(f.ageMs).toBe(10 * DAY_MS);
    expect(f.est.h24!.amount).toBeCloseTo(1, 12);
    expect(f.est.h24!.pct).toBeCloseTo(0.01, 12);
    expect(f.est.d365?.pct).toBeCloseTo(0.1 * 36.5, 9);
    // no status at all (older payloads, trader rows): also now
    expect(botFacts(grid(), now).ageMs).toBe(10 * DAY_MS);
    // closing is still running
    expect(historyEnd({ status: 'stopped', closing: true, priceAt: now - DAY_MS }, now)).toBe(now);
  });

  it('a stopped grid uses its recorded stop time (halt.at)', () => {
    const f = botFacts(grid({ status: 'stopped', halt: { at: now - 8 * DAY_MS, what: 'Stop' }, priceAt: now - 7 * DAY_MS }), now);
    expect(f.ageMs).toBe(2 * DAY_MS);
    expect(f.est.h24!.amount).toBeCloseTo(5, 12); // 10 over 2 days, not 10 over 10 days
    expect(f.est.h24!.pct).toBeCloseTo(0.05, 12);
    expect(f.est.d365?.pct).toBeCloseTo(18.25, 9);
  });

  it('a closed LP with no halt record falls back to its last activity (last reading / range move / trade)', () => {
    const lp = {
      kind: 'lp', id: 'l', status: 'closed', startedAt: now - 9 * DAY_MS, usdPerQuote: 1, startValue: 100, config: { capital: 100 },
      pnl: { net: 3, price: -1, fees: 4 }, halt: null,
      priceAt: now - 4 * DAY_MS, lastRerangeAt: now - 5 * DAY_MS, archivedAt: now - 1 * DAY_MS,
    };
    expect(historyEnd(lp, now)).toBe(now - 4 * DAY_MS);
    const f = botFacts(lp, now);
    expect(f.ageMs).toBe(5 * DAY_MS);
    expect(f.est.h24!.amount).toBeCloseTo(2 / 5, 12); // P&L 2 over 5 active days
    // trades are activity too; archivedAt only when nothing else is recorded
    expect(historyEnd({ status: 'stopped', trades: [{ timestamp: now - 3 * H }, { timestamp: now - 6 * H }] }, now)).toBe(now - 3 * H);
    expect(historyEnd({ status: 'closed', archivedAt: now - 2 * H }, now)).toBe(now - 2 * H);
    expect(historyEnd({ status: 'closed' }, now)).toBe(now);
  });

  it('a paused LP with its position open keeps earning: its window runs to now, so rates and APR don\'t inflate (review #50)', () => {
    const lp = (net: number, at: number) => ({
      kind: 'lp', id: 'l', status: 'stopped', startedAt: now - 10 * DAY_MS, usdPerQuote: 1, startValue: 100, config: { capital: 100 },
      position: { id: 1, lower: 1, upper: 2, openedAt: now - 10 * DAY_MS }, halt: { at: now - 8 * DAY_MS, what: 'Pause' },
      pnl: { net, price: 0, fees: net }, priceAt: at,
    });
    // paused 8 days ago; P&L 2 at the pause, then the position kept earning: 10 by now (+8 more over 30 more days later)
    expect(historyEnd(lp(10, now), now)).toBe(now);
    const a = botFacts(lp(10, now), now), later = botFacts(lp(18, now + 30 * DAY_MS), now + 30 * DAY_MS);
    expect(a.ageMs).toBe(10 * DAY_MS);
    expect(a.est.h24!.amount).toBeCloseTo(1, 12); // 10 over 10 days, not 10 over the 2 days before the pause
    expect(later.ageMs).toBe(40 * DAY_MS);
    expect(later.est.h24!.amount).toBeCloseTo(18 / 40, 12); // stays at the real pace, never runs away
    expect(later.est.d365!.pct!).toBeLessThan(a.est.d365!.pct!);
    // frozen at the pause, the same bot would have read 18 over 2 days: 9 a day, 32.85 = 3285% APR
    // once the position is gone (or the bot closed / archived), the window ends at the stop again
    const { position: _p, ...noPos } = lp(10, now); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(historyEnd(noPos, now)).toBe(now - 8 * DAY_MS);
    expect(historyEnd({ ...lp(10, now), status: 'closed' }, now)).toBe(now - 8 * DAY_MS);
    expect(historyEnd({ ...lp(10, now), archivedAt: now - DAY_MS }, now)).toBe(now - 8 * DAY_MS);
    // a paused grid still freezes (it stops ticking when paused)
    expect(historyEnd({ kind: 'grid', status: 'stopped', halt: { at: now - 8 * DAY_MS } }, now)).toBe(now - 8 * DAY_MS);
  });

  it('the end is never after now, and a stopped bot\'s figures stop drifting as time passes', () => {
    expect(historyEnd({ status: 'stopped', halt: { at: now + DAY_MS } }, now)).toBe(now);
    const b = grid({ status: 'stopped', priceAt: now - 8 * DAY_MS });
    expect(botFacts(b, now).est.h24).toEqual(botFacts(b, now + 30 * DAY_MS).est.h24);
  });
});
