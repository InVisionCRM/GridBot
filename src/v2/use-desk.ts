/** SSE deltas. The hook replaces server fields. It does not add them up. */
import { useEffect, useState } from 'react';
import type { DeskDelta, DeskSnapshot } from './metrics';

const WAIT_MS = 8_000;

/** A heartbeat lists no bot, price, or activity edits. It must not move the data time. */
export function isHeartbeat(d: DeskDelta): boolean {
  return d.bots.length === 0 && (d.removedIds?.length ?? 0) === 0 && d.prices.length === 0 && d.activity.length === 0;
}

/** Merge a delta by bot id. An empty bot list keeps the current bots. removedIds drops them. */
export function applyDelta(cur: DeskSnapshot, d: DeskDelta): DeskSnapshot {
  if (isHeartbeat(d)) return cur;
  const removed = new Set(d.removedIds ?? []);
  const incoming = new Map(d.bots.map((b) => [b.metrics.botId, b]));
  const seen = new Set<string>();
  const bots = [];
  for (const b of cur.bots) {
    const id = b.metrics.botId;
    if (removed.has(id)) continue;
    const next = incoming.get(id);
    if (next) { bots.push(next); seen.add(id); } else bots.push(b);
  }
  for (const b of d.bots) {
    if (!seen.has(b.metrics.botId) && !removed.has(b.metrics.botId)) bots.push(b);
  }
  return {
    source: cur.source,
    portfolio: d.portfolio,
    prices: d.prices.length ? d.prices : cur.prices,
    bots,
    activity: d.activity.length ? [...d.activity, ...cur.activity].slice(0, 48) : cur.activity,
  };
}

export function useDesk() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let got = false;
    const es = new EventSource('/api/v2/stream');
    const timer = window.setTimeout(() => { if (!got) setFailed(true); }, WAIT_MS);
    const live = () => { got = true; setFailed(false); setStale(false); };
    const onSnap = (e: Event) => {
      live();
      setSnap(JSON.parse((e as MessageEvent).data) as DeskSnapshot);
    };
    const onDelta = (e: Event) => {
      const d = JSON.parse((e as MessageEvent).data) as DeskDelta;
      live();
      setSnap((cur) => (cur ? applyDelta(cur, d) : cur));
    };
    es.addEventListener('snapshot', onSnap);
    es.addEventListener('delta', onDelta);
    es.addEventListener('hb', () => setStale(false));
    es.addEventListener('problem', () => setFailed(true));
    es.onerror = () => {
      setStale(true);
      if (!got) setFailed(true);
    };
    return () => { window.clearTimeout(timer); es.close(); };
  }, []);
  return { snap, stale, failed };
}
