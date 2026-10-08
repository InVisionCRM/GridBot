import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatPrice, formatTime, formatUsd } from './lib/format';
import { Guide } from './Guide';
import { useStream, type ActivityEvent, type Ticks } from './ui/useStream';
import { AnimatedNumber, Heartbeat, useFlash } from './ui/motion';
import { Activity } from './ui/Activity';
import { Chart, EquityChart } from './ui/Chart';
import { TrendBots, type TrendPrefill } from './ui/TrendBots';
import { Backtest, type BtPrefill } from './ui/Backtest';
import { Analytics, MarketPanels } from './ui/Analytics';
import { Alerts, loadPrefs, notify, notifyCategory, savePrefs, type NotifyPrefs } from './ui/Alerts';
import { http } from './ui/api';
import { px } from './ui/fmt';
import { Markets } from './ui/Markets';
import { ChainBadge, ChainBar, ChainFilterCtx, DexTag, Orientation, PairPicker, chainOf, dexName, explorerAddr, explorerTx, feeLabel, lbl, marketsOf, mk, unflipKey, type ChainFilter } from './ui/chains';
import { DEFAULT_GAS_RESERVE, gasReserve, parseGasRes } from './live/gasReserve';

type Status = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Grid = Status;

async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`/api/bot/${path}`, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const n = (x: number | null | undefined, d = 4) => (x == null ? '—' : x.toLocaleString(undefined, { maximumFractionDigits: d }));
/** Signed amount in quote units, e.g. "+0.0951 DAI" / "−12.3 HEX" */
const q = (x: number | null | undefined, sym: string, sig = 4) =>
  x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x) < 1e-12 ? '0' : Number(Math.abs(x).toPrecision(sig)).toLocaleString(undefined, { maximumFractionDigits: 12 })} ${sym}`;
const pct = (x: number | null | undefined, d = 3) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = (x: number) => `${x >= 0 ? '+' : '−'}${formatUsd(Math.abs(x))}`;
const PRESETS = [10, 12, 16, 20];

type StratPreset = { id: string; name: string; blurb: string; legCount: number; defaultCapitalUsd?: number; flipped?: boolean };
type Econ = {
  ok: boolean; reasons: string[]; quote: string; levelSize: number; buyLevels: number; spacingPct: number; roundTripFeePct: number;
  impactPct: number; gasQuote: number; feeQuote: number; taxQuote?: number; buyTaxPct?: number; sellTaxPct?: number; netPerRoundTrip: number; netPct: number; bestNetPct: number; usdPerQuote?: number | null;
};

function EconLine({ e }: { e: Econ }) {
  const k = e.usdPerQuote;
  return (
    <span>
      size {n(e.levelSize, 6)} {e.quote}{k ? ` (≈${formatUsd(e.levelSize * k)})` : ''} ×{e.buyLevels} · step {pct(e.spacingPct)} · fee {pct(e.roundTripFeePct)} ·
      impact {pct(e.impactPct)} · gas {e.gasQuote >= 1 ? n(e.gasQuote, 2) : n(e.gasQuote, 8)} {e.quote}{(e.buyTaxPct || e.sellTaxPct) ? ` · tax buy ${pct(e.buyTaxPct ?? 0)} / sell ${pct(e.sellTaxPct ?? 0)}${e.taxQuote ? ` (≈${n(e.taxQuote, 6)} ${e.quote}/RT)` : ''}` : ''} · <strong>net {q(e.netPerRoundTrip, e.quote)} ({pct(e.netPct)})/RT</strong> worst
      {e.bestNetPct ? ` · best ${pct(e.bestNetPct)}` : ''}
    </span>
  );
}

const TABS = [['grids', 'Grids'], ['trend', 'Trend bots'], ['chart', 'Chart'], ['backtest', 'Backtest'], ['analytics', 'Analytics'], ['markets', 'Markets'], ['alerts', 'Alerts']] as const;
type Tab = (typeof TABS)[number][0];

function Ticker({ s, pairs, ticks, prev, spots }: { s: Status; pairs: string[]; ticks: Ticks | null; prev: Ticks | null; spots: Record<string, number> }) {
  return (
    <div className="ticker" aria-label="prices">
      {pairs.map((p) => {
        const m = mk(s, p);
        const v = ticks?.prices?.[p] ?? spots?.[p];
        const o = prev?.prices?.[p];
        const dir = v != null && o != null ? (v > o ? 'up' : v < o ? 'down' : '') : '';
        return (
          <span key={`${p}-${ticks?.t ?? 0}`} className={`tk ${dir ? `tk-${dir}` : ''}`}>
            <b title={m.label}>{m.legacy ? p : m.label.replace(/·.*/, '')}</b>{!m.legacy && <ChainBadge c={chainOf(s, m.chainId)} testnet={false} />} {v != null ? px(v, 5) : '—'}{dir === 'up' ? ' ▲' : dir === 'down' ? ' ▼' : ''}
          </span>
        );
      })}
    </div>
  );
}

function GridRow({ x, sel, onSel, busy, act }: { x: Grid; sel: boolean; onSel: () => void; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const flash = useFlash(x.trades.length);
  const pnlQ = x.pnl.realized + x.pnl.unrealized;
  return (
    <tr className={`${sel ? 'selected' : ''} ${flash ? 'fill-flash' : ''}`} onClick={onSel} style={{ cursor: 'pointer' }}>
      <td><Heartbeat beat={x.priceAt} state={x.lastError ? 'error' : x.status} /> {x.chainShort && x.chainShort !== 'PLS' ? <ChainBadge c={{ short: x.chainShort, color: x.chainColor ?? '#888', name: x.chainKey, status: 'live' }} testnet={false} /> : null}{(x.label ?? `PLS/${x.stable}`).replace(/·.*/, '')}{x.flipped ? <i className="flip-tag" title={`flipped: spends ${x.quoteSym}, stacks ${x.base}`}>⇄</i> : null} <DexTag name={x.dexName} feeBps={x.feeBps} feeTier={x.feeTier} /> <span className="muted small">{x.mode}</span>{x.custom ? <span className={`risk-dot risk-${x.risk ?? 'unknown'}`} title={`custom · ${x.risk ?? 'unknown'}`} /> : null}{x.available === false ? <span className="neg small"> unavailable</span> : null}</td>
      <td className={`st ${x.status}`}>{x.status}{x.inFlight ? ' · tx' : ''}</td>
      <td className="small">{x.config ? `${formatPrice(x.config.lowerPrice)}–${formatPrice(x.config.upperPrice)} ×${x.config.gridCount}` : '—'}
        {x.config && x.price && (x.price < x.config.lowerPrice || x.price > x.config.upperPrice) ? <span className="neg"> · out of range</span> : null}</td>
      <td className={pnlQ >= 0 ? 'pos' : 'neg'}>
        <AnimatedNumber value={pnlQ} format={(v) => q(v, x.quoteSym ?? x.stable)} />
        {x.usdPerQuote && x.usdPerQuote !== 1 ? <span className="muted small"> ≈{usd(pnlQ * x.usdPerQuote)}</span> : null}
        <span className="muted small"> · {x.stats.roundTrips}RT</span>
      </td>
      <td>
        {x.status === 'running'
          ? <button type="button" className="btn kill small-btn" disabled={busy} onClick={(e) => { e.stopPropagation(); void act(() => api(`grids/${x.id}/stop`, 'POST')); }}>STOP</button>
          : x.config
            ? <button type="button" className="btn small-btn" disabled={busy} onClick={(e) => { e.stopPropagation(); void act(() => api(`grids/${x.id}/resume`, 'POST')); }}>Resume</button>
            : null}
      </td>
    </tr>
  );
}

function ChartTab({ s, ticks, chain }: { s: Status; ticks: Ticks | null; chain: ChainFilter }) {
  const keys = marketsOf(s).filter((m) => m.tradable && (chain === 'all' || m.chainId === chain)).map((m) => m.key);
  const [pair, setPair] = useState<string>(keys[0] ?? s.quotes?.[0] ?? 'DAI');
  useEffect(() => { if (keys.length && !keys.includes(pair)) setPair(keys[0]); }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const [panel, setPanel] = useState<Status | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/market/panel?pair=${encodeURIComponent(pair)}`).then((p) => !dead && setPanel(p)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [pair]);
  return (
    <>
      <div className="card"><Chart status={s} ticks={ticks} pairs={keys.length ? keys : s.quotes ?? []} pair={pair} onPairChange={setPair} height={520} /></div>
      {panel && <div className="card"><h3>Market · {lbl(s, pair)}</h3><MarketPanels panels={[panel]} /></div>}
    </>
  );
}

