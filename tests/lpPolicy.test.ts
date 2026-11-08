import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { atr } from '../src/market/indicators';
import { EMPTY_POLICY, LpPolicyFields, optionalPayload } from '../src/ui/LpPolicyFields';
import {
  DEFAULT_COMPOUND_POLICY, DEFAULT_RANGE_POLICY, LP_PRESET_A, LP_PRESET_B, checkRangePolicy, compoundPolicy,
  decideCompound, decideRangeMove, effectiveBand, feePace, toEdgeFrac, type LpCompoundPolicy,
} from '../src/market/lpPolicy';

/** The defaults without the cost check (on since 2026-11-08): the bare move rule the mechanics tests are about. */
const NO_COST = { ...DEFAULT_RANGE_POLICY, costCheck: false };

/**
 * The rule the engine used before these gates: the first tick outside the range moves,
 * and a tick back inside clears the clock. The price-impact cap sits outside this decision.
 */
function legacyMove(tickOut: boolean, outSince: number | null, now: number, rerange: boolean) {
  if (!tickOut) return { move: false, outSince: null as number | null };
  const since = outSince ?? now;
  if (!rerange) return { move: false, outSince: since };
  return { move: true, outSince: since };
}

describe('decideRangeMove defaults reproduce the current rule', () => {
  const base = { price: 100, lower: 90, upper: 110, policy: NO_COST };
  const cases: { tickOut: boolean; outSince: number | null; now: number; rerange: boolean }[] = [
    { tickOut: false, outSince: null, now: 1_000, rerange: true },
    { tickOut: false, outSince: 500, now: 5_000, rerange: true },
    { tickOut: false, outSince: 500, now: 5_000, rerange: false },
    { tickOut: true, outSince: null, now: 1_000, rerange: true },
    { tickOut: true, outSince: 1_000, now: 1_000, rerange: true },
    { tickOut: true, outSince: 1_000, now: 9_000_000, rerange: true },
    { tickOut: true, outSince: null, now: 4_000, rerange: false },
    { tickOut: true, outSince: 100, now: 4_000, rerange: false },
  ];
  it.each(cases)('tickOut=$tickOut rerange=$rerange', (c) => {
    const d = decideRangeMove({ ...base, ...c });
    expect({ move: d.move, outSince: d.outSince }).toEqual(legacyMove(c.tickOut, c.outSince, c.now, c.rerange));
    expect(d.nearEdge).toBe(false);
  });

  it('without the cost check a tick-out moves at once, no quote asked', () => {
    const d = decideRangeMove({ ...base, tickOut: true, outSince: null, now: 1, rerange: true });
    expect(d.wait).toBeNull();
    expect(d.move).toBe(true);
  });

  it('a recent move does not hold the next one when cooldown is 0', () => {
    const d = decideRangeMove({ ...base, tickOut: true, outSince: null, lastMoveAt: 5_000, now: 5_000, rerange: true });
    expect(d.move).toBe(true);
    expect(d.wait).toBeNull();
  });
});

