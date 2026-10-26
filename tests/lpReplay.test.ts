import { describe, expect, it } from 'vitest';
import { addSwaps, positionFor, replayLp, replayTable, type PoolMinute, type ReplayOpts, type ReplayPool } from '../src/market/lpReplay';
import { sqrtPriceAt } from '../src/live/v3Liquidity';

/** WETH/USDG-like pool: base = token0 (18 decimals), quote = token1 (6), tick spacing 1, 0.01 % swaps. */
const POOL: ReplayPool = { baseIs0: true, baseDecimals: 18, quoteDecimals: 6, spacing: 1, swapFee: 1e-4 };
const T = -200_000; // ≈ 2,063 quote per base
const T0 = 1_800_000_000;
/** Free moves: no gas, no impact cap */
const BASE: Omit<ReplayOpts, 'bandPct' | 'rerange'> = { capital: 1000, gasOpen: 0, gasMove: 0, maxImpact: 1 };
/** One minute per entry at the given ticks; `f1` quote fees (raw) per unit of liquidity each minute; a deep pool. */
const minutes = (ticks: number[], f1 = 1e-9, liq = 1e24): PoolMinute[] =>
  ticks.map((c, i) => ({ t: T0 + i * 60, lo: c, hi: c, c, f0: 0, f1, liq, n: 1 }));
const repeat = (tick: number, n: number) => Array.from({ length: n }, () => tick);

describe('addSwaps: a pool\'s swaps folded into minutes', () => {
  it('fees per unit of liquidity on the side paid in, the starting tick in the minute\'s range, liquidity averaged', () => {
    const m: PoolMinute[] = [];
    const last = addSwaps(m, [
      { t: T0 + 5, a0: 1e18, a1: -2e9, liq: 1e18, tick: T - 3 },
      { t: T0 + 50, a0: -5e17, a1: 1e9, liq: 3e18, tick: T + 2 },
      { t: T0 + 61, a0: 2e18, a1: -4e9, liq: 2e18, tick: T - 1 },
    ], { feeTier: 100, lpShare: 0.75, lastTick: T });
    expect(last).toBe(T - 1);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ t: T0, lo: T - 3, hi: T + 2, c: T + 2, n: 2 });
    expect(m[0].f0).toBeCloseTo((1e18 * 1e-4 * 0.75) / 1e18, 15);
    expect(m[0].f1).toBeCloseTo((1e9 * 1e-4 * 0.75) / 3e18, 25);
    expect(m[0].liq).toBe(2e18);
    // the next minute starts where the price was (T + 2), so its range covers the move down to T − 1
    expect(m[1]).toMatchObject({ t: T0 + 60, lo: T - 1, hi: T + 2, c: T - 1, n: 1 });
  });

  it('a later batch continues the same minute; an older swap is refused', () => {
    const m: PoolMinute[] = [];
    let last = addSwaps(m, [{ t: T0 + 1, a0: 1e18, a1: -1, liq: 1e18, tick: T }], { feeTier: 100, lpShare: 1, lastTick: null });
    last = addSwaps(m, [{ t: T0 + 30, a0: 1e18, a1: -1, liq: 3e18, tick: T + 4 }], { feeTier: 100, lpShare: 1, lastTick: last });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ lo: T, hi: T + 4, c: T + 4, n: 2, liq: 2e18 });
    expect(() => addSwaps(m, [{ t: T0 - 60, a0: 1, a1: -1, liq: 1, tick: T }], { feeTier: 100, lpShare: 1, lastTick: last })).toThrow(/older/);
  });
});

describe('replayLp: fees', () => {
  it('a price that never leaves the range: earned after costs is the fees less the opening swap, and fees scale with trading', () => {
    const a = replayLp(minutes(repeat(T, 100)), POOL, { ...BASE, bandPct: 0.05, rerange: true });
    expect(a.moves).toBe(0);
    expect(a.inRange).toBe(1);
    expect(a.fees).toBeGreaterThan(0);
    expect(a.moveLoss).toBe(0);
    expect(a.net).toBeCloseTo(a.fees - a.swapCost, 9);
    const b = replayLp(minutes(repeat(T, 100), 2e-9), POOL, { ...BASE, bandPct: 0.05, rerange: true });
    expect(b.fees).toBeCloseTo(2 * a.fees, 6);
  });

  it('fees are counted in the coin they were paid in', () => {
    // quote fees only: all of it is quote coin
    const q = replayLp(minutes(repeat(T, 50)), POOL, { ...BASE, bandPct: 0.05, rerange: false });
    expect(q.feeCoins.base).toBe(0);
    expect(q.feeCoins.quote).toBeCloseTo(q.fees, 12);
    // base fees only (f0 per unit of liquidity, raw token0 with 18 decimals): base coin, worth base × price
    const rows = minutes(repeat(T, 50), 0).map((m) => ({ ...m, f0: 1e-6 }));
    const b = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: false });
    const price = sqrtPriceAt(T) ** 2 * 1e12; // quote per base (18 vs 6 decimals)
    expect(b.feeCoins.quote).toBe(0);
    expect(b.feeCoins.base).toBeGreaterThan(0);
    expect(b.fees).toBeCloseTo(b.feeCoins.base * price, 6);
  });

  it('earns only for the part of a minute inside the range', () => {
    // ±5% ≈ ±488 ticks: half the minutes sit 2000 ticks above
    const half = replayLp(minutes([T, ...repeat(T, 49), ...repeat(T + 2000, 50)]), POOL, { ...BASE, bandPct: 0.05, rerange: false });
    const all = replayLp(minutes(repeat(T, 100)), POOL, { ...BASE, bandPct: 0.05, rerange: false });
    expect(half.inRange).toBeCloseTo(49 / 99, 6);
    expect(half.fees).toBeCloseTo((all.fees * 49) / 99, 6);
    // a minute that spans from inside to outside counts the share of its ticks inside
    const rows = minutes(repeat(T, 3));
    rows[1] = { ...rows[1], lo: T, hi: T + 999 };
    const r = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: false });
    const top = Math.floor(Math.log(rawUpper(0.05)) / Math.log(1.0001)) + 1; // the range's upper tick (exclusive)
    expect(r.inRange).toBeCloseTo((1 + (top - T) / 1000) / 2, 2);
  });
});

