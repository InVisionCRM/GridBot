/** Uniswap-V2-style adapter (PulseX V1/V2, 9mm V2, Uniswap V2) with a per-DEX fee. */
import type { DexConfig } from '../../live/chains';
import type { PoolRef } from '../../live/markets';
import { NATIVE, priceImpact } from '../../live/swapMath';
import type { ChainReader } from '../bot/chain';
import { FACTORY, PAIR, ROUTER } from './abis';
import { isZero, readCall, sameAddr, type BuiltSwap, type DexAdapter, type PoolState, type QuoteOut, type SwapRequest } from './types';

export class V2Adapter implements DexAdapter {
  readonly kind = 'v2' as const;
  private pairs = new Map<string, string>();
  constructor(private readonly reader: Pick<ChainReader, 'call'>, readonly cfg: DexConfig, readonly wrappedNative: string) {
    if (cfg.kind !== 'v2' || cfg.feeBps == null) throw new Error(`${cfg.id}: V2 adapter needs kind v2 and feeBps`);
  }
  get spender() { return this.cfg.router; }
  get feeBps() { return this.cfg.feeBps!; }

  private async pairOf(a: string, b: string): Promise<string> {
    const k = [a.toLowerCase(), b.toLowerCase()].sort().join('-');
    const c = this.pairs.get(k);
    if (c) return c;
    const [pair] = await readCall<[string]>(this.reader, this.cfg.factory, FACTORY, 'getPair', [a, b]);
    if (!isZero(pair)) this.pairs.set(k, pair);
    return pair;
  }

  async findPools(a: string, b: string): Promise<PoolRef[]> {
    const pair = await this.pairOf(a, b);
    return isZero(pair) ? [] : [{ dex: this.cfg.id, kind: 'v2', address: pair, feeBps: this.feeBps }];
  }

  async state(pool: PoolRef, a: string, b: string): Promise<PoolState> {
    const addr = await this.pairOf(a, b);
    if (isZero(addr)) throw new Error(`No ${this.cfg.name} pool for ${a} → ${b}`);
    const [[r0, r1], [t0]] = await Promise.all([
      readCall<[bigint, bigint]>(this.reader, addr, PAIR, 'getReserves'),
      readCall<[string]>(this.reader, addr, PAIR, 'token0'),
    ]);
    const aIs0 = sameAddr(t0, a);
    return { pool: { ...pool, address: addr }, token0: t0, token1: aIs0 ? b : a, reserve0: r0, reserve1: r1 };
  }

  async quote(pool: PoolRef, tokenIn: string, tokenOut: string, amountIn: bigint, withImpact = true): Promise<QuoteOut> {
    const path = [tokenIn, tokenOut];
    const [[amounts], st] = await Promise.all([
      readCall<[bigint[]]>(this.reader, this.cfg.router, ROUTER, 'getAmountsOut', [amountIn, path]),
      withImpact ? this.state(pool, tokenIn, tokenOut) : Promise.resolve(null),
    ]);
    const amountOut = amounts[amounts.length - 1];
    let impact = 0;
    if (st) {
      const inIs0 = sameAddr(st.token0, tokenIn);
      impact = priceImpact(amountIn, amountOut, [{ reserveIn: inIs0 ? st.reserve0 : st.reserve1, reserveOut: inIs0 ? st.reserve1 : st.reserve0 }], this.feeBps);
    }
    return { amountOut, impact };
  }

  buildSwap(r: SwapRequest): BuiltSwap {
    if (r.amountIn <= 0n) throw new Error('amountIn must be positive');
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.recipient)) throw new Error('Recipient must be a wallet address');
    if (r.tokenIn === NATIVE && r.tokenOut === NATIVE) throw new Error('Cannot swap native for native');
    const w = (t: string) => (t === NATIVE ? this.wrappedNative : t);
    const path = [w(r.tokenIn), w(r.tokenOut)];
    let method: string;
    let args: unknown[];
    let value = 0n;
    const fot = r.feeOnTransfer ? 'SupportingFeeOnTransferTokens' : '';
    if (r.tokenIn === NATIVE) { method = `swapExactETHForTokens${fot}`; args = [r.amountOutMin, path, r.recipient, r.deadline]; value = r.amountIn; }
    else if (r.tokenOut === NATIVE) { method = `swapExactTokensForETH${fot}`; args = [r.amountIn, r.amountOutMin, path, r.recipient, r.deadline]; }
    else { method = `swapExactTokensForTokens${fot}`; args = [r.amountIn, r.amountOutMin, path, r.recipient, r.deadline]; }
    return { to: this.cfg.router, data: ROUTER.encodeFunctionData(method, args), value, method, args };
  }
}