describe('dwell, buffer, cost check, near edge', () => {
  const edge = { price: 120, lower: 90, upper: 110 };

  it('dwell 30 minutes does not move on the first reading, and does at 30 minutes', () => {
    const policy = { ...NO_COST, dwellMin: 30 };
    const first = decideRangeMove({ ...edge, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(first).toMatchObject({ move: false, wait: 'dwell', outSince: 0 });
    const early = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 29 * 60_000, rerange: true, policy });
    expect(early.move).toBe(false);
    const due = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 30 * 60_000, rerange: true, policy });
    expect(due).toMatchObject({ move: true, wait: null });
  });

  it('coming back inside clears the dwell clock', () => {
    const policy = { ...NO_COST, dwellMin: 30 };
    const back = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: false, outSince: 0, now: 10 * 60_000, rerange: true, policy });
    expect(back).toMatchObject({ move: false, outSince: null, wait: 'in' });
  });

  it('a buffer keeps a price that is outside the ticks but not past the buffer', () => {
    const policy = { ...NO_COST, bufferPct: 0.02 };
    // 110 * 1.02 = 112.2. 111 is out of the ticks (the caller says so) but inside the buffer.
    const held = decideRangeMove({ price: 111, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(held).toMatchObject({ move: false, wait: 'buffer', outSince: null });
    const past = decideRangeMove({ price: 113, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(past.move).toBe(true);
  });

  it('buffer 0 does not consult price, so a tick-out still moves even if the price looks inside', () => {
    const d = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy: NO_COST });
    expect(d.move).toBe(true);
  });

  it('the default policy has the cost check on: a tick-out asks for a quote instead of moving (Kyle 2026-11-08)', () => {
    expect(DEFAULT_RANGE_POLICY.costCheck).toBe(true);
    const d = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy: DEFAULT_RANGE_POLICY });
    expect(d).toMatchObject({ move: false, wait: 'need-cost' });
  });

  it('the horizon is how long ranges have lasted here, not a day: a 21-minute life blocks a move a 24-hour horizon would allow', () => {
    const i = { price: 100, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy: DEFAULT_RANGE_POLICY, moveCost: 0.014, feePerHour: 0.012 };
    expect(decideRangeMove({ ...i, horizonH: null }).move).toBe(true); // 0.012 × 24 h = 0.29 > 0.014
    expect(decideRangeMove({ ...i, horizonH: 21 / 60 })).toMatchObject({ move: false, wait: 'cost' }); // 0.012 × 0.35 h = 0.004 < 0.014
  });

  it("a losing streak holds every move: the last 24 hours' moves lost money together", () => {
    const d = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy: NO_COST, losingStreak: true });
    expect(d).toMatchObject({ move: false, wait: 'losing' });
  });

  it('the cost check asks for a quote, then moves only when the fees would pay for it', () => {
    const policy = { ...NO_COST, costCheck: true, feeHorizonH: 24 };
    const ask = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 0, rerange: true, policy });
    expect(ask).toMatchObject({ move: false, wait: 'need-cost' });
    const poor = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 0, rerange: true, policy, moveCost: 10, feePerHour: 0.1 });
    expect(poor).toMatchObject({ move: false, wait: 'cost' }); // 0.1 * 24 = 2.4 < 10
    const rich = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 0, rerange: true, policy, moveCost: 10, feePerHour: 1 });
    expect(rich.move).toBe(true); // 24 > 10
    const unknown = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 0, rerange: true, policy, moveCost: null, feePerHour: 1 });
    expect(unknown.wait).toBe('cost');
  });

  it('auto-move off still waits, gates or not', () => {
    const d = decideRangeMove({ ...edge, tickOut: true, outSince: null, now: 60 * 60_000, rerange: false, policy: { ...NO_COST, dwellMin: 1 } });
    expect(d).toMatchObject({ move: false, wait: 'off' });
  });

  it('near-edge is the outer fraction of the centre-to-edge distance, and only while inside', () => {
    expect(toEdgeFrac(100, 90, 110)).toBeCloseTo(1, 9);
    expect(toEdgeFrac(110, 90, 110)).toBeCloseTo(0, 9);
    expect(toEdgeFrac(108, 90, 110)).toBeCloseTo(0.2, 9); // 80% of the way to the upper edge
    const policy = { ...NO_COST, nearEdgeFrac: 0.2 };
    const near = decideRangeMove({ price: 108, lower: 90, upper: 110, tickOut: false, outSince: null, now: 0, rerange: true, policy });
    expect(near.nearEdge).toBe(true);
    const mid = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: false, outSince: null, now: 0, rerange: true, policy });
    expect(mid.nearEdge).toBe(false);
    const outside = decideRangeMove({ price: 120, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(outside.nearEdge).toBe(false);
  });
});

