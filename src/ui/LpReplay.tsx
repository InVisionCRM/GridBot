/**
 * New bot → Liquidity: what each range, with and without moving, would have earned on the pool's real trades over the
 * last day, 7, 30 or 365 days (server: /api/lp/replay, market/lpReplay.ts), and the position it opens with today's
 * money: its coins and its share of the pool. It opens on 7 days; a longer window is read from the chain only when it is
 * picked. Click a row to use its settings.
 */
import type { ReplayRow } from '../market/lpReplay';
import { L, Tip } from './Tip';
import { cls, num, pct, qty, time } from './fmt';
import { Usd } from './money';
import { ReplayFrame, youngNote, type Days } from './ReplayWindow';

type Ready = { days: Days; from: number; to: number; swaps: number; capital: number; base: string; quote: string; gasMove: number; maxImpact: number; rows: ReplayRow[] };

export function LpReplay({ pair, capital, maxImpact, band, rerange, usdPer, onPick }: {
  pair: string; capital: number; maxImpact: number | null; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void;
}) {
  const params: Record<string, string> = { market: pair };
  if (capital > 0) params.capital = String(capital);
  if (maxImpact != null) params.maxImpact = String(maxImpact);
  return (
    <ReplayFrame<Ready> title={(w) => `What it would have earned over ${w}`} path="/api/lp/replay" params={params}
      ready={(a) => <Ready a={a} band={band} rerange={rerange} usdPer={usdPer} onPick={onPick} />} />
  );
}

const same = (r: ReplayRow, band: number, rerange: boolean) => Math.abs(r.bandPct - band) < 1e-9 && r.rerange === rerange;

/** Each coin on its own line, in units: "+0.5976 NVDA" over "+101.2 USDG". A coin at 0 is left out. */
function Units({ c, base, quote, sig, sign = true }: { c: { base: number; quote: number }; base: string; quote: string; sig: number; sign?: boolean }) {
  const parts = ([[c.base, base], [c.quote, quote]] as const).filter(([v]) => v !== 0);
  if (!parts.length) return <span className="coin-line">0 {quote}</span>;
  return <>{parts.map(([v, sym]) => <span key={sym} className="coin-line">{qty(v, sym, sig, sign)}</span>)}</>;
}
const perDay = (c: { base: number; quote: number }, days: number) => ({ base: days > 0 ? c.base / days : 0, quote: days > 0 ? c.quote / days : 0 });

