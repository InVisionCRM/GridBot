/**
 * What the liquidity and grid replays share on the page: the window switch (24h / 7d / 30d / 365d, opening on 7 days),
 * asking the server again while it reads a pool's history, the read's progress, and the error banner.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { http } from './api';
import { num, time } from './fmt';

export type Days = 1 | 7 | 30 | 365;
const WINDOWS: { days: Days; label: string }[] = [{ days: 1, label: '24h' }, { days: 7, label: '7d' }, { days: 30, label: '30d' }, { days: 365, label: '365d' }];
export const windowWords = (d: Days) => (d === 1 ? 'the last 24 hours' : d === 365 ? 'the last year' : `the last ${d} days`);

type Waiting = { state: 'syncing'; days: Days; done: number; total: number } | { state: 'error'; error: string };
type Answer<R> = Waiting | (R & { state: 'ready'; days: Days });

/**
 * GET `path` with `params` and the window; asks again every 3 s while the server reads the history. Waits for typing
 * to stop (500 ms) before asking for new inputs. An answer for a window picked before the current one is not returned.
 */
function useReplay<R>(path: string, params: Record<string, string>, days: Days, nonce: number) {
  const [a, setA] = useState<Answer<R> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const query = new URLSearchParams({ ...params, days: String(days) }).toString();
  useEffect(() => {
    let alive = true, next: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      try {
        const r = await http<Answer<R>>(`${path}?${query}`);
        if (!alive) return;
        setA(r); setErr(null);
        if (r.state === 'syncing') next = setTimeout(ask, 3000);
      } catch (e) { if (alive) { setA(null); setErr((e as Error).message); } }
    };
    const first = setTimeout(ask, 500);
    return () => { alive = false; clearTimeout(first); if (next) clearTimeout(next); };
  }, [path, query, nonce]);
  return { a: a && a.state !== 'error' && a.days !== days ? null : a, err };
}

/** The replay frame: title with the window switch, then the progress, an error, or `ready(answer)`. */
export function ReplayFrame<R>({ title, path, params, ready }: { title: (w: string) => string; path: string; params: Record<string, string>; ready: (a: R & { days: Days }) => ReactNode }) {
  const [nonce, setNonce] = useState(0);
  const [days, setDays] = useState<Days>(7);
  const { a, err } = useReplay<R>(path, params, days, nonce);
  const retry = <button type="button" className="btn small-btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>;
  return (
    <div className="replay">
      <div className="replay-head">
        <h3>{title(windowWords(days))}</h3>
        <div className="seg" role="radiogroup" aria-label="Replay window">
          {WINDOWS.map((w) => <button key={w.days} type="button" role="radio" aria-checked={days === w.days} className={days === w.days ? 'on' : ''} onClick={() => setDays(w.days)}>{w.label}</button>)}
        </div>
      </div>
      {err && <div className="banner error"><span className="grow">{err}</span>{retry}</div>}
      {a?.state === 'error' && <div className="banner error"><span className="grow">Couldn't read the pool's trades: {a.error}</span>{retry}</div>}
      {(!a && !err) && <p className="muted small">Looking up the pool's trades…</p>}
      {a?.state === 'syncing' && (
        <div className="replay-sync">
          <p className="small">Reading {windowWords(days)} of this pool's trades from the chain{a.total ? `: ${Math.floor((100 * a.done) / a.total)}%` : '…'}</p>
          <div className="replay-bar"><span style={{ width: `${a.total ? (100 * a.done) / a.total : 0}%` }} /></div>
          <p className="muted small">
            {days <= 7
              ? 'The first time takes a few minutes on a busy pool (Robinhood\'s ETH/USDG has about 200,000 trades a day). After that only the new trades are read.'
              : `Each day before the ones already read is fetched from the chain, newest first. ${days === 365 ? 'A year can take an hour or more on a busy pool' : 'A month can take several minutes on a busy pool'} (a public RPC answers a few requests a second). It keeps reading if you leave this page or pick another window, and what it has read is kept.`}
          </p>
        </div>
      )}
      {a?.state === 'ready' && ready(a)}
    </div>
  );
}

/** "The pool's trades only start on …" when a pool is younger than the window, else nothing. */
export function youngNote(a: { from: number; to: number; days: Days }): string {
  return a.from > a.to - a.days * 86_400 + 86_400 ? ` The pool's trades only start on ${time(a.from * 1000)}, so this covers ${num((a.to - a.from) / 86_400, 1)} days, not ${a.days}.` : '';
}
