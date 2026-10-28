/**
 * Plays JSONL contract (pure types). Nothing in here is wired into the running bot.
 *
 * Candidates and vetted rows are the team's contract. Paper-trade rows are one fill each.
 * Scorekeeper fields sit on the same paper-trade row so a closed play can be read without a join.
 * Percents on a vetted row (`maxImpactPct`, `stopLossPct`, `tpPct`) are percent numbers net of fees
 * (1 = 1%). Taxes are fractions (0.01 = 1%), the same unit as src/live/tax.ts.
 */

/** Swap fee in basis points (100 = 1%), or `dynamic` when the pool has no fixed tier. */
export type FeeTier = number | 'dynamic';

export const SIGNALS = ['momentum', 'volume_spike', 'liq_growth', 'smart_wallet', 'x_buzz'] as const;
export type Signal = (typeof SIGNALS)[number];

/** Signals that may open a play. `x_buzz` is context and is never a trigger by itself. */
export const NON_X_SIGNALS = ['momentum', 'volume_spike', 'liq_growth', 'smart_wallet'] as const;
export type NonXSignal = (typeof NON_X_SIGNALS)[number];

/** Wire values are V2, V3, V4. The parser also accepts the lowercase spellings. */
export const POOL_KINDS = ['V2', 'V3', 'V4'] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

export const LAUNCHPADS = ['PumpPill', 'Arrow'] as const;
export type LaunchpadId = (typeof LAUNCHPADS)[number];

export const PAPER_TRADE_SCHEMA_VERSION = 1;

export const EXIT_REASONS = [
  'stop_loss', 'trailing_tp', 'time_stop', 'signal_decay',
  'sell_sim_failed', 'tax_rose', 'liq_pulled', 'manual', 'migration',
] as const;

export interface Candidate {
  id: string;
  /** Unix epoch milliseconds. */
  t: number;
  chainId: number;
  pool: string;
  dex: string;
  token: string;
  quote: string;
  signal: Signal;
  /** 0–1. X fields never raise this. */
  strength: number;
  /** Quote per token at the flag. */
  priceAtFlag: number;
  priceSource: string;
  liqUsd: number;
  vol24hUsd: number;
  /** Hours. */
  poolAgeH: number;
  thesis: string;
  /**
   * Basis points (100 = 1%) or `dynamic`. A raw Uniswap `fee()` (10000 = 1%) is not this unit.
   * `dynamic` must be replaced with the fee actually charged. It is never filled in as 1 bp.
   */
  feeTier: FeeTier;
  poolKind: PoolKind;
  xMentions?: number;
  xUniqueAuthors?: number;
  /** −1..1. Context only. */
  xSentiment?: number;
  redFlags: string[];
  launchpad?: string;
  /** 0–1. Below 1 the token is still on the bonding curve. */
  curveProgress?: number;
  /** `rejected` is skipped at intake. Any other status is recorded and does not by itself block. */
  status?: string;
  rejectReason?: string;
}

export interface VettedTaxes {
  /** Fraction 0–1. */
  buy: number;
  sell: number;
  transfer: number;
}

export interface Vetted {
  candidateId: string;
  /** Unix epoch milliseconds. */
  t: number;
  pass: boolean;
  reasons: string[];
  sizeUsd: number;
  /** Percent number, net of fees. 1 = 1%. */
  maxImpactPct: number;
  /** Percent number, net of fees. 25 = a 25% net loss. */
  stopLossPct: number;
  /** Percent numbers, net of fees. */
  tpPct: number[];
  timeStopH: number;
  taxes: VettedTaxes;
  launchpad?: string;
  /**
   * Liquidity can be pulled. When true, a pass is paper-only and the size is cut in half.
   * Absent means the officer did not flag it.
   */
  lpUnlocked?: boolean;
}

export interface PaperCosts {
  /** Quote units. This leg's pool fee (size × fee on a buy, tokens × mid × fee on a sell). */
  swapFee: number;
  /** Native coin, including the L1 data fee on Robinhood Chain. */
  gasNative: number;
  /** Quote units. */
  tax: number;
  /** Fraction 0–1. */
  impact: number;
}

/**
 * One fill. Buys have `exitReason: null`. The sum of `netTokens` across a play's rows is the
 * quote-coin result after fees, taxes, impact and gas.
 */
export interface PaperTradeRow {
  id: string;
  candidateId: string;
  /** Fill time, unix epoch milliseconds. */
  t: number;
  side: 'buy' | 'sell';
  /** Effective fill price, quote per token, after fee, impact and tax. */
  price: number;
  /** Human token units. On a buy this is what the wallet kept after tax. */
  tokens: number;
  costs: PaperCosts;
  exitReason: string | null;
  /** Signed quote-coin change, net of gas converted into the quote coin. */
  netTokens: number;
  schemaVersion?: number;
  playId?: string;
  signalType?: Signal;
  source?: string;
  token?: string;
  pool?: string;
  entryTs?: number;
  exitTs?: number;
  feeTierEntry?: FeeTier;
  feeTierExit?: FeeTier;
  /** Fractions 0–1. */
  impactEntry?: number;
  impactExit?: number;
  gasUsed?: number;
  gasPrice?: number;
  /** Size in the coin that was spent. */
  sizeSpent?: number;
  /** Net target, percent number. */
  targetPct?: number;
  /** Net stop, percent number. */
  stopPct?: number;
  /** Sell tax actually taken, fraction 0–1. */
  sellTaxTaken?: number;
}

/** Scorekeeper columns. Present together on a closed-play row; absent on a bare fill. */
export const SCOREKEEPER_FIELDS = [
  'playId', 'signalType', 'source', 'token', 'pool', 'entryTs', 'exitTs',
  'feeTierEntry', 'feeTierExit', 'impactEntry', 'impactExit', 'gasUsed', 'gasPrice',
  'sizeSpent', 'targetPct', 'stopPct', 'sellTaxTaken', 'schemaVersion',
] as const;

export type ScorekeeperField = (typeof SCOREKEEPER_FIELDS)[number];
