/**
 * Crypto units only: every result is shown in the coin it was earned in. The old "$" switch (dollar value beside
 * it) is gone; `Usd` renders nothing and `Amt` is the coin amount alone. The context stays so callers compile.
 */
import { createContext, useContext } from 'react';
import { qty } from './fmt';

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

/** Was " ≈ $12.50" with the "$" switch on. No dollar amounts are shown any more: always nothing. */
export function Usd(_: { v: number | null | undefined; k: number | null | undefined; sign?: boolean }) {
  return null;
}

/** "+12.5 DAI", then the dollars when the switch is on. */
export function Amt({ v, sym, k, sig = 5, sign = true }: { v: number | null | undefined; sym: string; k: number | null | undefined; sig?: number; sign?: boolean }) {
  return <>{qty(v, sym, sig, sign)}<Usd v={v} k={k} sign={sign} /></>;
}
