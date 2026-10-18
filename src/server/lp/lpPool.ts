/**
 * One market's V3 pool as a liquidity position sees it: price, fee counters, tick spacing, and the mapping between the
 * market's base/quote (human units, quote per base) and the pool's token0/token1 (raw units, token1 per token0).
 */
import type { DexConfig } from '../../live/chains';
import type { MarketDef, MarketToken } from '../../live/markets';
import { alignTick, amountsForLiquidity, feeGrowthInside, liquidityForAmounts, sqrtPriceAt, tickAtPrice } from '../../live/v3Liquidity';
import type { ChainReader } from '../bot/chain';
import { V3_POOL, V3_POOL_LP } from '../dex/abis';
import { readCall, sameAddr } from '../dex/types';

export interface PoolView {
  tick: number;
  /** √(raw token1 per raw token0) */
  sqrtP: number;
  /** Active liquidity at the current tick */
  liquidity: bigint;
  spacing: number;
  baseIs0: boolean;
  global0: bigint;
  global1: bigint;
  /** Mid price, quote per base (human) */
  price: number;
}

/** Amounts in market terms (human units). */
export interface Coins { base: number; quote: number }

export class LpPool {
  private static0: { token0: string; spacing: number } | null = null;
  constructor(readonly reader: Pick<ChainReader, 'call'>, readonly def: MarketDef, readonly dex: DexConfig, readonly wrapped: string) {
    if (def.pool.kind !== 'v3' || def.pool.feeTier == null || !def.pool.address) throw new Error(`${def.base.symbol}/${def.quote.symbol}: a liquidity position needs a V3 pool`);
    if (!dex.positionManager) throw new Error(`${dex.name}: liquidity positions aren't supported here (no verified position manager)`);
  }
  get address() { return this.def.pool.address; }
  get npm() { return this.dex.positionManager!; }
  get fee() { return this.def.pool.feeTier!; }
  /** ERC-20 address the pool uses for a market token (native coin → its wrapped token) */
  tokenAddr(t: MarketToken) { return t.native ? this.wrapped : t.address; }
  get baseAddr() { return this.tokenAddr(this.def.base); }
  get quoteAddr() { return this.tokenAddr(this.def.quote); }

  async view(): Promise<PoolView> {
    if (!this.static0) {
      const [[token0], [spacing]] = await Promise.all([
        readCall<[string]>(this.reader, this.address, V3_POOL, 'token0'),
        readCall<[bigint]>(this.reader, this.address, V3_POOL_LP, 'tickSpacing'),
      ]);
      this.static0 = { token0, spacing: Number(spacing) };
    }
    const [[sqrtPriceX96, tick], [liquidity], [global0], [global1]] = await Promise.all([
      readCall<[bigint, bigint]>(this.reader, this.address, V3_POOL, 'slot0'),
      readCall<[bigint]>(this.reader, this.address, V3_POOL, 'liquidity'),
      readCall<[bigint]>(this.reader, this.address, V3_POOL_LP, 'feeGrowthGlobal0X128'),
      readCall<[bigint]>(this.reader, this.address, V3_POOL_LP, 'feeGrowthGlobal1X128'),
    ]);
    const baseIs0 = sameAddr(this.static0.token0, this.baseAddr);
    const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
    const v = { tick: Number(tick), sqrtP, liquidity, spacing: this.static0.spacing, baseIs0, global0, global1, price: 0 };
    v.price = this.marketPrice(sqrtP * sqrtP, v);
    return v;
  }

  /** raw token1/token0 → quote per base (human) */
  marketPrice(raw1per0: number, v: { baseIs0: boolean }) {
    const db = this.def.base.decimals, dq = this.def.quote.decimals;
    return v.baseIs0 ? raw1per0 * 10 ** (db - dq) : (1 / raw1per0) * 10 ** (db - dq);
  }
  /** quote per base (human) → raw token1/token0 */
  rawPrice(price: number, v: { baseIs0: boolean }) {
    const db = this.def.base.decimals, dq = this.def.quote.decimals;
    return v.baseIs0 ? price * 10 ** (dq - db) : 1 / (price * 10 ** (dq - db));
  }

