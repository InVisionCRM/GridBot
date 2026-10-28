import { describe, expect, it } from 'vitest';
import { botMetrics } from '../src/metrics/botMetrics';
import { ageMs, botFacts as rawFacts, DAY_MS, estHint, estNeedMs, extrapolate, moveParts, unitsText, winRateOf } from '../src/ui/deskStats';
import { bucketItems, deskItems, emptyQuery, nextSort } from '../src/ui/deskTableModel';
import { allOn, toggleEvery, toggleId } from '../src/ui/botPick';

/** The UI only reshapes the server's metrics, so give each test bot the metrics the server would attach. */
const withMetrics = <T extends Record<string, unknown>>(b: T, at: number) => ({ ...b, metrics: botMetrics(b, at) });
const botFacts = (b: Record<string, unknown>, at: number) => rawFacts(withMetrics(b, at), at);

const now = 1_700_000_000_000;

describe('desk stat math', () => {
  it('counts age from the start and refuses a missing or future start', () => {
    expect(ageMs(now - 2 * DAY_MS, now)).toBe(2 * DAY_MS);
    expect(ageMs(null, now)).toBeNull();
    expect(ageMs(now + 1000, now)).toBeNull();
  });

  it('extrapolates the P&L so far across a day, a week, and a year', () => {
    const age = 2 * DAY_MS;
    const day = extrapolate(10, 100, age, DAY_MS)!;
    const week = extrapolate(10, 100, age, 7 * DAY_MS)!;
    const year = extrapolate(40, 100, 4 * age, 365 * DAY_MS)!;
    expect(day.amount).toBe(5); expect(day.pct).toBeCloseTo(0.05);
    expect(week.amount).toBe(35); expect(week.pct).toBeCloseTo(0.35);
    expect(year.amount).toBe(1825); expect(year.pct).toBeCloseTo(18.25);
    expect(extrapolate(10, 0, age, DAY_MS)).toEqual({ amount: 5, pct: null });
    expect(extrapolate(10, 100, 30_000, DAY_MS)).toBeNull();
  });

  it('nothing under a day of history; from a day on, amount ÷ age in days × the window (no other cap)', () => {
    // one minute of a −1 swap cost must not become a −525,600 yearly estimate
    expect(extrapolate(-1, 100, 60_000, 365 * DAY_MS)).toBeNull();
    expect(extrapolate(-1, 100, 60_000, DAY_MS)).toBeNull();
    expect(extrapolate(1, 100, 0.48 * DAY_MS, DAY_MS)).toBeNull();
    expect(extrapolate(10, 100, 2 * DAY_MS, 365 * DAY_MS)?.amount).toBe(1825);
    expect(extrapolate(10, 100, 7 * DAY_MS, 365 * DAY_MS)?.amount).toBeCloseTo(521.43, 2);
    expect(extrapolate(1, 100, DAY_MS, DAY_MS)?.amount).toBe(1);
  });

  it('counts fills and re-centers from stored fields, and leaves a hole when they are absent', () => {
    expect(moveParts({ kind: 'grid', moveCount: 4, recenter: { count: 2 } })).toMatchObject({ n: 6, text: '4 fills · 2 re-centers' });
    expect(moveParts({ kind: 'grid' })).toMatchObject({ n: null, text: null });
    expect(moveParts({ kind: 'lp', reranges: 1 })).toMatchObject({ n: 1, text: '1 re-center' });
    expect(moveParts({ kind: 'lp' })).toMatchObject({ n: null, text: null });
    expect(moveParts({ kind: 'trend', moveCount: 3 })).toMatchObject({ n: 3, text: '3 trades' });
    expect(moveParts({ kind: 'trend' })).toMatchObject({ n: null, text: null });
  });

  it('uses round trips for a grid win rate and leaves it blank until a trip closes', () => {
    expect(winRateOf({ kind: 'grid', stats: { roundTrips: 4, wins: 3 } })).toBe(0.75);
    expect(winRateOf({ kind: 'grid', stats: { roundTrips: 0, wins: 0 } })).toBeNull();
    expect(winRateOf({ kind: 'lp', reranges: 2 })).toBeNull();
  });

  it('puts the estimate on the facts and dashes fees the bot does not earn', () => {
    const grid = {
      kind: 'grid', id: 'g', startedAt: now - 2 * DAY_MS, usdPerQuote: 1,
      config: { totalCapitalQuote: 100, lowerPrice: 10, upperPrice: 20, gridCount: 10 },
      pnl: { realized: 4, unrealized: 6 },
      stats: { roundTrips: 2, wins: 1, totalFees: 0.2, totalGas: 0.3 },
      moveCount: 5, recenter: { count: 0 },
    };
    const f = botFacts(grid, now);
    expect(f.ageMs).toBe(2 * DAY_MS);
    expect(f.investedUsd).toBe(100);
    expect(f.realizedUsd).toBe(4);
    expect(f.unrealizedUsd).toBe(6);
    expect(f.est.h24).toEqual({ amount: 2, pct: null }); // Generated (realized 4 over 2 days), not total P&L
    expect(f.generated).toEqual({ quote: 4 });
    expect(f.est.d365).toEqual({ amount: 730, pct: 7.3 }); // 4 over 2 days × 365, on 100 in (a day of history is enough)
    expect(f.feesPaidUsd).toBeCloseTo(0.5);
    expect(f.feesEarnedUsd).toBeNull();
    expect(f.timeInRange).toBeNull();
    expect(f.winRate).toBe(0.5);
    expect(f.moves.n).toBe(5);
    expect(f.spacingFrac).toBeGreaterThan(0);
    expect(botFacts({ kind: 'grid', id: 'x' }, now).est.h24).toBeNull();
  });
});

