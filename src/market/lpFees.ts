/**
 * On-chain fee pace for a V3 pool, so a liquidity candidate is ranked on fees the pool actually paid
 * rather than on reported volume (which can be wash trades or aggregator prints that never hit this pool).
 *
 * Uniswap V3 (and the PancakeSwap fork 9mm uses) stores fees per unit of liquidity as a Q128 counter:
 *   fees of one side = liquidity × (growthNow − growthThen) / 2^128
 * That is the liquidity providers' fee. Protocol fee is a separate cut and is not in this counter.
 * Implied volume over the window ≈ fees ÷ the pool fee. A window under an hour or over 14 days is ignored.
 */
export const FEE_WINDOW_MIN_MS = 60 * 60_000;
export const FEE_WINDOW_MAX_MS = 14 * 24 * 3600_000;
const Q128 = 1n << 128n;

/** Raw token units of fees earned by `liquidity` between two fee-growth readings. */
export function feesFromGrowth(liquidity: bigint, growthThen: bigint, growthNow: bigint): bigint {
  if (liquidity <= 0n || growthNow <= growthThen) return 0n;
  return liquidity * (growthNow - growthThen) / Q128;
}

export interface FeePace {
  /** Fees over the window, in USD */
  feesUsd: number;
  windowMs: number;
  /** Implied swap volume in USD (fees ÷ pool fee) */
  volumeUsd: number;
  /**
   * Multiply candle volume by this so the week's volume matches the chain.
   * Above 1 when the chain shows more fees than the candles; 0 when the pool earned nothing.
   */
  scale: number;
}

/**
 * `candleVolumeUsd` is the reported volume over the same window (quote volume × USD per quote).
 * null when the window is outside the range we trust, or the fee can't be turned into a scale.
 */
export function feePace(p: {
  feesUsd: number; windowMs: number; feeBps: number; candleVolumeUsd: number;
}): FeePace | null {
  if (!(p.windowMs >= FEE_WINDOW_MIN_MS && p.windowMs <= FEE_WINDOW_MAX_MS)) return null;
  if (!(p.feeBps > 0) || !(p.feesUsd >= 0)) return null;
  const volumeUsd = p.feesUsd / (p.feeBps / 10_000);
  const scale = p.candleVolumeUsd > 0 ? volumeUsd / p.candleVolumeUsd : (volumeUsd > 0 ? Infinity : 0);
  if (!Number.isFinite(scale)) return null;
  return { feesUsd: p.feesUsd, windowMs: p.windowMs, volumeUsd, scale };
}

/**
 * USD of fees earned between two readings. Uses the smaller liquidity, so a liquidity add in the window
 * does not get credit for fees it was not there to earn. A window under an hour or over 14 days is ignored.
 */
export function feesBetween(p: {
  atThen: number; now: number;
  liquidityThen: bigint; liquidityNow: bigint;
  g0Then: bigint; g0Now: bigint; g1Then: bigint; g1Now: bigint;
  dec0: number; dec1: number; usd0: number; usd1: number;
}): { feesUsd: number; windowMs: number } | null {
  const windowMs = p.now - p.atThen;
  if (!(windowMs >= FEE_WINDOW_MIN_MS && windowMs <= FEE_WINDOW_MAX_MS)) return null;
  const liquidity = p.liquidityThen < p.liquidityNow ? p.liquidityThen : p.liquidityNow;
  const usd0 = feeHuman(feesFromGrowth(liquidity, p.g0Then, p.g0Now), p.dec0) * Math.max(0, p.usd0);
  const usd1 = feeHuman(feesFromGrowth(liquidity, p.g1Then, p.g1Now), p.dec1) * Math.max(0, p.usd1);
  if (!Number.isFinite(usd0 + usd1)) return null;
  return { feesUsd: usd0 + usd1, windowMs };
}

/** Human units from a raw fee amount. */
export function feeHuman(raw: bigint, decimals: number): number {
  if (raw <= 0n || decimals < 0 || decimals > 36) return 0;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  return Number(whole) + Number(frac) / Number(base);
}
