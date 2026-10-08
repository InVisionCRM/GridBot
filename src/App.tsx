/** App shell: top bar, Home / New bot / bot detail / Tools, activity drawer, Guide. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Guide } from './Guide';
import { useStream, type ActivityEvent } from './ui/useStream';
import { Activity } from './ui/Activity';
import { loadPrefs, notify, notifyCategory, savePrefs, type NotifyPrefs } from './ui/Alerts';
import { botApi, http } from './ui/api';
import { usd } from './ui/fmt';
import { ChainFilterCtx, chainOf, chains, type ChainFilter } from './ui/chains';
import { Home } from './ui/Home';
import { NewBot } from './ui/NewBot';
import { GridDetail } from './ui/GridDetail';
import { TrendDetail } from './ui/TrendDetail';
import { Tools } from './ui/Tools';
import { TOOL_TABS, type View } from './ui/model';

function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem('view') ?? 'null') as View | null;
    if (v && ['home', 'new', 'grid', 'trend', 'tools'].includes(v.v)) return v;
  } catch { /* storage unavailable */ }
  return { v: 'home' };
}
function saveView(v: View) {
  // Prefills are one-shot: never restored from storage.
  const plain: View = v.v === 'new' ? { v: 'new', kind: v.kind } : v.v === 'tools' ? { v: 'tools', tab: v.tab } : v;
  try { localStorage.setItem('view', JSON.stringify(plain)); } catch { /* storage unavailable */ }
}
function loadChain(): ChainFilter {
  try { const c = localStorage.getItem('chain'); return c && c !== 'all' ? Number(c) : 'all'; } catch { return 'all'; }
}

