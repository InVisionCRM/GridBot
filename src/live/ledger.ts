/** Live trade records + realized PnL including gas. Pure functions; persisted by the UI. */
import type { NetworkKey } from './networks';

export interface LiveTrade {
  id: string;
  /** 'mainnet'/'testnet' for legacy PulseChain trades; chain key (e.g. 'base') otherwise */
  network: NetworkKey | string;
  side: 'buy' | 'sell';
  intervalIndex: number;
  stable: string;
  /** PLS amount bought or sold (human units) */
  plsAmount: number;
  /** Stablecoin amount spent (buy) or received (sell) */
  stableAmount: number;
  /** Execution price, stable per PLS */
  price: number;
  /** Gas paid in PLS for this trade (approval + swap) */
  gasPls: number;
  /** Gas in USD at the time of the trade */
  gasUsd: number;
  txHash: string;
  approvalTxHash?: string;
  timestamp: number;
  /** Realized PnL incl. gas (sells only; buys = 0, their gas sits in the cost basis). Failed = −gas. */
  realizedPnlUsd: number;
  /** Transaction reverted/rejected after gas was spent. No tokens moved; only the gas is lost. */
  failed?: boolean;
  /** Manual trade: counts gas, but not part of the grid position/PnL */
  manual?: boolean;
  /** Simulated (paper mode) fill */
  paper?: boolean;
  /** DEX/version + pool fee the fill executed on (e.g. 'pulsex-v1', 29 bps; V3 adds feeTier). Absent on old fills = PulseX V2. */
  dex?: string;
  feeBps?: number;
  feeTier?: number;
  /** Combined token tax applied on this swap (fraction), when the token is taxed */
  taxPct?: number;
  /** Where the received amount came from: wallet balance change (actual, after tax) · Transfer log · amountOutMin · paper */
  outSource?: 'balance' | 'log' | 'minOut' | 'paper';
  /** Expected post-tax output from the quote (to compare with the actual amount received) */
  expectedOut?: number;
  note?: string;
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
}

export interface Position {
  plsHeld: number;
  /** Total USD cost of the PLS held, including buy gas */
  costUsd: number;
}

export function emptyPosition(): Position {
  return { plsHeld: 0, costUsd: 0 };
}

/** Apply a buy: adds PLS and cost (stable spent + gas). */
export function applyBuy(pos: Position, plsAmount: number, stableSpent: number, gasUsd: number): Position {
  return { plsHeld: pos.plsHeld + plsAmount, costUsd: pos.costUsd + stableSpent + gasUsd };
}

/**
 * Apply a sell. Uses the matched lot's cost when given (grid sells always sell one interval's lot),
 * otherwise average cost. Returns new position and realized PnL (proceeds − cost − sell gas).
 */
export function applySell(pos: Position, plsAmount: number, stableReceived: number, gasUsd: number, lotCost?: number): { pos: Position; realized: number } {
  if (plsAmount <= 0) throw new Error('Sell amount must be positive');
  const sold = Math.min(plsAmount, pos.plsHeld);
  const avg = pos.plsHeld > 0 ? pos.costUsd / pos.plsHeld : 0;
  const cost = lotCost != null && lotCost > 0 ? Math.min(lotCost, pos.costUsd) : avg * sold;
  const realized = stableReceived - cost - gasUsd;
  return { pos: { plsHeld: pos.plsHeld - sold, costUsd: Math.max(0, pos.costUsd - cost) }, realized };
}

/** Rebuild the position from a trade history (oldest first). */
export function replay(trades: LiveTrade[]): Position {
  let pos = emptyPosition();
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.failed || t.manual) continue;
    if (t.side === 'buy') pos = applyBuy(pos, t.plsAmount, t.stableAmount, t.gasUsd);
    else pos = applySell(pos, t.plsAmount, t.stableAmount, t.gasUsd, t.lotCost).pos;
  }
  return pos;
}

export function totals(trades: LiveTrade[], price: number | null) {
  const pos = replay(trades);
  // Manual test trades only cost gas from the grid's point of view
  const realized = trades.reduce((s, t) => s + (t.manual ? -t.gasUsd : t.realizedPnlUsd), 0);
  const gasUsd = trades.reduce((s, t) => s + t.gasUsd, 0);
  const unrealized = price != null ? pos.plsHeld * price - pos.costUsd : 0;
  return { pos, realized, gasUsd, unrealized };
}

/** Per-grid round-trip stats (quote units). */
export function roundTripStats(trades: LiveTrade[]) {
  const ok = trades.filter((t) => !t.failed && !t.manual);
  const sells = ok.filter((t) => t.side === 'sell');
  const nets = sells.map((t) => t.roundTripNet ?? t.realizedPnlUsd);
  const totalNet = nets.reduce((a, b) => a + b, 0);
  const slips = ok.filter((t) => t.slippagePct != null).map((t) => t.slippagePct!);
  return {
    roundTrips: sells.length,
    wins: nets.filter((n) => n > 0).length,
    totalNet,
    avgNet: sells.length ? totalNet / sells.length : 0,
    totalFees: ok.reduce((s, t) => s + (t.feeQuote ?? 0), 0),
    totalGas: trades.reduce((s, t) => s + t.gasUsd, 0),
    avgSlippagePct: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : 0,
  };
}
