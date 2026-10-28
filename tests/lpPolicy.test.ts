import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { atr } from '../src/market/indicators';
import { EMPTY_POLICY, LpPolicyFields, optionalPayload } from '../src/ui/LpPolicyFields';
import {
  DEFAULT_COMPOUND_POLICY, DEFAULT_RANGE_POLICY, LP_PRESET_A, LP_PRESET_B, checkCompoundPolicy, checkRangePolicy,
  decideCompound, decideRangeMove, effectiveBand, feePace, toEdgeFrac,
} from '../src/market/lpPolicy';

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
  const base = { price: 100, lower: 90, upper: 110, policy: DEFAULT_RANGE_POLICY };
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

  it('a default policy never asks for a cost quote', () => {
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
    const policy = { ...DEFAULT_RANGE_POLICY, dwellMin: 30 };
    const first = decideRangeMove({ ...edge, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(first).toMatchObject({ move: false, wait: 'dwell', outSince: 0 });
    const early = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 29 * 60_000, rerange: true, policy });
    expect(early.move).toBe(false);
    const due = decideRangeMove({ ...edge, tickOut: true, outSince: 0, now: 30 * 60_000, rerange: true, policy });
    expect(due).toMatchObject({ move: true, wait: null });
  });

  it('coming back inside clears the dwell clock', () => {
    const policy = { ...DEFAULT_RANGE_POLICY, dwellMin: 30 };
    const back = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: false, outSince: 0, now: 10 * 60_000, rerange: true, policy });
    expect(back).toMatchObject({ move: false, outSince: null, wait: 'in' });
  });

  it('a buffer keeps a price that is outside the ticks but not past the buffer', () => {
    const policy = { ...DEFAULT_RANGE_POLICY, bufferPct: 0.02 };
    // 110 * 1.02 = 112.2. 111 is out of the ticks (the caller says so) but inside the buffer.
    const held = decideRangeMove({ price: 111, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(held).toMatchObject({ move: false, wait: 'buffer', outSince: null });
    const past = decideRangeMove({ price: 113, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy });
    expect(past.move).toBe(true);
  });

  it('buffer 0 does not consult price, so a tick-out still moves even if the price looks inside', () => {
    const d = decideRangeMove({ price: 100, lower: 90, upper: 110, tickOut: true, outSince: null, now: 0, rerange: true, policy: DEFAULT_RANGE_POLICY });
    expect(d.move).toBe(true);
  });

  it('the cost check asks for a quote, then moves only when the fees would pay for it', () => {
    const policy = { ...DEFAULT_RANGE_POLICY, costCheck: true, feeHorizonH: 24 };
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
    const d = decideRangeMove({ ...edge, tickOut: true, outSince: null, now: 60 * 60_000, rerange: false, policy: { ...DEFAULT_RANGE_POLICY, dwellMin: 1 } });
    expect(d).toMatchObject({ move: false, wait: 'off' });
  });

  it('near-edge is the outer fraction of the centre-to-edge distance, and only while inside', () => {
    expect(toEdgeFrac(100, 90, 110)).toBeCloseTo(1, 9);
    expect(toEdgeFrac(110, 90, 110)).toBeCloseTo(0, 9);
    expect(toEdgeFrac(108, 90, 110)).toBeCloseTo(0.2, 9); // 80% of the way to the upper edge
    const policy = { ...DEFAULT_RANGE_POLICY, nearEdgeFrac: 0.2 };
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
    const policy = { ...DEFAULT_RANGE_POLICY, costCheck: true, feeHorizonH: 24 };
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
    expect(decideCompound(1e9, 1, DEFAULT_COMPOUND_POLICY)).toEqual({ compound: false, need: Infinity });
  });

  it('compounds at the multiple and not below it', () => {
    const on = { enabled: true, gasMultiple: 10 };
    expect(decideCompound(100, 10, on)).toMatchObject({ compound: true, need: 100 });
    expect(decideCompound(99.99, 10, on).compound).toBe(false);
    expect(decideCompound(0, 10, on).compound).toBe(false);
  });
});

describe('cooldown and the named presets', () => {
  const edge = { price: 120, lower: 90, upper: 110, tickOut: true, rerange: true };

  it('the first move is not held, and the next one waits out the cooldown', () => {
    const policy = { ...DEFAULT_RANGE_POLICY, cooldownMin: 60 };
    const first = decideRangeMove({ ...edge, outSince: null, lastMoveAt: null, now: 0, policy });
    expect(first.move).toBe(true);
    const held = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 59 * 60_000, policy });
    expect(held).toMatchObject({ move: false, wait: 'cooldown' });
    const due = decideRangeMove({ ...edge, outSince: 0, lastMoveAt: 0, now: 60 * 60_000, policy });
    expect(due.move).toBe(true);
  });

  it('dwell is reported while it is still running, then the cooldown', () => {
    const policy = { ...DEFAULT_RANGE_POLICY, dwellMin: 12 * 60, cooldownMin: 24 * 60 };
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
    expect(optionalPayload(draft).range).toMatchObject({ dwellMin: 12 * 60, cooldownMin: 24 * 60, bufferPct: 0, atrMult: 0, costCheck: false });
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
    expect(checkCompoundPolicy({})).toEqual(DEFAULT_COMPOUND_POLICY);
    expect(checkRangePolicy({ dwellMin: 30 }).cooldownMin).toBe(0);
    expect(() => checkRangePolicy({ dwellMin: -1 })).toThrow(/Dwell/);
    expect(() => checkRangePolicy({ cooldownMin: 20_000 })).toThrow(/Cooldown/);
    expect(() => checkRangePolicy({ bufferPct: 0.2 })).toThrow(/buffer/);
    expect(() => checkCompoundPolicy({ gasMultiple: 0 })).toThrow(/multiple/);
  });
});
