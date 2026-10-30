/**
 * The Wallet (drawer and full page), from the holdings read and the server's value history: rows in dollars with
 * their coins under them (Kyle, 2026-10-30: "tracks the dollar amounts", like Coinbase), largest first.
 */
import type { BotRef, CoinView, HoldingsSnapshot } from '../live/holdingsMath';

export interface AssetRow { key: string; chainId: number; address: string | null; symbol: string; amount: number; usd: number | null; inBot: boolean }
export interface PoolRow {
  key: string; chainId: number; t0: CoinView; t1: CoinView; usd: number | null;
  dex: string; fee: string; range: 'in' | 'below' | 'above' | null; bot: BotRef | null; stranded: boolean;
}
export interface FeeLine { key: string; chainId: number; t0: CoinView; t1: CoinView; usd: number | null; leftover: boolean }
export interface WalletModel {
  /**
   * The headline: the server's own total, the same figure the value history records (all chains: dust left out;
   * one chain: that chain's total), so the chart's last point and the headline are one number. Showing dust only
   * adds rows.
   */
  total: number | null;
  assets: AssetRow[]; pools: PoolRow[]; fees: FeeLine[];
  /** Each chain's dollars, largest first: the filter pills */
  chains: { chainId: number; usd: number }[];
  /** Rows folded away as dust */
  hidden: number;
}

/** A coin amount in full, grouped: "34,000 USDG", "21.3 SPY", "0.00016568 NVDA". */
export const coinAmount = (n: number, symbol: string) =>
  `${!Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}${Number(Math.abs(n).toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 12 })}`} ${symbol}`;

const byUsd = <T extends { usd: number | null }>(a: T, b: T) => (b.usd ?? -Infinity) - (a.usd ?? -Infinity);

export function walletModel(h: HoldingsSnapshot, chain: number | 'all', showDust: boolean): WalletModel {
  const on = (id: number) => chain === 'all' || id === chain, keep = (dust: boolean) => showDust || !dust;
  const assets: AssetRow[] = h.wallet.filter((r) => on(r.coin.chainId) && keep(r.dust)).map((r) => ({
    key: `${r.coin.chainId}:${r.coin.address ?? 'native'}`, chainId: r.coin.chainId, address: r.coin.address, symbol: r.coin.symbol,
    amount: r.coin.amount, usd: r.coin.usd, inBot: r.bots.length > 0,
  })).sort(byUsd);
  const pools: PoolRow[] = h.positions.filter((r) => on(r.chainId) && keep(r.dust)).map((r) => ({
    key: `${r.chainId}:${r.pool}:${r.tokenId ?? ''}`, chainId: r.chainId, t0: r.token0, t1: r.token1, usd: r.usd,
    dex: r.dexName, fee: r.feeLabel, range: r.range, bot: r.bot, stranded: r.stranded,
  })).sort(byUsd);
  const fees: FeeLine[] = h.fees.filter((r) => on(r.chainId) && keep(r.dust)).map((r) => ({
    key: `${r.chainId}:${r.pool}:${r.tokenId ?? ''}:fee`, chainId: r.chainId, t0: r.token0, t1: r.token1, usd: r.usd, leftover: r.leftover,
  })).sort(byUsd);
  const hidden = [...h.wallet.map((r) => [r.coin.chainId, r.dust] as const), ...h.positions.map((r) => [r.chainId, r.dust] as const), ...h.fees.map((r) => [r.chainId, r.dust] as const)]
    .filter(([id, dust]) => on(id) && dust).length;
  const total = chain === 'all' ? h.netWorthExDustUsd : h.chains.find((c) => c.chainId === chain)?.usd ?? null;
  const chains = h.chains.filter((c) => c.usd > 0).map((c) => ({ chainId: c.chainId, usd: c.usd })).sort((a, b) => b.usd - a.usd);
  return { total, assets, pools, fees, chains, hidden };
}

/** The chart's line: the recorded points, then the value now (the current read) */
export function worthLine(points: { t: number; usd: number }[], now: { t: number; usd: number | null }): { t: number; usd: number }[] {
  const pts = points.filter((p) => p.t < now.t);
  return now.usd == null ? pts : [...pts, { t: now.t, usd: now.usd }];
}

/** The change over the line: from its first point to its last */
export function worthChange(line: { usd: number }[]): { usd: number; pct: number | null } | null {
  if (line.length < 2) return null;
  const a = line[0].usd, b = line[line.length - 1].usd;
  return { usd: b - a, pct: a > 0 ? (b - a) / a : null };
}