describe('effectiveBand and fee pace', () => {
  it('ATR multiple 0 returns the configured band unchanged, even outside the usual clamp', () => {
    expect(effectiveBand(0.01, 5, 100, 0)).toBe(0.01);
    expect(effectiveBand(0.2, null, 100, 0)).toBe(0.2);
  });

  it('ATR widens up to the bot maximum and never narrows below the configured band', () => {
    expect(effectiveBand(0.01, 4, 100, 2)).toBeCloseTo(0.08, 9); // 2 * 4 / 100
    expect(effectiveBand(0.1, 1, 100, 2)).toBe(0.1); // ATR would be 2%, configured is wider
    expect(effectiveBand(0.01, 80, 100, 2)).toBe(0.5); // clamped
    expect(effectiveBand(0.01, null, 100, 2)).toBe(0.01);
  });

  it('uses Wilder ATR from indicators.ts', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i }));
    const series = atr(bars, 14);
    const last = series[series.length - 1]!;
    expect(last).toBeGreaterThan(0);
    expect(effectiveBand(0.01, last, 110, 1)).toBeCloseTo(Math.max(0.01, last / 110), 9);
  });

  it('a pace younger than 10 minutes is not a pace', () => {
    expect(feePace(10, 9 * 60_000)).toBeNull();
    expect(feePace(10, 10 * 60_000)).toBeCloseTo(10 / (10 / 60), 9);
  });

  it('the cost check keeps the in-range pace while the position sits outside', () => {
    const policy = { ...NO_COST, costCheck: true, feeHorizonH: 24 };
    const earned = 12;
    const inRange = 2 * 3_600_000;
    const pace = feePace(earned, inRange)!;
    expect(pace).toBeCloseTo(6, 9);
    const moveCost = pace * 24 * 0.9;
    const edge = { price: 120, lower: 90, upper: 110, tickOut: true, outSince: 0, now: 0, rerange: true, policy, moveCost };
    expect(decideRangeMove({ ...edge, feePerHour: pace }).move).toBe(true);
    const aged = feePace(earned, inRange + 10 * 24 * 3_600_000)!;
    expect(aged * 24).toBeLessThan(moveCost);
    expect(decideRangeMove({ ...edge, feePerHour: aged }).move).toBe(false);
    expect(decideRangeMove({ ...edge, now: 10 * 24 * 3_600_000, feePerHour: pace }).move).toBe(true);
  });
});

describe('decideCompound', () => {
  it('is off by default, whatever the fees are', () => {
    expect(decideCompound(1e9, 1, 1e6, DEFAULT_COMPOUND_POLICY)).toEqual({ compound: false, need: Infinity });
  });

  it('waits for √(2 × gas × position value): Kyle\'s ETH/USDG (0.023 USDG gas, 2,250 USDG) waits for about 10 USDG, not 0.23', () => {
    const on = { enabled: true };
    const need = Math.sqrt(2 * 0.023 * 2250);
    expect(need).toBeCloseTo(10.17, 2);
    // 0.23 USDG is what "10 × gas" compounded at: 317 times in 49 h on Robinhood
    expect(decideCompound(0.23, 0.023, 2250, on)).toEqual({ compound: false, need });
    expect(decideCompound(need - 1e-9, 0.023, 2250, on).compound).toBe(false);
    expect(decideCompound(need, 0.023, 2250, on).compound).toBe(true);
    expect(decideCompound(0, 0, 2250, on).compound).toBe(false);
  });

  it('a bigger position or dearer gas waits for more fees', () => {
    const on = { enabled: true };
    expect(decideCompound(1, 1, 400, on).need).toBe(Math.sqrt(800));
    expect(decideCompound(1, 1, 1600, on).need).toBe(Math.sqrt(3200));
    expect(decideCompound(1, 4, 400, on).need).toBe(Math.sqrt(3200));
  });

  it('a gas or position value that is not a number is an error, not a compound', () => {
    expect(() => decideCompound(1, NaN, 100, { enabled: true })).toThrow(/gas NaN/);
    expect(() => decideCompound(1, 1, NaN, { enabled: true })).toThrow(/position value NaN/);
  });
});

