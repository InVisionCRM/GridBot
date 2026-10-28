/**
 * Adapts a chain reader to the V3 lock check. eth_call reverts become `0x` (the contract answered).
 * Transport errors, including a rate limit, are thrown so the check can back off and, if they persist, fail closed.
 * Nothing here signs or sends a transaction.
 */
import type { ChainConfig } from '../../live/chains';
import { inspectV3LpLock, unverifiedV3Lp, type V3LockLog, type V3LockRpc, type V3LpReport } from '../../market/v3LpLock';
import type { FreshPool } from '../../market/tokenTrader';
import { isTransportError } from '../chains/fallback';

export interface V3LockReader {
  call(tx: { to: string; data: string }): Promise<string>;
  getCode?(address: string): Promise<string>;
  getBlockNumber?(): Promise<number>;
  getTransactionReceipt?(hash: string): Promise<{ logs: readonly { address?: string; topics: readonly string[]; data: string; blockNumber?: number; transactionHash?: string }[] } | null>;
  getLogs?(f: { address: string; topics: (string | string[])[]; fromBlock: number; toBlock: number }): Promise<readonly { address?: string; topics: readonly string[]; data: string; blockNumber: number; transactionHash?: string }[]>;
}

const unavailable = (what: string) => () => Promise.reject(new Error(`${what} is not available on this reader`));

/** Map a chain reader onto the check's RPC. Reverts are `0x`; everything else is thrown. */
export function v3LockRpc(reader: V3LockReader): V3LockRpc {
  return {
    async call(to, data) {
      try {
        return await reader.call({ to, data });
      } catch (e) {
        if (!isTransportError(e)) return '0x';
        throw e;
      }
    },
    getCode: reader.getCode ? (a) => reader.getCode!(a) : unavailable('getCode'),
    blockNumber: reader.getBlockNumber ? () => reader.getBlockNumber!() : unavailable('getBlockNumber'),
    getLogs: reader.getLogs
      ? async (f) => {
        const logs = await reader.getLogs!(f);
        return logs.map((l): V3LockLog => ({
          address: l.address ?? f.address, topics: [...l.topics], data: l.data,
          blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash,
        }));
      }
      : unavailable('getLogs'),
    getReceipt: reader.getTransactionReceipt
      ? async (hash) => {
        const receipt = await reader.getTransactionReceipt!(hash);
        if (!receipt) return null;
        return {
          logs: receipt.logs.map((l) => ({
            address: l.address ?? '', topics: [...l.topics], data: l.data,
            blockNumber: Number(l.blockNumber ?? 0), transactionHash: l.transactionHash ?? hash,
          })),
        };
      }
      : unavailable('getTransactionReceipt'),
  };
}

export function positionManagerFor(dexes: ChainConfig['dexes'], dexId: string): string | null {
  const hit = dexes.find((d) => d.id === dexId || d.gecko === dexId);
  if (hit?.kind === 'v3' && hit.positionManager) return hit.positionManager;
  return null;
}

/** Run the check for one discovered pool. V2 / flag-off callers should not use this. Never throws. */
export async function readV3LpLock(reader: V3LockReader, pool: FreshPool, dexes: ChainConfig['dexes'], o: {
  nowSec: number; blockTimeSec: number; logChunk: number;
  /** Off unless true. Does not change the check when false or omitted. */
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
  /** 0 or omitted: no cap. */
  callBudget?: number;
  blockNumber?: number;
}): Promise<V3LpReport> {
  const npm = positionManagerFor(dexes, pool.dex);
  if (!npm) return unverifiedV3Lp(pool.pool, '', 'no position manager for this V3 pool');
  const blocksPerDay = Math.ceil(86_400 / Math.max(o.blockTimeSec, 0.2));
  const bounds: { cacheEnabled?: boolean; cacheTtlMs?: number; callBudget?: number; blockNumber?: number } = {};
  if (o.cacheEnabled === true) {
    bounds.cacheEnabled = true;
    if (o.cacheTtlMs != null) bounds.cacheTtlMs = o.cacheTtlMs;
  }
  if (o.callBudget != null && o.callBudget > 0) bounds.callBudget = o.callBudget;
  if (o.blockNumber != null) bounds.blockNumber = o.blockNumber;
  try {
    return await inspectV3LpLock(v3LockRpc(reader), {
      chainId: pool.chainId, pool: pool.pool, positionManager: npm, nowSec: o.nowSec,
      chunkBlocks: Math.max(250, o.logChunk), maxBlockSpan: blocksPerDay * 3,
      ...bounds,
    });
  } catch (e) {
    return unverifiedV3Lp(pool.pool, npm, `rpc failed: ${String((e as Error)?.message ?? e).slice(0, 180)}`);
  }
}
