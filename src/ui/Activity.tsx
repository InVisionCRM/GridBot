/** Animated activity feed (newest first). New items slide in; respects prefers-reduced-motion via CSS. */
import { useMemo, useState } from 'react';
import type { ActivityEvent } from './useStream';
import { ChainBadge, chainOf, explorerTx, useChainFilter } from './chains';

const ICON: Record<string, string> = {
  tick: '◷', signal: '⚡', blocked: '⛔', queued: '⋯', sent: '↗', confirmed: '✓', filled: '●', skipped: '↷', stop_moved: '⇡',
  alert: '🔔', range: '⇹', started: '▶', stopped: '■', error: '✕', info: 'i', candles: '▤',
};
const FILTERS: Record<string, (e: ActivityEvent) => boolean> = {
  all: () => true,
  trades: (e) => ['queued', 'sent', 'confirmed', 'filled', 'skipped'].includes(e.type),
  signals: (e) => ['signal', 'blocked', 'stop_moved', 'tick'].includes(e.type),
  alerts: (e) => ['alert', 'range'].includes(e.type),
  system: (e) => ['started', 'stopped', 'error', 'info', 'candles'].includes(e.type),
};

export function Activity({ events, compact = false, connected, status }: { events: ActivityEvent[]; compact?: boolean; connected: boolean; status?: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [f, setF] = useState<keyof typeof FILTERS>('all');
  const { chain } = useChainFilter();
  const [showTicks, setShowTicks] = useState(false);
  const list = useMemo(() => [...events].reverse().filter((e) => FILTERS[f](e) && (showTicks || e.type !== 'tick' || f === 'signals') && (chain === 'all' || e.chainId == null || e.chainId === chain)).slice(0, compact ? 80 : 300), [events, f, showTicks, compact, chain]);
  const now = Date.now();
  return (
    <div className={`activity ${compact ? 'compact' : ''}`}>
      <div className="activity-head">
        <strong>Activity</strong>
        <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'live (server-sent events)' : 'polling fallback'}>{connected ? 'LIVE' : 'POLL'}</span>
        <span className="grow" />
        <label className="small muted tick-toggle"><input type="checkbox" checked={showTicks} onChange={(e) => setShowTicks(e.target.checked)} /> candle ticks</label>
      </div>
      <div className="seg small">{Object.keys(FILTERS).map((k) => <button key={k} type="button" className={k === f ? 'on' : ''} onClick={() => setF(k)}>{k}</button>)}</div>
      <ul className="feed">
        {list.map((e) => (
          <li key={e.id} className={`ev ev-${e.type} lv-${e.level} ${now - e.t < 4000 ? 'fresh' : ''}`}>
            <span className="ev-ic">{ICON[e.type] ?? '·'}</span>
            <span className="ev-body">
              <span className="ev-msg">{status && e.chainId != null && e.chainId !== status.legacyChainId ? <ChainBadge c={chainOf(status, e.chainId)} testnet={false} /> : null}{e.msg}</span>
              <span className="ev-meta">{new Date(e.t).toLocaleTimeString()} · {e.type}{e.kind && e.kind !== 'system' ? ` · ${e.kind}` : ''}
                {status && typeof e.data?.hash === 'string' && !String(e.data.hash).startsWith('paper') ? <> · <a href={explorerTx(status, e.chainId, String(e.data.hash))} target="_blank" rel="noreferrer">explorer ↗</a></> : null}</span>
            </span>
          </li>
        ))}
        {!list.length && <li className="muted small">Nothing yet — events appear here as bots tick, signal, queue, send and fill.</li>}
      </ul>
    </div>
  );
}
