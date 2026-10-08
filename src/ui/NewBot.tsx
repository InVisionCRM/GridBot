/** New bot: pick grid or trend, fill a short form in dollars, read one plain sentence about the economics, start. */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TREND, STRATEGIES, type TrendConfig } from '../market/strategy';
import { TFS, type TF } from '../market/candles';
import { STRATEGY_PRESETS } from '../live/presets';
import { DEFAULT_GAS_RESERVE, gasReserve, parseGasRes } from '../live/gasReserve';
import { botApi } from './api';
import { num, pct, px, usd } from './fmt';
import { ChainBadge, Orientation, PairPicker, chainOf, feeLabel, marketsOf, mk, unflipKey, useChainFilter } from './chains';
import { TrendConfigEditor, strategyRule } from './TrendConfig';
import { errMsg, usdPerQuoteOf, type AnyObj, type Nav, type TrendPrefill } from './model';

interface Common { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }
type Mode = 'paper' | 'live';
interface Econ {
  ok: boolean; reasons: string[]; levelSize: number; buyLevels: number; spacingPct: number; roundTripFeePct: number;
  impactPct: number; gasQuote: number; netPerRoundTrip: number; netPct: number; buyTaxPct?: number; sellTaxPct?: number;
}
interface Leg { quote: string; label?: string; pool?: { dexName: string; feeBps: number; feeTier?: number; switchTo: boolean }; lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalUsd: number; capitalUsd: number; bandPct: number; econ: Econ }
interface Limits { impact: string; slippage: string; deadline: string; gasRes: string }
const DEFAULT_LIMITS: Limits = { impact: '3', slippage: '1', deadline: '10', gasRes: '2%' };
const BANDS = [0.05, 0.08, 0.12, 0.2];
const LEVELS = [10, 12, 16, 20];

/** First tradable market on the filtered chain. */
function defaultPair(s: AnyObj, chain: number | 'all'): string {
  const ms = marketsOf(s).filter((m) => m.tradable && (chain === 'all' || m.chainId === chain));
  return ms[0]?.key ?? s.quotes?.[0] ?? 'DAI';
}

function limitsBody(l: Limits, quoteNative: boolean) {
  const g = parseGasRes(l.gasRes);
  return {
    maxPriceImpact: Number(l.impact) / 100, slippageBps: Math.round(Number(l.slippage) * 100), deadlineMinutes: Number(l.deadline),
    ...(quoteNative && g ? { gasReservePct: g.pct, gasReserveNative: g.fixed } : {}),
  };
}

function LimitsFields({ l, set, quoteNative, quote }: { l: Limits; set: (l: Limits) => void; quoteNative: boolean; quote: string }) {
  const f = (k: keyof Limits) => (e: { target: { value: string } }) => set({ ...l, [k]: e.target.value });
  return (
    <div className="form-row">
      <label title="Skip a trade if it would move the pool price more than this">Max price impact %<input value={l.impact} onChange={f('impact')} /></label>
      <label title="If the price moves more than this before the swap is mined, it reverts and only gas is lost">Slippage %<input value={l.slippage} onChange={f('slippage')} /></label>
      <label title="Minutes a swap stays valid on-chain">Deadline (min)<input value={l.deadline} onChange={f('deadline')} /></label>
      {quoteNative && <label title={`Kept aside for gas and never traded: "2%" of capital or a fixed ${quote} amount such as "50000"`}>Gas reserve<input value={l.gasRes} onChange={f('gasRes')} /></label>}
    </div>
  );
}

