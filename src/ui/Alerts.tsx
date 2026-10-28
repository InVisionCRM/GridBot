/** Alerts: lock-screen Web Push, in-tab notifications, and server-side price / RSI alerts. */
import { useEffect, useState } from 'react';
import { FILL_DIGEST_LIMIT, FILL_DIGEST_WINDOW_MS, LP_OUT_MS, type PushPrefs, type PushPublicView, type PushType } from '../live/pushRules';
import { pctToEdge, rangeZone } from '../live/rangeBand';
import { ethToUsd, useEthUsd } from './units';
import { http } from './api';
import { ChainBadge, PairPicker, chainOf, chains, lbl, mk, useChainFilter } from './chains';
import { RangeBar } from './charts';
import { dur, num, px, time } from './fmt';
import { disablePush, enablePush, isIos, loadPushStatus, localSubscription, needsHomeScreen, pushOptedIn, savePushPrefs, setPushOptIn, shouldRestorePush, unsubscribePush } from './pushClient';
import type { ActivityEvent } from './useStream';
import { lpName } from './model';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface NotifyPrefs {
  enabled: boolean; fills: boolean; stops: boolean; errors: boolean; range: boolean; alerts: boolean; pnl: boolean; pnlUsd: number;
  gas: boolean; sniper: boolean;
}
export type FeedKey = 'fills' | 'stops' | 'errors' | 'range' | 'alerts' | 'pnl' | 'gas' | 'sniper';
export const DEFAULT_PREFS: NotifyPrefs = {
  enabled: false, fills: true, stops: true, errors: true, range: true, alerts: true, pnl: true, pnlUsd: 10, gas: true, sniper: true,
};
export function loadPrefs(): NotifyPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('notify-prefs') ?? '{}') }; } catch { return DEFAULT_PREFS; }
}
export function savePrefs(p: NotifyPrefs) { localStorage.setItem('notify-prefs', JSON.stringify(p)); }

/** Which in-tab category an activity event belongs to (null = never notify in the tab). */
export function notifyCategory(e: ActivityEvent): FeedKey | null {
  if (!e.notify) return null;
  if (e.type === 'filled') return 'fills';
  if (e.type === 'signal' && /stop|take-profit/.test(e.msg)) return 'stops';
  if (e.type === 'stopped' || e.type === 'error' || e.type === 'skipped') return 'errors';
  if (e.type === 'range') return 'range';
  if (e.type === 'alert') return 'alerts';
  if (e.type === 'info' && /low gas/i.test(e.msg)) return 'gas';
  if (e.data?.push === 'sniper' || e.msg.startsWith('Sniper:')) return 'sniper';
  return null;
}

export function notify(title: string, body: string, tag?: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag, silent: false }); } catch { /* some browsers need a service worker */ }
}

const RULES: { type: PushType; feed: FeedKey | null; title: string; detail: string; mark: string }[] = [
  { type: 'grid_fill', feed: 'fills', mark: 'fill', title: 'Grid fill', detail: `Every buy and sell, with the round-trip net. More than ${FILL_DIGEST_LIMIT} in ${FILL_DIGEST_WINDOW_MS / 60_000} min arrive as one digest.` },
  { type: 'lp_range', feed: 'range', mark: 'lp', title: 'LP near edge / out of range', detail: `Price past 80% of the band, out for ${LP_OUT_MS / 60_000} min, or an auto-move.` },
  { type: 'bot_halted', feed: 'errors', mark: 'halt', title: 'Bot halted', detail: 'A safety stop: tax, impact cap, loss limit, RPC. A button you pressed does not ping.' },
  { type: 'tx_failed', feed: 'errors', mark: 'fail', title: 'Failed transaction', detail: 'Reverts, skipped sells, and a profit send that did not land. The in-tab feed is shared with Bot halted.' },
  { type: 'gas_low', feed: 'gas', mark: 'gas', title: 'Gas low', detail: 'Below that chain’s own threshold.' },
  { type: 'sniper', feed: 'sniper', mark: 'snipe', title: 'Sniper hit', detail: 'A new pool passed checks. Paper or live still follows the token trader; this only notifies.' },
  { type: 'daily_summary', feed: null, mark: 'day', title: 'Daily summary', detail: 'Generated per chain, in the coin, at 21:00 ET. Paper is labeled. Off until you turn it on.' },
];

function Switch({ on, label, disabled, onClick }: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} disabled={disabled} onClick={onClick}>
      <i />
    </button>
  );
}

function feeOf(lp: AnyObj): string {
  if (lp.feeTier != null) return `${+(Number(lp.feeTier) / 10000).toFixed(2)}%`;
  if (lp.feeBps != null) return `${+(Number(lp.feeBps) / 100).toFixed(2)}%`;
  return '';
}

