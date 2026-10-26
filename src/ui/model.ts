/** View model shared by the screens: bot names, coins earned, range checks, navigation. */
import type { TF } from '../market/candles';
import type { TrendConfig } from '../market/strategy';
import { gasReserve, type GasReserveCfg } from '../live/gasReserve';
import { mk } from './chains';

export type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TrendPrefill { pair: string; tf: TF; cfg: TrendConfig; capital?: number; nonce: number }
export interface BtPrefill { pair: string; tf: TF; cfg: TrendConfig; nonce: number }
/** A grid from Opportunities opened in New bot: the range is re-centred on the live price with that setting's width. */
export interface GridPrefill { pair: string; bandPct: number; gridCount: number; nonce: number }
/** A liquidity range from Opportunities opened in New bot. */
export interface LpPrefill { pair: string; bandPct: number; nonce: number }

export const TOOL_TABS = [['chart', 'Charts'], ['backtest', 'Backtest'], ['analytics', 'Analytics'], ['markets', 'Markets'], ['convert', 'Convert'], ['alerts', 'Alerts'], ['system', 'System'], ['friends', 'Friends']] as const;
export type ToolTab = (typeof TOOL_TABS)[number][0];

export type HoldingsFocus = 'wallet' | 'lp' | 'fees' | 'bots' | 'chains' | 'how';
export type View =
  | { v: 'home' }
  | { v: 'opps' }
  | { v: 'auto' }
  | { v: 'holdings'; focus?: HoldingsFocus }
  | { v: 'new'; kind: BotKind; trendPrefill?: TrendPrefill; gridPrefill?: GridPrefill; lpPrefill?: LpPrefill }
  | { v: 'grid'; id: string }
  | { v: 'trend'; id: string }
  | { v: 'lp'; id: string }
  | { v: 'tools'; tab: ToolTab; btPrefill?: BtPrefill; analytics?: 'live' | 'paper' };
export type Nav = (v: View) => void;
export type BotKind = 'grid' | 'trend' | 'lp';
/** Detail view of a bot */
export const botView = (kind: BotKind, id: string): View => ({ v: kind, id });

/** 'PLS/DAI', 'ETH/USDC' (chain suffix dropped: the chain badge shows it). */
export const gridName = (g: AnyObj) => String(g.label ?? `PLS/${g.stable}`).replace(/·.*/, '');
export const quoteSym = (b: AnyObj) => b.quoteSym ?? b.stable ?? b.quote;

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

/** Same arithmetic as the server's live-start check (checkGasReserve / assertCovers) for the coin a market spends. */
export function spendFunds(s: AnyObj, key: string, amount: number, gas: GasReserveCfg): Funds {
  return coinFunds(s, key, 'quote', amount, gas);
}

/**
 * Either coin of a market in the signing wallet. The gas set-aside applies to the coin a bot SPENDS when it is the
 * native coin (the quote side); a base coin given to a liquidity bot only has to be there (assertHolds).
 */
export function coinFunds(s: AnyObj, key: string, side: 'base' | 'quote', amount: number, gas: GasReserveCfg): Funds {
  const m = mk(s, key);
  const native = side === 'quote' ? !!m.quoteNative : !!m.baseNative, address = side === 'quote' ? m.quoteAddress : m.baseAddress;
  const wallet = (s.wallets ?? []).find((w: AnyObj) => w.chainId === m.chainId);
  const coin = wallet?.coins.find((c: AnyObj) => (native ? c.native : c.address === address));
  const readError: string | null = !wallet ? null : wallet.error ?? (wallet.at == null ? 'still loading' : coin?.error ?? null);
  // A coin missing from a wallet that read fine really is 0; a failed read is never shown as 0.
  const have: number | null = wallet && !readError ? coin?.amount ?? 0 : null;
  const row = (s.allocations?.rows ?? []).find((r: AnyObj) => r.chainId === m.chainId && (native ? r.native : String(r.address).toLowerCase() === address));
  const inUse: number = row?.allocated ?? 0;
  const reserved = side === 'quote' && native;
  const reserve = reserved ? gasReserve(Math.max(0, amount), gas) : 0;
  const need = Math.max(0, amount) + reserve + inUse;
  const free = have == null ? null : have - inUse;
  const max = free == null ? null : Math.max(0, reserved ? Math.min(free / (1 + gas.pct), free - gas.fixed) : free);
  return { symbol: side === 'quote' ? m.quote : m.base, have, readError, inUse, reserve, need, max, ok: have == null ? null : have + 1e-9 >= need };
}

/**
 * What every bot made by trading, per coin it spends (no dollar conversion): banked trades, and a liquidity bot's fees
 * after gas, swap costs and coins lost to range moves (LpEngine.pnl net).
 */
export interface CoinEarnings { symbol: string; amount: number; trades: number; wins: number; losses: number; fees: number }
export function earnedByCoin(bots: AnyObj[]): CoinEarnings[] {
  const m = new Map<string, CoinEarnings>();
  const at = (sym: string) => { const e = m.get(sym) ?? { symbol: sym, amount: 0, trades: 0, wins: 0, losses: 0, fees: 0 }; m.set(sym, e); return e; };
  for (const b of bots) {
    if (b.kind === 'grid') {
      const e = at(quoteSym(b));
      e.amount += b.pnl.realized; e.trades += b.stats.roundTrips; e.wins += b.stats.wins; e.losses += b.stats.roundTrips - b.stats.wins;
    } else if (b.kind === 'trend') {
      const e = at(quoteSym(b)), won = Math.round(b.stats.count * b.stats.winRate);
      e.amount += b.pnl.realized; e.trades += b.stats.count; e.wins += won; e.losses += b.stats.count - won;
    } else if (b.pnl) {
      const e = at(quoteSym(b));
      e.amount += b.pnl.net; e.fees += b.pnl.fees;
    }
  }
  return [...m.values()].sort((a, b) => b.trades + b.fees - (a.trades + a.fees));
}

/** Round down to `sig` significant digits (a Max that never overshoots the balance). */
export function floorSig(x: number, sig = 6): number {
  if (!(x > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(x)) - sig + 1);
  return Math.floor(x / p) * p;
}

export function errMsg(e: unknown) { return (e as Error).message; }
