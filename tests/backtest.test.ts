import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/market/candles';
import { maxDrawdown, runGridBacktest, runTrendBacktest, sweepTrend } from '../src/market/backtest';
import { DEFAULT_TREND, computeIndicators, signalAt, type TrendConfig } from '../src/market/strategy';
import { GAS_UNITS_RT } from '../src/live/economics';
import { candlesFromCloses, wavePath } from './helpers/candles';

const FREE = { feeBps: 0, pool: null, gasPricePls: 0, approval: 'exact' as const, slippageBps: 0 };
const FEE_ONLY = { ...FREE, feeBps: 29 };
const cfg = (o: Partial<TrendConfig> = {}): TrendConfig => ({ ...DEFAULT_TREND, ...o });

// 9 setup bars → EMA2/EMA3 cross on bar 8; entry fills at bar 9's open.
const SETUP = candlesFromCloses([1, 1, 1, 1, 1, 1, 1, 1, 1.1]);
const C = cfg({ fast: 2, slow: 3, atrPeriod: 2, stopAtr: 1, tpR: 2, trailAtr: 0, cooldownBars: 0 });
const A8 = computeIndicators(SETUP, C).atr[8]!;
const E = 1.1;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: SETUP[0].t + i * 3600, o, h, l, c, v: 1 });
const run = (extra: Candle[], c = C, costs = FREE) => runTrendBacktest([...SETUP, ...extra], c, '1h', { capital: 1000, costs });

describe('trend backtester: fills and exits', () => {
  it('signal on close i → filled at open i+1', () => {
    expect(signalAt(computeIndicators(SETUP, C), SETUP, 8, C).enter).toBe(true);
    const r = run([bar(9, E, E, E, E), bar(10, E, E, E, E)]);
    expect(r.trades[0]).toMatchObject({ entryT: SETUP[0].t + 9 * 3600, entryPrice: E, reason: 'end' });
  });

  it('stop intrabar fills at the stop; gap through fills at the open', () => {
    const stop = E - A8;
    const a = run([bar(9, E, E, stop - 0.001, E), bar(10, E, E, E, E)]);
    expect(a.trades[0]).toMatchObject({ reason: 'stop', exitT: SETUP[0].t + 9 * 3600 });
    expect(a.trades[0].exitPrice).toBeCloseTo(stop, 12);
    const g = run([bar(9, E, E, E, E), bar(10, stop * 0.9, stop * 0.9, stop * 0.8, stop * 0.85)]);
    expect(g.trades[0].reason).toBe('stop');
    expect(g.trades[0].exitPrice).toBeCloseTo(stop * 0.9, 12);
  });

  it('take-profit at R multiple; stop wins when both are inside one candle', () => {
    const stop = E - A8, tp = E + 2 * A8;
    const t = run([bar(9, E, E, E, E), bar(10, E, tp + 0.01, E, E)]);
    expect(t.trades[0].reason).toBe('tp');
    expect(t.trades[0].exitPrice).toBeCloseTo(tp, 12);
    expect(run([bar(9, E, E, E, E), bar(10, E, tp + 0.01, stop - 0.01, E)]).trades[0].reason).toBe('stop');
  });

  it('trailing stop ratchets only after the bar that set the high', () => {
    const c = cfg({ ...C, tpR: 0, trailAtr: 1 });
    const hi = E + 3 * A8, trailStop = hi - A8;
    // bar 9 makes the high and dips below the future trail level, but above the initial stop → no exit on bar 9
    const r = run([bar(9, E, hi, E - 0.5 * A8, hi - 0.1 * A8), bar(10, hi - 0.1 * A8, hi - 0.1 * A8, trailStop - 0.001, trailStop)], c);
    expect(r.trades[0].reason).toBe('trail');
    expect(r.trades[0].exitT).toBe(SETUP[0].t + 10 * 3600);
    expect(r.trades[0].exitPrice).toBeCloseTo(trailStop, 12);
  });

  it('max hold exits at the open after N closed bars; cost gate can block the entry', () => {
    const flat = [9, 10, 11, 12].map((i) => bar(i, E, E, E, E));
    const m = run(flat, cfg({ ...C, tpR: 0, maxHoldBars: 2 }));
    expect(m.trades[0]).toMatchObject({ reason: 'maxhold', exitT: SETUP[0].t + 11 * 3600, bars: 2 });
    const b = run(flat, cfg({ ...C, minEdgePct: 0.4 }));
    expect(b.trades).toHaveLength(0);
    expect(b.metrics.blockedByCost).toBe(1);
  });
});