describe('cooldown and the named presets', () => {
  const edge = { price: 120, lower: 90, upper: 110, tickOut: true, rerange: true };

  it('the first move is not held, and the next one waits out the cooldown', () => {
    const policy = { ...NO_COST, cooldownMin: 60 };
    const first = decideRangeMove({ ...edge, outSince: null, lastMoveAt: null, now: 0, policy });
    expect(first.move).toBe(true);
    const held = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 59 * 60_000, policy });
    expect(held).toMatchObject({ move: false, wait: 'cooldown' });
    const due = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 60 * 60_000, policy });
    expect(due.move).toBe(true);
  });

  it('dwell is reported while it is still running, then the cooldown', () => {
    const policy = { ...NO_COST, dwellMin: 12 * 60, cooldownMin: 24 * 60 };
    const dwelling = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 11 * 60 * 60_000, policy });
    expect(dwelling.wait).toBe('dwell');
    const cooling = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 12 * 60 * 60_000, policy });
    expect(cooling.wait).toBe('cooldown');
    const due = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 24 * 60 * 60_000, policy });
    expect(due.move).toBe(true);
  });

  it('an empty form omits the new fields, and a preset fills dwell, cooldown and width', () => {
    expect(optionalPayload(EMPTY_POLICY)).toEqual({});
    const draft = { ...EMPTY_POLICY, dwellMin: String(LP_PRESET_A.dwellMin), cooldownMin: String(LP_PRESET_A.cooldownMin) };
    expect(optionalPayload(draft).range).toMatchObject({ dwellMin: 12 * 60, cooldownMin: 24 * 60, bufferPct: 0, atrMult: 0, costCheck: true });
    expect(optionalPayload(draft).compound).toBeUndefined();
    const html = renderToStaticMarkup(createElement(LpPolicyFields, { d: EMPTY_POLICY, set: () => {}, onPreset: () => {} }));
    expect(html).toContain('Preset A · ±2% · 12h outside · 24h cooldown');
    expect(html).toContain('Preset B · ±3% · 4h outside · 12h cooldown');
    expect(html.toLowerCase()).not.toContain('recommend');
  });

  it('names two presets and does not treat either as a default', () => {
    expect(LP_PRESET_A).toMatchObject({ id: 'a', bandPct: 0.02, dwellMin: 12 * 60, cooldownMin: 24 * 60 });
    expect(LP_PRESET_B).toMatchObject({ id: 'b', bandPct: 0.03, dwellMin: 4 * 60, cooldownMin: 12 * 60 });
    expect(DEFAULT_RANGE_POLICY.dwellMin).toBe(0);
    expect(DEFAULT_RANGE_POLICY.cooldownMin).toBe(0);
    expect(LP_PRESET_A.label + LP_PRESET_B.label).not.toMatch(/recommend/i);
  });
});

describe('policy checks', () => {
  it('fills defaults for an empty edit and rejects a bad one', () => {
    expect(checkRangePolicy({})).toEqual(DEFAULT_RANGE_POLICY);
    expect(compoundPolicy({})).toEqual(DEFAULT_COMPOUND_POLICY);
    expect(checkRangePolicy({ dwellMin: 30 }).cooldownMin).toBe(0);
    expect(() => checkRangePolicy({ dwellMin: -1 })).toThrow(/Dwell/);
    expect(() => checkRangePolicy({ cooldownMin: 20_000 })).toThrow(/Cooldown/);
    expect(() => checkRangePolicy({ bufferPct: 0.2 })).toThrow(/buffer/);
    // a bot saved with the old gas multiple keeps only on/off
    expect(compoundPolicy({ enabled: true, gasMultiple: 10 } as Partial<LpCompoundPolicy>)).toEqual({ enabled: true });
  });
});