export default function App() {
  const [prefs, setPrefsState] = useState<NotifyPrefs>(loadPrefs);
  const setPrefs = (p: NotifyPrefs) => { setPrefsState(p); savePrefs(p); };
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onEvent = useCallback((e: ActivityEvent) => {
    const p = prefsRef.current;
    const c = notifyCategory(e);
    if (p.enabled && c && p[c]) notify(`PulseChain bot · ${e.type.replace('_', ' ')}`, e.msg, `${e.type}-${e.botId ?? e.id}`);
  }, []);
  const { status: s, events, ticks, prevTicks, connected, error: streamErr, refresh } = useStream(onEvent);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem('tab') as Tab) || 'grids');
  const [chain, setChainState] = useState<ChainFilter>(() => { const v = localStorage.getItem('chain'); return v && v !== 'all' ? Number(v) : 'all'; });
  const setChain = (c: ChainFilter) => { setChainState(c); localStorage.setItem('chain', String(c)); };
  const chainCtx = useMemo(() => ({ chain, setChain }), [chain]);
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem('tab', t); };
  const [trendPrefill, setTrendPrefill] = useState<TrendPrefill | null>(null);
  const [btPrefill, setBtPrefill] = useState<BtPrefill | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  const closeGuide = useCallback(() => setGuide(false), []);
  const [strats, setStrats] = useState<StratPreset[]>([]);
  const [econ, setEcon] = useState<Econ | null>(null);
  const [econErr, setEconErr] = useState<string | null>(null);
  const [f, setF] = useState({
    mode: 'paper', stable: '', lowerPrice: '', upperPrice: '', gridCount: '12',
    totalCapitalUsd: '100', impact: '3', slippage: '1', deadline: '10', gasRes: '2%', allowTight: false, presetUsd: '',
  });

  useEffect(() => {
    if (s) setSel((id) => (id && s.grids.some((g: Grid) => g.id === id) ? id : s.grids[0]?.id ?? null));
  }, [s]);
  // Large PnL change notification (Σ realized + unrealized ≈USD across grids + trend bots)
  const pnlBase = useRef<number | null>(null);
  useEffect(() => {
    if (!s?.aggregate) return;
    const total = s.aggregate.realized + s.aggregate.unrealized;
    if (pnlBase.current == null) { pnlBase.current = total; return; }
    const d = total - pnlBase.current;
    if (Math.abs(d) >= prefs.pnlUsd) {
      if (prefs.enabled && prefs.pnl) notify('PulseChain bot · PnL change', `Σ PnL moved ${d >= 0 ? '+' : '−'}${formatUsd(Math.abs(d))} → ${usd(total)}`, 'pnl');
      pnlBase.current = total;
    }
  }, [s?.aggregate, prefs]);
  useEffect(() => { void api('presets').then((r) => setStrats(r.presets ?? [])).catch(() => undefined); }, []);

  // Default / chain-switch pair for the add-grid form: first tradable market on the selected chain; range ±5 % of spot.
  useEffect(() => {
    if (!s) return;
    const ms = marketsOf(s).filter((m) => m.tradable && (chain === 'all' || m.chainId === chain));
    if (f.stable && (ms.some((m) => m.key === unflipKey(f.stable)) || !ms.length)) return;
    const key = ms[0]?.key ?? (s.quotes ?? s.stables)[0] ?? 'DAI';
    const p = s.spots?.[key] ?? s.grids.find((g: Grid) => g.stable === key)?.price ?? null;
    setF((x) => ({
      ...x, stable: key,
      lowerPrice: p ? String(+(p * 0.95).toPrecision(5)) : '',
      upperPrice: p ? String(+(p * 1.05).toPrecision(5)) : '',
    }));
  }, [s, f.stable, chain]);
  // Pair or orientation change: re-centre the range on that orientation's spot (HEX/PLS ≈ 1 / PLS/HEX).
  const pickPair = (key: string) => {
    const p = s?.spots?.[key] ?? (s ? mk(s, key).spot : null) ?? null;
    setF((x) => ({ ...x, stable: key, lowerPrice: p ? String(+(p * 0.95).toPrecision(5)) : x.lowerPrice, upperPrice: p ? String(+(p * 1.05).toPrecision(5)) : x.upperPrice }));
  };

  // Pre-start economics from current reserves + gas: per-level size, spacing, impact, gas, net per round-trip.
  useEffect(() => {
    const lo = +f.lowerPrice, hi = +f.upperPrice, g = +f.gridCount, c = +f.totalCapitalUsd;
    if (!(lo > 0) || !(hi > lo) || !(g >= 2) || !(c > 0) || !f.stable) { setEcon(null); setEconErr(null); return; }
    const t = setTimeout(() => {
      void api(`econ?quote=${encodeURIComponent(f.stable)}&lower=${lo}&upper=${hi}&grids=${g}&capital=${c}`)
        .then((e) => { setEcon(e); setEconErr(null); })
        .catch((e) => { setEcon(null); setEconErr((e as Error).message); });
    }, 250);
    return () => clearTimeout(t);
  }, [f.lowerPrice, f.upperPrice, f.gridCount, f.totalCapitalUsd, f.stable]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: { target: { value?: string; checked?: boolean; type?: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value! }));
  // Gas reserve: "2%" = share of capital, "50" = fixed amount of the native token (only used when the quote is native).
  const gasRes = parseGasRes(f.gasRes);
  const limits = () => ({
    maxPriceImpact: Number(f.impact) / 100, slippageBps: Math.round(Number(f.slippage) * 100), deadlineMinutes: Number(f.deadline),
    ...(fm.quoteNative && gasRes ? { gasReservePct: gasRes.pct, gasReserveNative: gasRes.fixed } : {}),
  });
  const body = () => ({
    mode: f.mode, stable: f.stable, lowerPrice: +f.lowerPrice, upperPrice: +f.upperPrice,
    gridCount: +f.gridCount, totalCapitalUsd: +f.totalCapitalUsd, limits: limits(),
    // paper-only; the server ignores it for live and hard-blocks non-net-positive grids
    allowTightSpacing: f.mode === 'paper' && f.allowTight,
  });
  const resAmt = gasReserve(+f.totalCapitalUsd || 0, gasRes ?? DEFAULT_GAS_RESERVE);
  const canAdd = !econ || econ.ok || (f.mode === 'paper' && f.allowTight);

  const g: Grid | null = useMemo(() => s?.grids?.find((x: Grid) => x.id === sel) ?? null, [s, sel]);

  if (!s) return <div className="app"><p className="muted">{err ?? streamErr ?? 'Connecting…'}</p></div>;

  const tx = (h: string, chainId: number | undefined) =>
    h && !h.startsWith('paper')
      ? <a href={explorerTx(s, chainId, h)} target="_blank" rel="noreferrer">{h.slice(0, 10)}…</a>
      : <span className="muted">{h ? 'paper' : ''}</span>;

  type Leg = { quote: string; label?: string; flipped?: boolean; pool?: { dexName: string; feeBps: number; feeTier?: number; switchTo: boolean }; lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalUsd: number; capitalUsd: number; spot: number; bandPct: number; econ: Econ };
  const preview = async (id: string): Promise<Leg[]> => {
    const prev = await api(`presets/${id}/preview?quote=${encodeURIComponent(f.stable || 'DAI')}${+f.presetUsd > 0 ? `&capitalUsd=${+f.presetUsd}` : ''}`);
    return prev.legs as Leg[];
  };
  const legSummary = (l: Leg) =>
    `${l.label ?? `PLS/${l.quote}`} ±${(l.bandPct * 100).toFixed(1)}% ×${l.gridCount} $${l.capitalUsd} (${n(l.totalCapitalUsd, 2)} ${mk(s, l.quote).quote})${l.pool ? ` · ${l.pool.dexName} ${l.pool.feeTier != null ? l.pool.feeTier / 10000 : l.pool.feeBps / 100}%${l.pool.switchTo ? ' (best pool — market switches to it on start)' : ' (best pool)'}` : ''} · size ${n(l.econ.levelSize, 4)} · step ${pct(l.econ.spacingPct)} · impact ${pct(l.econ.impactPct)} · gas ${n(l.econ.gasQuote, 6)} · net ${q(l.econ.netPerRoundTrip, l.quote)} (${pct(l.econ.netPct)})/RT${l.econ.ok ? '' : ' ✗ ' + l.econ.reasons.join(' ')}`;

  const add = () => act(async () => {
    const m = mk(s, f.stable), c = chainOf(s, m.chainId);
    if (f.mode === 'live' && !confirm(`Add LIVE grid ${m.label} on ${c?.name ?? s.network} from ${c?.address ?? s.address}?`)) return;
    const r = await api('grids', 'POST', body());
    setSel(r.id);
  });

  const fm = mk(s, f.stable), fc = chainOf(s, fm.chainId);
  const visGrids = s.grids.filter((x: Grid) => chain === 'all' || (x.chainId ?? s.legacyChainId) === chain);
  const tickerKeys = chain === 'all'
    ? [...marketsOf(s).filter((m) => m.legacy).slice(0, 3).map((m) => m.key), ...chainsFirstMarkets(s)]
    : marketsOf(s).filter((m) => m.chainId === chain && m.tradable).slice(0, 8).map((m) => m.key);

  return (
    <ChainFilterCtx.Provider value={chainCtx}>
    <div className="app wide">
      <div className="live-banner mainnet">
        <Heartbeat beat={s.spotsAt} state={connected ? 'running' : 'idle'} title={connected ? 'live stream' : 'polling'} />
        <strong>MULTI</strong>
        <span>{(s.chains ?? []).filter((c: Grid) => c.tradable).length || 1} chains</span>
        <span>· grids {s.grids.filter((x: Grid) => x.status === 'running').length}/{s.grids.length} · trend {(s.trends ?? []).filter((x: Grid) => x.status === 'running').length}/{(s.trends ?? []).length}</span>
        {s.txBusy && <span className="busy-pill">tx busy</span>}
        <Ticker s={s} pairs={tickerKeys.length ? tickerKeys : s.quotes ?? []} ticks={ticks} prev={prevTicks} spots={s.spots ?? {}} />
        <span className="grow" />
        <button type="button" className={`btn small-btn ${prefs.enabled ? 'primary' : ''}`} title="browser notifications" onClick={() => setTab('alerts')}>{prefs.enabled ? '🔔' : '🔕'}</button>
        <button type="button" className="btn small-btn" onClick={() => setGuide(true)}>Guide</button>
        <button type="button" className="btn kill" disabled={busy} title="stop every grid and trend bot on every chain" onClick={() => act(() => api('stop-all', 'POST'))}>KILL ALL</button>
      </div>
      <ChainBar s={s} busy={busy} onStop={(c) => { if (confirm(`Stop every bot on ${c.name}?`)) void act(() => http(`/api/chains/${c.id}/stop`, 'POST')); }} />
      {guide && <Guide onClose={closeGuide} />}
      {err && <div className="banner warn">{err}</div>}
      <nav className="tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'trend' && (s.trends ?? []).some((t: Grid) => t.position) ? <i className="dot" /> : null}</button>)}
      </nav>
      <div className="layout">
      <main>
      {tab === 'trend' && <TrendBots status={s} ticks={ticks} act={act} busy={busy} prefill={trendPrefill} onBacktest={(p) => { setBtPrefill({ ...p, nonce: Date.now() }); setTab('backtest'); }} />}
      {tab === 'chart' && <ChartTab s={s} ticks={ticks} chain={chain} />}
      {tab === 'markets' && <Markets status={s} act={act} busy={busy} />}
      {tab === 'backtest' && <Backtest status={s} prefill={btPrefill} onUse={(p) => { setTrendPrefill({ ...p, nonce: Date.now() }); setTab('trend'); void refresh(); }} />}
      {tab === 'analytics' && <Analytics status={s} />}
      {tab === 'alerts' && <Alerts status={s} prefs={prefs} setPrefs={setPrefs} />}
      {tab === 'grids' && <>

      <div className="card stats">
        <div><span className="k">Address</span>{s.address ? <a href={explorerAddr(s, chain === 'all' ? undefined : chain, s.address)} target="_blank" rel="noreferrer">{s.address}</a> : <span className="muted">no signing key (paper only)</span>}</div>
        {s.walletBalances && (chain === 'all' || chain === s.legacyChainId) && (
          <div><span className="k">PulseChain</span>{n(s.walletBalances.pls, 2)} PLS
            {Object.entries(s.walletBalances.quotes || s.walletBalances.stables || {}).map(([sym, v]) => ` · ${n(v as number)} ${sym}`)}
          </div>
        )}
        <div><span className="k">Σ Realized ≈$</span><span className={s.aggregate.realized >= 0 ? 'pos' : 'neg'}>{usd(s.aggregate.realized)}</span></div>
        <div><span className="k">Σ Unreal ≈$</span><span className={s.aggregate.unrealized >= 0 ? 'pos' : 'neg'}>{usd(s.aggregate.unrealized)}</span></div>
        <div><span className="k">Σ RT / fees / gas</span>{s.aggregate.roundTrips} · {formatUsd(s.aggregate.feesUsd ?? 0)} · {formatUsd(s.aggregate.gasUsd)}</div>
        {s.aggregate.unpriced ? <div><span className="k">Unpriced</span><span className="muted small">{s.aggregate.unpriced} bot(s) without a USD route</span></div> : null}
      </div>


      <div className="card">
        <h3>Strategies <span className="muted small">PulseChain presets · all net-positive per RT after 2×0.29% fee + impact + gas · live re-checked vs reserves</span></h3>
        <div className="form-row" style={{ marginBottom: 8 }}>
          <label>Preset $/leg<input value={f.presetUsd} placeholder="default" onChange={set('presetUsd')} /></label>
        </div>
        <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          {strats.map((p) => (
            <div key={p.id} className="preset-chip">
              <button type="button" className="btn small-btn" disabled={busy} title={p.blurb}
                onClick={() => act(async () => {
                  const legs = await preview(p.id);
                  if (legs.length === 1) {
                    const L = legs[0];
                    setF((x) => ({
                      ...x, stable: L.quote,
                      lowerPrice: String(L.lowerPrice), upperPrice: String(L.upperPrice),
                      gridCount: String(L.gridCount), totalCapitalUsd: String(L.totalCapitalUsd), allowTight: false,
                    }));
                  }
                  setErr(`${p.name}: ` + legs.map(legSummary).join(' || '));
                })}>Prefill</button>
              <button type="button" className={`btn small-btn ${f.mode === 'live' ? 'danger' : 'primary'}`} disabled={busy}
                title={`Start: ${p.blurb}`}
                onClick={() => act(async () => {
                  const legs = await preview(p.id);
                  const bad = legs.filter((l) => !l.econ.ok);
                  if (bad.length && f.mode === 'live') throw new Error(`${p.name} blocked live: ` + bad.map((l) => `${l.label ?? l.quote}: ${l.econ.reasons.join(' ')}`).join(' · '));
                  if (bad.length && !(f.mode === 'paper' && f.allowTight)) throw new Error(`${p.name} not net-positive (paper: tick "simulate anyway"): ` + bad.map((l) => l.econ.reasons.join(' ')).join(' · '));
                  if (f.mode === 'live' && !confirm(`Start LIVE preset ${p.name} from ${s.address}?\n\n${legs.map(legSummary).join('\n')}`)) return;
                  const r = await api(`presets/${p.id}/start`, 'POST', {
                    mode: f.mode, quote: f.stable || 'DAI', capitalUsd: +f.presetUsd > 0 ? +f.presetUsd : undefined,
                    allowTightSpacing: f.mode === 'paper' && f.allowTight, limits: limits(),
                  });
                  if (r.ids?.[0]) setSel(r.ids[0]);
                })}>Start</button>
              <span className="small"><strong>{p.name}</strong>{p.flipped ? <i className="flip-tag" title="flipped orientation: spends PLS, stacks the token">⇄</i> : null} <span className="muted">{p.blurb}</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h3>Grids {chain !== 'all' && <span className="muted small">{chainOf(s, chain)?.name} · {visGrids.length}/{s.grids.length}</span>}</h3>
          <table>
            <thead><tr><th>Pair</th><th>Status</th><th>Range×N</th><th>PnL</th><th></th></tr></thead>
            <tbody>
              {visGrids.map((x: Grid) => <GridRow key={x.id} x={{ ...x, chainColor: chainOf(s, x.chainId)?.color }} sel={x.id === sel} onSel={() => setSel(x.id)} busy={busy} act={act} />)}
              {visGrids.length === 0 && <tr><td colSpan={5} className="muted">no grids{chain !== 'all' ? ' on this chain' : ''} — add one</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Add grid</h3>
          <div className="form-row">
            <label>Mode<select value={f.mode} onChange={set('mode')}><option value="paper">paper</option><option value="live" disabled={!(fc?.hasSigner ?? s.hasSigner) || !fm.liveAllowed}>live{fm.liveAllowed ? ((fm.buyTaxPct || fm.sellTaxPct) ? ` (tax ${((fm.buyTaxPct ?? 0)*100).toFixed(1)}/${((fm.sellTaxPct ?? 0)*100).toFixed(1)}%)` : '') : ' (blocked: safety)'}</option></select></label>
            <PairPicker s={s} value={f.stable} onChange={pickPair} />
            <label>Lower<input value={f.lowerPrice} onChange={set('lowerPrice')} /></label>
            <label>Upper<input value={f.upperPrice} onChange={set('upperPrice')} /></label>
            <label>Grids<input value={f.gridCount} onChange={set('gridCount')} /></label>
            <label>Capital ({fm.quote || 'quote'})<input value={f.totalCapitalUsd} onChange={set('totalCapitalUsd')} /></label>
            <label>Impact %<input value={f.impact} onChange={set('impact')} /></label>
            <label>Slip %<input value={f.slippage} onChange={set('slippage')} /></label>
            <label>Deadline<input value={f.deadline} onChange={set('deadline')} /></label>
            {fm.quoteNative && <label title={`Gas reserve kept in ${fm.quote}: "2%" of capital or a fixed amount, e.g. "50000"`}>Gas res.<input value={f.gasRes} onChange={set('gasRes')} /></label>}
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            {PRESETS.map((p) => (
              <button key={p} type="button" className={`btn small-btn ${+f.gridCount === p ? 'primary' : ''}`} onClick={() => setF((x) => ({ ...x, gridCount: String(p) }))}>{p}</button>
            ))}
            <span className="muted small">max 50 · min step 1.0% · <ChainBadge c={fc} /> {fm.dexName ?? fm.dex} {feeLabel(fm)} LP fee{fm.custom ? ` · custom ${fm.risk ?? 'unknown'}` : ''}</span>
          </div>
          <div className="orient-line">
            <Orientation m={fm} />
            <span className="muted small">levels in {fm.quote} per {fm.base} · buys spend {fm.quote} for {fm.base} on dips · sells give each level's own {fm.base} lot back for {fm.quote} · PnL in {fm.quote}</span>
            {fm.quoteNative && +f.totalCapitalUsd > 0 && (
              <span className="small" title="Gas is paid from the same native balance; the reserve is never traded. Live start is blocked if capital + reserve exceeds the wallet balance.">
                gas reserve {n(resAmt, 2)} {fm.quote}{gasRes?.fixed ? '' : ` (${((gasRes?.pct ?? DEFAULT_GAS_RESERVE.pct) * 100).toFixed(1).replace(/\.0$/, '')}%)`} · wallet needs {n(+f.totalCapitalUsd + resAmt, 2)} {fm.quote}{!gasRes && <b className="neg"> · bad reserve</b>}
              </span>
            )}
          </div>
          {econ && (
            <p className={`small ${econ.ok ? 'pos' : 'neg'}`} style={{ marginTop: 8 }}>
              <EconLine e={econ} />
              {!econ.ok && <><br />{f.mode === 'live' ? 'BLOCKED (live): ' : 'Blocked: '}{econ.reasons.join(' ')}</>}
            </p>
          )}
          {econErr && <p className="small neg" style={{ marginTop: 8 }}>{econErr}</p>}
          {econ && !econ.ok && f.mode === 'paper' && (
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <input type="checkbox" checked={f.allowTight} onChange={set('allowTight')} /> paper: simulate anyway (would be blocked live)
            </label>
          )}
          <div className="actions" style={{ marginTop: 10 }}>
            <button type="button" className={`btn ${f.mode === 'live' ? 'danger' : 'primary'}`} disabled={busy || !canAdd} onClick={add}>Add & start</button>
          </div>
        </div>
      </div>

      {g && (
        <>
          <div className="card stats">
            <div><span className="k">Selected</span><ChainBadge c={chainOf(s, g.chainId)} /> {(g.label ?? `PLS/${g.stable}`).replace(/·.*/, '')} <DexTag name={g.dexName} feeBps={g.feeBps} feeTier={g.feeTier} /> · {g.mode} · {g.status} · {g.id}</div>
            <div><span className="k">Orientation</span><Orientation m={{ base: g.base ?? 'PLS', quote: g.quoteSym ?? g.stable, flipped: g.flipped, label: g.label }} compact />{g.gasReserve ? <span className="muted small"> · gas reserve {n(g.gasReserve, 2)} {g.quoteSym} (not traded)</span> : null}</div>
            <div><span className="k">Price</span>{g.price ? `${formatPrice(g.price)} ${g.quoteSym ?? g.stable}/${g.base ?? 'PLS'}` : '—'}</div>
            <div><span className="k">Size/buy</span>{n(g.usdPerBuy, 6)} {g.quoteSym ?? g.stable}</div>
            <div><span className="k">Realized</span><span className={g.pnl.realized >= 0 ? 'pos' : 'neg'}>{q(g.pnl.realized, g.quoteSym ?? g.stable)}</span>{g.usdPerQuote && g.usdPerQuote !== 1 ? <span className="muted small"> ≈{usd(g.pnl.realized * g.usdPerQuote)}</span> : null}</div>
            <div><span className="k">Unreal</span><span className={g.pnl.unrealized >= 0 ? 'pos' : 'neg'}>{q(g.pnl.unrealized, g.quoteSym ?? g.stable)}</span>{g.usdPerQuote && g.usdPerQuote !== 1 ? <span className="muted small"> ≈{usd(g.pnl.unrealized * g.usdPerQuote)}</span> : null}</div>
            <div><span className="k">Stacked</span>{n(g.pnl.plsHeld, g.pnl.plsHeld < 10 ? 6 : 2)} {g.base ?? 'PLS'} <span className="muted small">held by this grid</span></div>
            <div><span className="k">RT stats</span>
              {g.stats.roundTrips} RT ({g.stats.wins} win) · avg <span className={g.stats.avgNet >= 0 ? 'pos' : 'neg'}>{q(g.stats.avgNet, g.quoteSym ?? g.stable)}</span>
              {' '}· fees {n(g.stats.totalFees, 8)} · gas {n(g.stats.totalGas, 8)} {g.quoteSym ?? g.stable} · slip {pct(g.stats.avgSlippagePct)} · LP fee {((g.feeBps ?? 29) / 100).toFixed(2)}%
            </div>
            {g.econ && <div><span className="k">At start</span><span className={`small ${g.econ.ok ? '' : 'neg'}`}><EconLine e={g.econ} /></span></div>}
            {g.spacingWarn && <div className="neg small">{g.spacingWarn}</div>}
            {!g.mode || g.mode === 'paper' ? (g.balances && <div><span className="k">Paper</span>{n(g.balances.pls, 6)} {g.base ?? 'PLS'} · {n(g.balances.stable)} {g.quoteSym ?? g.stable}</div>) : null}
            <div className="actions">
              <button type="button" className="btn" disabled={busy || !g.config || g.status === 'running'} onClick={() => act(() => api(`grids/${g.id}/start`, 'POST', body()))}>Restart config</button>
              <button type="button" className="btn" disabled={busy} onClick={() => act(() => api(`grids/${g.id}/limits`, 'PUT', limits()))}>Apply limits</button>
              <button type="button" className="btn danger" disabled={busy || g.status === 'running' || !!g.inFlight} onClick={() => act(async () => { await api(`grids/${g.id}`, 'DELETE'); setSel(null); })}>Remove</button>
            </div>
          </div>

          <div className="split">
            <div className="card"><Chart status={s} ticks={ticks} pairs={[g.stable]} pair={g.stable} compact height={320} /></div>
            <div className="card">
              <h3>Equity &amp; drawdown <span className="muted small">{g.quoteSym ?? g.stable}</span></h3>
              <EquityChart series={[{ name: `equity ${g.quoteSym ?? g.stable}`, data: g.equityHist ?? [], color: '#3dd6c6' }]} />
            </div>
          </div>
          <div className="split">
            <div className="card">
              <h3>Levels</h3>
              <table><tbody>
                {[...g.intervals].reverse().map((iv: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
                  <tr key={iv.index}><td>#{iv.index}</td><td>{formatPrice(iv.buyPrice)} → {formatPrice(iv.sellPrice)}</td><td className={`st ${iv.status}`}>{iv.status}{iv.needsRearm ? ' (rearm)' : ''}</td><td>{iv.plsAmount ? `${n(iv.plsAmount, iv.plsAmount < 10 ? 6 : 0)} ${g.base ?? 'PLS'}` : ''}</td></tr>
                ))}
                {g.intervals.length === 0 && <tr><td className="muted">—</td></tr>}
              </tbody></table>
            </div>
            <div className="card">
              <h3>Log</h3>
              <div className="log">{s.log.map((l: any, i: number) => <div key={i} className={l.level}>{formatTime(l.t)} {l.msg}</div>)}</div>
            </div>
          </div>

          <div className="card">
            <h3>Fills <span className="muted small">({g.trades.length})</span></h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Time</th><th>Side</th><th>#</th><th>{g.base ?? 'PLS'}</th><th>{g.quoteSym ?? g.stable}</th><th title="getPrice at trigger">Trig</th><th title="router quote after known tax">Quote</th><th title="from receipt / balance change (actual received)">Exec</th><th title="+ = worse than quote">Slip</th><th title="token tax applied on this swap">Tax</th><th>Gas {g.quoteSym ?? g.stable}</th><th title="matched lot: proceeds − sell gas − lot cost">RT net</th><th>DEX</th><th>Tx</th></tr></thead>
              <tbody>
                {g.trades.map((t: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
                  <tr key={t.id} className={t.failed ? 'failed-row' : ''}>
                    <td>{formatTime(t.timestamp)}</td><td className={`side ${t.side}`}>{t.side}{t.failed ? ' ✗' : ''}</td>
                    <td className="muted">{t.intervalIndex}</td>
                    <td>{n(t.plsAmount, t.plsAmount < 10 ? 6 : 2)}</td><td>{n(t.stableAmount, 6)}</td>
                    <td>{t.triggerPrice ? formatPrice(t.triggerPrice) : '—'}</td>
                    <td>{t.quotedPrice ? formatPrice(t.quotedPrice) : '—'}</td>
                    <td title={t.fromReceipt === false && !t.paper ? 'receipt log missing: amountOutMin used' : ''}>{t.execPrice ?? t.price ? formatPrice(t.execPrice ?? t.price) : '—'}{t.fromReceipt === false && !t.paper ? '*' : ''}</td>
                    <td className={(t.slippagePct ?? 0) > 0.001 ? 'neg' : ''}>{t.slippagePct != null ? pct(t.slippagePct) : '—'}</td>
                    <td title={t.outSource ? `out via ${t.outSource}` : ''}>{t.taxPct != null && t.taxPct > 0.0005 ? pct(t.taxPct) : '—'}</td>
                    <td title={`${n(t.gasPls, 8)} ${g.base ?? 'PLS'}`}>{n(t.gasUsd, 8)}</td>
                    <td className={(t.roundTripNet ?? t.realizedPnlUsd) >= 0 ? 'pos' : 'neg'}>{t.side === 'sell' || t.failed ? q(t.roundTripNet ?? t.realizedPnlUsd, g.quoteSym ?? g.stable) : ''}</td>
                    <td className="small nowrap" title={t.feeTier != null ? `${t.feeTier / 10000}% tier` : t.feeBps != null ? `${t.feeBps / 100}% fee` : ''}>{dexName(s ?? {}, g.chainId, t.dex)}</td>
                    <td>{tx(t.txHash, g.chainId)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </>
      )}
      </>}
      </main>
      <aside><Activity events={events} connected={connected} compact status={s} /></aside>
      </div>
    </div>
    </ChainFilterCtx.Provider>
  );
}

/** First market of each non-legacy tradable chain (compact all-chains ticker). */
function chainsFirstMarkets(s: Status): string[] {
  const out: string[] = [];
  for (const c of s.chains ?? []) {
    if (c.id === s.legacyChainId || !c.tradable) continue;
    const m = marketsOf(s).find((x) => x.chainId === c.id && !x.custom);
    if (m) out.push(m.key);
  }
  return out;
}
