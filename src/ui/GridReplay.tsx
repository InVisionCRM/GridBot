/**
 * New bot → Grid: what each range width × level count, and the range typed in the form, would have earned on the pool's
 * real trades over the last day, 7, 30 or 365 days (server: /api/grid/replay, market/gridReplay.ts). Earned is units:
 * completed round trips after every cost, in the quote coin. Tap a row to put that range around today's price.
 */
import type { GridReplayRow } from '../market/gridReplay';
import { L, Tip } from './Tip';
import { cls, num, pct, qty, time } from './fmt';
import { Usd } from './money';
import { ReplayFrame, youngNote, type Days } from './ReplayWindow';

type Ready = { days: Days; from: number; to: number; trades: number; capital: number; base: string; quote: string; spot: number; yoursNote: string | null; rows: GridReplayRow[] };

/** A row's range around today's price, as the form takes it */
export const rangeAround = (spot: number, r: Pick<GridReplayRow, 'below' | 'above'>) => ({ lower: +(spot * (1 - r.below)).toPrecision(5), upper: +(spot * (1 + r.above)).toPrecision(5) });
const width = (r: GridReplayRow) => (Math.abs(r.below - r.above) < 1e-9 ? `±${num(r.below * 100, 1)}%` : `−${num(r.below * 100, 1)}% / +${num(r.above * 100, 1)}%`);

export function GridReplay({ pair, capital, lower, upper, levels, usdPer, onPick }: {
  pair: string; capital: number; lower: number; upper: number; levels: number; usdPer: number | null;
  onPick: (lower: number, upper: number, levels: number) => void;
}) {
  const params: Record<string, string> = { market: pair };
  if (capital > 0) params.capital = String(capital);
  if (lower > 0 && upper > lower && levels >= 2) Object.assign(params, { lower: String(lower), upper: String(upper), levels: String(levels) });
  return (
    <ReplayFrame<Ready> title={(w) => `What the grid would have earned over ${w}`} path="/api/grid/replay" params={params}
      ready={(a) => <GridReady a={a} usdPer={usdPer} onPick={onPick} />} />
  );
}

export function GridReady({ a, usdPer, onPick }: { a: Ready; usdPer: number | null; onPick: (lower: number, upper: number, levels: number) => void }) {
  const q = a.quote, b = a.base;
  const best = a.rows.reduce((x, r) => (r.earned > x.earned ? r : x), a.rows[0]);
  const days = a.rows[0]?.days ?? 0;
  const pick = (r: GridReplayRow) => { const g = rangeAround(a.spot, r); onPick(g.lower, g.upper, r.levels); };
  return (
    <>
      <p className="muted small">
        {num(a.trades, 0)} real trades from {time(a.from * 1000)} to {time(a.to * 1000)}, replayed with {qty(a.capital, q, 4, false)} and the grid's own
        rules: the levels, the start-up buy, reinvesting, and the pool fee, price impact and gas at today's pool depth and gas price.
        Each range is placed around the price at the start; tap a row to put the same range around today's price.
        Earned is the completed round trips after every cost, in {q}. Coins still held at the end (levels bought and not sold
        yet) are shown, not counted, like the price itself.{youngNote(a)}
      </p>
      {a.yoursNote && <p className="small muted">{a.yoursNote}</p>}
      <div className="table-wrap tall"><table className="replay-table">
        <thead><tr>
          <th>Range</th>
          <th>Levels</th>
          <th>Earned <Tip>Completed round trips (bought at a level, sold one level up) after the pool fee, price impact and gas, in {q}. The ★ row earned the most.</Tip></th>
          <th>Per day</th>
          <th className="narrow-hide">Round trips</th>
          <th className="narrow-hide">In range <Tip>Share of the time the price was between the lowest and highest level.</Tip></th>
          <th className="narrow-hide">Held at the end <Tip>Coins bought at levels the price never came back up to, and what they cost. Not in Earned: what they are worth depends on the price.</Tip></th>
        </tr></thead>
        <tbody>{a.rows.map((r, i) => (
          <tr key={i} className={`pickable ${r.yours ? 'selected' : ''}`} onClick={() => pick(r)} title="Use this range around today's price">
            <td>{width(r)}{r.yours ? <span className="tag">yours</span> : null}{r === best ? <span className="best-mark" title="Earned the most here"> ★</span> : null}</td>
            <td>{r.levels}</td>
            <td className={cls(r.earned)}>{qty(r.earned, q, 4)}</td>
            <td className={cls(r.earned)}>{qty(days > 0 ? r.earned / days : 0, q, 3)}</td>
            <td className="narrow-hide">{r.roundTrips}</td>
            <td className="narrow-hide">{pct(r.inRange, 0)}</td>
            <td className="narrow-hide txt">{r.held ? <L tip={`Cost ${qty(r.held.cost, q, 4, false)}`}>{qty(r.held.base, b, 4, false)}</L> : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">
        Best here: {width(best)}, {best.levels} levels, {qty(best.earned, q, 4)}<Usd v={best.earned} k={usdPer} />. Past trades don't promise future
        ones: a quiet week earns less, and a strong trend leaves the grid holding coins or all sold.
      </p>
    </>
  );
}
