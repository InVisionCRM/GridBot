/**
 * Holdings: the Wallet's full page (Wallet.tsx, mode "page"): every coin and position in dollars with its coins under
 * it, fees not collected yet, dust on a switch, and how it's counted. The drawer shows the same view, shorter.
 */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { HOW_HOLDINGS, type HoldingsSnapshot } from '../live/holdingsMath';
import { errMsg, type AnyObj, type Nav } from './model';
import { WalletView } from './Wallet';

const DUST_KEY = 'holdingsDust';

export function useHoldings() {
  const [data, setData] = useState<HoldingsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback((refresh = false) => {
    if (refresh) setLoading(true);
    return http<HoldingsSnapshot>(`/api/holdings${refresh ? '?refresh=1' : ''}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), 60_000);
    return () => clearInterval(t);
  }, [load]);
  return { data, err, loading, reload: () => load(true) };
}

export function Holdings({ s, snap, loading, error, reload, nav }: {
  s: AnyObj;
  snap: HoldingsSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  focus?: string;
  nav: Nav;
}) {
  const [showDust, setShowDust] = useState(() => { try { return localStorage.getItem(DUST_KEY) === '0'; } catch { return false; } });
  const flip = () => setShowDust((v) => {
    const next = !v;
    try { localStorage.setItem(DUST_KEY, next ? '0' : '1'); } catch { /* storage unavailable */ }
    return next;
  });
  return (
    <main className="wl-page">
      <div className="wl-page-bar">
        {snap?.address && <span className="muted">{snap.address.slice(0, 6)}…{snap.address.slice(-4)}</span>}
        <button type="button" className="dk-btn" disabled={loading} onClick={reload}>{loading ? 'Reading…' : 'Read again'}</button>
      </div>
      {error && <p className="note bad">{error}</p>}
      {snap?.overdrawn && <p className="note">Bot books add up to more than the wallet holds. The amounts here are the wallet's, not the books'.</p>}
      {snap?.errors.map((e, i) => <p key={i} className="note">{e.message}</p>)}
      <WalletView s={s} snap={snap} mode="page" nav={nav} onDust={{ shown: showDust, flip }} />
      <details className="fold how">
        <summary>How this is counted</summary>
        {(snap?.how ?? HOW_HOLDINGS).map((line) => <p key={line}>{line}</p>)}
      </details>
    </main>
  );
}
