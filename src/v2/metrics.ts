/**
 * BotMetrics contract. Views display these fields and do not derive money.
 *
 * Headline is token units generated, net of costs (`generated`), with `generatedUsd` under it.
 * Home's headline is live `generatedUsd` plus per-token chips. Paper is separate.
 * Price change and value versus capital are breakdown context, not the hero.
 * est.d1 / d7 / d365 are pace in token units. Null until the window has enough history:
 * about 28 minutes, 3.2 hours, and 30 days. The bot screen prints a dash for D7 and D365.
 * Those pace figures open only from the Breakdown projected toggle. APR is generatedUsd / capitalInUsd once the bot
 * is at least ~28 minutes old and, when a fill count exists, has at least two fills.
 * Otherwise APR is null. Not compounded and not annualized.
 * Percents are fractions. Null means the snapshot did not carry the figure.
 */

export type BotMode = 'live' | 'paper';
export type BotKind = 'grid' | 'trend' | 'lp' | 'token';
export type BotStatus = 'running' | 'paused' | 'stopped' | 'closed';

export interface TokenQty {
  symbol: string;
  amount: number;
  usd: number | null;
}

export interface EstimateBlock {
  d1: TokenQty[] | null;
  d7: TokenQty[] | null;
  d365: TokenQty[] | null;
  usd: { d1: number | null; d7: number | null; d365: number | null };
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
  startedAt: number | null;
  ageSec: number | null;
  capitalInUsd: number | null;
  currentValueUsd: number | null;
  /** Realized trade profit in USD. Null when the bot has no such figure. */
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  feesCollected: TokenQty[];
  feesOwed: TokenQty[];
  feesCollectedUsd: number | null;
  feesUncollectedUsd: number | null;
  gasUsd: number | null;
  swapCostUsd: number | null;
  /** Not in the owner snapshot. Stay null rather than zero. */
  tokenTaxesUsd: number | null;
  realizedRebalanceLossUsd: number | null;
  priceChangeUsd: number | null;
  /** Net token units. Empty when they cannot be split or are unknown. */
  generated: TokenQty[];
  generatedUsd: number | null;
  headline: 'generated';
  /** generatedUsd + priceChangeUsd. Sheet only. Null if either part is unknown. */
  totalPnlUsd: number | null;
  totalPnlPct: number | null;
  aprPct: number | null;
  est: EstimateBlock;
  moveCount: number | null;
  fillCount: number | null;
  range: RangeBlock | null;
  asOf: number;
  calc: string;
  /** Coins deposited, in the engine quote coin. Not dollars. */
  invested: TokenQty[];
  /** Fee coins before costs. LP only; empty when the bot has no split. */
  grossFees: TokenQty[];
  /** Gas plus swap cost, in the engine quote coin. */
  feesPaid: TokenQty[];
  /** Range-move loss, in the engine quote coin. */
  moveLoss: TokenQty[];
}

export interface CandleBar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface FillMark { id: string; t: number; price: number; side: 'buy' | 'sell' }

export interface BotDesk {
  metrics: BotMetrics;
  pair: string;
  base: string;
  quote: string;
  chain: string;
  /** Full chain name, for example Ethereum. */
  chainName: string;
  chainColor: string;
  dex: string;
  /** in / out / idle from the payload. "near" is only set when the server says so. */
  tone: 'in' | 'near' | 'out' | 'idle';
  spark: number[];
  levels: number[];
  candles: CandleBar[];
  fills: FillMark[];
  flashLevel: number | null;
  price: number | null;
  change24h: number | null;
  /** Pool fee in basis points, when the snapshot has one. */
  feeBps: number | null;
  /** When this bot's price was read. Used to pick one tape row per pool. */
  priceAt: number | null;
}

export interface TapePrice {
  symbol: string;
  chain: string;
  price: number | null;
  change24h: number | null;
  /** Set only when this pair has another pool on the same chain. */
  fee: string | null;
}

export interface ActivityItem {
  id: string;
  t: number;
  botId: string;
  /** Conventional base/quote, without a chain suffix. */
  pair: string;
  chain: string;
  kind: 'fill' | 'recenter' | 'fee';
  text: string;
  tone: 'up' | 'down' | 'flat';
}

export interface PortfolioSnapshot {
  asOf: number;
  /** Live bots, summed after each bot's dollars are rounded to cents. Null if a running live bot has no dollar figure. */
  generatedUsd: number | null;
  /** Sum of running live est.d1. Null when any running live bot has no D1 yet. */
  generatedPerDay: TokenQty[] | null;
  /** Sum of running live est.usd.d1. Null when any running live bot has no D1 yet. */
  generatedPerDayUsd: number | null;
  paperGeneratedUsd: number | null;
  tokens: TokenQty[];
  paperTokens: TokenQty[];
  priceChangeUsd: number | null;
  currentValueUsd: number | null;
  capitalInUsd: number | null;
  feesTodayLiveUsd: number | null;
  feesTodayPaperUsd: number | null;
  botsRunning: number;
  botsTotal: number;
  /** Real generated points only. Empty when the snapshot has no path. */
  madeSeries: number[];
}

export interface HoldingLine { symbol: string; amount: number; chain: string }

export interface DeskSnapshot {
  /** live: the bot server. snapshot: the gitignored owner file. fixture: the AAA/BBB sample. */
  source: 'live' | 'snapshot' | 'fixture';
  portfolio: PortfolioSnapshot;
  bots: BotDesk[];
  prices: TapePrice[];
  activity: ActivityItem[];
  /** Token balances only. Empty on the live stream, which does not carry a wallet. */
  holdings: HoldingLine[];
}

export interface DeskDelta {
  asOf: number;
  portfolio: PortfolioSnapshot;
  /** Bots to add or replace, keyed by metrics.botId. Empty means no bot edits. */
  bots: BotDesk[];
  /** Bot ids that left the desk. Empty means nobody was removed. */
  removedIds?: string[];
  prices: TapePrice[];
  activity: ActivityItem[];
}
