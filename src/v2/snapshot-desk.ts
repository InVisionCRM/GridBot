/**
 * Holds one adapted snapshot. Heartbeats refresh asOf and do not change money.
 */
import type { DeskDelta, DeskSnapshot } from './metrics';

export function createSnapshotDesk(snap: DeskSnapshot) {
  return {
    snapshot(): DeskSnapshot {
      return snap;
    },
    tick(): DeskDelta {
      const asOf = Date.now();
      return { asOf, portfolio: { ...snap.portfolio, asOf }, bots: [], prices: [], activity: [] };
    },
  };
}
