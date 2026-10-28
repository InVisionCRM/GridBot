/**
 * Holds one adapted snapshot. A heartbeat carries that same asOf.
 * It does not stamp the current time, and it does not change money.
 */
import type { DeskDelta, DeskSnapshot } from './metrics';

export function createSnapshotDesk(snap: DeskSnapshot) {
  return {
    snapshot(): DeskSnapshot {
      return snap;
    },
    tick(): DeskDelta {
      return { asOf: snap.portfolio.asOf, portfolio: snap.portfolio, bots: [], prices: [], activity: [] };
    },
  };
}
