/**
 * Uniswap V4 adapter. One PoolManager for the chain; a pool is a PoolKey, and its id is
 * keccak256(abi.encode(key)). Discovery reads Initialize logs (there is no getPool). Quotes go through
 * the V4 Quoter; the live LP fee is StateView.getSlot0 (dynamic-fee pools included). Swaps are built for
 * the Universal Router and spend through Permit2 — this adapter never sends.
 *
 * address(0) is native ETH. The rest of the app thinks in the wrapped native, so state() faces address(0)
 * as WETH. The real key is kept on PoolRef.v4 and is what the quoter, the router and the safety probe use.
 */
import { getAddress, zeroPadValue } from 'ethers';
import type { DexConfig } from '../../live/chains';
import type { PoolRef } from '../../live/markets';
import { NATIVE } from '../../live/swapMath';
import { midPrice, v3Impact, virtualReserves } from '../../live/v3Math';
import type { ChainReader } from '../bot/chain';
import { PERMIT2, V4_POOL_MANAGER, V4_QUOTER, V4_STATE_VIEW } from './abis';
import { assessHook, type HookDecision } from './v4Hooks';
import {
  encodeUniversalRouterExecute, encodeV4ExactInputSingle, isDynamicFee, lpFeeBps, poolId, sortCurrencies,
  UINT128_MAX, type V4PoolKey,
} from './v4PoolKey';
import { isZero, readCall, sameAddr, ZERO, type BuiltSwap, type DexAdapter, type PoolState, type QuoteOut, type SwapRequest } from './types';

/** Inclusive getLogs span. Robinhood rejects a range of 10_000_000 blocks or more. */
export const V4_LOG_CHUNK = 9_000_000;

type LogReader = {
  getBlockNumber(): Promise<number>;
  getLogs(f: { address: string; topics: (string | string[] | null)[]; fromBlock: number; toBlock: number }): Promise<readonly { topics: readonly string[]; data: string }[]>;
};

export type V4Reader = Pick<ChainReader, 'call'> & Partial<LogReader>;

interface PairCache { to: number; pools: PoolRef[] }

/** Currencies to search: the pair as given, plus address(0) in place of the wrapped native (V4 ETH pools). */
export function currencyPairs(a: string, b: string, wrapped: string): [string, string][] {
  const A = getAddress(a), B = getAddress(b);
  const first = sortCurrencies(A, B);
  const out: [string, string][] = [first];
  if (sameAddr(A, wrapped) || sameAddr(B, wrapped)) {
    const z = (t: string) => (sameAddr(t, wrapped) ? ZERO : t);
    const second = sortCurrencies(z(A), z(B));
    if (!sameAddr(second[0], first[0]) || !sameAddr(second[1], first[1])) out.push(second);
  }
  return out;
}

/**
 * Map a market token (WETH address or 'native') onto the pool's currency.
 * A wrapped-native input settles as address(0) when that is what the pool was initialized with.
 */
export function resolveCurrency(token: string, key: V4PoolKey, wrapped: string): string {
  if (token === NATIVE || sameAddr(token, wrapped)) {
    if (isZero(key.currency0) || isZero(key.currency1)) return ZERO;
    if (sameAddr(key.currency0, wrapped)) return key.currency0;
    if (sameAddr(key.currency1, wrapped)) return key.currency1;
  }
  return [key.currency0, key.currency1].find((c) => sameAddr(c, token)) ?? token;
}

export class V4Adapter implements DexAdapter {
  readonly kind = 'v4' as const;
  private readonly initTopic: string;
  private readonly cache = new Map<string, PairCache>();

  constructor(private readonly reader: V4Reader, readonly cfg: DexConfig, readonly wrappedNative: string) {
    if (cfg.kind !== 'v4' || !cfg.quoter || !cfg.stateView || !cfg.permit2) {
      throw new Error(`${cfg.id}: V4 adapter needs kind v4, quoter, stateView and permit2`);
    }
    this.initTopic = V4_POOL_MANAGER.getEvent('Initialize')!.topicHash;
  }

