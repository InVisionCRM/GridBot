/**
 * Uniswap V3 exact-in math across tick ranges (pure, no network).
 *
 * Inside one range the pool is a constant-product pool of the virtual reserves L/√P and L·√P. That is what the
 * $100/$500/$1000 display and the sizing cap use. A trade that leaves the range is not: the next range can have
 * much less liquidity, so the constant-product number understates the impact. This walk is that cross-range quote.
 *
 * The live check does not scan ticks. It asks QuoterV2 for the sized trade (one eth_call, the chain's own walk)
 * and turns the result into an impact with v3Impact. This module is the same math, for tests and for a quote
 * when the ranges are already known.
 */
import { v3Impact } from './v3Math';

export interface V3Range {
  /** √(raw token1 per raw token0) at the lower tick. */
  sqrtLower: number;
  sqrtUpper: number;
  liquidity: number;
}

export interface V3ExactIn {
  ranges: readonly V3Range[];
  sqrtPrice: number;
  /** Raw amount of the input token, before the LP fee. */
  amountIn: number;
  /** Fee tier in hundredths of a bip (3000 = 0.3%). */
  feePips: number;
  /** token0 in, price moves down. */
  zeroForOne: boolean;
}

export interface V3SwapResult {
  amountOut: number;
  sqrtPriceAfter: number;
  /** Ranges left behind. 0 means the trade stayed in the active range. */
  crossed: number;
}

/**
 * Exact-in through contiguous ranges. Output is what the swapper receives (fee taken from the input).
 * Stops at the last range it was given: input that does not fit produces no further output.
 */
export function v3ExactIn(o: V3ExactIn): V3SwapResult {
  if (!(o.amountIn > 0) || !(o.sqrtPrice > 0)) throw new Error('amount and price must be positive');
  if (!(o.feePips >= 0) || o.feePips >= 1_000_000) throw new Error('bad fee tier');
  const ranges = [...o.ranges].sort((a, b) => a.sqrtLower - b.sqrtLower);
  const feeFactor = (1_000_000 - o.feePips) / 1_000_000;
  let idx = o.zeroForOne
    ? ranges.findIndex((r) => o.sqrtPrice > r.sqrtLower && o.sqrtPrice <= r.sqrtUpper)
    : ranges.findIndex((r) => o.sqrtPrice >= r.sqrtLower && o.sqrtPrice < r.sqrtUpper);
  if (idx < 0) throw new Error('price is outside the ranges');
  let sqrtP = o.sqrtPrice;
  let remaining = o.amountIn;
  let out = 0;
  let crossed = 0;
  for (let step = 0; step < ranges.length + 1 && remaining > 1e-12; step++) {
    const range = ranges[idx];
    const target = o.zeroForOne ? range.sqrtLower : range.sqrtUpper;
    const toward = o.zeroForOne ? -1 : 1;
    if (!(range.liquidity > 0) || Math.abs(sqrtP - target) < 1e-18) {
      sqrtP = target;
      crossed++;
      idx += toward;
      if (idx < 0 || idx >= ranges.length) break;
      continue;
    }
    const L = range.liquidity;
    const feeIn = remaining * feeFactor;
    if (o.zeroForOne) {
      const maxIn = L * (sqrtP - target) / (sqrtP * target);
      if (feeIn < maxIn) {
        const next = (L * sqrtP) / (L + feeIn * sqrtP);
        out += L * (sqrtP - next);
        sqrtP = next;
        remaining = 0;
      } else {
        out += L * (sqrtP - target);
        remaining -= maxIn / feeFactor;
        sqrtP = target;
        crossed++;
        idx += toward;
        if (idx < 0 || idx >= ranges.length) break;
      }
    } else {
      const maxIn = L * (target - sqrtP);
      if (feeIn < maxIn) {
        const next = sqrtP + feeIn / L;
        out += L * (next - sqrtP) / (sqrtP * next);
        sqrtP = next;
        remaining = 0;
      } else {
        out += L * (target - sqrtP) / (sqrtP * target);
        remaining -= maxIn / feeFactor;
        sqrtP = target;
        crossed++;
        idx += toward;
        if (idx < 0 || idx >= ranges.length) break;
      }
    }
  }
  return { amountOut: Math.max(0, out), sqrtPriceAfter: sqrtP, crossed };
}

/** Constant-product quote of the active range only, as if its liquidity continued forever. */
export function v3ActiveRangeOut(sqrtPrice: number, liquidity: number, amountIn: number, feePips: number, zeroForOne: boolean): number {
  const feeFactor = (1_000_000 - feePips) / 1_000_000;
  const dx = amountIn * feeFactor;
  const r0 = liquidity / sqrtPrice;
  const r1 = liquidity * sqrtPrice;
  if (zeroForOne) return r1 * dx / (r0 + dx);
  return r0 * dx / (r1 + dx);
}

/** Impact vs the mid, fee removed, matching v3Impact / QuoterV2. */
export function v3AmountImpact(amountIn: number, amountOut: number, sqrtPrice: number, feePips: number, zeroForOne: boolean): number {
  const price = sqrtPrice * sqrtPrice;
  const mid = zeroForOne ? price : 1 / price;
  return v3Impact(BigInt(Math.round(amountIn)), BigInt(Math.round(amountOut)), mid, feePips / 100);
}
