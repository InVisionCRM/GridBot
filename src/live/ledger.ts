/** Live trade records + realized PnL including gas. Pure functions; persisted by the UI. */
import type { NetworkKey } from './networks';

export interface LiveTrade {
  id: string;
  /** 'mainnet'/'testnet' for legacy PulseChain trades; chain key (e.g. 'ethereum') otherwise */
  network: NetworkKey | string;
  side: 'buy' | 'sell';
  intervalIndex: number;
  /** Start-up buy: the levels above the start price it bought coins for (split between them) */
  seed?: number[];
  stable: string;
  /** PLS amount bought or sold (human units) */
  plsAmount: number;
  /** Stablecoin amount spent (buy) or received (sell) */
  stableAmount: number;
  /** Execution price, stable per PLS */
  price: number;
  /** Gas paid in PLS for this trade (approval + swap) */
  gasPls: number;
  /** Gas in the quote coin at the time of the trade (was `gasUsd`, which was never dollars) */
  gasQuote: number;
  txHash: string;
  approvalTxHash?: string;
  timestamp: number;
  /** Realized PnL incl. gas (sells only; buys = 0, their gas sits in the cost basis). Failed = −gas. */
  realizedPnlQuote: number;
  /** Transaction reverted/rejected after gas was spent. No tokens moved; only the gas is lost. */
  failed?: boolean;
  /** Manual trade: counts gas, but not part of the grid position/PnL */
  manual?: boolean;
  /** A sale of a close: in the position and PnL, not a grid round trip */
  closeSale?: boolean;
  /** Simulated (paper mode) fill */
  paper?: boolean;
  /** DEX/version + pool fee the fill executed on (e.g. 'pulsex-v1', 29 bps; V3 adds feeTier). Absent on old fills = PulseX V2. */
  dex?: string;
  feeBps?: number;
  feeTier?: number;
  /** Combined token tax applied on this swap (fraction), when the token is taxed */
  taxPct?: number;
  /** Where the received amount came from: the receipt's net transfers (actual, after tax) · amountOutMin · paper ('balance': older fills, the wallet's balance change) */
  outSource?: 'balance' | 'log' | 'minOut' | 'paper';
  /** Expected post-tax output from the quote (to compare with the actual amount received) */
  expectedOut?: number;
  note?: string;
  /** Gas could not be converted to base units when this swap was reconciled: gasPls/gasUsd are 0, not the real cost */
  gasUnknown?: boolean;
  // ── Per-fill diagnostics (all prices quote per PLS, amounts in quote units) ──
  /** getPrice() when the level was crossed */
  triggerPrice?: number;
  /** Grid level that triggered */
  levelPrice?: number;
  /** Effective price of the router quote used to build the tx (amountIn/out) */
  quotedPrice?: number;
  /** Executed price from receipt amounts (stableAmount / plsAmount) */
  execPrice?: number;
  /** Adverse slippage vs quote (+ = worse than quoted) */
  slippagePct?: number;
  /** Output read from receipt logs (false = fell back to amountOutMin) */
  fromReceipt?: boolean;
  /** LP fee paid on this swap, in quote units */
  feeQuote?: number;
  /** buy: lot cost basis (spent + gas). sell: cost of the matched lot being sold */
  lotCost?: number;
  /** sell: matched buy→sell round-trip net (proceeds − sell gas − lot cost) */
  roundTripNet?: number;
  /** sell: part of closing / stopping the grid (a cash-out at market), not a grid round trip */
  closeOut?: boolean;
}

/**
 * A cash-out sale made while closing / stopping the grid: the free coins (interval −1) or a level sold at market.
 * Its result is a liquidation at the price of the day, not grid output, so it is not a round trip.
 */
export function isCloseOut(t: Pick<LiveTrade, 'side' | 'intervalIndex'> & { closeOut?: boolean; closeSale?: boolean }): boolean {
  return t.side === 'sell' && (!!t.closeOut || !!t.closeSale || t.intervalIndex < 0);
}

export interface Position {
  plsHeld: number;
  /** Total quote-coin cost of the base coin held, including buy gas */
  costQuote: number;
}

export function emptyPosition(): Position {
  return { plsHeld: 0, costQuote: 0 };
}

/** Apply a buy: adds PLS and cost (stable spent + gas). */
export function applyBuy(pos: Position, plsAmount: number, stableSpent: number, gasQuote: number): Position {
  return { plsHeld: pos.plsHeld + plsAmount, costQuote: pos.costQuote + stableSpent + gasQuote };
}

/**
 * Apply a sell. Uses the matched lot's cost when given (grid sells always sell one interval's lot),
 * otherwise average cost. Returns new position and realized PnL (proceeds − cost − sell gas).
 */
export function applySell(pos: Position, plsAmount: number, stableReceived: number, gasQuote: number, lotCost?: number): { pos: Position; realized: number } {
  if (plsAmount <= 0) throw new Error('Sell amount must be positive');
  const sold = Math.min(plsAmount, pos.plsHeld);
  const avg = pos.plsHeld > 0 ? pos.costQuote / pos.plsHeld : 0;
  const cost = lotCost != null && lotCost > 0 ? Math.min(lotCost, pos.costQuote) : avg * sold;
  const realized = stableReceived - cost - gasQuote;
  return { pos: { plsHeld: pos.plsHeld - sold, costQuote: Math.max(0, pos.costQuote - cost) }, realized };
}