describe('trend backtester: costs and look-ahead', () => {
  const k = candlesFromCloses(wavePath(500));
  const c = cfg({ fast: 5, slow: 20, cooldownBars: 0, tpR: 0, stopAtr: 3, minEdgePct: 0, expectedMoveAtr: 5 });

  it('cost accounting: proceeds = cost × (1−f)² × exit/entry; Σ pnl = equity change', () => {
    const r = runTrendBacktest(k, c, '1h', { capital: 1000, costs: FEE_ONLY });
    expect(r.trades.length).toBeGreaterThan(3);
    for (const t of r.trades) {
      expect(t.proceeds).toBeCloseTo(t.cost * 0.9971 ** 2 * (t.exitPrice / t.entryPrice), 9);
      expect(t.fees).toBeCloseTo(t.cost * 0.0029 + t.pls * 0.0029 * (t.exitPrice / 0.9971), 9);
      expect(t.gas).toBe(0);
    }
    const sum = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(r.metrics.endEquity - 1000).toBeCloseTo(sum, 9);
    // costs only ever reduce results
    const free = runTrendBacktest(k, c, '1h', { capital: 1000, costs: FREE });
    expect(free.trades.length).toBe(r.trades.length);
    expect(free.metrics.endEquity).toBeGreaterThan(r.metrics.endEquity);
  });

  it('gas and slippage are charged per swap', () => {
    const g = 0.001;
    const r = runTrendBacktest(k, c, '1h', { capital: 1000, costs: { ...FEE_ONLY, gasPricePls: g, slippageBps: 20 } });
    const t = r.trades[0];
    const want = (GAS_UNITS_RT.approve + GAS_UNITS_RT.swap) * g * t.entryPrice + GAS_UNITS_RT.swap * g * t.exitPrice;
    expect(t.gas).toBeCloseTo(want, 12);
    expect(t.proceeds).toBeCloseTo((t.cost - (GAS_UNITS_RT.approve + GAS_UNITS_RT.swap) * g * t.entryPrice) * 0.9971 ** 2 * 0.998 ** 2 * (t.exitPrice / t.entryPrice) - GAS_UNITS_RT.swap * g * t.exitPrice, 9);
  });

  it('no look-ahead: changing the future never changes past trades or equity', () => {
    const base = runTrendBacktest(k, c, '1h', { capital: 1000, costs: FEE_ONLY });
    for (const m of [150, 260, 400]) {
      const future = k.slice(m).map((x, j) => ({ ...x, o: x.o * (j % 2 ? 3 : 0.3), h: x.h * 3, l: x.l * 0.3, c: x.c * (j % 3 ? 0.5 : 2) }));
      const alt = runTrendBacktest([...k.slice(0, m), ...future], c, '1h', { capital: 1000, costs: FEE_ONLY });
      const cut = k[m].t;
      expect(alt.trades.filter((t) => t.exitT < cut)).toEqual(base.trades.filter((t) => t.exitT < cut));
      expect(alt.equity.filter((e) => e.t < cut)).toEqual(base.equity.filter((e) => e.t < cut));
    }
  });

  it('metrics are consistent with the trade list', () => {
    const r = runTrendBacktest(k, c, '1h', { capital: 1000, costs: FEE_ONLY });
    const w = r.trades.filter((t) => t.pnl > 0), l = r.trades.filter((t) => t.pnl <= 0);
    expect(r.metrics.trades).toBe(r.trades.length);
    expect(r.metrics.winRate).toBeCloseTo(w.length / r.trades.length, 12);
    if (l.length && w.length) expect(r.metrics.profitFactor).toBeCloseTo(w.reduce((a, t) => a + t.pnl, 0) / -l.reduce((a, t) => a + t.pnl, 0), 9);
    expect(r.metrics.maxDrawdown).toBeCloseTo(maxDrawdown(r.equity.map((e) => e.v)), 12);
    expect(r.metrics.exposure).toBeGreaterThan(0); expect(r.metrics.exposure).toBeLessThan(1);
    expect(r.equity[0].bh).toBeCloseTo(1000 * 0.9971 ** 2 * (r.equity[0].bh / 1000 / 0.9971 ** 2), 9);
    expect(maxDrawdown([100, 120, 90, 130, 65])).toBe(0.5);
  });

  it('sweep skips invalid combos and flags overfitting', () => {
    const s = sweepTrend(k, c, '1h', 'fast', [5, 10, 30], 'slow', [20, 40], { capital: 1000, costs: FEE_ONLY });
    expect(s.rows.map((r) => [r.x, r.y])).toEqual([[5, 20], [5, 40], [10, 20], [10, 40], [30, 40]]);
    expect(s.notes.join(' ')).toMatch(/overfit/);
    if (s.best) expect(s.best.trades).toBeGreaterThanOrEqual(3);
  });
});

