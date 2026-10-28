/**
 * Live assess adapter for `lpUnlockCheck`. V2 reads the pair as an LP token. V3 reuses the position-NFT check.
 * eth_call only. Never throws: a reader failure comes back unverified.
 */
import type { ChainConfig } from '../../live/chains';
import { lpUnlockFromV3, readV2LpUnlock, unverifiedLpUnlock, type LpUnlockEvidence } from '../../market/lpUnlock';
import type { FreshPool } from '../../market/tokenTrader';
import type { V3LpReport } from '../../market/v3LpLock';
import { readV3LpLock, v3LockRpc, type V3LockReader } from './v3LpLockRead';

export async function readLiveLpUnlock(
  reader: V3LockReader,
  pool: FreshPool,
  dexes: ChainConfig['dexes'],
  o: { nowSec: number; blockTimeSec: number; logChunk: number },
  /** When the V3 flag already read this pool, reuse that report instead of calling again. */
  v3Report?: V3LpReport,
): Promise<LpUnlockEvidence> {
  try {
    if (pool.kind === 'v3') {
      const report = v3Report ?? await readV3LpLock(reader, pool, dexes, o);
      return lpUnlockFromV3(report);
    }
    if (pool.kind === 'v2') {
      return await readV2LpUnlock(v3LockRpc(reader), { chainId: pool.chainId, pool: pool.pool, token: pool.token });
    }
    return unverifiedLpUnlock('other', 'no LP lock read for this pool');
  } catch (e) {
    const kind = pool.kind === 'v3' ? 'v3' : pool.kind === 'v2' ? 'v2' : 'other';
    return unverifiedLpUnlock(kind, `rpc failed: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
  }
}
