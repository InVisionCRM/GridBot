/**
 * Rates, estimates and APR of a stopped / closed bot span start → stop, not start → now; a paused LP that still holds
 * its position runs to now (review #50). Running bots unchanged. Since #43 the window lives in the server's metrics
 * (src/metrics/botMetrics.ts historyEnd, used by finish()); the desk / stat table read it from there (botFacts).
 */
import { describe, expect, it } from 'vitest';
import { botFacts as rawFacts, historyEnd, DAY_MS } from '../src/ui/deskStats';
import { botMetrics } from '../src/metrics/botMetrics';

const now = 1_800_000_000_000;
const H = 3_600_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const facts = (b: Obj, at = now) => rawFacts({ ...b, metrics: botMetrics(b, at) }, at);
const grid = (p: Obj = {}) => ({
  kind: 'grid', id: 'g', startedAt: now - 10 * DAY_MS, usdPerQuote: 1, chainId: 369,
  config: { totalCapitalQuote: 100, lowerPrice: 10, upperPrice: 20, gridCount: 10 },
  pnl: { realized: 4, unrealized: 6 }, stats: { roundTrips: 2, wins: 1, totalFees: 0, totalGas: 0 }, moveCount: 5,
  ...p,
});
const perDay = (m: Obj | null) => (m?.generatedRate?.d1 ? Object.values(m.generatedRate.d1 as Record<string, number>)[0] : null);
const gen = (m: Obj | null) => (m?.generated ? Object.values(m.generated as Record<string, number>)[0] : null);

describe('history window of a stopped / closed bot', () => {
  it('a running bot runs to now (unchanged)', () => {
    const b = grid({ status: 'running', priceAt: now - 2 * DAY_MS });
    expect(facts(b).ageMs).toBe(10 * DAY_MS);
    // no status at all (older payloads, trader rows): also now
    expect(facts(grid()).ageMs).toBe(10 * DAY_MS);
    // closing is still running
    expect(historyEnd({ status: 'stopped', closing: true, priceAt: now - DAY_MS }, now)).toBe(now);
  });

  it('a stopped grid uses its recorded stop time (halt.at): Generated ÷ 2 days, not ÷ 10', () => {
    const b = grid({ status: 'stopped', halt: { at: now - 8 * DAY_MS, what: 'Stop' }, priceAt: now - 7 * DAY_MS });
    expect(facts(b).ageMs).toBe(2 * DAY_MS);
    const m = botMetrics(b, now)!;
    if (gen(m)) expect(perDay(m)).toBeCloseTo(gen(m)! / 2, 12);
  });

  it('a closed LP with no halt record falls back to its last activity (last reading / range move / trade)', () => {
    const lp = {
      kind: 'lp', id: 'l', status: 'closed', startedAt: now - 9 * DAY_MS, usdPerQuote: 1, startValue: 100, config: { capital: 100 },
      pnl: { net: 3, price: -1, fees: 4 }, halt: null,
      priceAt: now - 4 * DAY_MS, lastRerangeAt: now - 5 * DAY_MS, archivedAt: now - 1 * DAY_MS,
    };
    expect(historyEnd(lp, now)).toBe(now - 4 * DAY_MS);
    expect(facts(lp).ageMs).toBe(5 * DAY_MS);
    expect(historyEnd({ status: 'stopped', trades: [{ timestamp: now - 3 * H }, { timestamp: now - 6 * H }] }, now)).toBe(now - 3 * H);
    expect(historyEnd({ status: 'closed', archivedAt: now - 2 * H }, now)).toBe(now - 2 * H);
    expect(historyEnd({ status: 'closed' }, now)).toBe(now);
  });

  it('a paused LP with its position open keeps earning: its window runs to now, so rates and APR don\'t inflate (review #50)', () => {
    const lp = (at: number) => ({
      kind: 'lp', id: 'l', status: 'stopped', startedAt: now - 10 * DAY_MS, usdPerQuote: 1, startValue: 100, config: { capital: 100 },
      position: { id: 1, lower: 1, upper: 2, openedAt: now - 10 * DAY_MS }, halt: { at: now - 8 * DAY_MS, what: 'Pause' },
      pnl: { net: 10, price: 0, fees: 10 }, priceAt: at,
    });
    expect(historyEnd(lp(now), now)).toBe(now);
    expect(facts(lp(now)).ageMs).toBe(10 * DAY_MS);
    expect(facts(lp(now + 30 * DAY_MS), now + 30 * DAY_MS).ageMs).toBe(40 * DAY_MS);
    // once the position is gone (or the bot closed / archived), the window ends at the stop again
    const { position: _p, ...noPos } = lp(now); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(historyEnd(noPos, now)).toBe(now - 8 * DAY_MS);
    expect(historyEnd({ ...lp(now), status: 'closed' }, now)).toBe(now - 8 * DAY_MS);
    expect(historyEnd({ ...lp(now), archivedAt: now - DAY_MS }, now)).toBe(now - 8 * DAY_MS);
    // a paused grid still freezes (it stops ticking when paused)
    expect(historyEnd({ kind: 'grid', status: 'stopped', halt: { at: now - 8 * DAY_MS } }, now)).toBe(now - 8 * DAY_MS);
  });

  it('the end is never after now, and a stopped bot\'s figures stop drifting as time passes', () => {
    expect(historyEnd({ status: 'stopped', halt: { at: now + DAY_MS } }, now)).toBe(now);
    const b = grid({ status: 'stopped', priceAt: now - 8 * DAY_MS });
    expect(facts(b).ageMs).toBe(facts(b, now + 30 * DAY_MS).ageMs);
    expect(botMetrics(b, now)!.generatedRate).toEqual(botMetrics(b, now + 30 * DAY_MS)!.generatedRate);
  });
});
