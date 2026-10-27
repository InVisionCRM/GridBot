/**
 * BotMetrics contract. Every figure is produced on the server.
 * Views display these fields and do not derive one money figure from another.
 *
 * Headline is always dollarsMadeUsd (metrics.headline === 'dollarsMade').
 * LP: fees collected + fees owed − gas − swap fees − taxes − realized rebalance loss.
 * Grid, trend, token: realized trade profit − fees − gas − taxes.
 * totalPnlUsd = dollarsMadeUsd + priceChangeUsd.
 * aprPct and est.* extrapolate dollars made. Simple APR, not compounded.
 * Percents are fractions (0.041 = 4.1%). Estimates are USD, or null.
 */

export type BotMode = 'live' | 'paper';
export type BotKind = 'grid' | 'trend' | 'lp' | 'token';
export type BotStatus = 'running' | 'paused' | 'stopped' | 'closed';

export interface EstimateBlock {
  d1: number | null;
  d7: number | null;
  d365: number | null;
  /** Why an estimate is missing, or what the extrapolation is. */
  needs: string;
}

export interface RangeBlock {
  lower: number;
  upper: number;
  current: number;
  inRange: boolean;
}

export interface BotMetrics {
  botId: string;
  mode: BotMode;
  kind: BotKind;
  status: BotStatus;
  startedAt: number;
  ageSec: number;
  capitalInUsd: number;
  currentValueUsd: number;
  /** Realized trade profit for grid, trend, and token. Not the headline. */
  realizedUsd: number;
  unrealizedUsd: number;
  feesEarnedUsd: number;
  feesCollectedUsd: number;
  /** Fees owed / still in the position. */
  feesUncollectedUsd: number;
  gasUsd: number;
  /** Swap fees (pool fee and impact the server has already summed). */
  swapCostUsd: number;
  tokenTaxesUsd: number;
  realizedRebalanceLossUsd: number;
  priceChangeUsd: number;
  dollarsMadeUsd: number;
  headline: 'dollarsMade';
  /** dollarsMadeUsd + priceChangeUsd. Expander only. */
  totalPnlUsd: number;
  totalPnlPct: number;
  /** Simple APR on dollars made. Null until there is enough history. */
  aprPct: number | null;
  est: EstimateBlock;
  moveCount: number;
  fillCount: number;
  range: RangeBlock | null;
  asOf: number;
  /** Tooltip. The server's formula in words. */
  calc: string;
}

export interface CandleBar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface FillMark { id: string; t: number; price: number; side: 'buy' | 'sell' }

/** Identity, series, and presentation hints that are not money math. */
export interface BotDesk {
  metrics: BotMetrics;
  pair: string;
  base: string;
  quote: string;
  chain: string;
  chainColor: string;
  dex: string;
  /** Server hint for the status ring. The view does not infer "near". */
  tone: 'in' | 'near' | 'out' | 'idle';
  spark: number[];
  levels: number[];
  candles: CandleBar[];
  fills: FillMark[];
  /** Level price to glow. Null when nothing just filled. */
  flashLevel: number | null;
  price: number;
  change24h: number;
}

export interface TapePrice { symbol: string; price: number; change24h: number }

export interface ActivityItem {
  id: string;
  t: number;
  botId: string;
  pair: string;
  kind: 'fill' | 'recenter' | 'fee';
  text: string;
  tone: 'up' | 'down' | 'flat';
}

/**
 * Portfolio figures the per-bot payload does not include.
 * The desk snapshot carries them so Home does not add bots up itself.
 */
export interface PortfolioSnapshot {
  asOf: number;
  /** Live bots only. Home headline. */
  dollarsMadeUsd: number;
  paperDollarsMadeUsd: number;
  priceChangeUsd: number;
  currentValueUsd: number;
  capitalInUsd: number;
  feesTodayLiveUsd: number;
  feesTodayPaperUsd: number;
  botsRunning: number;
  botsTotal: number;
  madeSeries: number[];
}

export interface DeskSnapshot {
  portfolio: PortfolioSnapshot;
  bots: BotDesk[];
  prices: TapePrice[];
  activity: ActivityItem[];
}

export interface DeskDelta {
  asOf: number;
  portfolio: PortfolioSnapshot;
  bots: BotDesk[];
  prices: TapePrice[];
  activity: ActivityItem[];
}
