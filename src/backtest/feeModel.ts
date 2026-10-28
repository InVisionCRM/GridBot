/**
 * LP fee model for candle volume. Swap-by-swap replay does not use `k` (the pool's own fee amounts are already
 * the on-chain fees). Candle volume does:
 *
 *   fees = k × volume × fee rate × LP share × (our liquidity ÷ active liquidity) × time in range
 *
 * `k` is the calibration knob against on-chain collections. The 0.05% pool (fee tier 500) pays liquidity
 * providers 75% of the swap fee (protocol fee 1/4). A read-only check of Uniswap position NFT 1390514 on that
 * pool landed within 4% of the fees the position collected when the model used that share. Pass another `k`
 * when a pool's candles over- or under-state collections. The default `k` is 1 (no extra scale).
 */
export const DEFAULT_FEE_K = 1;

/** 0.05% Uniswap-style tier: LPs keep 75%. Pancake/9mm 0.25% and 1% tiers keep 68% (measured 2026-10-17). */
export function lpShareForFeeTier(feeTier: number, explicit?: number): number {
  if (explicit != null) {
    if (!(explicit >= 0 && explicit <= 1)) throw new Error(`bad LP share ${explicit}`);
    return explicit;
  }
  if (feeTier === 500) return 0.75;
  if (feeTier === 100) return 0.75;
  if (feeTier === 2500 || feeTier === 10000) return 0.68;
  if (!(feeTier > 0)) throw new Error(`bad fee tier ${feeTier}`);
  return 1;
}

export interface FeeModelInput {
  /** Quote-token volume of the candle */
  volumeQuote: number;
  /** Pool fee as a fraction (0.0005 = 0.05%) */
  feeRate: number;
  lpShare: number;
  k: number;
  /** Our liquidity ÷ (ours + the pool's active liquidity) */
  poolShare: number;
  /** Fraction of the candle the price spent inside the range */
  inRange: number;
}

/** Quote units of LP fees for one candle. Labeled modeled wherever it is reported. */
export function candleLpFees(i: FeeModelInput): number {
  if (!(i.k >= 0)) throw new Error(`bad fee k ${i.k}`);
  if (!(i.lpShare >= 0 && i.lpShare <= 1)) throw new Error(`bad LP share ${i.lpShare}`);
  return i.k * Math.max(0, i.volumeQuote) * i.feeRate * i.lpShare * Math.max(0, i.poolShare) * Math.max(0, Math.min(1, i.inRange));
}
