/**
 * Uniswap V4 adapter. One PoolManager for the chain; a pool is a PoolKey, and its id is
 * keccak256(abi.encode(key)). Discovery reads Initialize logs (there is no getPool). Quotes go through
 * the V4 Quoter; the live LP fee is StateView.getSlot0 (dynamic-fee pools included). Swaps are built for
 * the Universal Router and spend through Permit2 — this adapter never sends.
 *
 * address(0) is native ETH. state() faces address(0) as WETH so reserves line up with the wrapped address
 * the rest of the app stores. A trade does not. A WETH market matches only a WETH currency, and a native
 * market matches only address(0). The real key is kept on PoolRef.v4. The safety probe still accepts WETH
 * as a stand-in for address(0), because it simulates the pool's own currency.
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

/** Shown when a V4 pool's currencies are not the market's tokens (native ETH is not WETH). */
export const V4_CURRENCY_MISMATCH = 'V4 pool currency does not match this market: native ETH and WETH are different pools';

/**
 * Both pool currencies equal the market's tokens. `native` means address(0). The wrapped-native
 * address is a different currency and does not match address(0).
 */
export function v4PoolMatches(
  pool: { v4?: { currency0: string; currency1: string } },
  base: { address: string; native?: boolean },
  quote: { address: string; native?: boolean },
): boolean {
  const v = pool.v4;
  if (!v) return false;
  const want = [(base.native ? ZERO : base.address).toLowerCase(), (quote.native ? ZERO : quote.address).toLowerCase()].sort();
  const have = [v.currency0.toLowerCase(), v.currency1.toLowerCase()].sort();
  return want[0] === have[0] && want[1] === have[1];
}

/**
 * Quote view for an exact match against this pool. Add-token passes the wrapped address for both
 * currencies; a pool that actually uses address(0) is a native market, and a pool that uses the
 * wrapped address stays a wrapped market.
 */
export function v4QuoteForPool<T extends { address: string; native?: boolean }>(
  pool: { v4?: { currency0: string; currency1: string } },
  quote: T,
  wrapped: string,
): T {
  const v = pool.v4;
  if (!v || quote.native || !sameAddr(quote.address, wrapped)) return quote;
  if ([v.currency0, v.currency1].some((c) => isZero(c))) return { ...quote, native: true };
  return quote;
}

/** getLogs or the head read failed. `pools` are the chunks that completed; the scan is incomplete. */
export class V4ScanError extends Error {
  readonly partial = true;
  constructor(message: string, readonly pools: PoolRef[]) {
    super(message);
    this.name = 'V4ScanError';
  }
}

/** Inclusive getLogs span. Robinhood rejects a range of 10_000_000 blocks or more. */
export const V4_LOG_CHUNK = 9_000_000;

type LogReader = {
  getBlockNumber(): Promise<number>;
  getLogs(f: { address: string; topics: (string | string[] | null)[]; fromBlock: number; toBlock: number }): Promise<readonly { topics: readonly string[]; data: string }[]>;
};

export type V4Reader = Pick<ChainReader, 'call'> & Partial<LogReader>;

interface PairCache { to: number; pools: PoolRef[] }

/**
 * The one sorted pair to search. WETH is not rewritten to address(0): a native market passes address(0)
 * itself, and a WETH market passes the wrapped address. `wrapped` is unused and kept so callers stay put.
 */
export function currencyPairs(a: string, b: string, wrapped: string): [string, string][] {
  void wrapped;
  return [sortCurrencies(getAddress(a), getAddress(b))];
}

/**
 * Map a market token onto this pool's currency. 'native' is address(0) only. The wrapped-native
 * address matches only the wrapped currency, never address(0).
 */
export function resolveCurrency(token: string, key: V4PoolKey, wrapped: string): string {
  if (token === NATIVE) {
    if (isZero(key.currency0)) return key.currency0;
    if (isZero(key.currency1)) return key.currency1;
    return token;
  }
  if (sameAddr(token, wrapped)) {
    if (sameAddr(key.currency0, wrapped)) return key.currency0;
    if (sameAddr(key.currency1, wrapped)) return key.currency1;
    return token;
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
    const add = (p: PoolRef) => {
      const id = p.address.toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      out.push(p);
    };
    for (const [c0, c1] of currencyPairs(a, b, this.wrappedNative)) {
      try {
        for (const p of await this.poolsFor(c0, c1, { getLogs: logs, getBlockNumber: headOf })) add(p);
      } catch (e) {
        if (e instanceof V4ScanError) {
          for (const p of e.pools) add(p);
          throw new V4ScanError(e.message, out);
        }
        throw e;
      }
    }
    return out;
  }

  private async poolsFor(c0: string, c1: string, reader: LogReader): Promise<PoolRef[]> {
    const key = `${c0.toLowerCase()}:${c1.toLowerCase()}`;
    const start = this.cfg.v4StartBlock ?? 0;
    const cache = this.cache.get(key) ?? { to: start - 1, pools: [] };
    let head: number;
    try { head = await reader.getBlockNumber(); }
    catch (e) { throw new V4ScanError(`V4 Initialize scan failed: ${(e as Error).message || 'head unavailable'}`, cache.pools); }
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
      } catch (e) {
        throw new V4ScanError(
          `V4 Initialize scan failed for ${c0}/${c1} at blocks ${from}-${to}: ${(e as Error).message || 'getLogs failed'}`,
          cache.pools,
        );
      }
      for (const log of logs) {
        const ref = this.parseInit(log);
        // Topics are indexed, but a mis-delivered log must not attach address(0) to a WETH search.
        if (!ref?.v4 || !sameAddr(ref.v4.currency0, c0) || !sameAddr(ref.v4.currency1, c1)) continue;
        cache.pools.push(ref);
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
    // TAKE_ALL pays msgSender(), the transaction signer. The V4 command has no recipient field, so
    // `recipient` must be that signer (Quoter passes the account it is quoting for).
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
