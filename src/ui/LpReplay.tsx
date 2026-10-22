/**
 * New bot → Liquidity: how each range, with and without moving, would have done on the pool's real trades over the
 * last days (server: /api/lp/replay, market/lpReplay.ts). Click a row to use its settings.
 */
import { useEffect, useState } from 'react';
import type { ReplayRow } from '../market/lpReplay';
import { LP_MAX_MOVES_PER_DAY } from '../market/lp';
import { http } from './api';
import { Tip } from './Tip';
import { cls, num, qty, time } from './fmt';

/** Amounts in the table: two decimals (signed where asked), small ones to 3 significant digits. */
const amt = (x: number, sign = false) => {
  const s = Math.abs(x) >= 0.01 || x === 0 ? Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.abs(x).toPrecision(3);
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}${s}`;
};

type Answer =
  | { state: 'syncing'; done: number; total: number }
  | { state: 'error'; error: string }
  | { state: 'ready'; from: number; to: number; swaps: number; capital: number; base: string; quote: string; gasMove: number; maxImpact: number; rows: ReplayRow[] };

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

export function LpReplay({ pair, capital, maxImpact, band, rerange, onPick }: {
  pair: string; capital: number; maxImpact: number | null; band: number; rerange: boolean; onPick: (band: number, rerange: boolean) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const { a, err } = useReplay(pair, capital, maxImpact, nonce);
  const retry = <button type="button" className="btn small-btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>;

  return (
    <div className="replay">
      <h3>How these settings did on this pool's real trades</h3>
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
      {a?.state === 'ready' && <ReplayTable a={a} band={band} rerange={rerange} onPick={onPick} />}
    </div>
  );
}

function ReplayTable({ a, band, rerange, onPick }: { a: Extract<Answer, { state: 'ready' }>; band: number; rerange: boolean; onPick: (band: number, rerange: boolean) => void }) {
  const q = a.quote;
  const best = a.rows.reduce((b, r) => (r.vsHold > b.vsHold ? r : b), a.rows[0]);
  const days = a.rows[0]?.days ?? 0;
  return (
    <>
      <p className="muted small">
        {num(a.swaps, 0)} trades from {time(a.from * 1000)} to {time(a.to * 1000)}, replayed with {qty(a.capital, q, 4, false)} and the bot's own rules.
        A move costs about {qty(a.gasMove, q, 3, false)} in gas plus the swap. Click a row to use it.
      </p>
      <div className="table-wrap tall"><table className="replay-table">
        <thead><tr>
          <th>Range</th>
          <th>Moves <Tip>On: out of range, it moves the range to the price once the fees it's missing pass what moving costs, at most {LP_MAX_MOVES_PER_DAY} times a day (like the bot). Off: the range stays where it opened.</Tip></th>
          <th>Fees <Tip>Its share of the pool's fees, for the time the price was inside its range.</Tip></th>
          <th className="narrow-hide">Costs <Tip>Gas plus the swaps to the range's mix (pool fee and price impact), for the opening and every move.</Tip></th>
          <th>Result vs holding <Tip>What it ends with minus the coins it held right after opening, valued at the last price. Positive: the position's trading beat simply holding those coins. Negative: holding them would have left you with more. Fees are in here, and so is what moving locks in: a position sells {a.base} as the price rises and buys it as it falls, and a move makes that mix final.</Tip></th>
          <th className="narrow-hide">Per day <Tip>Result vs holding divided by the days replayed.</Tip></th>
          <th>Days ahead <Tip>The same setting started fresh each day: on how many days it beat holding. One replay is one path through the trades; this shows how often it held up.</Tip></th>
        </tr></thead>
        <tbody>{a.rows.map((r) => {
          const on = Math.abs(r.bandPct - band) < 1e-9 && r.rerange === rerange;
          return (
            <tr key={`${r.bandPct}-${r.rerange}`} className={`pickable ${on ? 'selected' : ''}`} onClick={() => onPick(r.bandPct, r.rerange)} title="Use these settings">
              <td>±{num(r.bandPct * 100, 1)}%{r === best ? <span className="best-mark" title="Best result here"> ★</span> : null}</td>
              <td className="txt">{r.rerange ? `on · ${r.moves} move${r.moves === 1 ? '' : 's'}` : 'off'}</td>
              <td>{amt(r.fees)}</td>
              <td className="narrow-hide">{amt(r.gas + r.swapCost)}</td>
              <td className={cls(r.vsHold)}>{amt(r.vsHold, true)}</td>
              <td className={`narrow-hide ${cls(r.vsHold)}`}>{amt(days > 0 ? r.vsHold / days : 0, true)}</td>
              <td className={r.daysAhead * 2 > r.daysRun ? 'pos' : r.daysAhead * 2 < r.daysRun ? 'neg' : ''}>{r.daysAhead} of {r.daysRun}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <p className="muted small">Amounts in {q}. Past trades don't promise future ones: a strong trend can turn any of these around.</p>
    </>
  );
}