/** Paper/Live switch + start button. Live is disabled with the reason when it isn't allowed. */
function StartRow({ s, pairKey, mode, setMode, label, disabled, onStart, busy }: { s: AnyObj; pairKey: string; mode: Mode; setMode: (m: Mode) => void; label: string; disabled: boolean; onStart: () => void; busy: boolean }) {
  const m = mk(s, pairKey), c = chainOf(s, m.chainId);
  const why = !(c?.hasSigner ?? s.hasSigner) ? 'Live needs a signing key in .env' : !m.liveAllowed ? 'Live blocked: this token failed the safety check' : null;
  useEffect(() => { if (why && mode === 'live') setMode('paper'); }, [why, mode, setMode]);
  return (
    <div className="start-row">
      <div className="seg mode" role="radiogroup" aria-label="Paper or live">
        <button type="button" role="radio" aria-checked={mode === 'paper'} className={mode === 'paper' ? 'on' : ''} onClick={() => setMode('paper')}>Paper</button>
        <button type="button" role="radio" aria-checked={mode === 'live'} className={mode === 'live' ? 'on live' : ''} disabled={!!why} title={why ?? 'Signs and sends real swaps'} onClick={() => setMode('live')}>Live</button>
      </div>
      <button type="button" className={`btn ${mode === 'live' ? 'live' : 'primary'}`} disabled={busy || disabled} onClick={onStart}>{label}</button>
      <span className="muted small">{mode === 'paper' ? 'Paper uses real prices and simulated fills. No funds move.' : why ?? `Trades real funds from ${c?.address ?? s.address ?? 'your wallet'} on ${c?.name ?? 'this chain'}.`}</span>
    </div>
  );
}

/** "Each completed buy-then-sell nets about $0.08 …" */
function Verdict({ e, k, quote, fee }: { e: Econ; k: number | null; quote: string; fee: string }) {
  const money = (q: number) => (k ? usd(q * k) : `${num(q, 6)} ${quote}`);
  const signed = (q: number) => (k ? usd(q * k, true) : `${num(q, 6)} ${quote}`);
  return (
    <div className={`verdict ${e.ok ? 'ok' : 'bad'}`}>
      {e.ok
        ? <span>Each completed buy-then-sell nets about <b>{signed(e.netPerRoundTrip)}</b> ({pct(e.netPct, 2)} of a {money(e.levelSize)} level) after fees, price impact and gas. Levels are {pct(e.spacingPct, 2)} apart.</span>
        : <span><b className="neg">Not profitable at this size.</b> {e.reasons.join(' ')}</span>}
      <span className="detail">Worst level: pool fee {fee} each way ({pct(e.roundTripFeePct, 3)} round trip) · impact {pct(e.impactPct, 3)} · gas {money(e.gasQuote)}{e.buyTaxPct || e.sellTaxPct ? ` · token tax ${pct(e.buyTaxPct ?? 0, 1)} buy / ${pct(e.sellTaxPct ?? 0, 1)} sell` : ''} · {e.buyLevels} levels below the price get funds</span>
    </div>
  );
}