export default function App() {
  const [prefs, setPrefsState] = useState<NotifyPrefs>(loadPrefs);
  const setPrefs = (p: NotifyPrefs) => { setPrefsState(p); savePrefs(p); };
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onEvent = useCallback((e: ActivityEvent) => {
    const p = prefsRef.current;
    const c = notifyCategory(e);
    if (p.enabled && c && p[c]) notify(`GridBot · ${e.type.replace('_', ' ')}`, e.msg, `${e.type}-${e.botId ?? e.id}`);
  }, []);
  const { status: s, events, ticks, connected, error: streamErr, refresh } = useStream(onEvent);

  const [view, setViewState] = useState<View>(loadView);
  const nav = useCallback((v: View) => { setViewState(v); saveView(v); window.scrollTo({ top: 0 }); }, []);
  const [chain, setChainState] = useState<ChainFilter>(loadChain);
  const setChain = (c: ChainFilter) => { setChainState(c); try { localStorage.setItem('chain', String(c)); } catch { /* storage unavailable */ } };
  const chainCtx = useMemo(() => ({ chain, setChain }), [chain]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  const closeGuide = useCallback(() => setGuide(false), []);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!drawer) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [drawer]);

  // Notify on a large move in total profit (realized + unrealized ≈USD across every bot).
  const pnlBase = useRef<number | null>(null);
  useEffect(() => {
    if (!s?.aggregate) return;
    const total = s.aggregate.realized + s.aggregate.unrealized;
    if (pnlBase.current == null) { pnlBase.current = total; return; }
    const d = total - pnlBase.current;
    if (Math.abs(d) >= prefs.pnlUsd) {
      if (prefs.enabled && prefs.pnl) notify('GridBot · profit change', `Total profit moved ${usd(d, true)} → ${usd(total, true)}`, 'pnl');
      pnlBase.current = total;
    }
  }, [s?.aggregate, prefs]);

  // A detail view falls back to Home when its bot disappears from the status (removed), or on the first status
  // when a stored view points at a bot that no longer exists. A bot that was just created is not in the status
  // until the next refresh, so a missing id alone is not enough.
  const prevIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!s) return;
    const ids = new Set<string>([...s.grids, ...(s.trends ?? [])].map((b: { id: string }) => b.id));
    if ((view.v === 'grid' || view.v === 'trend') && !ids.has(view.id) && (prevIds.current === null || prevIds.current.has(view.id))) nav({ v: 'home' });
    prevIds.current = ids;
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [refresh]);

  if (!s) return <div className="app"><p className="muted" style={{ paddingTop: 24 }}>{err ?? streamErr ?? 'Connecting to the bot server…'}</p></div>;

  const cs = chains(s);
  const sel = chain === 'all' ? null : chainOf(s, chain);
  const running = s.grids.filter((g: { status: string }) => g.status === 'running').length + (s.trends ?? []).filter((t: { status: string }) => t.status === 'running').length;
  const stopAll = () => act(() => (sel ? http(`/api/chains/${sel.id}/stop`, 'POST') : botApi('stop-all', 'POST')));
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <ChainFilterCtx.Provider value={chainCtx}>
      <div className="app">
        <header className="topbar">
          <span className="logo"><i />GridBot</span>
          <nav className="nav" aria-label="main">
            <button type="button" className={view.v === 'home' || view.v === 'grid' || view.v === 'trend' ? 'on' : ''} onClick={() => nav({ v: 'home' })}>Home</button>
            <button type="button" className={view.v === 'new' ? 'on' : ''} onClick={() => nav({ v: 'new', kind: 'grid' })}>New bot</button>
            <button type="button" className={view.v === 'tools' ? 'on' : ''} onClick={() => nav({ v: 'tools', tab: view.v === 'tools' ? view.tab : TOOL_TABS[0][0] })}>Tools</button>
          </nav>
          <span className="grow" />
          <div className="chainpick" role="tablist" aria-label="chain filter">
            <button type="button" role="tab" aria-selected={chain === 'all'} className={chain === 'all' ? 'on' : ''} onClick={() => setChain('all')}>All</button>
            {cs.map((c) => (
              <button key={c.id} type="button" role="tab" aria-selected={chain === c.id} className={chain === c.id ? 'on' : ''} onClick={() => setChain(c.id)}
                title={c.hasSigner ? `${c.name}: ${c.gasNative?.toPrecision(4) ?? '—'} ${c.nativeSymbol} for gas${c.lowGas ? ' (low)' : ''}` : `${c.name}: no key, paper only`}>
                {c.short}{c.lowGas ? <i className="gas-low" aria-label="low gas" /> : null}
              </button>
            ))}
          </div>
          {s.address
            ? <span className="pill" title={s.address}>Address {short(s.address)}</span>
            : <span className="pill warn" title="No signing key in .env: every bot runs in paper mode">Paper only</span>}
          {!connected && <span className="pill warn" title="Live stream lost; polling every 3 s">Reconnecting</span>}
          <button type="button" className="btn ghost small-btn" onClick={() => setDrawer(true)}>Activity</button>
          <button type="button" className="btn ghost small-btn" onClick={() => setGuide(true)}>Guide</button>
          <button type="button" className="btn kill small-btn" disabled={busy || running === 0}
            title={sel ? `Stop every bot on ${sel.name}. Holdings are kept.` : 'Stop every bot on every chain. Holdings are kept.'}
            onClick={stopAll}>{sel ? `Stop all on ${sel.short}` : 'Stop all'}</button>
        </header>

        {err && <div className="banner error" role="alert"><span className="grow">{err}</span><button type="button" className="btn ghost small-btn" onClick={() => setErr(null)}>Dismiss</button></div>}

        {view.v === 'home' && <Home s={s} nav={nav} act={act} busy={busy} />}
        {view.v === 'new' && <NewBot s={s} kind={view.kind} trendPrefill={view.trendPrefill} nav={nav} act={act} busy={busy} />}
        {view.v === 'grid' && <GridDetail s={s} id={view.id} events={events} ticks={ticks} nav={nav} act={act} busy={busy} />}
        {view.v === 'trend' && <TrendDetail s={s} id={view.id} events={events} ticks={ticks} nav={nav} act={act} busy={busy} />}
        {view.v === 'tools' && <Tools s={s} view={view} ticks={ticks} nav={nav} act={act} busy={busy} prefs={prefs} setPrefs={setPrefs} />}

        {drawer && <>
          <div className="drawer-scrim" onClick={() => setDrawer(false)} />
          <aside className="drawer" aria-label="Activity">
            <div className="actions"><span className="grow" /><button type="button" className="btn ghost small-btn" onClick={() => setDrawer(false)}>Close</button></div>
            <Activity events={events} connected={connected} status={s} />
          </aside>
        </>}
        {guide && <Guide onClose={closeGuide} />}
      </div>
    </ChainFilterCtx.Provider>
  );
}
