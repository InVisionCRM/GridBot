/**
 * New bot → Liquidity: what each range, with and without moving, would have earned on the pool's real trades over the
 * last day, 7, 30 or 365 days (server: /api/lp/replay, market/lpReplay.ts), and the position it opens with today's
 * money: its coins and its share of the pool. It opens on 7 days; a longer window is read from the chain only when it is
 * picked. Click a row to use its settings.
 */
import { useEffect, useState } from 'react';
import type { ReplayRow } from '../market/lpReplay';
import { http } from './api';
import { L, Tip } from './Tip';
import { cls, num, pct, qty, time } from './fmt';
import { Usd } from './money';

type Days = 1 | 7 | 30 | 365;
const WINDOWS: { days: Days; label: string }[] = [{ days: 1, label: '24h' }, { days: 7, label: '7d' }, { days: 30, label: '30d' }, { days: 365, label: '365d' }];
const windowWords = (d: Days) => (d === 1 ? 'the last 24 hours' : d === 365 ? 'the last year' : `the last ${d} days`);

type Answer =
  | { state: 'syncing'; days: Days; done: number; total: number }
  | { state: 'error'; error: string }
  | { state: 'ready'; days: Days; from: number; to: number; swaps: number; capital: number; base: string; quote: string; gasMove: number; maxImpact: number; rows: ReplayRow[] };
type Ready = Extract<Answer, { state: 'ready' }>;

/** Re-asks while the server reads the pool's history; waits for typing to stop before asking for a new amount. */
function useReplay(pair: string, capital: number, maxImpact: number | null, days: Days, nonce: number) {
  const [a, setA] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, next: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const q = new URLSearchParams({ market: pair, days: String(days) });
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
  }, [pair, capital, maxImpact, days, nonce]);
  return { a, err };
}

export function LpReplay({ pair, capital, maxImpact, band, rerange, usdPer, onPick }: {
  pair: string; capital: number; maxImpact: number | null; band: number; rerange: boolean; usdPer: number | null; onPick: (band: number, rerange: boolean) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [days, setDays] = useState<Days>(7);
  const { a, err } = useReplay(pair, capital, maxImpact, days, nonce);
  const retry = <button type="button" className="btn small-btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>;
  // an answer for the window picked before this one is not shown under the new one's title
  const shown = a && a.state !== 'error' && a.days !== days ? null : a;

  return (
    <div className="replay">
      <div className="replay-head">
        <h3>What it would have earned over {windowWords(days)}</h3>
        <div className="seg" role="radiogroup" aria-label="Replay window">
          {WINDOWS.map((w) => <button key={w.days} type="button" role="radio" aria-checked={days === w.days} className={days === w.days ? 'on' : ''} onClick={() => setDays(w.days)}>{w.label}</button>)}
        </div>
      </div>
      {err && <div className="banner error"><span className="grow">{err}</span>{retry}</div>}
      {shown?.state === 'error' && <div className="banner error"><span className="grow">Couldn't read the pool's trades: {shown.error}</span>{retry}</div>}
      {(!shown && !err) && <p className="muted small">Looking up the pool's trades…</p>}
      {shown?.state === 'syncing' && (
        <div className="replay-sync">
          <p className="small">Reading {windowWords(days)} of this pool's trades from the chain{shown.total ? `: ${Math.floor((100 * shown.done) / shown.total)}%` : '…'}</p>
          <div className="replay-bar"><span style={{ width: `${shown.total ? (100 * shown.done) / shown.total : 0}%` }} /></div>
          <p className="muted small">
            {days <= 7
              ? 'The first time takes a few minutes on a busy pool (Robinhood\'s ETH/USDG has about 200,000 trades a day). After that only the new trades are read.'
              : `Each day before the ones already read is fetched from the chain, newest first. ${days === 365 ? 'A year can take an hour or more on a busy pool' : 'A month can take several minutes on a busy pool'} (a public RPC answers a few requests a second). It keeps reading if you leave this page or pick another window, and what it has read is kept.`}
          </p>
        </div>
      )}
      {shown?.state === 'ready' && <Ready a={shown} band={band} rerange={rerange} usdPer={usdPer} onPick={onPick} />}
    </div>
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
        {a.from > a.to - a.days * 86_400 + 86_400 ? ` The pool's trades only start on ${time(a.from * 1000)}, so this covers ${num(days, 1)} days, not ${a.days}. ` : ' '}
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
