/**
 * Net-of-cost prices for a play (pure). The pool fee is an argument on every call.
 * There is no default tier: a 1% pool is 100 bps because the caller read it, and a dynamic
 * or missing tier is refused rather than filled in as 1 bp (0.01%).
 *
 *   N = S · (1−f_b) · (1−i_b) · (1−t_b) / P0
 *   Q = N · P · (1−f_s) · (1−i_s) · (1−t_s)
 *   K = (1−f_b)(1−i_b)(1−t_b)·(1−f_s)(1−i_s)(1−t_s)
 *   g = (G_in + G_out) / S
 *   R = (P/P0)·K − 1 − g
 *   P* / P0 = (1 + R* + g) / K
 *
 * With a 1% fee each way and nothing else, K = 0.99² = 0.9801, so the mid has to rise about
 * 2.03% to net zero. The round-trip cost (the fraction of size lost if the mid does not move)
 * is 1 − K + g, about 1.99% in that same case. Those two numbers are not the same.
 */
import { v3FeeBps } from '../live/chains';
import type { FeeTier } from './types';

export interface LegCost {
  /** Swap-fee fraction for this leg. Required. 0.01 is a 1% pool. */
  fee: number;
  /** Price-impact fraction for this leg. */
  impact: number;
  /** Token-tax fraction for this leg. */
  tax: number;
  /** Gas for this leg, already converted to quote units. */
  gasQuote: number;
}

export interface RoundTripInput {
  /** Quote spent on the entry, S. */
  size: number;
  entry: LegCost;
  exit: LegCost;
}

export interface RoundTrip {
  /** Product of both legs' keep-factors. */
  k: number;
  /** Both legs' gas as a fraction of size. */
  g: number;
  /** Fraction of size lost when the mid does not move: 1 − K + g. */
  costFrac: number;
  /** Gross mid rise that nets zero: (1+g)/K − 1. */
  breakEvenMove: number;
}

const openUnit = (n: number) => Number.isFinite(n) && n >= 0 && n < 1;

function legOk(leg: LegCost): boolean {
  return openUnit(leg.fee) && openUnit(leg.impact) && openUnit(leg.tax) && Number.isFinite(leg.gasQuote) && leg.gasQuote >= 0;
}

/** Share of a leg that survives the fee, the impact and the tax. */
export function keepFactor(leg: Pick<LegCost, 'fee' | 'impact' | 'tax'>): number {
  return (1 - leg.fee) * (1 - leg.impact) * (1 - leg.tax);
}

/**
 * Uniswap `fee()` is hundredths of a bip (10000 = 1%). This divides by 100, the same conversion
 * as `v3FeeBps`. It does not pick a tier when the read is missing.
 */
export function feeBpsFromUniswapFee(fee: number): number | null {
  if (!Number.isFinite(fee) || fee < 0) return null;
  const bps = v3FeeBps(fee);
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10_000) return null;
  return bps;
}

/** Basis points to a fraction. 100 → 0.01. Returns null for a non-fee. */
export function feeFraction(feeBps: number): number | null {
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= 10_000) return null;
  return feeBps / 10_000;
}

/**
 * Fraction for a stored tier. `dynamic` and an unreadable number return null.
 * Null is not 1 bp.
 */
export function resolveFeeFraction(tier: FeeTier): number | null {
  if (tier === 'dynamic') return null;
  return feeFraction(tier);
}

export function roundTrip(input: RoundTripInput): RoundTrip | null {
  if (!(input.size > 0) || !legOk(input.entry) || !legOk(input.exit)) return null;
  const k = keepFactor(input.entry) * keepFactor(input.exit);
  if (!(k > 0)) return null;
  const g = (input.entry.gasQuote + input.exit.gasQuote) / input.size;
  return { k, g, costFrac: 1 - k + g, breakEvenMove: (1 + g) / k - 1 };
}

