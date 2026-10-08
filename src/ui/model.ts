/** View model shared by the screens: bot names, ≈USD profit, range checks, navigation. */
import type { TF } from '../market/candles';
import type { TrendConfig } from '../market/strategy';
import { mk } from './chains';

export type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TrendPrefill { pair: string; tf: TF; cfg: TrendConfig; capitalUsd?: number; nonce: number }
export interface BtPrefill { pair: string; tf: TF; cfg: TrendConfig; nonce: number }

export const TOOL_TABS = [['chart', 'Charts'], ['backtest', 'Backtest'], ['analytics', 'Analytics'], ['markets', 'Markets'], ['alerts', 'Alerts']] as const;
export type ToolTab = (typeof TOOL_TABS)[number][0];

export type View =
  | { v: 'home' }
  | { v: 'new'; kind: 'grid' | 'trend'; trendPrefill?: TrendPrefill }
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

/** ≈USD per unit of a market's quote token (stables 1, others via the chain's native/stable market). */
export const usdPerQuoteOf = (s: AnyObj, key: string): number | null => mk(s, key).usdPerQuote ?? null;

export function errMsg(e: unknown) { return (e as Error).message; }
