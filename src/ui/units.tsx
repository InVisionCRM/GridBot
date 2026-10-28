/**
 * Crypto units only (Kyle's rule): no dollar amount is shown anywhere. Per-bot figures are in the bot's own coins;
 * figures that only exist as a cross-coin total (net worth, a pool's depth or liquidity, analytics totals, the
 * smart trader's limits) are shown in ETH.
 *
 * The ETH price used to turn such a dollar total into ETH (the API keeps dollars internally):
 *  1. the holdings snapshot's own ETH price (`usdEach` of an ETH / WETH row), so net worth and its divisor come from
 *     the same snapshot; else
 *  2. the server's per-chain native/stable market read in /api/bot/status (`chains[].nativeUsd`), Ethereum first, then
 *     any other chain whose native coin is ETH (Robinhood Chain, …).
 * No price → a dash, never a dollar figure.
 */
import { createContext, useContext } from 'react';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import type { AnyObj } from './model';
import { coinNum, ethUsdFromChains } from '../lib/ethUnits';

/** Dollars per ETH for the screens (null until a price is known). */
export const EthUsdCtx = createContext<number | null>(null);
export const useEthUsd = () => useContext(EthUsdCtx);

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function ethUsdOf(s: AnyObj | null | undefined, holdings?: HoldingsSnapshot | null): number | null {
  for (const r of holdings?.wallet ?? []) {
    const sym = String(r.coin?.symbol ?? '').toUpperCase();
    if ((sym === 'ETH' || sym === 'WETH') && ok(r.coin.usdEach)) return r.coin.usdEach;
  }
  return ethUsdFromChains((s?.chains ?? []) as { id: number; nativeSymbol?: string | null; nativeUsd?: number | null }[]);
}

export { coinNum };

/** A dollar amount shown in ETH: "1.234 ETH" (sign: "+1.234 ETH" / "−1.234 ETH"); dash with no price. */
export function inEth(usd: number | null | undefined, ethUsd: number | null | undefined, sign = false, sig = 4): string {
  if (usd == null || !Number.isFinite(usd) || !ok(ethUsd)) return '—';
  const e = usd / ethUsd;
  return `${e < 0 ? '−' : sign && e > 0 ? '+' : ''}${coinNum(e, sig)} ETH`;
}

/** Short form for chips and pool stats: 12.3k ETH, 1.2M ETH. */
export function inEthShort(usd: number | null | undefined, ethUsd: number | null | undefined, sign = false): string {
  if (usd == null || !Number.isFinite(usd) || !ok(ethUsd)) return '—';
  const e = usd / ethUsd, a = Math.abs(e), s = e < 0 ? '−' : sign && e > 0 ? '+' : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M ETH`;
  if (a >= 1e4) return `${s}${(a / 1e3).toFixed(1)}k ETH`;
  return `${s}${coinNum(a, 3)} ETH`;
}

/** ETH → dollars for inputs whose setting is stored in dollars (null without a price). */
export const ethToUsd = (eth: number, ethUsd: number | null | undefined) => (ok(ethUsd) ? eth * ethUsd : null);
/** Dollars → ETH for showing such a setting (null without a price). */
export const usdToEth = (usd: number | null | undefined, ethUsd: number | null | undefined) => (usd != null && Number.isFinite(usd) && ok(ethUsd) ? usd / ethUsd : null);

/** Net worth as a per-token list: wallet coins + coins in positions + fees owed, by symbol (dust left out). */
export function holdingsByToken(h: HoldingsSnapshot | null | undefined, chain: number | 'all' = 'all'): { sym: string; amount: number; usd: number | null }[] {
  if (!h) return [];
  const m = new Map<string, { sym: string; amount: number; usd: number | null }>();
  const add = (c: { symbol: string; amount: number; usd: number | null; chainId: number } | null | undefined) => {
    if (!c || !(c.amount > 0) || (chain !== 'all' && c.chainId !== chain)) return;
    const sym = c.symbol.toUpperCase() === 'WETH' ? 'ETH' : c.symbol;
    const x = m.get(sym) ?? { sym, amount: 0, usd: 0 };
    x.amount += c.amount;
    x.usd = x.usd == null || c.usd == null ? (x.usd ?? c.usd) : x.usd + c.usd;
    m.set(sym, x);
  };
  for (const r of h.wallet ?? []) if (!r.dust) add(r.coin);
  for (const p of h.positions ?? []) if (!p.dust) { add(p.token0); add(p.token1); }
  for (const f of h.fees ?? []) if (!f.dust) { add(f.token0); add(f.token1); }
  return [...m.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

/** <Eth usd={…} />: a dollar value from the API shown in ETH (short form by default, for pool sizes and chips). */
export function Eth({ usd, sign = false, full = false }: { usd: number | null | undefined; sign?: boolean; full?: boolean }) {
  const ethUsd = useEthUsd();
  return <>{full ? inEth(usd, ethUsd, sign) : inEthShort(usd, ethUsd, sign)}</>;
}
