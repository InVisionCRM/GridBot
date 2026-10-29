import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE_POLICY } from '../src/market/lpPolicy';
import { replayLp, type PoolMinute, type ReplayOpts, type ReplayPool } from '../src/market/lpReplay';
import { formatEthReplay, runEthUsdgReplay } from '../src/market/ethUsdgReplay';

/** Same pool shape as the replay unit tests: base token0, 18/6, spacing 1, 0.01% swaps. */
const POOL: ReplayPool = { baseIs0: true, baseDecimals: 18, quoteDecimals: 6, spacing: 1, swapFee: 1e-4 };
const T = -200_000;
const T0 = 1_800_000_000;
const BASE: Omit<ReplayOpts, 'bandPct' | 'rerange'> = { capital: 1000, gasOpen: 0, gasMove: 0, maxImpact: 1 };
const minutes = (ticks: number[], f1 = 1e-9, liq = 1e24): PoolMinute[] =>
  ticks.map((c, i) => ({ t: T0 + i * 60, lo: c, hi: c, c, f0: 0, f1, liq, n: 1 }));
const repeat = (tick: number, n: number) => Array.from({ length: n }, () => tick);

describe('replay with an explicit default policy matches a replay with no policy', () => {
  const paths = [
    repeat(T, 80),
    [T, ...repeat(T + 2000, 40)],
    Array.from({ length: 60 }, (_, i) => (i % 2 ? T + 1500 : T)),
  ];
  it.each(paths.map((ticks, i) => [i, ticks] as const))('path %s', (_i, ticks) => {
    const opts = { ...BASE, bandPct: 0.05, rerange: true, gasMove: 0.01, gasOpen: 0.02 };
    const legacy = replayLp(minutes(ticks), POOL, opts);
    const explicit = replayLp(minutes(ticks), POOL, {
      ...opts,
      range: { ...DEFAULT_RANGE_POLICY },
      compound: { enabled: false, gasMultiple: 10 },
      gasCompound: 0.01,
    });
    expect(explicit.moves).toBe(legacy.moves);
    expect(explicit.fees).toBe(legacy.fees);
    expect(explicit.moveLoss).toBe(legacy.moveLoss);
    expect(explicit.gas).toBe(legacy.gas);
    expect(explicit.swapCost).toBe(legacy.swapCost);
    expect(explicit.net).toBe(legacy.net);
    expect(explicit.inRange).toBe(legacy.inRange);
    expect(explicit.blocked).toBe(legacy.blocked);
    expect(explicit.compounds).toBe(0);
    expect(legacy.compounds).toBe(0);
  });
});

