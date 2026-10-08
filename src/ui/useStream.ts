/** Live state over SSE (/api/bot/stream) with automatic fallback to polling. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { botApi, http } from './api';

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
    es = new EventSource('/api/bot/stream');
    es.addEventListener('hello', (e) => { setConnected(true); stopPoll(); push(JSON.parse((e as MessageEvent).data).recent, false); });
    es.addEventListener('activity', (e) => push([JSON.parse((e as MessageEvent).data)], true));
    es.addEventListener('ticks', (e) => { const t = JSON.parse((e as MessageEvent).data); setTicks((p) => { setPrevTicks(p); return t; }); });
    es.addEventListener('status', (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => { setConnected(false); startPoll(); };
    return () => { es?.close(); stopPoll(); };
  }, [refresh]);

  return { status, events, ticks, prevTicks, connected, error, refresh };
}
