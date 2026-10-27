/** App shell: Home, Bots, Holdings, More, bot detail, activity drawer, Guide. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Guide } from './Guide';
import { useStream, type ActivityEvent } from './ui/useStream';
import { Activity } from './ui/Activity';
import { loadPrefs, notify, notifyCategory, savePrefs, type NotifyPrefs } from './ui/Alerts';
import { botApi, http } from './ui/api';
import { usd } from './ui/fmt';
import { ChainFilterCtx, chainOf, RefreshCtx, type ChainFilter } from './ui/chains';
import { Home } from './ui/Home';
import { Bots } from './ui/Bots';
import { More } from './ui/More';
import { NewBot } from './ui/NewBot';
import { GridDetail } from './ui/GridDetail';
import { TrendDetail } from './ui/TrendDetail';
import { LpDetail } from './ui/LpDetail';
import { ViewError } from './ui/ViewError';
import { Tools } from './ui/Tools';
import { Opportunities } from './ui/Opportunities';
import { SmartTrader } from './ui/SmartTrader';
import { useVersion } from './ui/System';
import { type View } from './ui/model';
import { Header } from './ui/Header';
import { Holdings, useHoldings } from './ui/Holdings';
import { loadShowUsd, saveShowUsd, ShowUsdCtx } from './ui/money';

function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem('view') ?? 'null') as View | null;
    if (v && ['home', 'bots', 'more', 'opps', 'auto', 'holdings', 'new', 'grid', 'trend', 'lp', 'tools'].includes(v.v)) return v;
  } catch { /* storage unavailable */ }
  return { v: 'home' };
}
function saveView(v: View) {
  // Prefills are one-shot: never restored from storage.
  const plain: View = v.v === 'new' ? { v: 'new', kind: v.kind } : v.v === 'tools' ? { v: 'tools', tab: v.tab } : v.v === 'holdings' ? { v: 'holdings' } : v;
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
  const [showUsd, setShowUsdState] = useState(loadShowUsd);
  const usdCtx = useMemo(() => ({ on: showUsd, set: (on: boolean) => { setShowUsdState(on); saveShowUsd(on); } }), [showUsd]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ver = useVersion();
  const holdings = useHoldings();
  const [guide, setGuide] = useState(false);
  const closeGuide = useCallback(() => setGuide(false), []);
  const [drawer, setDrawer] = useState(false);
  const scrolling = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const move = () => { scrolling.current = true; };
    const end = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => { scrolling.current = false; }, 500);
    };
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [drawer]);

  // Notify on a large move in total profit: realized + unrealized in dollars across LIVE bots (grids, trends and LPs).
  const pnlBase = useRef<number | null>(null);
  useEffect(() => {
    if (!s?.aggregate) return;
    const total = s.aggregate.realized + s.aggregate.unrealized;
    if (pnlBase.current == null) { pnlBase.current = total; return; }
    const d = total - pnlBase.current;
    if (Math.abs(d) >= prefs.pnlUsd) {
      if (prefs.enabled && prefs.pnl) notify('GridBot · profit change', `Live total profit moved ${usd(d, true)} → ${usd(total, true)}`, 'pnl');
      pnlBase.current = total;
    }
  }, [s?.aggregate, prefs]);

  // A detail view falls back to Home when its bot disappears from the status (removed), or on the first status
  // when a stored view points at a bot that no longer exists. A bot that was just created is not in the status
  // until the next refresh, so a missing id alone is not enough.
  const prevIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!s) return;
    const ids = new Set<string>([...s.grids, ...(s.trends ?? []), ...(s.lps ?? [])].filter((b: { archivedAt?: number | null }) => !b.archivedAt).map((b: { id: string }) => b.id));
    if ((view.v === 'grid' || view.v === 'trend' || view.v === 'lp') && !ids.has(view.id) && (prevIds.current === null || prevIds.current.has(view.id))) nav({ v: 'home' });
    prevIds.current = ids;
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [refresh]);

  if (!s) return <div className="app"><p className="muted" style={{ paddingTop: 24 }}>{err ?? streamErr ?? 'Connecting to the bot server…'}</p></div>;

  const sel = chain === 'all' ? null : chainOf(s, chain);
  const stopAll = () => {
    if (scrolling.current) return;
    const what = sel ? `every bot on ${sel.name}` : 'every bot on every chain';
    if (!confirm(`Stop ${what}? They keep their coins. This does not sell.`)) return;
    void act(() => (sel ? http(`/api/chains/${sel.id}/stop`, 'POST', undefined, 'header-chain-stop') : botApi('stop-all', 'POST', undefined, 'header-stop-all')));
  };
  return (
    <ChainFilterCtx.Provider value={chainCtx}><RefreshCtx.Provider value={refresh}><ShowUsdCtx.Provider value={usdCtx}>
      <div className="app">
        <Header
          s={s} view={view} nav={nav} chain={chain} setChain={setChain} showUsd={showUsd} setShowUsd={usdCtx.set}
          connected={connected} ver={ver.v} holdings={holdings.data} onActivity={() => setDrawer(true)} onGuide={() => setGuide(true)}
        />

        {err && <div className="banner error" role="alert"><span className="grow">{err}</span><button type="button" className="btn ghost small-btn" onClick={() => setErr(null)}>Dismiss</button></div>}

        <ViewError key={`${view.v}:${'id' in view ? view.id : ''}:${'tab' in view ? view.tab : ''}:${view.v === 'holdings' ? view.focus ?? '' : ''}`} onHome={() => nav({ v: 'home' })}>
          {view.v === 'home' && <Home s={s} nav={nav} holdings={holdings.data} act={act} />}
          {view.v === 'bots' && <Bots s={s} nav={nav} busy={busy} onStopAll={stopAll} />}
          {view.v === 'more' && <More s={s} nav={nav} onGuide={() => setGuide(true)} onActivity={() => setDrawer(true)} />}
          {view.v === 'opps' && <Opportunities s={s} nav={nav} act={act} busy={busy} />}
          {view.v === 'auto' && <SmartTrader s={s} nav={nav} />}
          {view.v === 'holdings' && <Holdings s={s} snap={holdings.data} loading={holdings.loading} error={holdings.err} reload={holdings.reload} focus={view.focus} nav={nav} />}
          {view.v === 'new' && <NewBot s={s} kind={view.kind} trendPrefill={view.trendPrefill} gridPrefill={view.gridPrefill} lpPrefill={view.lpPrefill} nav={nav} act={act} busy={busy} />}
          {view.v === 'grid' && <GridDetail s={s} id={view.id} events={events} ticks={ticks} nav={nav} act={act} busy={busy} />}
          {view.v === 'trend' && <TrendDetail s={s} id={view.id} events={events} ticks={ticks} nav={nav} act={act} busy={busy} />}
          {view.v === 'lp' && <LpDetail s={s} id={view.id} events={events} ticks={ticks} nav={nav} act={act} busy={busy} />}
          {view.v === 'tools' && <Tools s={s} view={view} ticks={ticks} nav={nav} act={act} busy={busy} prefs={prefs} setPrefs={setPrefs} ver={ver} />}
        </ViewError>

        {drawer && <>
          <div className="drawer-scrim" onClick={() => setDrawer(false)} />
          <aside className="drawer" aria-label="Activity">
            <div className="actions"><span className="grow" /><button type="button" className="btn ghost small-btn" onClick={() => setDrawer(false)}>Close</button></div>
            <Activity events={events} connected={connected} status={s} />
          </aside>
        </>}
        {guide && <Guide onClose={closeGuide} />}
      </div>
    </ShowUsdCtx.Provider></RefreshCtx.Provider></ChainFilterCtx.Provider>
  );
}
