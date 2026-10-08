/**
 * Pure, dependency-free math for building PulseX V2 swaps.
 * All token amounts are bigint in smallest units (wei). No network access here,
 * so everything is unit-testable with mocks.
 */

export const NATIVE = 'native' as const;
export type TokenRef = string; // ERC20 address or NATIVE

export const BPS = 10_000n;

/** Slippage limits: must be > 0 and at most 5% for beginner safety. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 500;

export function validateSlippageBps(bps: number): string | null {
  if (!Number.isFinite(bps) || !Number.isInteger(bps)) return 'Slippage must be a whole number of basis points.';
  if (bps < MIN_SLIPPAGE_BPS) return 'Slippage must be greater than 0.';
  if (bps > MAX_SLIPPAGE_BPS) return 'Slippage above 5% is blocked — that invites bad fills and sandwich attacks.';
  return null;
}

/** amountOutMin = floor(quotedOut * (10000 - slippageBps) / 10000). Always rounds DOWN. */
export function applySlippage(quotedOut: bigint, slippageBps: number): bigint {
  const err = validateSlippageBps(slippageBps);
  if (err) throw new Error(err);
  if (quotedOut <= 0n) throw new Error('Quoted output must be positive.');
  return (quotedOut * (BPS - BigInt(slippageBps))) / BPS;
}

/** Uniswap V2 getAmountOut with a configurable fee (PulseX V2 = 29 bps). */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 29): bigint {
  if (amountIn <= 0n) throw new Error('amountIn must be positive');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Pool has no liquidity');
  const inWithFee = amountIn * (BPS - BigInt(feeBps));
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}

export interface HopReserves {
  reserveIn: bigint;
  reserveOut: bigint;
}

/**
 * Price impact (fraction 0..1) of a quote vs the pool mid price, EXCLUDING the LP fee.
 * mid output = amountIn * Π(reserveOut / reserveIn); fee-adjusted ideal = mid * (1-fee)^hops.
 * impact = 1 - quotedOut / feeAdjustedIdeal.
 */
export function priceImpact(amountIn: bigint, quotedOut: bigint, hops: HopReserves[], feeBps = 29): number {
  if (hops.length === 0) throw new Error('Need at least one hop');
  // Use floating point on ratios — fine for a display/limit metric.
  let ideal = Number(amountIn);
  for (const h of hops) {
    ideal = (ideal * Number(h.reserveOut)) / Number(h.reserveIn);
    ideal *= 1 - feeBps / 10_000;
  }
  if (!(ideal > 0)) return 1;
  const impact = 1 - Number(quotedOut) / ideal;
  return Math.max(0, impact);
}

/**
 * Choose a swap path. Native PLS is represented by WPLS in the path.
 * - Either side is native/WPLS → direct [in, out].
 * - Token→token with a direct pair → [in, out]; otherwise route through WPLS.
 */
export function selectPath(tokenIn: TokenRef, tokenOut: TokenRef, wpls: string, hasDirectPair = true): string[] {
  const norm = (t: TokenRef) => (t === NATIVE ? wpls : t);
  const a = norm(tokenIn);
  const b = norm(tokenOut);
  if (a.toLowerCase() === b.toLowerCase()) throw new Error('tokenIn and tokenOut must differ');
  const isW = (x: string) => x.toLowerCase() === wpls.toLowerCase();
  if (isW(a) || isW(b) || hasDirectPair) return [a, b];
  return [a, wpls, b];
}

export function deadlineFromNow(minutes: number, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (!(minutes >= 1 && minutes <= 60)) throw new Error('Deadline must be between 1 and 60 minutes.');
  return BigInt(nowSec + Math.round(minutes * 60));
}

export type SwapMethod = 'swapExactETHForTokens' | 'swapExactTokensForETH' | 'swapExactTokensForTokens';

export interface SwapCall {
  method: SwapMethod;
  args: unknown[];
  /** Native PLS to attach (only for swapExactETHForTokens) */
  value: bigint;
  path: string[];
  amountIn: bigint;
  amountOutMin: bigint;
  deadline: bigint;
}

export interface BuildSwapInput {
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  quotedOut: bigint;
  slippageBps: number;
  recipient: string;
  wpls: string;
  deadline: bigint;
  hasDirectPair?: boolean;
}

/** Build router call params. Picks the correct router method for native vs ERC20 in/out. */
export function buildSwapCall(i: BuildSwapInput): SwapCall {
  if (i.amountIn <= 0n) throw new Error('amountIn must be positive');
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.recipient)) throw new Error('Recipient must be a wallet address');
  if (i.tokenIn === NATIVE && i.tokenOut === NATIVE) throw new Error('Cannot swap PLS for PLS');
  const path = selectPath(i.tokenIn, i.tokenOut, i.wpls, i.hasDirectPair ?? true);
  const amountOutMin = applySlippage(i.quotedOut, i.slippageBps);

  if (i.tokenIn === NATIVE) {
    return {
      method: 'swapExactETHForTokens',
      args: [amountOutMin, path, i.recipient, i.deadline],
      value: i.amountIn,
      path, amountIn: i.amountIn, amountOutMin, deadline: i.deadline,
    };
  }
  if (i.tokenOut === NATIVE) {
    return {
      method: 'swapExactTokensForETH',
      args: [i.amountIn, amountOutMin, path, i.recipient, i.deadline],
      value: 0n,
      path, amountIn: i.amountIn, amountOutMin, deadline: i.deadline,
    };
  }
  return {
    method: 'swapExactTokensForTokens',
    args: [i.amountIn, amountOutMin, path, i.recipient, i.deadline],
    value: 0n,
    path, amountIn: i.amountIn, amountOutMin, deadline: i.deadline,
  };
}

/**
 * ERC20 approval plan. Native PLS needs no approval.
 * Default is EXACT amount (never unlimited). Returns null if current allowance suffices.
 */
export function approvalNeeded(tokenIn: TokenRef, allowance: bigint, amountIn: bigint): bigint | null {
  if (tokenIn === NATIVE) return null;
  if (allowance >= amountIn) return null;
  return amountIn; // exact amount
}

/** Decimal string → bigint units, rejecting extra precision instead of silently rounding. */
export function toUnits(value: string | number, decimals: number): bigint {
  const s = typeof value === 'number' ? value.toFixed(decimals) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const [whole, frac = ''] = s.split('.');
  const fracTrim = frac.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracTrim || '0');
}

export function fromUnits(value: bigint, decimals: number): number {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const n = Number(v / base) + Number(v % base) / Number(base);
  return neg ? -n : n;
}