/** Raw price at the top of ±band around tick T. */
function rawUpper(band: number) { return sqrtPriceAt(T) ** 2 * (1 + band); }

describe('replayLp: moving the range (the live bot\'s rule)', () => {
  const away = [T, ...repeat(T + 2000, 300)]; // jumps above a ±5% range and trades there

  it('moves as soon as a minute ends outside the range, whatever moving costs; never with moves off', () => {
    const on = replayLp(minutes(away), POOL, { ...BASE, bandPct: 0.05, rerange: true, gasMove: 0.001 });
    expect(on.moves).toBe(1);
    const off = replayLp(minutes(away), POOL, { ...BASE, bandPct: 0.05, rerange: false, gasMove: 0.001 });
    expect(off.moves).toBe(0);
    // after the move the price is inside the new range
    expect(on.inRange).toBeGreaterThan(0.9);
  });

  it('no daily limit: a price flipping in and out of the range moves every time it is out', () => {
    // the price flips 20% each minute for a day and a bit: every other minute ends outside the range
    const ticks = Array.from({ length: 1500 }, (_, i) => (i % 2 ? T + 2000 : T));
    const r = replayLp(minutes(ticks, 1e-6), POOL, { ...BASE, bandPct: 0.05, rerange: true });
    expect(r.moves).toBe(1499); // each minute ends 20% from the last move's centre
  });

  it('a swap over the price-impact cap holds the move back, counted once per stretch out of range', () => {
    // a deep pool at the open, then almost no liquidity where the price went
    const rows = minutes(away, 1e-9, 1e12);
    rows[0] = { ...rows[0], liq: 1e24 };
    const r = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: true, maxImpact: 0.03 });
    expect(r.moves).toBe(0);
    expect(r.blocked).toBe(1);
  });

  it('the price leaving a narrow range and coming back: moving locks in the coin mix, staying gets it back', () => {
    // up 3% for 3 hours (out of a ±1% range), then back to the start, with trading throughout
    // with fees of a few dollars a day on $1,000 (about what the Robinhood pool paid a ±1% range)
    const ticks = [T, ...repeat(T, 60), ...repeat(T + 296, 180), ...repeat(T, 240)];
    const move = replayLp(minutes(ticks, 1e-12), POOL, { ...BASE, bandPct: 0.01, rerange: true });
    const stay = replayLp(minutes(ticks, 1e-12), POOL, { ...BASE, bandPct: 0.01, rerange: false });
    expect(move.moves).toBe(2); // up, then back down
    expect(stay.moves).toBe(0);
    // staying is back to its opening coins (plus fees): nothing lost; moving sold on the way up and bought back higher
    expect(stay.moveLoss).toBe(0);
    expect(move.moveLoss).toBeGreaterThan(1); // real money on $1,000
    expect(move.net).toBeCloseTo(move.fees - move.gas - move.swapCost - move.moveLoss, 9);
    expect(move.net).toBeLessThan(stay.net);
  });

  it('pays gas and swap costs on every open', () => {
    const r = replayLp(minutes(away), POOL, { ...BASE, bandPct: 0.05, rerange: true, gasOpen: 0.5, gasMove: 0.25 });
    expect(r.moves).toBe(1);
    expect(r.gas).toBeCloseTo(0.75, 9);
    expect(r.swapCost).toBeGreaterThan(1000 * 0.4 * 1e-4); // the opening swap of about half the capital, at least its pool fee
  });

  it('refuses inputs it cannot replay', () => {
    expect(() => replayLp(minutes([T]), POOL, { ...BASE, bandPct: 0.05, rerange: true })).toThrow(/2 minutes/);
    expect(() => replayLp(minutes([T, T]), POOL, { ...BASE, bandPct: 0, rerange: true })).toThrow(/bad range/);
    expect(() => replayLp(minutes([T, T]), POOL, { ...BASE, capital: 1, gasOpen: 2, bandPct: 0.05, rerange: true })).toThrow(/costs more/);
  });
});

describe('positionFor: a position opened now', () => {
  it('holds coins worth the money put in, and a narrower range is more liquidity for the same money', () => {
    const price = sqrtPriceAt(T) ** 2 * 1e12;
    const wide = positionFor(1000, 0.2, T, POOL), narrow = positionFor(1000, 0.02, T, POOL);
    for (const x of [wide, narrow]) expect((x.coins.base * price + x.coins.quote) / 1000).toBeCloseTo(1, 3);
    expect(narrow.L / wide.L).toBeGreaterThan(5);
    // double the money, double the liquidity
    expect(positionFor(2000, 0.02, T, POOL).L / narrow.L).toBeCloseTo(2, 6);
  });
});

describe('replayTable', () => {
  it('each range with moves on and off', () => {
    const tab = replayTable(minutes(repeat(T, 1440)), POOL, BASE, [0.02, 0.05]);
    expect(tab.map((r) => [r.bandPct, r.rerange])).toEqual([[0.02, true], [0.02, false], [0.05, true], [0.05, false]]);
    // the price never moves: narrower earns more (more liquidity for the same money), nothing is lost to moves
    expect(tab[0].fees).toBeGreaterThan(tab[2].fees);
    for (const r of tab) expect(r.moveLoss).toBe(0);
  });
});
