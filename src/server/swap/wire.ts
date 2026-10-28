/**
 * Host wiring for SwapService. A friend's copy (readCopy) does not construct the service.
 * Taxes and the V3 proof come from the hub's safety reports (the same numbers the grid quoter uses).
 */
import type { Hub } from '../chains/hub';
import { sameAddr } from '../dex/types';
import type { SpendHolds, ReservedBalance } from './holds';
import { SwapService, type SwapServiceDeps } from './service';
import type { SwapAllocation } from './types';

export function swapDepsFromHub(d: {
  hub: Hub;
  allocations(): SwapAllocation[];
  reservations(): ReservedBalance[];
  holds?: SpendHolds;
}): SwapServiceDeps {
  return {
    runtime: (chainId) => d.hub.rt(chainId),
    allocations: d.allocations,
    reservations: d.reservations,
    taxes: (chainId, token) => d.hub.taxOf(chainId, token),
    v3Proven: (chainId, token) => d.hub.byChain(chainId).some((m) => m.safety?.taxMode === 'v3-proven' && sameAddr(m.base.address, token)),
    holds: d.holds,
  };
}

/** Undefined on a friend's copy, so the process neither builds nor serves swap quotes. */
export function swapForHost(copy: boolean, d: Parameters<typeof swapDepsFromHub>[0]): SwapService | undefined {
  if (copy) return undefined;
  return new SwapService(swapDepsFromHub(d));
}
