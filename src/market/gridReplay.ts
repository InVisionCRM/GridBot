/**
 * Grid replay (pure): a pool's real trades (poolHistory minutes, as 1-minute prices) through the live grid's own rules
 * (runGridBacktest: levels, the start-up buy, reinvesting, pool fee, price impact and gas from the cost model), for
 * several range widths × level counts around the window's first price, and the setting typed in the form.
 *
 * Earned is units: the completed round trips after every cost, in the quote coin. Coins still held at the end (levels
 * bought and not sold yet) are shown, not counted, like the coins' own price move.
 */
import { runGridBacktest, type BtResult } from './backtest';
import type { CostModel } from './costs';
import { minuteBars, type PoolMinute } from './lpReplay';
import type { PoolSides } from '../live/v3Liquidity';

/** Ranges tried, ± around the first price, and level counts */
export const GRID_WIDTHS = [0.02, 0.05, 0.1, 0.2, 0.3];
export const GRID_LEVELS = [10, 20, 40];

/** A range as fractions below and above the first price, and its level count; `yours` marks the form's own setting */
export interface GridSetting { below: number; above: number; levels: number; yours?: boolean }

export interface GridReplayRow extends GridSetting {
  yours: boolean;
  days: number;
  /** Completed round trips after pool fees, impact and gas, quote */
  earned: number;
  roundTrips: number;
  /** Paid on every swap of the run (the buys of coins still held too), quote: pool fees + impact + slippage, and gas */
  fees: number; gas: number;
  /** Share of the minutes the price closed inside the range */
  inRange: number;
  /** Coins still held at the end and what they cost (quote); null when every level sold */
  held: { base: number; cost: number } | null;
  lower: number; upper: number;
  priceStart: number; priceEnd: number;
}

/** The ranges tried (each width × each level count), the form's setting first when it is given. */
export function gridSettings(yours: GridSetting | null): GridSetting[] {
  const tried = GRID_WIDTHS.flatMap((w) => GRID_LEVELS.map((levels) => ({ below: w, above: w, levels })));
  return yours ? [{ ...yours, yours: true }, ...tried] : tried;
}

/** One replay per setting, the event loop let through between them (a year of minutes is a few hundred ms a run). */
export async function gridReplayTable(rows: PoolMinute[], pool: PoolSides, capital: number, costs: CostModel, settings: GridSetting[]): Promise<GridReplayRow[]> {
  if (rows.length < 2) throw new Error('need at least 2 minutes of trades');
  if (!(capital > 0)) throw new Error('capital must be > 0');
  const bars = minuteBars(rows, pool);
  const p0 = bars[0].o, last = bars[bars.length - 1];
  const days = (last.t - bars[0].t) / 86_400;
  const out: GridReplayRow[] = [];
  for (const s of settings) {
    if (!(s.below > 0 && s.below < 1 && s.above > 0)) throw new Error(`bad range −${s.below} / +${s.above}`);
    const lower = p0 * (1 - s.below), upper = p0 * (1 + s.above);
    const r: BtResult = runGridBacktest(bars, { lowerPrice: lower, upperPrice: upper, gridCount: s.levels, capital }, '1m', costs);
    const m = r.metrics;
    out.push({
      ...s, yours: s.yours === true, days,
      earned: m.earned, roundTrips: r.trades.length, fees: m.fees + m.impact + m.slippage, gas: m.gas,
      inRange: bars.filter((b) => b.c >= lower && b.c <= upper).length / bars.length,
      held: r.open ? { base: r.open.pls, cost: r.open.cost } : null,
      lower, upper, priceStart: p0, priceEnd: last.c,
    });
    await new Promise((res) => setTimeout(res, 0));
  }
  return out;
}
