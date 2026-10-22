/** Share of a market's pool fee that liquidity providers keep (V2: measured per DEX; V3: read from the pool's slot0). */
import type { MarketDef } from '../../live/markets';
import { lpShareFromFeeProtocol } from '../../market/lp';
import type { Hub } from '../chains/hub';
import { V3_POOL_FEES } from '../dex/abis';
import { readCall } from '../dex/types';

export async function lpShareOf(hub: Hub, d: MarketDef): Promise<number> {
  const dex = hub.chain(d.chainId).dexes.find((x) => x.id === d.pool.dex);
  if (!dex) throw new Error(`unknown DEX ${d.pool.dex}`);
  if (dex.kind === 'v2') {
    if (dex.lpShare == null) throw new Error(`${dex.name}: the share of fees paid to liquidity providers isn't verified`);
    return dex.lpShare;
  }
  if (!dex.protocolFee) throw new Error(`${dex.name}: protocol fee encoding isn't verified`);
  const r = await readCall<unknown[]>(hub.rt(d.chainId).reader, d.pool.address, V3_POOL_FEES, 'slot0');
  return lpShareFromFeeProtocol(Number(r[5]), dex.protocolFee);
}
