/**
 * adaptStatus over a hand-built status row set, with each bot's metrics attached the way status() attaches them
 * (src/server/bot/multi.ts). The desk reads those and computes nothing itself.
 */
import { adaptStatus, type ActivityEvent } from '../../src/v2/adapt-status';
import { gridMetrics, lpMetrics, trendMetrics } from '../../src/metrics/botMetrics';
import type { DeskSnapshot } from '../../src/v2/metrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export function withMetrics(status: Obj, asOf: number): Obj {
  return {
    ...status,
    grids: (status.grids ?? []).map((g: Obj) => ({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, asOf) })),
    lps: (status.lps ?? []).map((lp: Obj) => ({ ...lp, metrics: lpMetrics(lp, asOf) })),
    trends: (status.trends ?? []).map((t: Obj) => ({ ...t, metrics: trendMetrics(t, asOf) })),
  };
}

export function deskOf(status: Obj, events: ActivityEvent[], asOf: number, source?: DeskSnapshot['source']): DeskSnapshot {
  return adaptStatus(withMetrics(status, asOf), events, asOf, source);
}
