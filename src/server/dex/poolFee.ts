/**
 * A pool's real swap fee. V2: the DEX's verified fee (one fee per factory). V3 (Uniswap, PancakeSwap and forks): the
 * pool's own fee() (uint24, hundredths of a bip: 100 = 0.01 %, 10000 = 1 %); each pool of a token has its own tier, so
 * a DEX's first tier is never a stand-in (that priced every 1 % pool at 0.01 %, 2026-10-27).
 *
 * Dynamic-fee pools (Aerodrome Slipstream style, DexConfig.dynamicFee) can change fee() between blocks: callers must
 * read it at quote time and not cache it. Static V3 pools have an immutable fee(), so one read is enough.
 */
import type { DexConfig } from '../../live/chains';
import type { ChainReader } from '../bot/chain';
import { V3_POOL } from './abis';
import { readCall } from './types';

/** uint24 fee (hundredths of a bip) → bps: 100 → 1, 500 → 5, 3000 → 30, 10000 → 100. */
export const feeTierToBps = (tier: number) => tier / 100;

/** The V3 pool's current fee() in bps. Throws when the pool has no fee() (not a V3-style pool) or it is out of range. */
export async function readV3FeeBps(reader: Pick<ChainReader, 'call'>, pool: string): Promise<number> {
  const [raw] = await readCall<[bigint]>(reader, pool, V3_POOL, 'fee');
  const tier = Number(raw);
  // 1_000_000 = 100 %; anything at or above that is not a fee
  if (!Number.isFinite(tier) || tier < 0 || tier >= 1_000_000) throw new Error(`pool ${pool}: fee() ${raw} is out of range`);
  return feeTierToBps(tier);
}

/** Fee for a pool on a known DEX: V2 = the DEX's fee; V3 = fee() read from the pool. null = unknown (don't trade it). */
export async function poolFeeBps(reader: Pick<ChainReader, 'call'>, pool: string, dex: Pick<DexConfig, 'kind' | 'feeBps'> | null | undefined): Promise<number | null> {
  if (dex?.kind === 'v2') return dex.feeBps ?? null;
  // V4 has no per-pool fee() and is not swapped by this path.
  if (dex?.kind === 'v4') return null;
  try { return await readV3FeeBps(reader, pool); } catch { return null; }
}