describe('desk table', () => {
  const bots = [
    { id: 'g', kind: 'grid', mode: 'paper', status: 'running', label: 'ETH/USDC', chainId: 1, config: { totalCapitalQuote: 10 }, pnl: { realized: 1, unrealized: 0 }, usdPerQuote: 1, startedAt: now - DAY_MS },
    { id: 'g2', kind: 'grid', mode: 'paper', status: 'running', label: 'PLS/HEX', chainId: 369, config: { totalCapitalQuote: 4 }, pnl: { realized: 3, unrealized: 0 }, usdPerQuote: 1, startedAt: now - DAY_MS },
    { id: 't', kind: 'trend', mode: 'paper', status: 'stopped', name: 'HEX trend', chainId: 369, capital: 5, pnl: { realized: -1, unrealized: 0, returnPct: -0.2 }, usdPerQuote: 1, startedAt: now - DAY_MS },
    { id: 'l', kind: 'lp', mode: 'live', status: 'running', label: 'ETH/USDC LP', chainId: 1, inRange: false, config: { capital: 20 }, pnl: { net: 2, price: 0, fees: 1 }, usdPerQuote: 1, startValue: 20, startedAt: now - DAY_MS },
  ];
  const items = deskItems(bots.map((b) => withMetrics(b, now)), (b) => (b.chainId === 1 ? 'ETH' : 'PLS'), now);

  it('groups by strategy, with paper grids still under Grid', () => {
    const buckets = bucketItems(items, emptyQuery());
    expect(buckets.map((g) => g.name)).toEqual(['Grid', 'Trend', 'Liquidity']);
    expect(buckets[0].rows.map((r) => r.b.id)).toEqual(['g', 'g2']);
    expect(buckets[0].value).toBe(18); // server current value: capital + realized + unrealized (10+1, 4+3)
  });

  it('filters by type, status, and search, and sorts P&L with blanks last', () => {
    const running = bucketItems(items, { ...emptyQuery(), status: 'running' });
    expect(running.flatMap((g) => g.rows.map((r) => r.b.id))).toEqual(['g', 'g2', 'l']);
    const paper = bucketItems(items, { ...emptyQuery(), type: 'paper' });
    expect(paper.map((g) => g.name)).toEqual(['Paper']);
    expect(paper[0].rows.map((r) => r.b.id).sort()).toEqual(['g', 'g2', 't']);
    const found = bucketItems(items, { ...emptyQuery(), q: 'hex' });
    expect(found.flatMap((g) => g.rows.map((r) => r.b.id)).sort()).toEqual(['g2', 't']);
    const out = bucketItems(items, { ...emptyQuery(), status: 'out' });
    expect(out[0].rows[0].b.id).toBe('l');
    const sorted = bucketItems(items, { ...emptyQuery(), sort: 'pnl', dir: 'desc' });
    expect(sorted[0].rows.map((r) => r.b.id)).toEqual(['g2', 'g']);
    expect(nextSort('name', 'asc', 'pnl')).toEqual({ sort: 'pnl', dir: 'desc' });
    expect(nextSort('pnl', 'desc', 'pnl')).toEqual({ sort: 'pnl', dir: 'asc' });
  });
});