  /** ERC-20s are approved to Permit2. The router is approved in a second step (Quote.permit2). */
  get spender() { return this.cfg.permit2!; }

  /** No log reader (a unit-test mock): discovery is empty rather than throwing, so other DEXes still resolve. */
  async findPools(a: string, b: string): Promise<PoolRef[]> {
    const logs = this.reader.getLogs;
    const headOf = this.reader.getBlockNumber;
    if (!logs || !headOf) return [];
    const seen = new Set<string>();
    const out: PoolRef[] = [];
    for (const [c0, c1] of currencyPairs(a, b, this.wrappedNative)) {
      for (const p of await this.poolsFor(c0, c1, { getLogs: logs, getBlockNumber: headOf })) {
        const id = p.address.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(p);
      }
    }
    return out;
  }

  private async poolsFor(c0: string, c1: string, reader: LogReader): Promise<PoolRef[]> {
    const key = `${c0.toLowerCase()}:${c1.toLowerCase()}`;
    const start = this.cfg.v4StartBlock ?? 0;
    const cache = this.cache.get(key) ?? { to: start - 1, pools: [] };
    let head: number;
    try { head = await reader.getBlockNumber(); } catch { return cache.pools; }
    let from = Math.max(start, cache.to + 1);
    while (from <= head) {
      const to = Math.min(head, from + V4_LOG_CHUNK - 1);
      let logs: readonly { topics: readonly string[]; data: string }[];
      try {
        logs = await reader.getLogs({
          address: this.cfg.factory,
          topics: [this.initTopic, null, zeroPadValue(c0, 32), zeroPadValue(c1, 32)],
          fromBlock: from, toBlock: to,
        });
      } catch { break; }
      for (const log of logs) {
        const ref = this.parseInit(log);
        if (ref) cache.pools.push(ref);
      }
      cache.to = to;
      from = to + 1;
    }
    this.cache.set(key, cache);
    return cache.pools;
  }

  private parseInit(log: { topics: readonly string[]; data: string }): PoolRef | null {
    try {
      const ev = V4_POOL_MANAGER.parseLog({ topics: [...log.topics], data: log.data });
      if (!ev) return null;
      const currency0 = getAddress(String(ev.args.currency0));
      const currency1 = getAddress(String(ev.args.currency1));
      const fee = Number(ev.args.fee);
      const tickSpacing = Number(ev.args.tickSpacing);
      const hooks = getAddress(String(ev.args.hooks));
      const key: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
      const id = poolId(key);
      if (id.toLowerCase() !== String(ev.args.id).toLowerCase()) return null;
      const dynamicFee = isDynamicFee(fee);
      return {
        dex: this.cfg.id, kind: 'v4', address: id, feeBps: dynamicFee ? 0 : lpFeeBps(fee),
        v4: { currency0, currency1, fee, tickSpacing, hooks, poolId: id, dynamicFee },
      };
    } catch { return null; }
  }

  private keyOf(pool: PoolRef): PoolRef['v4'] & object {
    const v = pool.v4;
    if (!v) throw new Error('V4 pool is missing its PoolKey');
    return v;
  }

  async state(pool: PoolRef): Promise<PoolState> {
    const key = this.keyOf(pool);
    const [[sqrtPriceX96, , , lpFee], [liquidity]] = await Promise.all([
      readCall<[bigint, bigint, bigint, bigint]>(this.reader, this.cfg.stateView!, V4_STATE_VIEW, 'getSlot0', [key.poolId]),
      readCall<[bigint]>(this.reader, this.cfg.stateView!, V4_STATE_VIEW, 'getLiquidity', [key.poolId]),
    ]);
    const { r0, r1 } = virtualReserves(liquidity, sqrtPriceX96);
    const face = (c: string) => (isZero(c) ? this.wrappedNative : c);
    const liveBps = lpFeeBps(Number(lpFee));
    return {
      pool: { ...pool, address: key.poolId, feeBps: liveBps, v4: { ...key, dynamicFee: isDynamicFee(key.fee) } },
      token0: face(key.currency0), token1: face(key.currency1),
      reserve0: r0, reserve1: r1, sqrtPriceX96, liquidity,
    };
  }