describe('grid backtester', () => {
  it('oscillation inside the range completes profitable round trips net of fees', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 1 + 0.08 * Math.sin(i / 3));
    const k = candlesFromCloses(closes);
    const r = runGridBacktest(k, { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 8, capital: 1000 }, '1h', FEE_ONLY);
    expect(r.trades.length).toBeGreaterThan(10);
    for (const t of r.trades) {
      expect(t.pnl).toBeGreaterThan(0);
      expect(t.proceeds).toBeCloseTo(t.cost * 0.9971 ** 2 * (t.exitPrice / t.entryPrice), 9);
    }
    expect(() => runGridBacktest(k, { lowerPrice: 2, upperPrice: 3, gridCount: 5, capital: 1000 }, '1h', FEE_ONLY)).toThrow(/below/);
  });

  it('same rules as the live grid: every level gets capital ÷ levels; the ones above the first price are bought at the start and sell on the way up', () => {
    // straight up from 1.00 to 1.10 through a ±10% grid of 10 levels
    const k = candlesFromCloses(Array.from({ length: 11 }, (_, i) => 1 + i * 0.01));
    const r = runGridBacktest(k, { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 10, capital: 1000 }, '1h', FREE);
    // the 5 levels from 1.00 up each sold their share; nothing below the start ever bought
    expect(r.trades.map((t) => +t.exitPrice.toFixed(2))).toEqual([1.02, 1.04, 1.06, 1.08, 1.1]);
    for (const t of r.trades) { expect(t.entryPrice).toBe(1); expect(t.cost).toBeCloseTo(100, 9); }
    expect(r.metrics.totalReturn).toBeCloseTo((0.02 + 0.04 + 0.06 + 0.08 + 0.1) * 100 / 1000, 9);
  });

  it('reinvest (default) grows each level\'s next buy by its profit; reinvest: false keeps the sizes', () => {
    const k = candlesFromCloses(Array.from({ length: 300 }, (_, i) => 1 + 0.06 * Math.sin(i / 3)));
    const g = { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 8, capital: 1000 };
    const grow = runGridBacktest(k, g, '1h', FEE_ONLY), flat = runGridBacktest(k, { ...g, reinvest: false }, '1h', FEE_ONLY);
    expect(flat.trades.every((t) => Math.abs(t.cost - 125) < 1e-9 || t.entryPrice === 1)).toBe(true);
    expect(Math.max(...grow.trades.map((t) => t.cost))).toBeGreaterThan(125);
    expect(grow.trades.length).toBe(flat.trades.length);
    expect(grow.metrics.endEquity).toBeGreaterThan(flat.metrics.endEquity);
  });
});


describe('backtest: where the money went (fees, price impact, slippage, gas, price)', () => {
  // WBTC/ETH on Uniswap V3 0.01%, read from the chain 2026-10-20: mid 34.06 ETH per WBTC, 2,618.5 ETH + 76.88 WBTC near the price
  const POOL = { feeBps: 1, pool: { quoteReserve: 2618.5, plsReserve: 76.88 }, gasPricePls: 0, approval: 'exact' as const, slippageBps: 10 };
  const week = candlesFromCloses(Array.from({ length: 168 }, (_, i) => 34.06 * (1 + 0.01 * Math.sin(i / 6))));

  it('10,000 ETH in a pool that holds ~2,600 ETH near the price: price impact, not the market, takes most of it', () => {
    const r = runGridBacktest(week, { lowerPrice: 28.91, upperPrice: 39.113, gridCount: 6, capital: 10_000 }, '1h', POOL);
    const m = r.metrics;
    // the user's screenshot: holding WBTC −79.05% in a week the price barely moved
    expect(m.bhReturn).toBeLessThan(-0.75);
    expect(m.bhEntryImpactPct).toBeGreaterThan(0.75);
    // one level is 1,667 ETH: ~39% impact on a single buy
    expect(m.tradeSize).toBeCloseTo(10_000 / 6, 6);
    expect(m.tradeImpactPct).toBeCloseTo((10_000 / 6) / (2618.5 + 10_000 / 6), 2);
    expect(m.poolDepth).toBe(2618.5);
    expect(m.impact).toBeGreaterThan(m.fees * 100);
    // the breakdown adds up exactly: profit = price effect − fees − impact − slippage − gas
    expect(m.endEquity - m.startEquity).toBeCloseTo(m.priceEffect - m.fees - m.impact - m.slippage - m.gas, 6);
  });

  it('the same grid with 1 ETH pays almost nothing to impact', () => {
    const m = runGridBacktest(week, { lowerPrice: 28.91, upperPrice: 39.113, gridCount: 6, capital: 1 }, '1h', POOL).metrics;
    expect(m.tradeImpactPct).toBeLessThan(0.0001);
    expect(m.bhEntryImpactPct).toBeLessThan(0.001);
    expect(m.endEquity - m.startEquity).toBeCloseTo(m.priceEffect - m.fees - m.impact - m.slippage - m.gas, 9);
  });

  it('trend backtests break their result down the same way', () => {
    const r = run([bar(9, 1.1, 1.3, 1.1, 1.25), bar(10, 1.25, 1.4, 1.2, 1.3)], C, { ...FEE_ONLY, slippageBps: 10, pool: { quoteReserve: 1e6, plsReserve: 1e6 } });
    expect(r.trades).toHaveLength(1);
    const m = r.metrics;
    expect(m.impact).toBeGreaterThan(0);
    expect(m.endEquity - m.startEquity).toBeCloseTo(m.priceEffect - m.fees - m.impact - m.slippage - m.gas, 9);
  });
});
