/**
 * Live state over SSE (/api/bot/stream?v=2, docs/stream-v2.md) with automatic fallback to polling.
 * v2: the status comes once in hello, then as patches (only what changed). A patch out of sequence, or a new server
 * epoch, makes it reconnect (the new hello is a full snapshot). `stale` turns on when nothing (not even the hb) arrived
 * for 3 heartbeats.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { botApi, http } from './api';
import { apply, type Op } from '../live/delta';

export interface ActivityEvent {
  id: number; t: number; type: string; level: 'info' | 'success' | 'warn' | 'error'; msg: string;
  botId?: string; kind?: string; pair?: string; chainId?: number; notify?: boolean; data?: Record<string, unknown>;
}
export interface Ticks { t: number; prices: Record<string, number> }

export function useStream(onEvent?: (e: ActivityEvent) => void) {
  const [status, setStatus] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [ticks, setTicks] = useState<Ticks | null>(null);
  const [prevTicks, setPrevTicks] = useState<Ticks | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const lastId = useRef(0);

  const refresh = useCallback(async () => {
    try { setStatus(await botApi('status')); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const push = (list: ActivityEvent[], live: boolean) => {
      const fresh = list.filter((e) => e.id > lastId.current);
      if (!fresh.length) return;
      lastId.current = fresh[fresh.length - 1].id;
      setEvents((prev) => [...prev, ...fresh].slice(-300));
      if (live) fresh.forEach((e) => cb.current?.(e));
    };
    const pollOnce = async () => {
      await refresh();
      try { push((await http<{ events: ActivityEvent[] }>(`/api/activity?since=${lastId.current}`)).events, true); } catch { /* offline */ }
    };
    const startPoll = () => { if (!poll) poll = setInterval(pollOnce, 3000); };
    const stopPoll = () => { if (poll) clearInterval(poll); poll = null; };
    void refresh();
    if (typeof EventSource === 'undefined') { startPoll(); return stopPoll; }
    let seq = -1, epoch = '', hbMs = 5000, lastMsg = Date.now(), dead = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const seen = () => { lastMsg = Date.now(); setStale(false); };
    const watch = setInterval(() => { if (poll) { setStale(false); return; } if (Date.now() - lastMsg > hbMs * 3) setStale(true); }, 1000); // polling has its own error line
    const open = () => {
      es?.close();
      es = new EventSource('/api/bot/stream?v=2');
      es.addEventListener('hello', (e) => {
        const h = JSON.parse((e as MessageEvent).data);
        seen(); setConnected(true); stopPoll();
        seq = h.seq; epoch = h.epoch; hbMs = h.hbMs ?? hbMs;
        if (h.status) setStatus(h.status);
        push(h.recent, false);
      });
      es.addEventListener('patch', (e) => {
        const p = JSON.parse((e as MessageEvent).data) as { seq: number; ops: Op[] };
        seen();
        if (p.seq !== seq + 1) { resync(); return; } // missed one: start over from a fresh snapshot
        seq = p.seq;
        setStatus((prev: unknown) => (prev == null ? prev : apply(prev, p.ops)));
      });
      es.addEventListener('hb', (e) => {
        const h = JSON.parse((e as MessageEvent).data) as { seq: number; epoch: string };
        seen();
        if (h.epoch !== epoch || h.seq < seq) resync(); // the server restarted
      });
      es.addEventListener('activity', (e) => { seen(); push([JSON.parse((e as MessageEvent).data)], true); });
      es.addEventListener('ticks', (e) => { seen(); const t = JSON.parse((e as MessageEvent).data); setTicks((p) => { setPrevTicks(p); return t; }); });
      es.addEventListener('status', (e) => { seen(); setStatus(JSON.parse((e as MessageEvent).data)); }); // a v1 server
      es.onerror = () => { setConnected(false); startPoll(); };
    };
    const resync = () => { if (dead || retry) return; retry = setTimeout(() => { retry = null; if (!dead) open(); }, 200); };
    open();
    return () => { dead = true; es?.close(); stopPoll(); clearInterval(watch); if (retry) clearTimeout(retry); };
  }, [refresh]);

  return { status, events, ticks, prevTicks, connected, stale, error, refresh };
}