export function Ready({ a, band, rerange, usdPer, onPick }: { a: Ready; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void }) {
  const q = a.quote, base = a.base;
  const best = a.rows.reduce((b, r) => (r.net > b.net ? r : b), a.rows[0]);
  const sel = a.rows.find((r) => same(r, band, rerange)) ?? null;
  const days = a.rows[0]?.days ?? 0;
  return (
    <>
      <p className="muted small">
        {num(a.swaps, 0)} real trades from {time(a.from * 1000)} to {time(a.to * 1000)}, replayed with {qty(a.capital, q, 4, false)} and the bot's own rules.
        {youngNote(a)}{' '}
        Earned is the fees in each coin, less the swap fees paid in that coin and gas: coins, not prices. What the coins'
        price did is left out, and so is the change in the coin mix the position holds (shown on its own). Tap a row to use it.
      </p>
      {sel ? <Summary r={sel} a={a} days={days} usdPer={usdPer} /> : <p className="small muted">This range isn't in the replay (it tries ±1% to ±20%). Tap a row to see its numbers.</p>}
      <div className="table-wrap tall"><table className="replay-table">
        <thead><tr>
          <th>Range</th>
          <th>Moves <Tip>On: as soon as the price leaves the range, it moves the range to the price (like the bot's Auto-move). Off: the range stays where it opened.</Tip></th>
          <th>Earned <Tip>Fees in each coin, less the swap fees paid in that coin and gas (taken from {q}). The ★ row earned the most, adding the coins at the price they were earned.</Tip></th>
          <th>Per day</th>
          <th className="narrow-hide">In range <Tip>Share of the time the price was inside the range, so it was earning.</Tip></th>
          <th className="narrow-hide">Pool share <Tip>Its share of the liquidity trading at today's price if it opened now with this money: that share of every trade's fee.</Tip></th>
        </tr></thead>
        <tbody>{a.rows.map((r) => (
          <tr key={`${r.bandPct}-${r.rerange}`} className={`pickable ${same(r, band, rerange) ? 'selected' : ''}`} onClick={() => onPick(r.bandPct, r.rerange)} title="Use these settings">
            <td>±{num(r.bandPct * 100, 1)}%{r === best ? <span className="best-mark" title="Earned the most here"> ★</span> : null}</td>
            <td className="txt">{r.rerange ? `on · ${r.moves}` : 'off'}</td>
            <td className={cls(r.net)}><Units c={r.earnedCoins} base={base} quote={q} sig={4} /></td>
            <td className={cls(r.net)}><Units c={perDay(r.earnedCoins, days)} base={base} quote={q} sig={3} /></td>
            <td className="narrow-hide">{pct(r.inRange, 0)}</td>
            <td className="narrow-hide">{pct(r.poolShareNow, r.poolShareNow < 0.001 ? 4 : 2)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">Past trades don't promise future ones: a quiet week earns less, and a strong trend keeps a range out of the price.</p>
    </>
  );
}

/** The chosen setting in plain numbers: what it earned in each coin, what it paid, the mix change, and its share of the pool. */
function Summary({ r, a, days, usdPer }: { r: ReplayRow; a: Ready; days: number; usdPer: number | null }) {
  const q = a.quote, base = a.base;
  const mix = r.moveLoss + r.openLoss;
  return (
    <div className="replay-sum">
      <div>
        <span className="k"><L tip={`Fees in each coin, less the swap fees paid in that coin and gas, over the ${num(days, 1)} days replayed.`}>Earned</L></span>
        <b className={cls(r.net)}><Units c={r.earnedCoins} base={base} quote={q} sig={5} /></b>
        <small>{days > 0 ? <>a day: <Units c={perDay(r.earnedCoins, days)} base={base} quote={q} sig={3} /> · </> : ''}{pct(r.net / a.capital, 2, true)} of your money<Usd v={r.net} k={usdPer} /></small>
      </div>
      <div>
        <span className="k"><L tip="The pool's fees it would have earned, in the coins they were paid in, and what it paid out.">Fees</L></span>
        <b className="pos"><Units c={r.feeCoins} base={base} quote={q} sig={4} /></b>
        <small>
          gas {qty(r.gas, q, 3, false)} · swap fees <Units c={r.swapCoins} base={base} quote={q} sig={3} sign={false} />
          {r.rerange ? ` · ${r.moves} move${r.moves === 1 ? '' : 's'}` : ''}
        </small>
        <small><L tip="A position sells the coin that rises and buys the one that falls, so it ends with a different mix than it went in with. This is what that mix is worth less than the coins put in (at each move, and for the range still open at the end, at the last price). Like the coins' own price change, it is not taken out of Earned.">mix change, not counted: {qty(-mix, q, 3)}</L></small>
      </div>
      <div>
        <span className="k"><L tip="The coins a position opened now with this money would hold, around today's price.">Liquidity provided</L></span>
        <b>{num(r.coinsNow.base, 6)} {base}</b>
        <b>{num(r.coinsNow.quote, 6)} {q}</b>
        <small><Usd v={a.capital} k={usdPer} sign={false} /></small>
      </div>
      <div>
        <span className="k"><L tip="Its share of the liquidity trading at today's price, which is its share of every trade's fee while in range.">Share of the pool</L></span>
        <b>{pct(r.poolShareNow, r.poolShareNow < 0.001 ? 4 : 2)}</b>
        <small>in range {pct(r.inRange, 0)} of the time</small>
      </div>
    </div>
  );
}
