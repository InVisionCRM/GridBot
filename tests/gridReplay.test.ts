/**
 * Grid replay: the pool's minutes through the live grid's rules (runGridBacktest) for each width × level count, earned
 * in units (completed round trips after every cost), coins still held at the end shown and not counted.
 */
import { describe, expect, it } from 'vitest';
import { GRID_LEVELS, GRID_WIDTHS, gridReplayTable, gridSettings } from '../src/market/gridReplay';
import { DEFAULT_COSTS } from '../src/market/costs';
import type { PoolMinute } from '../src/market/lpReplay';
import { yoursOf } from '../src/server/replay/grid';

const SIDES = { baseIs0: true, baseDecimals: 18, quoteDecimals: 6 };
const T = -200_000; // ≈ 2,061 quote per base
const T0 = 1_800_000_000;
const minutes = (ticks: number[]): PoolMinute[] => ticks.map((c, i) => ({ t: T0 + i * 60, lo: c, hi: c, c, f0: 0, f1: 0, liq: 0, n: 1 }));
const COSTS = { ...DEFAULT_COSTS, slippageBps: 0 };
/** ±3 % swings (300 ticks) back and forth, 20 times */
const swings = Array.from({ length: 20 }, () => [...Array.from({ length: 30 }, (_, i) => T - i * 10), ...Array.from({ length: 60 }, (_, i) => T - 300 + i * 10), ...Array.from({ length: 30 }, (_, i) => T + 300 - i * 10)]).flat();

describe('grid replay', () => {
  it('a market going sideways: completed round trips earn, and a narrower range earns more of them', async () => {
    const [narrow, wide] = await gridReplayTable(minutes(swings), SIDES, 1000, COSTS, [{ below: 0.05, above: 0.05, levels: 10 }, { below: 0.3, above: 0.3, levels: 10 }]);
    expect(narrow.roundTrips).toBeGreaterThan(wide.roundTrips);
    expect(narrow.earned).toBeGreaterThan(0);
    expect(narrow.earned).toBeGreaterThan(wide.earned);
    expect(narrow.inRange).toBe(1);
    expect(narrow.fees).toBeGreaterThan(0); // the pool fee on every swap
    expect(narrow.days).toBeCloseTo((swings.length - 1) / 1440, 9);
  });

  it('levels closer than two pool fees lose on every round trip: the replay shows it', async () => {
    // ±5 % over 20 levels is 0.5 % apart; a round trip pays the 0.29 % fee twice (0.58 %)
    const [r] = await gridReplayTable(minutes(swings), SIDES, 1000, COSTS, [{ below: 0.05, above: 0.05, levels: 20 }]);
    expect(r.roundTrips).toBeGreaterThan(0);
    expect(r.earned).toBeLessThan(0);
  });

  it('a rise out of the range: every level sold, nothing held, and the time above the range is out of range', async () => {
    const up = [...Array(60).fill(T), ...Array.from({ length: 200 }, (_, i) => T + i * 10)];
    const [r] = await gridReplayTable(minutes(up), SIDES, 1000, COSTS, [{ below: 0.05, above: 0.05, levels: 10 }]);
    expect(r.held).toBeNull();
    expect(r.inRange).toBeLessThan(1);
    expect(r.roundTrips).toBeGreaterThan(0);
  });

  it('a fall: the levels bought are still held at the end, shown and not counted in earned', async () => {
    const down = [...Array(60).fill(T), ...Array.from({ length: 300 }, (_, i) => T - i * 5)];
    const [r] = await gridReplayTable(minutes(down), SIDES, 1000, COSTS, [{ below: 0.2, above: 0.2, levels: 10 }]);
    expect(r.held!.base).toBeGreaterThan(0);
    expect(r.held!.cost).toBeGreaterThan(0);
    // no level sold back above where it bought: no completed round trip, so nothing earned (the held coins' fall is not in it)
    expect(r.roundTrips).toBe(0);
    expect(r.earned).toBe(0);
  });

  it(`tries ${GRID_WIDTHS.length} widths × ${GRID_LEVELS.length} level counts, with the form's range first`, () => {
    expect(gridSettings(null)).toHaveLength(GRID_WIDTHS.length * GRID_LEVELS.length);
    const s = gridSettings({ below: 0.1, above: 0.2, levels: 7 });
    expect(s[0]).toEqual({ below: 0.1, above: 0.2, levels: 7, yours: true });
    expect(s).toHaveLength(GRID_WIDTHS.length * GRID_LEVELS.length + 1);
  });

  it('the form\'s range is replayed as fractions of today\'s price, and only when it holds that price', () => {
    expect(yoursOf(100, {})).toEqual({ setting: null, note: null });
    expect(yoursOf(100, { lower: 90, upper: 120, levels: 10 })).toEqual({ setting: { below: expect.closeTo(0.1, 12), above: expect.closeTo(0.2, 12), levels: 10 }, note: null });
    expect(yoursOf(100, { lower: 110, upper: 120, levels: 10 }).note).toMatch(/doesn't hold today's price/);
    expect(yoursOf(100, { lower: 90, upper: 120, levels: 1 }).note).toMatch(/at least 2 levels/);
  });
});

describe('grid replay page', () => {
  it('shows your range first, the held coins, the best row, and a tap puts that range around today\'s price', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { GridReady, rangeAround } = await import('../src/ui/GridReplay');
    const rows = await gridReplayTable(minutes(swings), SIDES, 1000, COSTS, gridSettings({ below: 0.04, above: 0.06, levels: 8 }));
    const a = { days: 7 as const, from: T0, to: T0 + 7 * 86_400, trades: 2400, capital: 1000, base: 'ETH', quote: 'USDG', spot: 2000, yoursNote: null, rows };
    const html = renderToStaticMarkup(createElement(GridReady, { a, usdPer: null, onPick: () => {} }))
      .replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
    expect(html).toMatch(/Range Levels Earned i Per day Round trips In range i Held at the end i −4% \/ \+6% yours/);
    expect(html).toContain('★');
    expect(html).toContain('Earned is the completed round trips after every cost, in USDG');
    expect(rangeAround(2000, { below: 0.05, above: 0.05 })).toEqual({ lower: 1900, upper: 2100 });
  });
});
