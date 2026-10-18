/** View model shared by the screens: bot names, ≈USD profit, range checks, navigation. */
import type { TF } from '../market/candles';
import type { TrendConfig } from '../market/strategy';
import { gasReserve, type GasReserveCfg } from '../live/gasReserve';
import { mk } from './chains';

export type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TrendPrefill { pair: string; tf: TF; cfg: TrendConfig; capital?: number; nonce: number }
export interface BtPrefill { pair: string; tf: TF; cfg: TrendConfig; nonce: number }
/** A daily pick opened in New bot: the range is re-centred on the live price with the pick's width. */
export interface GridPrefill { pair: string; bandPct: number; gridCount: number; nonce: number }

export const TOOL_TABS = [['chart', 'Charts'], ['backtest', 'Backtest'], ['analytics', 'Analytics'], ['markets', 'Markets'], ['alerts', 'Alerts']] as const;
export type ToolTab = (typeof TOOL_TABS)[number][0];

export type View =
  | { v: 'home' }
  | { v: 'new'; kind: 'grid' | 'trend'; trendPrefill?: TrendPrefill; gridPrefill?: GridPrefill }
  | { v: 'grid'; id: string }
  | { v: 'trend'; id: string }
  | { v: 'tools'; tab: ToolTab; btPrefill?: BtPrefill };
export type Nav = (v: View) => void;

/** 'PLS/DAI', 'ETH/USDC' (chain suffix dropped: the chain badge shows it). */
export const gridName = (g: AnyObj) => String(g.label ?? `PLS/${g.stable}`).replace(/·.*/, '');
export const quoteSym = (b: AnyObj) => b.quoteSym ?? b.stable ?? b.quote;

/** Grid profit (realized + unrealized) in ≈USD, or null when the quote has no USD route. */
export const gridPnlUsd = (g: AnyObj): number | null => (g.usdPerQuote == null ? null : (g.pnl.realized + g.pnl.unrealized) * g.usdPerQuote);
/** Trend bot profit (equity − capital) in ≈USD, or null when the quote has no USD route. */
export const trendPnlUsd = (t: AnyObj): number | null => (t.usdPerQuote == null ? null : (t.pnl.equity - t.capital) * t.usdPerQuote);

export function rangeState(g: AnyObj): 'in' | 'below' | 'above' | null {
  if (!g.config || g.price == null) return null;
  if (g.price < g.config.lowerPrice) return 'below';
  if (g.price > g.config.upperPrice) return 'above';
  return 'in';
}

/** The coin a market spends on buys, in the signing wallet, and what is free for a new bot. */
export interface Funds {
  symbol: string;
  /** Balance in the signing address; null when there is no signing key (paper only), or see readError */
  have: number | null;
  /** Why the balance is unknown although there is a signing key (still loading, or the read failed) */
  readError: string | null;
  /** Already committed to running live bots */
  inUse: number;
  /** Kept aside for gas when the coin is also the gas coin (PLS / ETH) */
  reserve: number;
  /** amount + reserve + inUse */
  need: number;
  /** Largest amount that fits (after the gas set-aside and what live bots use); null without a balance */
  max: number | null;
  /** null when the balance is unknown */
  ok: boolean | null;
}

/** Same arithmetic as the server's live-start check (checkGasReserve / assertCovers). */
export function spendFunds(s: AnyObj, key: string, amount: number, gas: GasReserveCfg): Funds {
  const m = mk(s, key);
  const wallet = (s.wallets ?? []).find((w: AnyObj) => w.chainId === m.chainId);
  const coin = wallet?.coins.find((c: AnyObj) => (m.quoteNative ? c.native : c.address === m.quoteAddress));
  const readError: string | null = !wallet ? null : wallet.error ?? (wallet.at == null ? 'still loading' : coin?.error ?? null);
  // A coin missing from a wallet that read fine really is 0; a failed read is never shown as 0.
  const have: number | null = wallet && !readError ? coin?.amount ?? 0 : null;
  const row = (s.allocations?.rows ?? []).find((r: AnyObj) => r.chainId === m.chainId && (m.quoteNative ? r.native : String(r.address).toLowerCase() === m.quoteAddress));
  const inUse: number = row?.allocated ?? 0;
  const reserve = m.quoteNative ? gasReserve(Math.max(0, amount), gas) : 0;
  const need = Math.max(0, amount) + reserve + inUse;
  const free = have == null ? null : have - inUse;
  const max = free == null ? null : Math.max(0, m.quoteNative ? Math.min(free / (1 + gas.pct), free - gas.fixed) : free);
  return { symbol: m.quote, have, readError, inUse, reserve, need, max, ok: have == null ? null : have + 1e-9 >= need };
}

/** Round down to `sig` significant digits (a Max that never overshoots the balance). */
export function floorSig(x: number, sig = 6): number {
  if (!(x > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(x)) - sig + 1);
  return Math.floor(x / p) * p;
}

export function errMsg(e: unknown) { return (e as Error).message; }
