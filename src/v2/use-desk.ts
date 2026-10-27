/** SSE deltas. The hook replaces server fields. It does not add them up. */
import { useEffect, useState } from 'react';
import type { DeskDelta, DeskSnapshot } from './metrics';

export function useDesk() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/v2/stream');
    const live = () => setStale(false);
    const onSnap = (e: Event) => {
      live();
      setSnap(JSON.parse((e as MessageEvent).data) as DeskSnapshot);
    };
    const onDelta = (e: Event) => {
      const d = JSON.parse((e as MessageEvent).data) as DeskDelta;
      live();
      setSnap((cur) => {
        if (!cur) return cur;
        const next = new Map(d.bots.map((b) => [b.metrics.botId, b]));
        return {
          source: cur.source,
          portfolio: d.portfolio,
          prices: d.prices.length ? d.prices : cur.prices,
          bots: cur.bots.map((b) => next.get(b.metrics.botId) ?? b),
          activity: d.activity.length ? [...d.activity, ...cur.activity].slice(0, 48) : cur.activity,
        };
      });
    };
    es.addEventListener('snapshot', onSnap);
    es.addEventListener('delta', onDelta);
    es.onerror = () => setStale(true);
    return () => es.close();
  }, []);
  return { snap, stale };
}