function GridForm({ s, nav, act, busy }: Common) {
  const { chain } = useChainFilter();
  const [tab, setTab] = useState<'preset' | 'custom'>('preset');
  const [pair, setPair] = useState(() => defaultPair(s, chain));
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [count, setCount] = useState('12');
  const [capUsd, setCapUsd] = useState('100');
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [allowTight, setAllowTight] = useState(false);
  const [mode, setMode] = useState<Mode>('paper');
  const [econ, setEcon] = useState<Econ | null>(null);
  const [econErr, setEconErr] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string>(STRATEGY_PRESETS[0].id);
  const [presetUsd, setPresetUsd] = useState('');
  const [legs, setLegs] = useState<Leg[] | null>(null);
  const [legErr, setLegErr] = useState<string | null>(null);

  const m = mk(s, pair);
  const k = usdPerQuoteOf(s, pair);
  const spot = s.spots?.[pair] ?? m.spot ?? null;
  const preset = STRATEGY_PRESETS.find((p) => p.id === presetId)!;
  const presetUsesPair = preset.legs.some((l) => l.quote === null);

  // Chain filter change: move to a market on that chain.
  useEffect(() => {
    const ms = marketsOf(s).filter((x) => x.tradable && (chain === 'all' || x.chainId === chain));
    if (ms.length && !ms.some((x) => x.key === unflipKey(pair))) setPair(ms[0].key);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pair change: centre an ±8% × 12 range on the spot of this orientation.
  const centre = (band: number) => { if (spot) { setLower(String(+(spot * (1 - band)).toPrecision(5))); setUpper(String(+(spot * (1 + band)).toPrecision(5))); } };
  useEffect(() => { centre(0.08); }, [pair, spot != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const capQuote = k ? +capUsd / k : null;
  useEffect(() => {
    if (tab !== 'custom') return;
    const lo = +lower, hi = +upper, g = +count;
    if (!(lo > 0) || !(hi > lo) || !(g >= 2) || !(capQuote! > 0)) { setEcon(null); setEconErr(null); return; }
    const t = setTimeout(() => {
      botApi(`econ?quote=${encodeURIComponent(pair)}&lower=${lo}&upper=${hi}&grids=${g}&capital=${capQuote}`)
        .then((e) => { setEcon(e); setEconErr(null); })
        .catch((e) => { setEcon(null); setEconErr(errMsg(e)); });
    }, 250);
    return () => clearTimeout(t);
  }, [tab, pair, lower, upper, count, capQuote]);

  useEffect(() => {
    if (tab !== 'preset') return;
    setLegs(null); setLegErr(null);
    const t = setTimeout(() => {
      botApi(`presets/${presetId}/preview?quote=${encodeURIComponent(pair)}${+presetUsd > 0 ? `&capitalUsd=${+presetUsd}` : ''}`)
        .then((r) => setLegs(r.legs as Leg[]))
        .catch((e) => setLegErr(errMsg(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [tab, presetId, pair, presetUsd]);

  const confirmLive = (what: string) => mode !== 'live' || confirm(`Start a LIVE ${what}? It signs real swaps from ${chainOf(s, m.chainId)?.address ?? s.address}.`);

  const startCustom = () => act(async () => {
    if (!confirmLive(`grid on ${m.label}`)) return;
    const r = await botApi('grids', 'POST', {
      mode, stable: pair, lowerPrice: +lower, upperPrice: +upper, gridCount: +count, totalCapitalUsd: capQuote,
      limits: limitsBody(limits, !!m.quoteNative), allowTightSpacing: mode === 'paper' && allowTight,
    });
    nav({ v: 'grid', id: r.id });
  });
  const startPreset = () => act(async () => {
    if (!confirmLive(`${preset.name} preset`)) return;
    const r = await botApi(`presets/${presetId}/start`, 'POST', {
      mode, quote: pair, capitalUsd: +presetUsd > 0 ? +presetUsd : undefined,
      limits: limitsBody(limits, quoteNative), allowTightSpacing: mode === 'paper' && allowTight,
    });
    nav(r.ids?.length === 1 ? { v: 'grid', id: r.ids[0] } : { v: 'home' });
  });
  const customize = (l: Leg) => {
    setPair(l.quote); setLower(String(l.lowerPrice)); setUpper(String(l.upperPrice)); setCount(String(l.gridCount)); setCapUsd(String(l.capitalUsd)); setTab('custom');
  };

  // Preset mode: the start check and gas reserve follow the preset's own pairs (Stack HEX spends PLS, for example).
  const startKey = tab === 'preset' && legs?.length ? legs[0].quote : pair;
  const quoteNative = tab === 'preset' ? !!legs?.some((l) => mk(s, l.quote).quoteNative) : !!m.quoteNative;
  const blocked = tab === 'custom' ? !!econ && !econ.ok : !!legs && legs.some((l) => !l.econ.ok);
  const canStart = tab === 'custom'
    ? !!econ && capQuote != null && (econ.ok || (mode === 'paper' && allowTight))
    : !!legs && (!blocked || (mode === 'paper' && allowTight));
  const res = gasReserve(capQuote ?? 0, parseGasRes(limits.gasRes) ?? DEFAULT_GAS_RESERVE);

  return (
    <div className="card">
      <div className="seg" role="tablist" aria-label="Grid setup">
        <button type="button" role="tab" aria-selected={tab === 'preset'} className={tab === 'preset' ? 'on' : ''} onClick={() => setTab('preset')}>Preset</button>
        <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>Custom</button>
      </div>

      {tab === 'preset' ? <>
        <div className="presets">
          {STRATEGY_PRESETS.map((p) => (
            <button key={p.id} type="button" className={`preset ${p.id === presetId ? 'on' : ''}`} onClick={() => { setPresetId(p.id); setPresetUsd(''); }}>
              <b>{p.name}</b><span>{p.blurb}</span>
            </button>
          ))}
        </div>
        <div className="form-row narrow">
          {presetUsesPair && <PairPicker s={s} value={pair} onChange={setPair} />}
          <label>Dollars per pair<input value={presetUsd} placeholder={`$${preset.legs[0].capitalUsd} (default)`} onChange={(e) => setPresetUsd(e.target.value)} /></label>
        </div>
        {legErr && <div className="banner error">{legErr}</div>}
        {!legs && !legErr && <p className="muted small spin">Checking against live pool prices…</p>}
        {legs && (
          <div className="legs">
            {legs.map((l) => {
              const lm = mk(s, l.quote);
              return (
                <div key={l.quote} className="leg stack" style={{ gap: 6 }}>
                  <div className="actions">
                    <ChainBadge c={chainOf(s, lm.chainId)} testnet={false} /><b>{l.label ?? lm.label}</b>
                    <span className="muted small">±{(l.bandPct * 100).toFixed(0)}% · {l.gridCount} levels · ${l.capitalUsd} ≈ {num(l.totalCapitalUsd, 4)} {lm.quote}{l.pool ? ` · ${l.pool.dexName} ${l.pool.feeTier != null ? l.pool.feeTier / 10_000 : l.pool.feeBps / 100}%${l.pool.switchTo ? ' (switches to this best pool)' : ''}` : ''}</span>
                    <span className="grow" />
                    {legs.length === 1 && <button type="button" className="btn ghost small-btn" onClick={() => customize(l)}>Customize</button>}
                  </div>
                  <Verdict e={l.econ} k={lm.usdPerQuote ?? null} quote={lm.quote} fee={feeLabel(lm)} />
                </div>
              );
            })}
          </div>
        )}
      </> : <>
        <div className="form-row">
          <PairPicker s={s} value={pair} onChange={setPair} />
          <label>Lowest price<input value={lower} onChange={(e) => setLower(e.target.value)} /></label>
          <label>Highest price<input value={upper} onChange={(e) => setUpper(e.target.value)} /></label>
          <label>Levels<input value={count} onChange={(e) => setCount(e.target.value)} /></label>
          <label>Capital ($)<input value={capUsd} onChange={(e) => setCapUsd(e.target.value)} /></label>
        </div>
        <div className="quick">
          <span className="muted small">Range around {spot ? px(spot) : '—'} {m.quote}/{m.base}:</span>
          {BANDS.map((b) => <button key={b} type="button" className="btn small-btn" disabled={!spot} onClick={() => centre(b)}>±{b * 100}%</button>)}
          <span className="muted small">Levels:</span>
          {LEVELS.map((n) => <button key={n} type="button" className={`btn small-btn ${+count === n ? 'primary' : ''}`} onClick={() => setCount(String(n))}>{n}</button>)}
        </div>
        <p className="small"><Orientation m={m} /> <span className="muted">· {capQuote != null ? `$${capUsd} ≈ ${num(capQuote, 4)} ${m.quote}` : `no dollar price for ${m.quote} yet`}{m.quoteNative && capQuote ? ` · ${num(res, 2)} ${m.quote} kept aside for gas` : ''}</span></p>
        {econErr && <div className="banner error">{econErr}</div>}
        {econ && <Verdict e={econ} k={k} quote={m.quote} fee={feeLabel(m)} />}
      </>}

      <details className="more">
        <summary>Advanced</summary>
        <div className="stack">
          <LimitsFields l={limits} set={setLimits} quoteNative={quoteNative} quote={mk(s, startKey).quote} />
          {blocked && mode === 'paper' && (
            <label className="check"><input type="checkbox" checked={allowTight} onChange={(e) => setAllowTight(e.target.checked)} /> Simulate anyway in paper mode (it would be blocked live)</label>
          )}
        </div>
      </details>

      <StartRow s={s} pairKey={startKey} mode={mode} setMode={setMode} busy={busy} disabled={!canStart}
        label={mode === 'live' ? 'Start live grid' : 'Start paper grid'} onStart={tab === 'custom' ? startCustom : startPreset} />
    </div>
  );
}

function TrendForm({ s, nav, act, busy, prefill }: Common & { prefill?: TrendPrefill }) {
  const { chain } = useChainFilter();
  const [pair, setPair] = useState(() => prefill?.pair ?? defaultPair(s, chain));
  const [tf, setTf] = useState<TF>(prefill?.tf ?? '4h');
  const [capUsd, setCapUsd] = useState(prefill?.capitalUsd ? String(prefill.capitalUsd) : '100');
  const [cfg, setCfg] = useState<TrendConfig>(prefill?.cfg ?? { ...DEFAULT_TREND });
  const [name, setName] = useState('');
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [mode, setMode] = useState<Mode>('paper');
  useEffect(() => {
    const ms = marketsOf(s).filter((x) => x.tradable && (chain === 'all' || x.chainId === chain));
    if (ms.length && !ms.some((x) => x.key === unflipKey(pair))) setPair(ms[0].key);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = mk(s, pair);
  const k = usdPerQuoteOf(s, pair);
  const rt = 1 - (1 - m.feeBps / 10_000) ** 2;
  const start = () => act(async () => {
    if (mode === 'live' && !confirm(`Start a LIVE trend bot on ${m.label} (${tf})? It signs real swaps from ${chainOf(s, m.chainId)?.address ?? s.address}.`)) return;
    const r = await botApi('trends', 'POST', { mode, quote: pair, tf, cfg, capitalUsd: +capUsd, name: name || undefined, limits: limitsBody(limits, !!m.quoteNative) });
    nav({ v: 'trend', id: r.id });
  });

  return (
    <div className="card">
      <div className="form-row">
        <PairPicker s={s} value={pair} onChange={setPair} />
        <label>Candle size<select value={tf} onChange={(e) => setTf(e.target.value as TF)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Strategy<select value={cfg.strategy} onChange={(e) => setCfg({ ...cfg, strategy: e.target.value as TrendConfig['strategy'] })}>{STRATEGIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        <label>Capital ($)<input value={capUsd} onChange={(e) => setCapUsd(e.target.value)} /></label>
      </div>
      <div className="verdict">
        <span>Buys {m.base} with {m.quote} when {strategyRule(cfg)} on a closed {tf} candle. Sells at the stop-loss ({cfg.stopAtr}× ATR below entry){cfg.tpR > 0 ? `, the take-profit (${cfg.tpR}× the stop distance above)` : ''}{cfg.trailAtr > 0 ? `, the trailing stop` : ''} or the exit signal.</span>
        <span className="detail">A trade only starts if the expected move beats the {pct(rt, 3)} round-trip pool fee ({feeLabel(m)} each way) plus impact, gas and a {pct(cfg.minEdgePct, 2)} margin. {k ? `$${capUsd} ≈ ${num(+capUsd / k, 4)} ${m.quote}.` : ''} Longer candles mean fewer trades, so fees take a smaller share.</span>
      </div>
      <details className="more">
        <summary>Advanced</summary>
        <div className="stack">
          <TrendConfigEditor cfg={cfg} onChange={setCfg} showStrategy={false} />
          <LimitsFields l={limits} set={setLimits} quoteNative={!!m.quoteNative} quote={m.quote} />
          <label>Name<input value={name} placeholder="automatic" onChange={(e) => setName(e.target.value)} /></label>
        </div>
      </details>
      <div className="actions">
        <button type="button" className="btn" onClick={() => nav({ v: 'tools', tab: 'backtest', btPrefill: { pair, tf, cfg, nonce: Date.now() } })}>Backtest these settings first</button>
      </div>
      <StartRow s={s} pairKey={pair} mode={mode} setMode={setMode} busy={busy} disabled={!(+capUsd > 0)}
        label={mode === 'live' ? 'Start live trend bot' : 'Start paper trend bot'} onStart={start} />
    </div>
  );
}

export function NewBot({ s, kind, trendPrefill, nav, act, busy }: Common & { kind: 'grid' | 'trend'; trendPrefill?: TrendPrefill }) {
  const pick = useMemo(() => [
    ['grid', 'Grid bot', 'Buys a little on each dip and sells it one level higher. Earns when the price swings sideways inside a range.'],
    ['trend', 'Trend bot', 'Buys when a trend starts and sells on a stop, take-profit or exit signal. Earns when the price moves in one direction.'],
  ] as const, []);
  return (
    <main className="stack">
      <div className="section-title"><h2>New bot</h2><span className="muted small">Start in paper mode to watch it with real prices before using real money.</span></div>
      <div className="kind-pick" role="radiogroup" aria-label="Bot type">
        {pick.map(([k, t, d]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => nav({ v: 'new', kind: k })}>
            <b>{t}</b><span>{d}</span>
          </button>
        ))}
      </div>
      {kind === 'grid'
        ? <GridForm s={s} nav={nav} act={act} busy={busy} />
        : <TrendForm key={trendPrefill?.nonce ?? 0} s={s} nav={nav} act={act} busy={busy} prefill={trendPrefill} />}
    </main>
  );
}