describe('chart bot pick', () => {
  it('toggles one bot and uses All to flip the whole list', () => {
    expect(toggleId([], 'a')).toEqual(['a']);
    expect(toggleId(['a'], 'a')).toEqual([]);
    expect(toggleEvery(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(toggleEvery(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(allOn(['a', 'b'], [])).toBe(true);
    expect(allOn(['a', 'b'], ['a'])).toBe(false);
  });
});

describe('grid capital is in the quote coin', () => {
  // HEX/PLS grid: capital, P&L and equity are all in PLS. PLS ≈ $0.0000051 (PulseX V1 WPLS/DAI reserves, block 27907302).
  const k = 0.0000051;
  const grid = {
    kind: 'grid', id: 'hexpls', startedAt: now - 10 * DAY_MS, usdPerQuote: k,
    config: { totalCapitalQuote: 14_000_000, lowerPrice: 200, upperPrice: 240, gridCount: 10 },
    pnl: { realized: 140_000, unrealized: 0 },
  };
  it('converts invested capital to dollars with the quote rate', () => {
    const f = botFacts(grid, now);
    expect(f.investedUsd).toBeCloseTo(14_000_000 * k, 6);
    expect(f.pnlUsd).toBeCloseTo(140_000 * k, 6);
    expect(f.pnlPct).toBeCloseTo(0.01, 9);
    expect(f.est.d365?.pct).toBeCloseTo(0.01 * 36.5, 9);
  });
  it('shows no dollar capital when the quote has no dollar rate', () => {
    const f = botFacts({ ...grid, usdPerQuote: null }, now);
    expect(f.investedUsd).toBeNull();
    expect(f.pnlPct).toBeNull();
    expect(f.valueUsd).toBeNull();
  });
  it('values a grid with no equity history at capital × rate', () => {
    expect(botFacts({ ...grid, pnl: undefined }, now).valueUsd).toBeCloseTo(14_000_000 * k, 6);
  });
});

describe('estimate hint for a dash', () => {
  it('every window needs one day of history, and says so', () => {
    for (const w of [DAY_MS, 7 * DAY_MS, 30 * DAY_MS, 365 * DAY_MS]) {
      expect(estNeedMs(w)).toBe(DAY_MS);
      expect(estHint(0.48 * DAY_MS, w)).toBe('shows after a day');
      expect(estHint(DAY_MS, w)).toBeNull();
    }
    expect(estHint(null, DAY_MS)).toBe('shows after a day');
    expect(estHint(2 * DAY_MS, 365 * DAY_MS)).toBeNull();
  });
  it('puts the hint on the facts exactly where the estimate is a dash', () => {
    const lp = {
      kind: 'lp', id: 'lp', startedAt: now - 2 * DAY_MS, usdPerQuote: 1, price: 2000, base: 'ETH', quote: 'USDC',
      startValue: 8000, config: { capital: 8000 }, value: 8100,
      pnl: { net: 120, price: -20, fees: 129.7, feeCoins: { base: 0.01, quote: 109.7 } },
    };
    const f = botFacts(lp, now);
    // two days old: every window has its figure, no hint
    expect(f.est.d365).not.toBeNull();
    expect(f.aprPct).not.toBeNull();
    expect(f.estHint).toEqual({ h24: null, d7: null, d365: null });
    expect(f.generatedRate?.d365?.USDC).toBeCloseTo(54.85 * 365, 9);
    expect(f.generatedRate?.d1).toEqual({ ETH: 0.005, USDC: 54.85 });
    // under a day: all dashes, each with the hint
    const young = botFacts({ ...lp, startedAt: now - 0.48 * DAY_MS }, now);
    expect([young.est.h24, young.est.d7, young.est.d365, young.aprPct]).toEqual([null, null, null, null]);
    expect(young.estHint).toEqual({ h24: 'shows after a day', d7: 'shows after a day', d365: 'shows after a day' });
  });
  it('writes units per token', () => {
    expect(unitsText({ ETH: 0.0062605, USDC: 41.455 })).toBe('+0.00626 ETH · +41.46 USDC');
    expect(unitsText({ PLS: -1_234_567.8 })).toBe('−1,234,568 PLS');
    expect(unitsText({ ETH: 0, USDC: 0 })).toBe('0');
    expect(unitsText(null)).toBe('—');
  });
});
