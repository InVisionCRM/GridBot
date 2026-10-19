/**
 * Concentrated-liquidity math for a Uniswap-V3-style position (pure, no network). Raw units throughout: amounts in
 * token smallest units, prices as raw token1 per raw token0. Doubles are precise to ~1e-15 relative, far inside the
 * slippage allowance on every mint; fee accounting uses exact uint256 bigint math like the contracts.
 */
export const Q128 = 2n ** 128n;
const U256 = 2n ** 256n;
const TICK_BASE = 1.0001;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** √price at a tick (raw token1 per raw token0). */
export function sqrtPriceAt(tick: number): number {
  return TICK_BASE ** (tick / 2);
}

/** Highest tick whose price is ≤ `price` (raw token1 per raw token0). */
export function tickAtPrice(price: number): number {
  if (!(price > 0)) throw new Error(`bad price ${price}`);
  const t = Math.floor(Math.log(price) / Math.log(TICK_BASE));
  return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}

/** Round a tick to the pool's spacing, outward from the position (down for the lower bound, up for the upper). */
export function alignTick(tick: number, spacing: number, dir: 'down' | 'up'): number {
  if (!(spacing > 0)) throw new Error(`bad tick spacing ${spacing}`);
  const t = dir === 'down' ? Math.floor(tick / spacing) * spacing : Math.ceil(tick / spacing) * spacing;
  const lo = Math.ceil(MIN_TICK / spacing) * spacing, hi = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.max(lo, Math.min(hi, t));
}

/** Token amounts (raw) a position of liquidity L holds at √price `s` in the range [sa, sb]. */
export function amountsForLiquidity(s: number, sa: number, sb: number, L: number): { amount0: number; amount1: number } {
  if (s <= sa) return { amount0: L * (1 / sa - 1 / sb), amount1: 0 };
  if (s >= sb) return { amount0: 0, amount1: L * (sb - sa) };
  return { amount0: L * (1 / s - 1 / sb), amount1: L * (s - sa) };
}

/** The most liquidity that `amount0` / `amount1` (raw) can fund in [sa, sb] at √price `s` (what the pool's mint takes). */
export function liquidityForAmounts(s: number, sa: number, sb: number, amount0: number, amount1: number): number {
  const L0 = amount0 / (1 / Math.max(s, sa) - 1 / sb);
  const L1 = amount1 / (Math.min(s, sb) - sa);
  if (s <= sa) return L0;
  if (s >= sb) return L1;
  return Math.min(L0, L1);
}

/**
 * Fee growth per unit of liquidity inside [tickLower, tickUpper] (Q128, wraps mod 2^256 exactly like the pool:
 * feeGrowthGlobal − below − above, where "outside" is measured relative to the current tick).
 */
export function feeGrowthInside(global: bigint, lowerOutside: bigint, upperOutside: bigint, tickCurrent: number, tickLower: number, tickUpper: number): bigint {
  const below = tickCurrent >= tickLower ? lowerOutside : global - lowerOutside;
  const above = tickCurrent < tickUpper ? upperOutside : global - upperOutside;
  return (((global - below - above) % U256) + U256) % U256;
}

/** Fees (raw) a position earned since its last snapshot: (inside now − inside then) × L / 2^128, wrap-safe. */
export function feesOwed(insideNow: bigint, insideLast: bigint, liquidity: bigint): bigint {
  const d = (((insideNow - insideLast) % U256) + U256) % U256;
  return (d * liquidity) / Q128;
}

/**
 * Share of a position's value held in the base coin, for a range [lower, upper] around `price` (all quote per base,
 * human units). Per unit of liquidity a position holds 1/√P − 1/√Pb base and √P − √Pa quote, so the share depends only
 * on where the price sits in the range: ½ in the geometric middle, 1 at or below the bottom, 0 at or above the top.
 */
export function rangeBaseShare(price: number, lower: number, upper: number): number {
  if (!(lower > 0 && upper > lower && price > 0)) throw new Error('bad range');
  if (price <= lower) return 1;
  if (price >= upper) return 0;
  const s = Math.sqrt(price), base = (1 / s - 1 / Math.sqrt(upper)) * price, quote = s - Math.sqrt(lower);
  return base / (base + quote);
}
