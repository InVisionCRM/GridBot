/**
 * Read-only desk built from bot.status() and the activity ring.
 * The same object feeds GET /api/v2/stream and GET /api/bot/:id/metrics.
 * It does not start, stop, or configure a bot, and it does not copy wallet fields.
 */
import { adaptStatus, type ActivityEvent as DeskEvent } from '../v2/adapt-status';
import type { ActivityEvent } from './bot/activity';
import type { DeskDelta, DeskSnapshot } from '../v2/metrics';

export function deskFromStatus(status: Record<string, unknown>, events: ActivityEvent[] = []): DeskSnapshot {
  const mapped: DeskEvent[] = events
    .filter((e) => e.type === 'filled' || e.type === 'range' || e.type === 'queued')
    .map((e) => ({ id: e.id, t: e.t, type: e.type, kind: e.kind, msg: e.msg, botId: e.botId, level: e.level }));
  const asOf = typeof status.spotsAt === 'number' ? status.spotsAt : Date.now();
  return adaptStatus(status, mapped, asOf, 'live');
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed between two desks. Unchanged bots are omitted. An empty delta is a heartbeat, not a removal. */
export function deskDelta(prev: DeskSnapshot, next: DeskSnapshot): DeskDelta {
  const prevIds = new Set(prev.bots.map((b) => b.metrics.botId));
  const nextById = new Map(next.bots.map((b) => [b.metrics.botId, b]));
  const removedIds = [...prevIds].filter((id) => !nextById.has(id));
  const bots = next.bots.filter((b) => {
    const old = prev.bots.find((p) => p.metrics.botId === b.metrics.botId);
    return !old || !sameJson(old, b);
  });
  const seen = new Set(prev.activity.map((a) => a.id));
  return {
    asOf: next.portfolio.asOf,
    portfolio: next.portfolio,
    bots,
    removedIds,
    prices: sameJson(prev.prices, next.prices) ? [] : next.prices,
    activity: next.activity.filter((a) => !seen.has(a.id)),
  };
}

export function deskChanged(d: DeskDelta): boolean {
  return d.bots.length > 0 || (d.removedIds?.length ?? 0) > 0 || d.prices.length > 0 || d.activity.length > 0;
}
