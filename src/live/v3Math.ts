/**
 * Pure Uniswap-V3 helpers (no network): path encoding, sqrtPriceX96 → price, virtual reserves.
 * Raw units throughout (token smallest units); callers scale by decimals.
 */
export const Q96 = 2n ** 96n;
export const V3_TIERS = [100, 500, 3000, 10000] as const;

/** exactInput path: tokenIn ‖ fee(uint24) ‖ token ‖ fee ‖ … ‖ tokenOut (packed, 20+3+20…). */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error('path needs n tokens and n−1 fees');
  let hex = '0x';
  tokens.forEach((t, i) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`bad token ${t}`);
    hex += t.slice(2).toLowerCase();
    if (i < fees.length) {
      const f = fees[i];
      if (!Number.isInteger(f) || f <= 0 || f >= 1_000_000) throw new Error(`bad fee tier ${f}`);
      hex += f.toString(16).padStart(6, '0');
    }
  });
  return hex;
}

export function decodeV3Path(path: string): { tokens: string[]; fees: number[] } {
  const h = path.replace(/^0x/, '');
  const tokens: string[] = [], fees: number[] = [];
  let i = 0;
  while (true) {
    tokens.push('0x' + h.slice(i, i + 40)); i += 40;
    if (i >= h.length) break;
    fees.push(parseInt(h.slice(i, i + 6), 16)); i += 6;
  }
  return { tokens, fees };
}

/** Mid price of token1 in token0, RAW units (token1 raw per token0 raw). */
export function rawPrice1per0(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s;
}

/** Mid price of `out` per `in`, human units. */
export function midPrice(sqrtPriceX96: bigint, inIs0: boolean, decIn: number, decOut: number): number {
  const p10 = rawPrice1per0(sqrtPriceX96); // raw t1 per raw t0
  const rawOutPerIn = inIs0 ? p10 : 1 / p10;
  return rawOutPerIn * 10 ** (decIn - decOut);
}

/**
 * Virtual reserves of the active range: x = L / √P (token0), y = L·√P (token1), raw units.
 * Within the current tick range the pool behaves exactly like a constant-product pool with these reserves,
 * which is what the V2-style cost model and backtests need.
 */
export function virtualReserves(liquidity: bigint, sqrtPriceX96: bigint): { r0: bigint; r1: bigint } {
  if (sqrtPriceX96 <= 0n) return { r0: 0n, r1: 0n };
  return { r0: (liquidity * Q96) / sqrtPriceX96, r1: (liquidity * sqrtPriceX96) / Q96 };
}

/**
 * Price impact of an exact-in quote vs the mid, excluding the LP fee: 1 − out / (in · mid · (1 − fee)).
 * amounts raw; midRawOutPerIn raw out per raw in.
 */
export function v3Impact(amountIn: bigint, amountOut: bigint, midRawOutPerIn: number, feeBps: number): number {
  const ideal = Number(amountIn) * midRawOutPerIn * (1 - feeBps / 10_000);
  if (!(ideal > 0)) return 1;
  return Math.max(0, 1 - Number(amountOut) / ideal);
}

/** SwapRouter02 recipient sentinel: keep the output in the router (then unwrapWETH9 to the user). */
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
