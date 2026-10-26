/**
 * New bot → Liquidity: what each range, with and without moving, would have earned on the pool's real trades over the
 * last days (server: /api/lp/replay, market/lpReplay.ts), and the position it opens with today's money: its coins and
 * its share of the pool. Click a row to use its settings.
 */
import { useEffect, useState } from 'react';
import type { ReplayRow } from '../market/lpReplay';
import { http } from './api';
import { L, Tip } from './Tip';
import { cls, num, pct, qty, time } from './fmt';
import { Usd } from './money';

type Answer =
  | { state: 'syncing'; done: number; total: number }
  | { state: 'error'; error: string }
  | { state: 'ready'; from: number; to: number; swaps: number; capital: number; base: string; quote: string; gasMove: number; maxImpact: number; rows: ReplayRow[] };
type Ready = Extract<Answer, { state: 'ready' }>;

/** Re-asks while the server reads the pool's history; waits for typing to stop before asking for a new amount. */
function useReplay(pair: string, capital: number, maxImpact: number | null, nonce: number) {
  const [a, setA] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, next: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const q = new URLSearchParams({ market: pair });
      if (capital > 0) q.set('capital', String(capital));
      if (maxImpact != null) q.set('maxImpact', String(maxImpact));
      try {
        const r = await http<Answer>(`/api/lp/replay?${q}`);
        if (!alive) return;
        setA(r); setErr(null);
        if (r.state === 'syncing') next = setTimeout(ask, 3000);
      } catch (e) { if (alive) { setA(null); setErr((e as Error).message); } }
    };
    const first = setTimeout(ask, 500);
    return () => { alive = false; clearTimeout(first); if (next) clearTimeout(next); };
  }, [pair, capital, maxImpact, nonce]);
  return { a, err };
}

export function LpReplay({ pair, capital, maxImpact, band, rerange, usdPer, onPick }: {
  pair: string; capital: number; maxImpact: number | null; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const { a, err } = useReplay(pair, capital, maxImpact, nonce);
  const retry = <button type="button" className="btn small-btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>;

  return (
    <div className="replay">
      <h3>What it would have earned last week</h3>
      {err && <div className="banner error"><span className="grow">{err}</span>{retry}</div>}
      {a?.state === 'error' && <div className="banner error"><span className="grow">Couldn't read the pool's trades: {a.error}</span>{retry}</div>}
      {(!a && !err) && <p className="muted small">Looking up the pool's trades…</p>}
      {a?.state === 'syncing' && (
        <div className="replay-sync">
          <p className="small">Reading this pool's trades from the chain{a.total ? `: ${Math.floor((100 * a.done) / a.total)}%` : '…'}</p>
          <div className="replay-bar"><span style={{ width: `${a.total ? (100 * a.done) / a.total : 0}%` }} /></div>
          <p className="muted small">The first time takes a few minutes on a busy pool (Robinhood's ETH/USDG has about 200,000 trades a day). After that only the new trades are read.</p>
        </div>
      )}
      {a?.state === 'ready' && <Ready a={a} band={band} rerange={rerange} usdPer={usdPer} onPick={onPick} />}
    </div>
  );
}

const same = (r: ReplayRow, band: number, rerange: boolean) => Math.abs(r.bandPct - band) < 1e-9 && r.rerange === rerange;

function Ready({ a, band, rerange, usdPer, onPick }: { a: Ready; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void }) {
  const q = a.quote;
  const best = a.rows.reduce((b, r) => (r.net > b.net ? r : b), a.rows[0]);
  const sel = a.rows.find((r) => same(r, band, rerange)) ?? null;
  const days = a.rows[0]?.days ?? 0;
  return (
    <>
      <p className="muted small">
        {num(a.swaps, 0)} real trades from {time(a.from * 1000)} to {time(a.to * 1000)}, replayed with {qty(a.capital, q, 4, false)} and the bot's own rules.
        Price moves are left out: these are the fees it would have earned, minus what it would have paid. Tap a row to use it.
      </p>
      {sel ? <Summary r={sel} a={a} days={days} usdPer={usdPer} /> : <p className="small muted">This range isn't in the replay (it tries ±1% to ±20%). Tap a row to see its numbers.</p>}
      <div className="table-wrap tall"><table className="replay-table">
        <thead><tr>
          <th>Range</th>
          <th>Moves <Tip>On: as soon as the price leaves the range, it moves the range to the price (like the bot's Auto-move). Off: the range stays where it opened.</Tip></th>
          <th>Earned <Tip>Fees minus gas, the swaps to the range's mix, and what range moves lost, in {q}.</Tip></th>
          <th>Per day</th>
          <th className="narrow-hide">In range <Tip>Share of the time the price was inside the range, so it was earning.</Tip></th>
          <th className="narrow-hide">Pool share <Tip>Its share of the liquidity trading at today's price if it opened now with this money: that share of every trade's fee.</Tip></th>
        </tr></thead>
        <tbody>{a.rows.map((r) => (
          <tr key={`${r.bandPct}-${r.rerange}`} className={`pickable ${same(r, band, rerange) ? 'selected' : ''}`} onClick={() => onPick(r.bandPct, r.rerange)} title="Use these settings">
            <td>±{num(r.bandPct * 100, 1)}%{r === best ? <span className="best-mark" title="Earned the most here"> ★</span> : null}</td>
            <td className="txt">{r.rerange ? `on · ${r.moves}` : 'off'}</td>
            <td className={cls(r.net)}>{qty(r.net, q, 4)}</td>
            <td className={cls(r.net)}>{qty(days > 0 ? r.net / days : 0, q, 3)}</td>
            <td className="narrow-hide">{pct(r.inRange, 0)}</td>
            <td className="narrow-hide">{pct(r.poolShareNow, r.poolShareNow < 0.001 ? 4 : 2)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">Past trades don't promise future ones: a quiet week earns less, and a strong trend keeps a range out of the price.</p>
    </>
  );
}

/** The chosen setting in plain numbers: what it earned, what went in, and its share of the pool. */
function Summary({ r, a, days, usdPer }: { r: ReplayRow; a: Ready; days: number; usdPer: number | null }) {
  const q = a.quote, base = a.base;
  return (
    <div className="replay-sum">
      <div>
        <span className="k"><L tip={`Fees minus gas, the swaps to the range's mix and what range moves lost, over the ${num(days, 1)} days replayed, in ${q}.`}>Earned after costs</L></span>
        <b className={cls(r.net)}>{qty(r.net, q, 5)}</b>
        <small>{days > 0 ? `${qty(r.net / days, q, 3)} a day · ` : ''}{pct(r.net / a.capital, 2, true)} of your money<Usd v={r.net} k={usdPer} /></small>
      </div>
      <div>
        <span className="k"><L tip="The pool's fees it would have earned, in the coins they were paid in.">Fees</L></span>
        <b className="pos">{qty(r.feeCoins.base, base, 4)}</b>
        <b className="pos">{qty(r.feeCoins.quote, q, 4)}</b>
        <small>costs {qty(r.gas + r.swapCost, q, 3, false)} · lost to moves {qty(r.moveLoss, q, 3, false)}{r.rerange ? ` · ${r.moves} move${r.moves === 1 ? '' : 's'}` : ''}</small>
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
