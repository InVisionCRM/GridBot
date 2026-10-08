/** Live-trade guards: price-impact cap, slippage, deadline. No dollar limits. */

export interface SafetyLimits {
  /** Max price impact as a fraction (0.03 = 3%) */
  maxPriceImpact: number;
  /** Slippage tolerance in basis points (100 = 1%) */
  slippageBps: number;
  /** Transaction deadline in minutes */
  deadlineMinutes: number;
  /** Native-spending markets (flipped HEX/PLS …): fraction of capital kept for gas (default 2 %, see gasReserve.ts) */
  gasReservePct?: number;
  /** …and/or a fixed native floor (e.g. 5000 PLS); reserve = max(pct × capital, fixed) */
  gasReserveNative?: number;
}

export const DEFAULT_LIMITS: SafetyLimits = {
  maxPriceImpact: 0.03,
  slippageBps: 100,
  deadlineMinutes: 10,
};

/** Upper bounds the settings will not exceed. */
export const HARD_CAPS = {
  maxPriceImpact: 0.05,
  slippageBps: 500,
  deadlineMinutes: 60,
};

/** Live mode opens on PulseChain mainnet; testnet is an optional choice in the network dropdown. */
export const DEFAULT_LIVE_NETWORK = 'mainnet' as const;

export function validateLimits(l: SafetyLimits): string[] {
  const e: string[] = [];
  if (!(l.maxPriceImpact > 0) || l.maxPriceImpact > HARD_CAPS.maxPriceImpact) e.push('Price-impact cap must be between 0% and 5%.');
  if (!Number.isInteger(l.slippageBps) || l.slippageBps < 1 || l.slippageBps > HARD_CAPS.slippageBps) e.push('Slippage must be between 0.01% and 5%.');
  if (!(l.deadlineMinutes >= 1 && l.deadlineMinutes <= HARD_CAPS.deadlineMinutes)) e.push('Deadline must be 1–60 minutes.');
  if (l.gasReservePct != null && !(l.gasReservePct >= 0 && l.gasReservePct <= 0.5)) e.push('Gas reserve must be 0–50% of capital.');
  if (l.gasReserveNative != null && !(l.gasReserveNative >= 0 && Number.isFinite(l.gasReserveNative))) e.push('Fixed gas reserve must be ≥ 0.');
  return e;
}

export interface TradeCheckInput {
  side: 'buy' | 'sell';
  tradeUsd: number;
  priceImpact: number;
  killSwitch: boolean;
  walletOnCorrectChain: boolean;
  priceIsOnChain: boolean;
  /** Grid sells only: PLS this trade sells, and PLS the bot itself bought (it never sells other PLS) */
  plsToSell?: number;
  plsHeldByBot?: number;
  /** One-off manual trade: not tied to bot inventory */
  manual?: boolean;
}

export interface CheckResult {
  ok: boolean;
  reasons: string[];
}

/** Every reason here blocks the trade. */
export function checkTrade(i: TradeCheckInput, l: SafetyLimits): CheckResult {
  const r: string[] = [];
  if (i.killSwitch) r.push('Kill switch is on.');
  if (!i.walletOnCorrectChain) r.push('RPC is on a different chain.');
  if (!i.priceIsOnChain) r.push('On-chain price unavailable.');
  if (!(i.tradeUsd > 0)) r.push('Trade size must be > 0.');
  if (!i.manual && i.side === 'sell' && i.plsToSell != null && i.plsHeldByBot != null && i.plsToSell > i.plsHeldByBot * 1.000001 + 1e-9) {
    r.push(`Sell (${i.plsToSell.toFixed(2)} PLS) exceeds PLS bought by the bot (${i.plsHeldByBot.toFixed(2)}).`);
  }
  if (i.priceImpact > l.maxPriceImpact) {
    r.push(`Price impact ${(i.priceImpact * 100).toFixed(2)}% > ${(l.maxPriceImpact * 100).toFixed(1)}% cap.`);
  }
  return { ok: r.length === 0, reasons: r };
}
