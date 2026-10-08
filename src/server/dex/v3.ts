/**
 * Uniswap-V3-style adapter (Uniswap V3 + SwapRouter02/QuoterV2, PancakeSwap V3 + SmartRouter/QuoterV2).
 * Quotes simulate the actual size through QuoterV2 (eth_call); swaps go through multicall(deadline, …):
 *   native in  → exactInputSingle{value}           (router wraps)
 *   native out → exactInputSingle(→ router) + unwrapWETH9(min, recipient)
 *   multi-hop  → exactInput(path)
 */
import type { DexConfig } from '../../live/chains';
import type { PoolRef } from '../../live/markets';
import { NATIVE } from '../../live/swapMath';
import { ADDRESS_THIS, encodeV3Path, midPrice, v3Impact, virtualReserves } from '../../live/v3Math';
import type { ChainReader } from '../bot/chain';
import { V3_FACTORY, V3_POOL, V3_QUOTER, V3_ROUTER } from './abis';
import { isZero, readCall, sameAddr, type BuiltSwap, type DexAdapter, type PoolState, type QuoteOut, type SwapRequest } from './types';

export class V3Adapter implements DexAdapter {
  readonly kind = 'v3' as const;
  constructor(private readonly reader: Pick<ChainReader, 'call'>, readonly cfg: DexConfig, readonly wrappedNative: string) {
    if (cfg.kind !== 'v3' || !cfg.quoter || !cfg.feeTiers?.length) throw new Error(`${cfg.id}: V3 adapter needs kind v3, quoter and feeTiers`);
  }
  get spender() { return this.cfg.router; }

  async findPools(a: string, b: string): Promise<PoolRef[]> {
    const found = await Promise.all(this.cfg.feeTiers!.map(async (tier) => {
      try {
        const [p] = await readCall<[string]>(this.reader, this.cfg.factory, V3_FACTORY, 'getPool', [a, b, tier]);
        return isZero(p) ? null : { dex: this.cfg.id, kind: 'v3' as const, address: p, feeBps: tier / 100, feeTier: tier };
      } catch { return null; }
    }));
    return found.filter((x): x is NonNullable<typeof x> => !!x);
  }

  private async poolAddr(pool: PoolRef, a: string, b: string) {
    if (pool.address) return pool.address;
    const [p] = await readCall<[string]>(this.reader, this.cfg.factory, V3_FACTORY, 'getPool', [a, b, pool.feeTier]);
    if (isZero(p)) throw new Error(`No ${this.cfg.name} pool at fee ${pool.feeTier}`);
    return p;
  }

  async state(pool: PoolRef, a: string, b: string): Promise<PoolState> {
    const addr = await this.poolAddr(pool, a, b);
    const [[sqrtPriceX96], [liquidity], [t0]] = await Promise.all([
      readCall<[bigint]>(this.reader, addr, V3_POOL, 'slot0'),
      readCall<[bigint]>(this.reader, addr, V3_POOL, 'liquidity'),
      readCall<[string]>(this.reader, addr, V3_POOL, 'token0'),
    ]);
    const { r0, r1 } = virtualReserves(liquidity, sqrtPriceX96);
    return { pool: { ...pool, address: addr }, token0: t0, token1: sameAddr(t0, a) ? b : a, reserve0: r0, reserve1: r1, sqrtPriceX96, liquidity };
  }

  async quote(pool: PoolRef, tokenIn: string, tokenOut: string, amountIn: bigint, withImpact = true): Promise<QuoteOut> {
    if (pool.feeTier == null) throw new Error('V3 pool needs a fee tier');
    const [q, st] = await Promise.all([
      readCall<[bigint, bigint, number, bigint]>(this.reader, this.cfg.quoter!, V3_QUOTER, 'quoteExactInputSingle', [{ tokenIn, tokenOut, amountIn, fee: pool.feeTier, sqrtPriceLimitX96: 0n }]),
      withImpact ? this.state(pool, tokenIn, tokenOut) : Promise.resolve(null),
    ]);
    const amountOut = q[0];
    let impact = 0;
    if (st?.sqrtPriceX96) {
      const inIs0 = sameAddr(st.token0, tokenIn);
      impact = v3Impact(amountIn, amountOut, midPrice(st.sqrtPriceX96, inIs0, 0, 0), pool.feeBps);
    }
    return { amountOut, impact, gasEstimate: q[3] };
  }

  buildSwap(r: SwapRequest & { path?: { tokens: string[]; fees: number[] } }): BuiltSwap {
    if (r.amountIn <= 0n) throw new Error('amountIn must be positive');
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.recipient)) throw new Error('Recipient must be a wallet address');
    if (r.tokenIn === NATIVE && r.tokenOut === NATIVE) throw new Error('Cannot swap native for native');
    const w = (t: string) => (t === NATIVE ? this.wrappedNative : t);
    const nativeOut = r.tokenOut === NATIVE;
    const to = nativeOut ? ADDRESS_THIS : r.recipient;
    const inner: string[] = [];
    if (r.path) {
      const tokens = r.path.tokens.map(w);
      inner.push(V3_ROUTER.encodeFunctionData('exactInput', [{ path: encodeV3Path(tokens, r.path.fees), recipient: to, amountIn: r.amountIn, amountOutMinimum: r.amountOutMin }]));
    } else {
      if (r.pool.feeTier == null) throw new Error('V3 pool needs a fee tier');
      inner.push(V3_ROUTER.encodeFunctionData('exactInputSingle', [{
        tokenIn: w(r.tokenIn), tokenOut: w(r.tokenOut), fee: r.pool.feeTier, recipient: to,
        amountIn: r.amountIn, amountOutMinimum: r.amountOutMin, sqrtPriceLimitX96: 0n,
      }]));
    }
    if (nativeOut) inner.push(V3_ROUTER.encodeFunctionData('unwrapWETH9', [r.amountOutMin, r.recipient]));
    const args = [r.deadline, inner];
    return {
      to: this.cfg.router, data: V3_ROUTER.encodeFunctionData('multicall', args),
      value: r.tokenIn === NATIVE ? r.amountIn : 0n, method: 'multicall', args,
    };
  }
}
