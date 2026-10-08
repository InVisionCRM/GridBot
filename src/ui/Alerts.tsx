/** Alerts (server-evaluated: price above/below, RSI threshold, grid out of range) + opt-in browser notifications. */
import { useState } from 'react';
import { PairPicker, lbl, mk } from './chains';
import { http } from './api';
import { px, time } from './fmt';
import type { ActivityEvent } from './useStream';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface NotifyPrefs { enabled: boolean; fills: boolean; stops: boolean; errors: boolean; range: boolean; alerts: boolean; pnl: boolean; pnlUsd: number }
export const DEFAULT_PREFS: NotifyPrefs = { enabled: false, fills: true, stops: true, errors: true, range: true, alerts: true, pnl: true, pnlUsd: 10 };
export function loadPrefs(): NotifyPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('notify-prefs') ?? '{}') }; } catch { return DEFAULT_PREFS; }
}
export function savePrefs(p: NotifyPrefs) { localStorage.setItem('notify-prefs', JSON.stringify(p)); }

/** Which notification category an activity event belongs to (null = never notify). */
export function notifyCategory(e: ActivityEvent): keyof NotifyPrefs | null {
  if (!e.notify) return null;
  if (e.type === 'filled') return 'fills';
  if (e.type === 'signal' && /stop|take-profit/.test(e.msg)) return 'stops';
  if (e.type === 'stopped' || e.type === 'error' || e.type === 'skipped') return 'errors';
  if (e.type === 'range') return 'range';
  if (e.type === 'alert') return 'alerts';
  return null;
}

export function notify(title: string, body: string, tag?: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag, silent: false }); } catch { /* some browsers need a service worker */ }
}

