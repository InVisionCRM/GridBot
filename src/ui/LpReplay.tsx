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

export function Ready({ a, band, rerange, usdPer, onPick }: { a: Ready; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void }) {
  const q = a.quote;
  const best = a.rows.reduce((b, r) => (r.result > b.result ? r : b), a.rows[0]);
  const mixOf = (r: ReplayRow) => r.moveLoss + r.openLoss;
  const sel = a.rows.find((r) => same(r, band, rerange)) ?? null;
  const days = a.rows[0]?.days ?? 0;
  // the row shown (the chosen setting, else the ★) whose moves lost more than its fees made: said in words
  const shown = sel ?? best;
  const losing = shown && shown.rerange && shown.moves > 0 && mixOf(shown) > shown.net ? shown : null;
  return (
    <>
      <p className="muted small">
        {num(a.swaps, 0)} real trades from {time(a.from * 1000)} to {time(a.to * 1000)}, replayed with {qty(a.capital, q, 4, false)} and the bot's own rules.
        {youngNote(a)}{' '}
        Result is what each setting would have left you against holding the coins: fees, less swap fees, gas and what
        the moves locked in (the coins a position gives back against the coins it took in). The coins' own price change
        is left out. Tap a row to use it.
      </p>
      {sel ? <Summary r={sel} a={a} days={days} usdPer={usdPer} /> : <p className="small muted">This range isn't in the replay (it tries ±1% to ±20%). Tap a row to see its numbers.</p>}
      <div className="table-wrap tall"><table className="replay-table">
        <thead><tr>
          <th>Range</th>
          <th>Moves <Tip>On: as soon as the price leaves the range, it moves the range to the price (like the bot's Auto-move). Off: the range stays where it opened.</Tip></th>
          <th>Result <Tip>Against holding the coins put in: fees, less swap fees, gas and what the moves locked in, in {q}. The ★ row did best.</Tip></th>
          <th>Per day</th>
          <th className="narrow-hide">Locked in <Tip>What the moves locked in, plus the mix the range still open at the end holds, in {q}. Counted in Result.</Tip></th>
          <th className="narrow-hide">In range <Tip>Share of the time the price was inside the range, so it was earning.</Tip></th>
          <th className="narrow-hide">Pool share <Tip>Its share of the liquidity trading at today's price if it opened now with this money: that share of every trade's fee.</Tip></th>
        </tr></thead>
        <tbody>{a.rows.map((r) => (
          <tr key={`${r.bandPct}-${r.rerange}`} className={`pickable ${same(r, band, rerange) ? 'selected' : ''}`} onClick={() => onPick(r.bandPct, r.rerange)} title="Use these settings">
            <td>±{num(r.bandPct * 100, 1)}%{r === best ? <span className="best-mark" title="The best result against holding"> ★</span> : null}</td>
            <td className="txt">{r.rerange ? `on · ${r.moves}` : 'off'}</td>
            <td className={cls(r.result)}>{qty(r.result, q, 4)}</td>
            <td className={cls(r.result)}>{qty(days > 0 ? r.result / days : 0, q, 3)}</td>
            <td className="narrow-hide">{qty(-mixOf(r), q, 3)}</td>
            <td className="narrow-hide">{pct(r.inRange, 0)}</td>
            <td className="narrow-hide">{pct(r.poolShareNow, r.poolShareNow < 0.001 ? 4 : 2)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {losing && <p className="small warn-text" data-testid="replay-warning">At ±{num(losing.bandPct * 100, 1)}% this pool left the range {losing.moves} times in {num(days, 1)} days; each move locked in {qty(mixOf(losing) / losing.moves, q, 3, false)} on average, and the fees did not cover it. Moves off, or a wider range, kept more.</p>}
      <p className="muted small">Past trades don't promise future ones: a quiet week earns less, and a strong trend keeps a range out of the price.</p>
    </>
  );
}

/** The chosen setting in plain numbers: its result, the fees in each coin and what it paid, and its share of the pool. */
function Summary({ r, a, days, usdPer }: { r: ReplayRow; a: Ready; days: number; usdPer: number | null }) {
  const q = a.quote, base = a.base;
  const mix = r.moveLoss + r.openLoss;
  return (
    <div className="replay-sum">
      <div>
        <span className="k"><L tip={`Against holding the coins put in, over the ${num(days, 1)} days replayed: fees, less swap fees, gas and what the moves locked in.`}>Result</L></span>
        <b className={cls(r.result)}>{qty(r.result, q, 5)}</b>
        <small>{days > 0 ? <>a day: {qty(r.result / days, q, 3)} · </> : ''}{pct(r.result / a.capital, 2, true)} of your money<Usd v={r.result} k={usdPer} /></small>
        <small>fees after swap fees and gas: <Units c={r.earnedCoins} base={base} quote={q} sig={4} /></small>
      </div>
      <div>
        <span className="k"><L tip="The pool's fees it would have earned, in the coins they were paid in, and what it paid out.">Fees</L></span>
        <b className="pos"><Units c={r.feeCoins} base={base} quote={q} sig={4} /></b>
        <small>
          gas {qty(r.gas, q, 3, false)} · swap fees <Units c={r.swapCoins} base={base} quote={q} sig={3} sign={false} />
          {r.rerange ? ` · ${r.moves} move${r.moves === 1 ? '' : 's'}` : ''}
        </small>
        <small><L tip="A position sells the coin that rises and buys the one that falls, so it gives back a different mix than it took in. This is what that cost at each move (and for the range still open at the end, at the last price). Counted in Result.">locked in by moves: {qty(-mix, q, 3)}</L></small>
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