  /**
   * Exact-in quote at this size, plus the LP fee read now (not the fee stored at discovery).
   * A rejected hook is reported on `hook` and does not throw — buildSwap is what refuses to produce calldata.
   */
  async quote(pool: PoolRef, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<QuoteOut> {
    const key = this.keyOf(pool);
    if (amountIn <= 0n) throw new Error('amountIn must be positive');
    if (amountIn > UINT128_MAX) throw new Error('V4 quote amount exceeds uint128');
    const cin = resolveCurrency(tokenIn, key, this.wrappedNative);
    const cout = resolveCurrency(tokenOut, key, this.wrappedNative);
    const zeroForOne = sameAddr(cin, key.currency0);
    if (!zeroForOne && !sameAddr(cin, key.currency1)) throw new Error('tokenIn is not in this V4 pool');
    if (!sameAddr(cout, zeroForOne ? key.currency1 : key.currency0)) throw new Error('tokenOut is not in this V4 pool');
    const hook: HookDecision = assessHook(key.hooks, this.cfg.hookAllowlist);
    const poolKey = { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks };
    const [q, slot] = await Promise.all([
      readCall<[bigint, bigint]>(this.reader, this.cfg.quoter!, V4_QUOTER, 'quoteExactInputSingle', [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }]),
      readCall<[bigint, bigint, bigint, bigint]>(this.reader, this.cfg.stateView!, V4_STATE_VIEW, 'getSlot0', [key.poolId]),
    ]);
    const amountOut = q[0];
    const lpFee = Number(slot[3]);
    const sqrtPriceX96 = slot[0];
    const inIs0 = zeroForOne;
    const impact = sqrtPriceX96 > 0n ? v3Impact(amountIn, amountOut, midPrice(sqrtPriceX96, inIs0, 0, 0), lpFeeBps(lpFee)) : 0;
    return { amountOut, impact, gasEstimate: q[1], lpFee, dynamicFee: isDynamicFee(key.fee), hook };
  }

  buildSwap(r: SwapRequest): BuiltSwap {
    if (r.amountIn <= 0n) throw new Error('amountIn must be positive');
    if (r.amountIn > UINT128_MAX || r.amountOutMin > UINT128_MAX) throw new Error('V4 amounts must fit in uint128');
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.recipient)) throw new Error('Recipient must be a wallet address');
    const key = this.keyOf(r.pool);
    const decision = assessHook(key.hooks, this.cfg.hookAllowlist);
    if (!decision.allowed) throw new Error(decision.reason ?? 'V4 hook rejected');
    const cin = resolveCurrency(r.tokenIn, key, this.wrappedNative);
    const cout = resolveCurrency(r.tokenOut, key, this.wrappedNative);
    const zeroForOne = sameAddr(cin, key.currency0);
    if (!zeroForOne && !sameAddr(cin, key.currency1)) throw new Error('tokenIn is not in this V4 pool');
    if (!sameAddr(cout, zeroForOne ? key.currency1 : key.currency0)) throw new Error('tokenOut is not in this V4 pool');
    const input = encodeV4ExactInputSingle({ key, zeroForOne, amountIn: r.amountIn, amountOutMin: r.amountOutMin });
    const data = encodeUniversalRouterExecute(input, r.deadline);
    return {
      to: this.cfg.router, data, value: isZero(cin) ? r.amountIn : 0n, method: 'execute',
      args: ['0x10', [input], r.deadline],
    };
  }

  /** Current Permit2 allowance of `spender` (the Universal Router). Null when the read fails. */
  async permit2Allowance(owner: string, token: string, spender: string): Promise<{ amount: bigint; expiration: bigint } | null> {
    try {
      const [amount, expiration] = await readCall<[bigint, bigint, bigint]>(this.reader, this.cfg.permit2!, PERMIT2, 'allowance', [owner, token, spender]);
      return { amount, expiration };
    } catch { return null; }
  }
}
