/**
 * Coins first, dollars on request: every result is shown in the coin it was earned in. The "$" switch in the top bar
 * adds the dollar value beside it, at today's price of that coin.
 */
import { createContext, useContext } from 'react';
import { qty, usd } from './fmt';

export const ShowUsdCtx = createContext<{ on: boolean; set: (on: boolean) => void } | null>(null);

export function useShowUsd() {
  const c = useContext(ShowUsdCtx);
  if (!c) throw new Error('useShowUsd outside ShowUsdCtx');
  return c;
}

export function loadShowUsd(): boolean {
  try { return localStorage.getItem('showUsd') === '1'; } catch { return false; }
}
export function saveShowUsd(on: boolean) {
  try { localStorage.setItem('showUsd', on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/** A coin worth about a dollar (within 2%, as the LP page's price pill already treats it): its dollars repeat its amount. */
export const pegged = (k: number | null | undefined) => typeof k === 'number' && Math.abs(k - 1) <= 0.02;

/**
 * " ≈ $12.50" with the switch on and a dollar price for the coin (k = dollars per coin); nothing otherwise. Nothing for
 * a coin worth about a dollar either: "−866 USDG ≈ −$866.00" says the same figure twice.
 */
export function Usd({ v, k, sign = true }: { v: number | null | undefined; k: number | null | undefined; sign?: boolean }) {
  const { on } = useShowUsd();
  if (!on || k == null || v == null || !Number.isFinite(v) || pegged(k)) return null;
  return <span className="usd"> ≈ {usd(v * k, sign)}</span>;
}

/** "+12.5 DAI", then the dollars when the switch is on. */
export function Amt({ v, sym, k, sig = 5, sign = true }: { v: number | null | undefined; sym: string; k: number | null | undefined; sig?: number; sign?: boolean }) {
  return <>{qty(v, sym, sig, sign)}<Usd v={v} k={k} sign={sign} /></>;
}
