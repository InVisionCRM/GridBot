/**
 * Liquidity floor for the token trader.
 *
 * The scan and the safety gate used to pass 0 (`assess` returned `source === 'snipe' ? 0 : 0`, and
 * `??` keeps a 0). That is still the default, so an unchanged install keeps buying the same pools.
 * A configured minimum is honored. `enforceLiquidityFloor` (off by default) raises that minimum to
 * $50,000 and never lowers a higher one. A snipe also keeps its own minimum: the higher one wins.
 */

/** Historical scan / gate floor. Leaving the setting here changes no buy. */
export const DEFAULT_MIN_LIQUIDITY_USD = 0;
/** Used only while `enforceLiquidityFloor` is on. */
export const ENFORCED_LIQUIDITY_FLOOR_USD = 50_000;

export interface LiquidityFloorOptions {
  minLiquidityUsd?: number | null;
  enforceLiquidityFloor?: boolean | null;
  /** Sniper's own minimum. Applied to snipe pools only, and only if it is the higher floor. */
  sniperMinLiquidityUsd?: number | null;
}

function usd(n: number | null | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** Floor from the setting and the flag, before a pool's own source is considered. */
export function effectiveMinLiquidityUsd(o: LiquidityFloorOptions = {}): number {
  const configured = usd(o.minLiquidityUsd, DEFAULT_MIN_LIQUIDITY_USD);
  return o.enforceLiquidityFloor ? Math.max(configured, ENFORCED_LIQUIDITY_FLOOR_USD) : configured;
}

/**
 * Floor the gate should apply to this pool. A reported 0 (what assess used to send) does not
 * wipe the configured floor. A higher reported floor is kept. Snipes still have to clear the
 * sniper minimum.
 */
export function gateMinLiquidityUsd(pool: { source: string }, reported: number | null | undefined, opt: LiquidityFloorOptions = {}): number {
  const sniper = pool.source === 'snipe' ? usd(opt.sniperMinLiquidityUsd, 0) : 0;
  return Math.max(usd(reported, 0), effectiveMinLiquidityUsd(opt), sniper);
}

/** The number the desk shows. This is the floor in force, including the flag. */
export function shownMinLiquidityUsd(status: object | null | undefined): number {
  if (!status || !('effectiveMinLiquidityUsd' in status)) return DEFAULT_MIN_LIQUIDITY_USD;
  return usd((status as { effectiveMinLiquidityUsd?: number | null }).effectiveMinLiquidityUsd, DEFAULT_MIN_LIQUIDITY_USD);
}