  /** Ticks for a market range [lower, upper] (quote per base), widened outward to the pool's spacing. */
  ticksFor(lower: number, upper: number, v: PoolView): { tickLower: number; tickUpper: number } {
    const a = tickAtPrice(this.rawPrice(lower, v)), b = tickAtPrice(this.rawPrice(upper, v));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const tickLower = alignTick(lo, v.spacing, 'down'), tickUpper = alignTick(hi + 1, v.spacing, 'up');
    if (tickUpper <= tickLower) throw new Error('range too narrow for this pool');
    return { tickLower, tickUpper };
  }
  /** Market prices (quote per base) at a tick range's ends, low first. */
  rangePrices(tickLower: number, tickUpper: number, v: { baseIs0: boolean }): { lower: number; upper: number } {
    const a = this.marketPrice(sqrtPriceAt(tickLower) ** 2, v), b = this.marketPrice(sqrtPriceAt(tickUpper) ** 2, v);
    return { lower: Math.min(a, b), upper: Math.max(a, b) };
  }

  private toRaw(c: Coins, v: { baseIs0: boolean }) {
    const b = c.base * 10 ** this.def.base.decimals, q = c.quote * 10 ** this.def.quote.decimals;
    return v.baseIs0 ? { a0: b, a1: q } : { a0: q, a1: b };
  }
  private fromRaw(a0: number, a1: number, v: { baseIs0: boolean }): Coins {
    const [b, q] = v.baseIs0 ? [a0, a1] : [a1, a0];
    return { base: b / 10 ** this.def.base.decimals, quote: q / 10 ** this.def.quote.decimals };
  }
  /** Coins a position of liquidity L holds now. */
  coinsFor(L: number, tickLower: number, tickUpper: number, v: PoolView): Coins {
    const a = amountsForLiquidity(v.sqrtP, sqrtPriceAt(tickLower), sqrtPriceAt(tickUpper), L);
    return this.fromRaw(a.amount0, a.amount1, v);
  }
  /** Liquidity `have` can fund in the range, and the coins that uses (the rest stays idle). */
  fund(have: Coins, tickLower: number, tickUpper: number, v: PoolView): { L: number; used: Coins } {
    const r = this.toRaw(have, v);
    const L = liquidityForAmounts(v.sqrtP, sqrtPriceAt(tickLower), sqrtPriceAt(tickUpper), r.a0, r.a1);
    return { L, used: this.coinsFor(L, tickLower, tickUpper, v) };
  }
  /** Share of a position's value held in the base coin at the current price (what to swap to before opening). */
  baseShare(tickLower: number, tickUpper: number, v: PoolView): number {
    const c = this.coinsFor(1e18, tickLower, tickUpper, v);
    const bv = c.base * v.price;
    return bv / (bv + c.quote);
  }
  /** Raw amounts in token order, for calldata. */
  rawAmounts(c: Coins, v: { baseIs0: boolean }) { return this.toRaw(c, v); }
  coinsFromRaw(a0: bigint, a1: bigint, v: { baseIs0: boolean }): Coins { return this.fromRaw(Number(a0), Number(a1), v); }

  /** Fee growth inside a range right now (the pool's counters; exactly what the position manager pays out). */
  async inside(tickLower: number, tickUpper: number, v: PoolView): Promise<{ in0: bigint; in1: bigint }> {
    type T = { feeGrowthOutside0X128: bigint; feeGrowthOutside1X128: bigint };
    const [lo, hi] = await Promise.all([
      readCall<T>(this.reader, this.address, V3_POOL_LP, 'ticks', [tickLower]),
      readCall<T>(this.reader, this.address, V3_POOL_LP, 'ticks', [tickUpper]),
    ]);
    return {
      in0: feeGrowthInside(v.global0, lo.feeGrowthOutside0X128, hi.feeGrowthOutside0X128, v.tick, tickLower, tickUpper),
      in1: feeGrowthInside(v.global1, lo.feeGrowthOutside1X128, hi.feeGrowthOutside1X128, v.tick, tickLower, tickUpper),
    };
  }
}