export function roundTripFromTiers(p: {
  size: number;
  entryTier: FeeTier;
  exitTier: FeeTier;
  impactEntry: number;
  impactExit: number;
  taxEntry: number;
  taxExit: number;
  gasQuoteEntry: number;
  gasQuoteExit: number;
}): RoundTrip | { error: string } {
  const feeEntry = resolveFeeFraction(p.entryTier);
  const feeExit = resolveFeeFraction(p.exitTier);
  if (feeEntry == null || feeExit == null) {
    return { error: 'Fee tier is dynamic or unreadable. Pass the fee the pool actually charged. Refusing to assume 0.01%.' };
  }
  const rt = roundTrip({
    size: p.size,
    entry: { fee: feeEntry, impact: p.impactEntry, tax: p.taxEntry, gasQuote: p.gasQuoteEntry },
    exit: { fee: feeExit, impact: p.impactExit, tax: p.taxExit, gasQuote: p.gasQuoteExit },
  });
  return rt ?? { error: 'Round-trip inputs are not usable.' };
}

/** True when the round-trip cost is over the cap. The cap itself is allowed; a dust of floating-point error is not an exceed. */
export function roundTripTooCostly(costFrac: number, maxFrac: number): boolean {
  return Number.isFinite(costFrac) && costFrac > maxFrac + 1e-9;
}

/** Tokens kept after the entry fee, impact and tax. Gas is not taken out of the token amount. */
export function tokensBought(size: number, mid: number, entry: LegCost): number | null {
  if (!(size > 0) || !(mid > 0) || !legOk(entry)) return null;
  return size * keepFactor(entry) / mid;
}

/** Quote proceeds before gas, at the current mid. */
export function proceeds(tokens: number, mid: number, exit: LegCost): number | null {
  if (!(tokens > 0) || !(mid > 0) || !legOk(exit)) return null;
  return tokens * mid * keepFactor(exit);
}

/** Net return R at `midNow`, given the entry mid. Same number as (Q − gas) / S − 1. */
export function netReturn(p: RoundTripInput & { midEntry: number; midNow: number }): number | null {
  const rt = roundTrip(p);
  if (!rt || !(p.midEntry > 0) || !(p.midNow > 0)) return null;
  return (p.midNow / p.midEntry) * rt.k - 1 - rt.g;
}

/** Mid at which the net return equals `netTarget` (a fraction; −0.25 is a 25% net loss). */
export function triggerPrice(midEntry: number, netTarget: number, rt: Pick<RoundTrip, 'k' | 'g'>): number | null {
  if (!(midEntry > 0) || !(rt.k > 0) || !Number.isFinite(netTarget) || !Number.isFinite(rt.g)) return null;
  const price = midEntry * (1 + netTarget + rt.g) / rt.k;
  return price > 0 ? price : null;
}

/** `stopLossPct` is a percent number, net of fees (25 fires after a 25% net loss). */
export function stopTriggerPrice(midEntry: number, stopLossPct: number, rt: Pick<RoundTrip, 'k' | 'g'>): number | null {
  if (!(stopLossPct > 0)) return null;
  return triggerPrice(midEntry, -stopLossPct / 100, rt);
}

/** `tpPct` is a percent number, net of fees. */
export function takeProfitTriggerPrice(midEntry: number, tpPct: number, rt: Pick<RoundTrip, 'k' | 'g'>): number | null {
  if (!(tpPct > 0)) return null;
  return triggerPrice(midEntry, tpPct / 100, rt);
}

/**
 * Trailing exit on net return. Arms when `peakNet >= trailArm`.
 * The exit net is (1+peakNet)·(1−trailGap) − 1. Fractions, not percents.
 * Returns null when the trail is not armed.
 */
export function trailingTriggerPrice(
  midEntry: number, peakNet: number, trailArm: number, trailGap: number, rt: Pick<RoundTrip, 'k' | 'g'>,
): number | null {
  if (!(peakNet >= trailArm) || !(trailGap >= 0) || !(trailGap < 1)) return null;
  const netAtExit = (1 + peakNet) * (1 - trailGap) - 1;
  return triggerPrice(midEntry, netAtExit, rt);
}
