import { BridgeError } from './errors';
import type { BridgeEta } from './types';

/**
 * Pure ETA gate. Compares p90 seconds to `maxEtaSec`.
 * p50 is not consulted: a fast typical fill with a slow tail still fails a tight cap.
 */
export function withinEta(eta: BridgeEta, maxEtaSec: number): boolean {
  if (typeof maxEtaSec !== 'number' || !Number.isFinite(maxEtaSec) || maxEtaSec < 0) {
    throw new BridgeError('bridge', 'invalid', 'bridge: maxEta must be a non-negative number of seconds');
  }
  if (eta == null || typeof eta.p90Sec !== 'number' || !Number.isFinite(eta.p90Sec) || eta.p90Sec < 0) return false;
  return eta.p90Sec <= maxEtaSec;
}

export function filterByEta<T extends { eta: BridgeEta }>(quotes: readonly T[], maxEtaSec: number): T[] {
  return quotes.filter((q) => withinEta(q.eta, maxEtaSec));
}