export function Alerts({ status: s, prefs, setPrefs }: { status: AnyObj; prefs: NotifyPrefs; setPrefs: (p: NotifyPrefs) => void }) {
  const [f, setF] = useState({ type: 'price_above', pair: 'DAI', value: '', tf: '1h', botId: '', repeat: false });
  const [err, setErr] = useState<string | null>(null);
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const enable = async () => {
    if (typeof Notification === 'undefined') return setErr('This browser has no Notification API.');
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (p !== 'granted') return setErr('Notifications were not allowed by the browser.');
    setPrefs({ ...prefs, enabled: true });
    notify('Notifications on', 'You will be notified about the events you selected.');
  };
  const add = async () => {
    setErr(null);
    try {
      await http('/api/alerts', 'POST', { type: f.type, pair: f.pair, value: +f.value, tf: f.tf, botId: f.botId || undefined, repeat: f.repeat });
      setF((x) => ({ ...x, value: '' }));
    } catch (e) { setErr((e as Error).message); }
  };
  const call = (fn: () => Promise<unknown>) => fn().catch((e) => setErr((e as Error).message));
  const spot = s.spots?.[f.pair] ?? mk(s, f.pair).spot;
  const tog = (k: keyof NotifyPrefs) => setPrefs({ ...prefs, [k]: !prefs[k] });

  return (
    <div className="split">
      <div className="card">
        <h3>Browser notifications <span className="muted small">opt-in · {perm}</span></h3>
        <div className="actions">
          {prefs.enabled && perm === 'granted'
            ? <button type="button" className="btn" onClick={() => setPrefs({ ...prefs, enabled: false })}>Turn off</button>
            : <button type="button" className="btn primary" onClick={enable}>Enable notifications</button>}
          <button type="button" className="btn small-btn" disabled={perm !== 'granted'} onClick={() => notify('Test', 'PulseChain bot notification test')}>Test</button>
        </div>
        <div className="checks">
          {([['fills', 'Fills (grid + trend)'], ['stops', 'Stops / trailing / take-profit hit'], ['errors', 'Bot stopped / errors / skipped sells'], ['range', 'Price leaves a grid range'], ['alerts', 'Alerts below'], ['pnl', 'Large PnL change']] as const).map(([k, l]) => (
            <label key={k}><input type="checkbox" checked={!!prefs[k]} onChange={() => tog(k)} /> {l}</label>
          ))}
          <label>Large PnL change ≥ $<input type="number" value={prefs.pnlUsd} style={{ width: 70 }} onChange={(e) => setPrefs({ ...prefs, pnlUsd: Math.max(1, +e.target.value) })} /> (Σ realized + unrealized)</label>
        </div>
        {err && <div className="banner warn">{err}</div>}
      </div>
      <div className="card">
        <h3>Alerts <span className="muted small">evaluated server-side every poll · fire on the crossing edge</span></h3>
        <div className="form-row">
          <label>Type<select value={f.type} onChange={(e) => setF((x) => ({ ...x, type: e.target.value }))}>
            <option value="price_above">Price above</option><option value="price_below">Price below</option>
            <option value="rsi_above">RSI(14) above</option><option value="rsi_below">RSI(14) below</option><option value="grid_range">Grid out of range</option>
          </select></label>
          {f.type !== 'grid_range' ? (
            <>
              <PairPicker s={s} value={f.pair} onChange={(key) => setF((x) => ({ ...x, pair: key }))} />
              <label>{f.type.startsWith('rsi') ? 'RSI' : `Price (${mk(s, f.pair).quote}/${mk(s, f.pair).base})`}<input value={f.value} placeholder={f.type.startsWith('rsi') ? '70' : spot ? px(spot) : ''} onChange={(e) => setF((x) => ({ ...x, value: e.target.value }))} /></label>
              {f.type.startsWith('rsi') && <label>TF<select value={f.tf} onChange={(e) => setF((x) => ({ ...x, tf: e.target.value }))}>{['5m', '15m', '1h', '4h', '1d'].map((t) => <option key={t}>{t}</option>)}</select></label>}
            </>
          ) : (
            <label>Grid<select value={f.botId} onChange={(e) => setF((x) => ({ ...x, botId: e.target.value }))}><option value="">—</option>{(s.grids ?? []).map((g: AnyObj) => <option key={g.id} value={g.id}>{lbl(s, g.stable)} {g.id.slice(0, 10)}</option>)}</select></label>
          )}
          <label><span>Repeat</span><input type="checkbox" checked={f.repeat} onChange={(e) => setF((x) => ({ ...x, repeat: e.target.checked }))} /></label>
          <button type="button" className="btn primary small-btn" onClick={add}>Add alert</button>
        </div>
        {spot && <p className="muted small">{lbl(s, f.pair)} now {px(spot)}</p>}
        <table>
          <thead><tr><th>Alert</th><th>State</th><th>Last fired</th><th></th></tr></thead>
          <tbody>{(s.alerts ?? []).map((a: AnyObj) => (
            <tr key={a.id}>
              <td>{a.type === 'grid_range' ? `Grid ${a.botId?.slice(0, 10)} (${lbl(s, a.pair)}) out of range` : `${lbl(s, a.pair)} ${a.type.startsWith('rsi') ? `RSI14 ${a.tf}` : 'price'} ${a.type.endsWith('above') ? '≥' : '≤'} ${a.type.startsWith('rsi') ? a.value : px(a.value)}`}{a.repeat ? ' · repeat' : ''}</td>
              <td className={a.active ? 'neg' : a.enabled ? 'pos' : 'muted'}>{a.active ? 'triggered' : a.enabled ? 'armed' : 'off'}</td>
              <td>{a.lastFiredAt ? time(a.lastFiredAt) : '—'}</td>
              <td className="actions">
                <button type="button" className="btn small-btn" onClick={() => call(() => http(`/api/alerts/${a.id}`, 'PUT', { enabled: !a.enabled }))}>{a.enabled ? 'Disable' : 'Enable'}</button>
                <button type="button" className="btn small-btn danger" onClick={() => call(() => http(`/api/alerts/${a.id}`, 'DELETE'))}>✕</button>
              </td>
            </tr>
          ))}{!(s.alerts ?? []).length && <tr><td colSpan={4} className="muted">no alerts</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}
