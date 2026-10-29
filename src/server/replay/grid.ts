/**
 * The grid replay behind New bot → Grid: the market's pool history (V2 or V3, ReplayPools) through gridReplayTable at
 * today's pool fee, depth and gas price (the same cost model as Tools → Backtest), over a window of 1, 7, 30 or 365 days,
 * for each range width × level count around the window's first price and the range typed in the form.
 */
import { gridReplayTable, gridSettings, type GridReplayRow, type GridSetting } from '../../market/gridReplay';
import { costModelOf } from '../bot/econ';
import type { Hub } from '../chains/hub';
import { DEFAULT_DAYS, type ReplayDays } from '../lp/poolHistory';
import { REPLAY_USD } from '../lp/replay';
import { REFRESH_MS, type ReplayPools, type WaitAnswer } from './pools';

export type GridReplayAnswer =
  | WaitAnswer
  | {
    state: 'ready'; days: ReplayDays; from: number; to: number; trades: number; capital: number; base: string; quote: string;
    /** Today's price (quote per base): a row's range around it is what "use it" puts in the form */
    spot: number;
    /** Why the form's own range has no row (it must hold today's price), null when it has one or none was given */
    yoursNote: string | null;
    rows: GridReplayRow[];
  };

/** The form's range as fractions below and above today's price, or why it can't be replayed. */
export function yoursOf(spot: number, f: { lower?: number; upper?: number; levels?: number }): { setting: GridSetting | null; note: string | null } {
  if (f.lower == null || f.upper == null || f.levels == null) return { setting: null, note: null };
  if (!(f.lower > 0 && f.upper > f.lower && Number.isInteger(f.levels) && f.levels >= 2)) return { setting: null, note: 'Your range needs a low under the high and at least 2 levels to be replayed.' };
  if (!(f.lower < spot && spot < f.upper)) return { setting: null, note: 'Your range doesn\'t hold today\'s price, so it can\'t be replayed around the first price of the window.' };
  return { setting: { below: 1 - f.lower / spot, above: f.upper / spot - 1, levels: f.levels }, note: null };
}

export class GridReplay {
  /** The last answer per market and window, kept while the history and the inputs are the same and REFRESH_MS has not passed */
  private answers = new Map<string, { key: string; at: number; answer: GridReplayAnswer }>();
  constructor(private readonly hub: Hub, private readonly pools: ReplayPools, private readonly approval: 'exact' | 'max', private readonly now: () => number = Date.now) {}

  async replay(q: { market: string; capital?: number; days?: ReplayDays; lower?: number; upper?: number; levels?: number }): Promise<GridReplayAnswer> {
    const days = q.days ?? DEFAULT_DAYS;
    const def = this.hub.def(q.market);
    const { h } = await this.pools.history(q.market);
    const w = this.pools.window(h, days, `${def.base.symbol}/${def.quote.symbol}`);
    if (!('rows' in w)) return w;
    const rows = w.rows, last = rows[rows.length - 1];

    const slot = `${q.market}|${days}`, key = `${q.capital ?? ''}|${q.lower ?? ''}|${q.upper ?? ''}|${q.levels ?? ''}|${rows.length}|${last.t}|${last.n}`;
    const kept = this.answers.get(slot);
    if (kept && kept.key === key && this.now() - kept.at < REFRESH_MS) return kept.answer;

    const snap = await this.hub.quoter(q.market).market();
    const usd = this.hub.usdPerQuote(q.market);
    const capital = q.capital ?? (usd ? REPLAY_USD / usd : null);
    if (!(capital != null && capital > 0)) throw new Error(`no price for ${def.quote.symbol}: enter an amount`);
    const yours = yoursOf(snap.spot, q);
    const table = await gridReplayTable(rows, await this.pools.sides(q.market), capital, costModelOf(snap, def.pool.feeBps, this.approval), gridSettings(yours.setting));
    const answer: GridReplayAnswer = {
      state: 'ready', days, from: rows[0].t, to: last.t, trades: rows.reduce((a, m) => a + m.n, 0), capital,
      base: def.base.symbol, quote: def.quote.symbol, spot: snap.spot, yoursNote: yours.note, rows: table,
    };
    this.answers.set(slot, { key, at: this.now(), answer });
    return answer;
  }
}
