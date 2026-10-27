/**
 * Two readings of a V3 pool's fee-growth counters, saved on the scan file. The first reading only starts the
 * clock. The next one (an hour to 14 days later) is the fees the pool actually paid, which is what a wash-flagged
 * pool is ranked on.
 */
import type { MarketDef } from '../../live/markets';
import { feesBetween } from '../../market/lpFees';
import { V3_POOL, V3_POOL_LP } from '../dex/abis';
import { readCall, sameAddr } from '../dex/types';
import type { Store } from '../bot/store';
import type { Hub } from '../chains/hub';
import type { ScanFile } from './scanner';

const HOUR = 60 * 60_000;

export async function onchainFeePace(hub: Hub, store: Store<ScanFile>, def: MarketDef, now: number): Promise<{ feesUsd: number; windowMs: number } | null> {
  if (def.pool.kind !== 'v3' || !def.pool.address) return null;
  const reader = hub.rt(def.chainId).reader;
  if (!reader?.call) return null;
  let token0: string, liquidity: bigint, g0: bigint, g1: bigint;
  try {
    [[token0], [liquidity], [g0], [g1]] = await Promise.all([
      readCall<[string]>(reader, def.pool.address, V3_POOL, 'token0'),
      readCall<[bigint]>(reader, def.pool.address, V3_POOL, 'liquidity'),
      readCall<[bigint]>(reader, def.pool.address, V3_POOL_LP, 'feeGrowthGlobal0X128'),
      readCall<[bigint]>(reader, def.pool.address, V3_POOL_LP, 'feeGrowthGlobal1X128'),
    ]);
  } catch { return null; }
  const key = `${def.chainId}:${def.pool.address.toLowerCase()}`;
  const file = store.load();
  const prev = file?.feeMarks?.[key];
  let out: { feesUsd: number; windowMs: number } | null = null;
  if (prev) {
    try {
      const snap = await (hub.has(def.key) ? hub.quoter(def.key) : hub.draftQuoter(def)).market();
      const usdQuote = hub.isStable(def.chainId, def.quote.address) ? 1 : (await hub.nativeUsdAsync(def.chainId)) ?? 0;
      const baseAddr = def.base.native ? hub.chain(def.chainId).wrappedNative.address : def.base.address;
      const baseIs0 = sameAddr(token0, baseAddr);
      const usdBase = snap.spot * usdQuote;
      out = feesBetween({
        atThen: prev.at, now, liquidityThen: BigInt(prev.liquidity), liquidityNow: liquidity,
        g0Then: BigInt(prev.g0), g0Now: g0, g1Then: BigInt(prev.g1), g1Now: g1,
        dec0: baseIs0 ? def.base.decimals : def.quote.decimals,
        dec1: baseIs0 ? def.quote.decimals : def.base.decimals,
        usd0: baseIs0 ? usdBase : usdQuote, usd1: baseIs0 ? usdQuote : usdBase,
      });
    } catch { out = null; }
  }
  // A second reading inside the hour would wipe the window, so the first mark stays until an hour has passed.
  if (file?.version === 4 && !(prev && now - prev.at < HOUR)) {
    file.feeMarks = { ...file.feeMarks, [key]: { at: now, g0: g0.toString(), g1: g1.toString(), liquidity: liquidity.toString() } };
    store.save(file);
  }
  return out;
}