/** Rebuild the position from a trade history (oldest first). */
export function replay(trades: LiveTrade[]): Position {
  let pos = emptyPosition();
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.failed || t.manual) continue;
    if (t.side === 'buy') pos = applyBuy(pos, t.plsAmount, t.stableAmount, t.gasQuote);
    else pos = applySell(pos, t.plsAmount, t.stableAmount, t.gasQuote, t.lotCost).pos;
  }
  return pos;
}

export function totals(trades: LiveTrade[], price: number | null) {
  const pos = replay(trades);
  // Manual test trades only cost gas from the grid's point of view
  const realized = trades.reduce((s, t) => s + (t.manual ? -t.gasQuote : t.realizedPnlQuote), 0);
  const gasQuote = trades.reduce((s, t) => s + t.gasQuote, 0);
  const unrealized = price != null ? pos.plsHeld * price - pos.costQuote : 0;
  return { pos, realized, gasQuote, unrealized };
}

/** Per-grid round-trip stats (quote units). */
export function roundTripStats(trades: LiveTrade[]) {
  const ok = trades.filter((t) => !t.failed && !t.manual);
  const sells = ok.filter((t) => t.side === 'sell' && !isCloseOut(t));
  const closeOuts = ok.filter((t) => isCloseOut(t));
  const nets = sells.map((t) => t.roundTripNet ?? t.realizedPnlQuote);
  const totalNet = nets.reduce((a, b) => a + b, 0);
  // Gas lost on failed and manual test trades is a cost of running the grid, so it comes off what the grid generated.
  const lostGas = trades.filter((t) => t.failed || t.manual).reduce((a, t) => a + t.gasQuote, 0);
  const slips = ok.filter((t) => t.slippagePct != null).map((t) => t.slippagePct!);
  return {
    roundTrips: sells.length,
    wins: nets.filter((n) => n > 0).length,
    totalNet,
    avgNet: sells.length ? totalNet / sells.length : 0,
    /** Round-trip profit minus gas lost on failed / manual trades (quote coin). Cash-out sales are not in it. */
    generated: totalNet - lostGas,
    closeOuts: closeOuts.length,
    closeOutNet: closeOuts.reduce((a, t) => a + (t.roundTripNet ?? t.realizedPnlQuote), 0),
    totalFees: ok.reduce((s, t) => s + (t.feeQuote ?? 0), 0),
    totalGas: trades.reduce((s, t) => s + t.gasQuote, 0),
    avgSlippagePct: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : 0,
  };
}

/*
 * Quote-coin fields were once named *Usd (totalCapitalUsd, usdPerBuy, costUsd, trades' gasUsd / realizedPnlUsd) but always
 * held quote-coin amounts: a HEX/PLS grid's "totalCapitalUsd 14,000,000" is PLS. They are now *Quote. Saved state and API
 * bodies with the old names are read through these helpers; status() also repeats the old names (see withLegacyNames)
 * so existing API readers keep working. The old names are deprecated and still hold quote-coin amounts.
 */
type Loose = Record<string, unknown>;
const moveKey = (o: Loose, from: string, to: string): Loose => {
  if (!(from in o)) return o;
  const { [from]: v, ...rest } = o;
  return to in rest ? rest : { ...rest, [to]: v };
};

/** A saved trade with old field names → current names. Idempotent. */
export function upgradeTradeNames<T>(t: T): T {
  if (!t || typeof t !== 'object') return t;
  return moveKey(moveKey(t as Loose, 'gasUsd', 'gasQuote'), 'realizedPnlUsd', 'realizedPnlQuote') as T;
}

/** A saved grid config / start body with `totalCapitalUsd` → `totalCapitalQuote`. Idempotent. */
export function upgradeConfigNames<T>(c: T): T {
  if (!c || typeof c !== 'object') return c;
  return moveKey(c as Loose, 'totalCapitalUsd', 'totalCapitalQuote') as T;
}

/** A saved grid or trend state with old names anywhere (config, usdPerBuy, trades) → current names. Idempotent. */
export function upgradeQuoteNames<T>(s: T): T {
  if (!s || typeof s !== 'object') return s;
  let o = moveKey(s as Loose, 'usdPerBuy', 'quotePerBuy');
  if (o.config && typeof o.config === 'object') o = { ...o, config: upgradeConfigNames(o.config) };
  if (Array.isArray(o.trades)) o = { ...o, trades: o.trades.map(upgradeTradeNames) };
  return o as T;
}

/** Deprecated aliases for API readers of the old names (same quote-coin values). */
export function legacyTradeNames<T extends { gasQuote: number; realizedPnlQuote: number }>(t: T): T & { gasUsd: number; realizedPnlUsd: number } {
  return { ...t, gasUsd: t.gasQuote, realizedPnlUsd: t.realizedPnlQuote };
}