function owedText(lp: AnyObj): string | null {
  const o = lp.owed;
  if (!o) return null;
  const parts: string[] = [];
  if (o.base > 0) parts.push(`${num(o.base, 4)} ${lp.base ?? ''}`);
  if (o.quote > 0) parts.push(`${num(o.quote, 4)} ${lp.quote ?? ''}`);
  return parts.length ? parts.join(' + ') : null;
}

function LpHealth({ s }: { s: AnyObj }) {
  const { chain } = useChainFilter();
  const rows = ((s.lps ?? []) as AnyObj[]).filter((lp) => lp.position && !lp.archivedAt && lp.status !== 'closed' && lp.status !== 'idle' && lp.price != null && lp.position.upper > lp.position.lower);
  const present = chains(s).filter((c) => rows.some((lp) => lp.chainId === c.id));
  const [chip, setChip] = useState<'all' | number>('all');
  const shown = rows.filter((lp) => (chip === 'all' || lp.chainId === chip) && (chain === 'all' || lp.chainId === chain));
  return (
    <section className="card lp-health">
      <div className="card-head">
        <h3>Liquidity range health <span className="muted small">{shown.length} position{shown.length === 1 ? '' : 's'}</span></h3>
        <div className="desk-chips" role="tablist" aria-label="Chains">
          <button type="button" className={`chip-btn${chip === 'all' ? ' on' : ''}`} onClick={() => setChip('all')}>All</button>
          {present.map((c) => <button key={c.id} type="button" className={`chip-btn${chip === c.id ? ' on' : ''}`} onClick={() => setChip(c.id)}>{c.short}</button>)}
        </div>
      </div>
      {shown.map((lp) => {
        const lower = lp.position.lower as number, upper = lp.position.upper as number, price = lp.price as number;
        const zone = rangeZone(price, lower, upper, lp.inRange ?? null);
        const pct = pctToEdge(price, lower, upper);
        const outFor = zone === 'out' && lp.outSince ? dur(Date.now() - lp.outSince) : null;
        const edge = zone === 'out' ? `out of range${outFor ? ` ${outFor}` : ''}` : zone === 'near' ? `${pct ?? '—'}% to edge` : (pct != null && pct >= 65 ? `${pct}% to edge` : 'in range · centered');
        const fees = owedText(lp);
        return (
          <article key={lp.id} className="lp-row">
            <div className="lp-top">
              <div>
                <strong>{lpName(lp)}</strong>
                <p className="muted small">{[lp.dexName ?? lp.dex, feeOf(lp)].filter(Boolean).join(' · ')} <ChainBadge c={chainOf(s, lp.chainId)} /></p>
              </div>
              <div className={`lp-edge ${zone}`}>
                <span>{edge}</span>
                <b>{px(price)}</b>
              </div>
            </div>
            <RangeBar wide lower={lower} upper={upper} price={price} inRange={zone === 'out' ? false : lp.inRange ?? true} />
            <div className="lp-bounds muted small"><span>{px(lower)}</span><span>{px(upper)}</span></div>
            <div className="lp-stats">
              <div><span>Range</span><b>{zone === 'out' ? 'Out' : zone === 'near' ? 'Near edge' : 'In range'}</b></div>
              <div><span>Fees waiting</span><b className={fees ? 'pos' : ''}>{fees ?? '—'}</b></div>
              <div><span>Moves</span><b>{lp.reranges ?? 0}{lp.lastRerangeAt ? ` · ${dur(Date.now() - lp.lastRerangeAt)}` : ''}</b></div>
            </div>
          </article>
        );
      })}
      {!shown.length && <p className="muted small">No open liquidity range{chip !== 'all' || chain !== 'all' ? ' on this chain' : ''}. A running liquidity bot shows its band here.</p>}
    </section>
  );
}

