/**
 * Price impact of the trade the token trader is about to send.
 *
 * V3: one fee() read on the pool we actually have (so a wrong stored fee tier cannot point QuoterV2 at a
 * different pool), then QuoterV2 quoteExactInputSingle plus the mid from slot0. That is the chain's tick walk.
 * V2: the router's getAmountsOut, which is already exact for a constant-product pair.
 *
 * Throws if the quote cannot be read. The caller treats that as unverified and, when the check is on, skips.
 */
import { amountToUnits, readDecimals } from '../../live/decimals';
import type { PoolRef } from '../../live/markets';
import type { FreshPool } from '../../market/tokenTrader';
import type { ChainReader } from '../bot/chain';
import { V3_POOL } from '../dex/abis';
import { readCall, type DexAdapter } from '../dex/types';

export async function quoteTradeImpact(
  rt: { reader: Pick<ChainReader, 'call'>; adapter(id: string): DexAdapter },
  pool: FreshPool,
  spend: number,
): Promise<number> {
  if (!(spend > 0)) throw new Error('trade size is empty');
  if (pool.kind !== 'v2' && pool.kind !== 'v3') throw new Error(`no impact quote for ${pool.kind}`);
  const ad = rt.adapter(pool.dex);
  if (ad.kind !== pool.kind) throw new Error(`${pool.dex} is ${ad.kind}, the pool is ${pool.kind}`);
  const decimals = await readDecimals(rt.reader, pool.chainId, pool.spend);
  const amountIn = amountToUnits(spend, decimals);
  const ref: PoolRef = { dex: pool.dex, kind: pool.kind, address: pool.pool, feeBps: pool.feeBps };
  if (pool.kind === 'v3') {
    const [fee] = await readCall<[bigint]>(rt.reader, pool.pool, V3_POOL, 'fee');
    const feeTier = Number(fee);
    if (!Number.isInteger(feeTier) || feeTier <= 0) throw new Error('pool fee() was unreadable');
    ref.feeTier = feeTier;
    ref.feeBps = feeTier / 100;
  }
  const q = await ad.quote(ref, pool.spend, pool.token, amountIn);
  if (!Number.isFinite(q.impact)) throw new Error('quote returned no impact');
  return q.impact;
}