describe('replay gates', () => {
  it('a short trip outside does not move when the dwell is longer than the trip', () => {
    const ticks = [T, ...repeat(T, 10), ...repeat(T + 2000, 5), ...repeat(T, 10)];
    const rows = minutes(ticks);
    const now = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: true });
    const dwell = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: true, range: { dwellMin: 30 } });
    // Out and back: today's rule moves twice. The dwell is longer than the trip, so it never moves.
    expect(now.moves).toBe(2);
    expect(dwell.moves).toBe(0);
    expect(dwell.moveLoss).toBe(0);
    expect(now.moveLoss).toBeGreaterThan(0);
  });

  it('a 0.3% buffer holds a close that is only just outside a ±1% range', () => {
    // ±1% is about ±100 ticks. +115 ticks is outside, and only ~0.15% past the edge.
    const ticks = [T, ...repeat(T, 5), ...repeat(T + 115, 3)];
    const rows = minutes(ticks);
    const now = replayLp(rows, POOL, { ...BASE, bandPct: 0.01, rerange: true });
    const buffered = replayLp(rows, POOL, { ...BASE, bandPct: 0.01, rerange: true, range: { bufferPct: 0.003 } });
    expect(now.moves).toBe(1);
    expect(buffered.moves).toBe(0);
  });

  it('a cooldown holds the move back after a range has just moved', () => {
    // ±1% is about ±100 ticks. +400 leaves, the range recentres, then +800 leaves again.
    const ticks = [T, T + 400, T + 400, T + 800];
    const rows = minutes(ticks);
    const now = replayLp(rows, POOL, { ...BASE, bandPct: 0.01, rerange: true });
    const cooled = replayLp(rows, POOL, { ...BASE, bandPct: 0.01, rerange: true, range: { cooldownMin: 30 } });
    expect(now.moves).toBe(2);
    expect(cooled.moves).toBe(1);
    expect(cooled.moveLoss).toBeLessThan(now.moveLoss);
  });

  it('compounds once waiting fees cover the gas multiple, without counting a move', () => {
    // Fees in both coins: an in-range position can only add liquidity when both sides are present.
    const rows = minutes(repeat(T, 30), 1e-9).map((m) => ({ ...m, f0: 1e-9 }));
    const off = replayLp(rows, POOL, { ...BASE, bandPct: 0.05, rerange: false });
    const on = replayLp(rows, POOL, {
      ...BASE, bandPct: 0.05, rerange: false, gasCompound: 0.01,
      compound: { enabled: true, gasMultiple: 10 },
    });
    expect(off.compounds).toBe(0);
    expect(off.moves).toBe(0);
    expect(on.moves).toBe(0);
    expect(on.compounds).toBeGreaterThan(0);
    expect(on.gas).toBeCloseTo(on.compounds * 0.01, 9);
    expect(on.fees).toBeGreaterThan(off.fees); // added liquidity earns more afterwards
  });
});

describe('synthetic seeded ETH/USDG fixture (not market data)', () => {
  const report = runEthUsdgReplay();
  const by = (name: string) => report.rows.find((r) => r.label.startsWith(name))!;

  it('leads with net quote and labels itself as a reconstruction', () => {
    const text = formatEthReplay(report);
    expect(text.split('\n')[0]).toBe('| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |');
    expect(text).toContain('Defaults');
    expect(text).toContain('Preset A');
    expect(text).toContain('Preset B');
    expect(text).toContain('Stay put');
    expect(text.toLowerCase()).not.toContain('recommend');
    expect(report.source).toMatch(/Synthetic test fixture/);
    expect(report.source).toMatch(/not the Robinhood swap tape/);
    expect(report.readme).toMatchObject({ moves: 23, fees: 70.38, moveLoss: 84.23, net: -16.22 });
    for (const r of report.rows) expect(r.net).toBeCloseTo(r.fees - r.gas - r.swapCost, 8);
  });

  it('locks the seeded path, and does not pick a preset', () => {
    const defaults = by('Defaults');
    const a = by('Preset A');
    const b = by('Preset B');
    const stay = by('Stay put');
    expect(defaults.moves).toBeGreaterThan(0);
    expect(stay.moves).toBe(0);
    expect(stay.moveLoss).toBe(0);
    // Locked from scripts/lpRangeReplay.ts on seed 20261026. Update both together if the path changes.
    expect(defaults.moves).toBe(34);
    expect(defaults.net).toBeCloseTo(21.838855101372637, 8); // move loss shown, not taken out
    expect(defaults.fees).toBeCloseTo(25.07681192444486, 8);
    expect(defaults.moveLoss).toBeCloseTo(258.5154298194676, 8);
    // The scheduled trips on this seed are shorter than either preset's dwell, so both stay put.
    expect(a.moves).toBe(0);
    expect(a.net).toBeCloseTo(13.795288364278656, 8);
    expect(a.fees).toBeCloseTo(13.893489003342983, 8);
    expect(b.moves).toBe(0);
    expect(b.net).toBeCloseTo(9.256867036507916, 8);
    expect(b.fees).toBeCloseTo(9.35481954983475, 8);
    expect(stay.fees).toBeCloseTo(27.235638179400578, 8);
    expect(stay.inRange).toBeCloseTo(0.9373035578783623, 8);
    expect(stay.net).toBeCloseTo(27.13719065509062, 8);
  });
});