export function Alerts({ status: s, prefs, setPrefs }: { status: AnyObj; prefs: NotifyPrefs; setPrefs: (p: NotifyPrefs) => void }) {
  const ethUsd = useEthUsd();
  const [push, setPush] = useState<PushPublicView | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [f, setF] = useState({ type: 'price_above', pair: 'DAI', value: '', tf: '1h', botId: '', repeat: false });
  const [err, setErr] = useState<string | null>(null);
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const ios = isIos();
  const installFirst = needsHomeScreen();
  const here = !!endpoint;

  const refresh = async () => {
    const view = await loadPushStatus();
    setPush(view);
    const sub = await localSubscription(view.publicKey).catch(() => null);
    setEndpoint(sub?.endpoint ?? null);
    return view;
  };

  useEffect(() => {
    let dead = false;
    refresh().then(async (view) => {
      if (dead) return;
      const sub = await localSubscription(view.publicKey).catch(() => null);
      if (dead || !sub || !shouldRestorePush(pushOptedIn())) return;
      await http('/api/push/subscribe', 'POST', sub.toJSON()).catch(() => undefined);
    }).catch((e) => { if (!dead) setPushErr((e as Error).message); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enableTab = async () => {
    if (typeof Notification === 'undefined') { setErr('This browser has no Notification API.'); return false; }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (p !== 'granted') { setErr('Notifications were not allowed by the browser.'); return false; }
    notify('Notifications on', 'You will be notified in this tab about the events you selected.');
    return true;
  };
  const setFeed = async (key: FeedKey) => {
    const next = !prefs[key];
    if (next && !prefs.enabled) {
      const ok = await enableTab();
      if (!ok) return;
      setPrefs({ ...prefs, enabled: true, [key]: true });
      return;
    }
    setPrefs({ ...prefs, [key]: next });
  };
  const setType = async (type: PushType) => {
    if (!push) return;
    setPushErr(null);
    const types = { ...push.prefs.types, [type]: !push.prefs.types[type] };
    try {
      const prefsNext = await savePushPrefs({ types });
      setPush({ ...push, prefs: prefsNext });
    } catch (e) { setPushErr((e as Error).message); }
  };
  const setQuiet = async (patch: Partial<PushPrefs['quiet']>) => {
    if (!push) return;
    setPushErr(null);
    try {
      const prefsNext = await savePushPrefs({ quiet: { ...push.prefs.quiet, ...patch } });
      setPush({ ...push, prefs: prefsNext });
    } catch (e) { setPushErr((e as Error).message); }
  };
  const turnOn = async () => {
    if (!push) return;
    if (installFirst) { setPushErr('Add GridBot to your Home Screen first, then open it from the icon.'); return; }
    setBusy(true); setPushErr(null);
    try {
      const json = await enablePush(push.publicKey);
      await http('/api/push/subscribe', 'POST', json);
      setPushOptIn(true);
      setEndpoint(json.endpoint ?? null);
      await refresh();
    } catch (e) { setPushErr((e as Error).message); } finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true); setPushErr(null);
    setPushOptIn(false);
    try {
      await unsubscribePush({
        knownEndpoint: endpoint,
        disable: disablePush,
        post: async (ep) => { await http('/api/push/unsubscribe', 'POST', { endpoint: ep }); },
      });
      setEndpoint(null);
      await refresh();
    } catch (e) { setPushErr((e as Error).message); } finally { setBusy(false); }
  };
  const sendTest = async () => {
    setBusy(true); setPushErr(null);
    try {
      await http('/api/push/test', 'POST', endpoint ? { endpoint } : {});
      await refresh();
    } catch (e) { setPushErr((e as Error).message); } finally { setBusy(false); }
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
  const quiet = push?.prefs.quiet;
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const via = host.endsWith('.ts.net') ? 'via the Tailscale gateway' : host === 'localhost' || host === '127.0.0.1' ? 'on this computer' : 'via the tailnet gateway';
  const last = push?.lastDeliveredAt ? new Date(push.lastDeliveredAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : null;
  const titleOn = here ? `${ios ? 'iPhone push' : 'Push'} is on` : push && push.subscribed > 0 ? 'Push is on for another device' : `${ios ? 'iPhone push' : 'Push'} is off`;
  const gasHint = chains(s).slice(0, 4).map((c) => `${c.lowGasNative} ${c.nativeSymbol}`).join(' · ');

  return (
    <div className="alerts-page">
      <h1 className="alerts-h">Alerts</h1>
      {installFirst && (
        <div className="banner warn" role="status">
          Add to Home Screen first. iPhone only delivers lock-screen alerts to the installed app (iOS 16.4 or later): Safari → Share → Add to Home Screen, then open GridBot from the icon.
        </div>
      )}
      {!installFirst && <p className="muted small home-hint">On iPhone, add GridBot to the Home Screen (iOS 16.4+) and open it from the icon. A Safari tab cannot show lock-screen alerts.</p>}

      <div className={`push-banner${here ? ' on' : ''}`}>
        <p>
          <b>{titleOn}</b>
          <span className="muted"> {here || (push && push.subscribed > 0) ? `Home Screen app · ${via}${last ? ` · last delivered ${last}` : ''}` : 'Off until this phone subscribes. Nothing is sent before that.'}</span>
        </p>
        <div className="actions">
          {here
            ? <button type="button" className="btn" disabled={busy} onClick={turnOff}>Turn off</button>
            : <button type="button" className="btn primary" disabled={busy || !push || installFirst} onClick={turnOn}>Turn on push</button>}
          <button type="button" className="btn" disabled={busy || !here} onClick={sendTest}>Send test</button>
          <button type="button" className={`btn${quiet?.on ? ' primary' : ''}`} disabled={!quiet || busy} onClick={() => setQuiet({ on: !quiet?.on })}>
            Quiet hours {quiet ? `${quiet.start}–${quiet.end}` : '23:00–07:00'}
          </button>
        </div>
      </div>
      {quiet?.on && (
        <div className="quiet-row">
          <label>From<input type="time" value={quiet.start} onChange={(e) => setQuiet({ start: e.target.value.slice(0, 5) })} /></label>
          <label>Until<input type="time" value={quiet.end} onChange={(e) => setQuiet({ end: e.target.value.slice(0, 5) })} /></label>
          <span className="muted small">A halt or a failed transaction still comes through. Times are US Eastern.</span>
        </div>
      )}
      {pushErr && <div className="banner warn" role="alert">{pushErr}</div>}

      <div className="alerts-desk">
        <section className="card">
          <div className="card-head">
            <h3>Alert rules <span className="muted small">what reaches your phone</span></h3>
            <button type="button" className="btn small-btn" onClick={() => setPriceOpen((v) => !v)}>+ Price / RSI alert</button>
          </div>
          <div className="rule rule-head" aria-hidden="true">
            <span />
            <span />
            <span className="rule-tog"><span>Push</span><span>Feed</span></span>
          </div>
          {RULES.map((r) => (
            <div key={r.type} className="rule">
              <i className={`rule-mark ${r.mark}`} aria-hidden="true" />
              <div>
                <strong>{r.title}</strong>
                <p className="muted small">{r.type === 'gas_low' && gasHint ? `${r.detail} (${gasHint})` : r.detail}</p>
              </div>
              <span className="rule-tog">
                <span>Push<Switch on={!!push?.prefs.types[r.type]} disabled={!push} label={`${r.title} push`} onClick={() => setType(r.type)} /></span>
                <span>Feed{r.feed
                  ? <Switch on={!!prefs[r.feed] && prefs.enabled} label={`${r.title} in this tab`} onClick={() => setFeed(r.feed!)} />
                  : <Switch on={false} disabled label="Daily summary is lock-screen only" onClick={() => undefined} />}</span>
              </span>
            </div>
          ))}
        </section>
        <div className="stack">
          <LpHealth s={s} />
          <section className="card recent-card">
            <h3>Recent <span className="muted small">delivered to this phone’s push service</span></h3>
            {(push?.deliveries ?? []).slice(0, 8).map((d, i) => (
              <div key={`${d.at}-${i}`} className="recent-row">
                <i className="g-mark" aria-hidden="true">G</i>
                <div>
                  <strong>{d.title.replace(/^GridBot · /, '')}</strong>
                  <p className={d.ok ? 'muted small' : 'small neg'}>{d.ok ? d.body : 'Not delivered'}</p>
                </div>
                <time>{time(d.at)}</time>
              </div>
            ))}
            {!push?.deliveries.length && <p className="muted small">Nothing delivered yet. Send a test once this phone is subscribed.</p>}
          </section>
        </div>
      </div>

      {priceOpen && (
        <div className="card" id="price-alerts">
          <h3>Price and RSI alerts <span className="muted small">evaluated server-side every poll · fire on the crossing edge</span></h3>
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
      )}

      <details className="card">
        <summary>In this browser tab <span className="muted small">opt-in · {perm} · the tab has to stay open</span></summary>
        <div className="actions">
          {prefs.enabled && perm === 'granted'
            ? <button type="button" className="btn" onClick={() => setPrefs({ ...prefs, enabled: false })}>Turn off</button>
            : <button type="button" className="btn primary" onClick={async () => { const ok = await enableTab(); if (ok) setPrefs({ ...prefs, enabled: true }); }}>Enable notifications</button>}
          <button type="button" className="btn small-btn" disabled={perm !== 'granted'} onClick={() => notify('Test', 'GridBot notification test')}>Test</button>
        </div>
        <div className="checks">
          {([['fills', 'Fills (grid + trend)'], ['stops', 'Stops / trailing / take-profit hit'], ['errors', 'Bot stopped / errors / skipped sells'], ['range', 'Price leaves a grid range'], ['alerts', 'Price and RSI alerts'], ['pnl', 'Large PnL change'], ['gas', 'Low gas'], ['sniper', 'Sniper hit']] as const).map(([k, l]) => (
            <label key={k}><input type="checkbox" checked={!!prefs[k]} onChange={() => tog(k)} /> {l}</label>
          ))}
          <label>Large P&amp;L change ≥ <input type="number" value={ethUsd ? +(prefs.pnlUsd / ethUsd).toPrecision(3) : ''} disabled={!ethUsd} step="any" style={{ width: 80 }} onChange={(e) => { const v = ethToUsd(+e.target.value, ethUsd); if (v != null) setPrefs({ ...prefs, pnlUsd: Math.max(0.01, v) }); }} /> ETH (all live bots, trades + open positions)</label>
        </div>
        {err && <div className="banner warn">{err}</div>}
      </details>
    </div>
  );
}
