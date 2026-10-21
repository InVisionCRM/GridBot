/** New bot: pick grid or trend, enter how much of the coin it spends (wallet balance + Max beside it), start. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_TREND, STRATEGIES, type TrendConfig } from '../market/strategy';
import { TFS, type TF } from '../market/candles';
import { STRATEGY_PRESETS } from '../live/presets';
import { DEFAULT_GAS_RESERVE, parseGasRes, type GasReserveCfg } from '../live/gasReserve';
import { humanAmount } from '../live/amount';
import { PAYOUT_MIN_GAS_MULTIPLE } from '../live/payout';
import { LP_BAND, LP_MAX_MOVES_PER_DAY, LP_MIN_SWAP_SHARE } from '../market/lp';
import { rangeBaseShare } from '../live/v3Liquidity';
import { L } from './Tip';
import { botApi } from './api';
import { pct, px } from './fmt';
import { ChainBadge, Orientation, PairPicker, chainOf, feeLabel, marketsOf, mk, unflipKey, useChainFilter } from './chains';
import { TrendConfigEditor, strategyRule } from './TrendConfig';
import { LinesEditor } from './LinesEditor';
import { coinFunds, errMsg, floorSig, spendFunds, type AnyObj, type BotKind, type Funds, type GridPrefill, type LpPrefill, type Nav, type TrendPrefill } from './model';

interface Common { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }
type Mode = 'paper' | 'live';
interface Econ {
  ok: boolean; reasons: string[]; levelSize: number; buyLevels: number; spacingPct: number; roundTripFeePct: number;
  impactPct: number; gasQuote: number; netPerRoundTrip: number; netPct: number; buyTaxPct?: number; sellTaxPct?: number;
}
interface Leg { quote: string; label?: string; pool?: { dexName: string; feeBps: number; feeTier?: number; switchTo: boolean }; lowerPrice: number; upperPrice: number; gridCount: number; capital: number | null; bandPct: number; econ: Econ | null }
interface Limits { impact: string; slippage: string; deadline: string; gasRes: string }
const DEFAULT_LIMITS: Limits = { impact: '3', slippage: '1', deadline: '10', gasRes: '2%' };
const BANDS = [0.05, 0.08, 0.12, 0.2];
const LEVELS = [10, 12, 16, 20];

const amt = (x: number, sym: string, sign = false) => `${sign && x > 0 ? '+' : ''}${humanAmount(x)} ${sym}`;

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
      <label><L tip="A trade is skipped if it would move the pool's price more than this against you. Default 3%.">Max price impact %</L><input value={l.impact} onChange={f('impact')} /></label>
      <label><L tip="If the price moves more than this between the quote and the swap landing, the swap cancels itself and only gas is lost. Default 1%.">Slippage %</L><input value={l.slippage} onChange={f('slippage')} /></label>
      <label><L tip="Minutes a sent swap stays valid. If it hasn't landed by then it cancels itself.">Deadline (min)</L><input value={l.deadline} onChange={f('deadline')} /></label>
      {quoteNative && <label><L tip={`Kept aside for gas and never traded: "2%" of the amount, or a fixed ${quote} amount such as "50000".`}>Gas set-aside</L><input value={l.gasRes} onChange={f('gasRes')} /></label>}
    </div>
  );
}

/** "Amount (PLS)" input with the wallet balance and a Max button. */
export function AmountField({ label, value, onChange, f }: { label: string; value: string; onChange: (v: string) => void; f: Funds }) {
  return (
    <label><L tip={`How much ${f.symbol} the bot gets, in ${f.symbol} (not dollars). Max = everything you can use after the gas set-aside and what your other live bots use.`}>{label}</L>
      <span className="pair-pick">
        <input value={value} inputMode="decimal" placeholder="0" onChange={(e) => onChange(e.target.value.replace(/,/g, ''))} />
        <button type="button" className="btn small-btn" disabled={f.max == null || f.max <= 0} title="Everything you can use after the gas set-aside and your other live bots"
          onClick={() => onChange(String(floorSig(f.max!)))}>Max</button>
      </span>
      <span className="muted">{+value > 0 ? `${amt(+value, f.symbol)} of ` : ''}{f.have == null ? (f.readError ? `your wallet (couldn't read your ${f.symbol} balance: ${f.readError})` : 'your wallet (no signing key: paper only)') : `${amt(f.have, f.symbol)} in your wallet${f.inUse > 0 ? ` · ${amt(f.inUse, f.symbol)} used by your live bots` : ''}`}</span>
    </label>
  );
}

/** Live-only problem with the wallet, in plain words; null when it fits or in paper mode. */
export function fundsProblem(f: Funds, amount: number, mode: Mode): string | null {
  if (mode !== 'live' || f.ok !== false) return null;
  const parts = [`${amt(amount, f.symbol)} to trade`, ...(f.reserve > 0 ? [`${amt(f.reserve, f.symbol)} kept for gas`] : []), ...(f.inUse > 0 ? [`${amt(f.inUse, f.symbol)} already used by your live bots`] : [])];
  return `Not enough ${f.symbol}: this needs ${amt(f.need, f.symbol)} (${parts.join(' + ')}) and your wallet has ${amt(f.have!, f.symbol)}.${f.max ? ` The most you can use is ${amt(floorSig(f.max, 4), f.symbol)}.` : ''}`;
}

/** Paper/Live switch + start button. Live is disabled with the reason when it isn't allowed. */
function StartRow({ s, pairKey, mode, setMode, label, disabled, problem, onStart, busy }: { s: AnyObj; pairKey: string; mode: Mode; setMode: (m: Mode) => void; label: string; disabled: boolean; problem: string | null; onStart: () => void; busy: boolean }) {
  const m = mk(s, pairKey), c = chainOf(s, m.chainId);
  const why = !(c?.hasSigner ?? s.hasSigner) ? 'Live needs a signing key in .env' : !m.liveAllowed ? 'Live blocked: this token failed the safety check' : null;
  useEffect(() => { if (why && mode === 'live') setMode('paper'); }, [why, mode, setMode]);
  return (
    <div className="start-row">
      <div className="seg mode" role="radiogroup" aria-label="Paper or live">
        <button type="button" role="radio" aria-checked={mode === 'paper'} className={mode === 'paper' ? 'on' : ''} onClick={() => setMode('paper')}>Paper</button>
        <button type="button" role="radio" aria-checked={mode === 'live'} className={mode === 'live' ? 'on live' : ''} disabled={!!why} title={why ?? 'Signs and sends real swaps'} onClick={() => setMode('live')}>Live</button>
      </div>
      <button type="button" className={`btn ${mode === 'live' ? 'live' : 'primary'}`} disabled={busy || disabled || !!problem} onClick={onStart}>{label}</button>
      {problem
        ? <span className="small neg">{problem}</span>
        : <span className="muted small">{mode === 'paper' ? 'Paper uses real prices and simulated fills. No funds move.' : why ?? `Trades real funds from ${c?.address ?? s.address ?? 'your wallet'} on ${c?.name ?? 'this chain'}.`}</span>}
    </div>
  );
}

/** "Each completed buy-then-sell nets about +0.083 DAI …" (always in the spend coin). */
function Verdict({ e, quote, fee }: { e: Econ; quote: string; fee: string }) {
  return (
    <div className={`verdict ${e.ok ? 'ok' : 'bad'}`}>
      {e.ok
        ? <span>Each completed buy-then-sell nets about <b>{amt(e.netPerRoundTrip, quote, true)}</b> ({pct(e.netPct, 2)} of a {amt(e.levelSize, quote)} level) after fees, price impact and gas. Levels are {pct(e.spacingPct, 2)} apart.</span>
        : <span><b className="neg">Each completed buy-then-sell {e.netPerRoundTrip < 0 ? `loses about ${amt(-e.netPerRoundTrip, quote)}` : `nets only ${amt(e.netPerRoundTrip, quote)}`} at this size.</b> You can still start it. A bigger amount, fewer levels or a wider range usually fixes this.</span>}
      <span className="detail">{e.ok ? '' : `${e.reasons.join(' ')} · `}Worst level: pool fee {fee} each way ({pct(e.roundTripFeePct, 3)} round trip) · impact {pct(e.impactPct, 3)} · gas {amt(e.gasQuote, quote)}{e.buyTaxPct || e.sellTaxPct ? ` · token tax ${pct(e.buyTaxPct ?? 0, 1)} buy / ${pct(e.sellTaxPct ?? 0, 1)} sell` : ''} · every level trades: the ones below the price wait to buy, the ones above are bought at the start</span>
    </div>
  );
}

/** "Follow the price up" checkbox (auto-recenter), on for every new grid. */
function FollowUp({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check follow">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span><b>Follow the price up</b> <span className="muted">When the price stays above the range for 2 hours with everything sold, move the range up around it (same width and levels; coins for the new levels above the price are bought then). Never moves down.</span></span>
    </label>
  );
}

/** Reinvest (default) or send profits to an address. `to` is checked again on the server. */
export interface ProfitsChoice { mode: 'reinvest' | 'send'; to: string }
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const profitsBody = (p: ProfitsChoice) => (p.mode === 'send' ? { mode: 'send' as const, to: p.to.trim() } : { mode: 'reinvest' as const });

/** What profits mean for each bot type. */
const PROFITS_COPY = {
  grid: { head: 'from each completed buy → sell', reinvest: "Added to that level's next buy, so buys grow as it earns.", send: `Buys stay the same size. Profit is sent once it's worth at least ${PAYOUT_MIN_GAS_MULTIPLE}× the transfer's gas.` },
  lp: { head: 'the trading fees the position earns', reinvest: 'Fees go back into the position each time the range moves (and when you close), so it grows as it earns. No extra transactions.', send: `Fees are collected straight to that address once they're worth at least ${PAYOUT_MIN_GAS_MULTIPLE}× the collect's gas. The position itself stays the same size.` },
} as const;

export function ProfitsField({ p, set, kind = 'grid' }: { p: ProfitsChoice; set: (p: ProfitsChoice) => void; kind?: keyof typeof PROFITS_COPY }) {
  const c = PROFITS_COPY[kind];
  return (
    <div className="profits">
      <span className="profits-head"><b>Profits</b> <span className="muted small">{c.head}</span></span>
      <label className="check"><input type="radio" name="profits" checked={p.mode === 'reinvest'} onChange={() => set({ ...p, mode: 'reinvest' })} />
        <span><b>Reinvest</b> <span className="muted">{c.reinvest}</span></span></label>
      <label className="check"><input type="radio" name="profits" checked={p.mode === 'send'} onChange={() => set({ ...p, mode: 'send' })} />
        <span><b>Send to an address</b> <span className="muted">{c.send}</span></span></label>
      {p.mode === 'send' && (
        <input className="mono" placeholder="0x… address that receives the profit" value={p.to} onChange={(e) => set({ ...p, to: e.target.value.trim() })} spellCheck={false} />
      )}
      {p.mode === 'send' && p.to && !isAddress(p.to) && <span className="small neg">That isn't a 0x… address (42 characters).</span>}
    </div>
  );
}

function GridForm({ s, nav, act, busy, prefill }: Common & { prefill?: GridPrefill }) {
  const { chain } = useChainFilter();
  const [tab, setTab] = useState<'preset' | 'custom'>(prefill ? 'custom' : 'preset');
  const [pair, setPair] = useState(() => prefill?.pair ?? defaultPair(s, chain));
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [count, setCount] = useState(prefill ? String(prefill.gridCount) : '12');
  const [follow, setFollow] = useState(true);
  const [profits, setProfits] = useState<ProfitsChoice>({ mode: 'reinvest', to: '' });
  const [amount, setAmount] = useState('');
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [mode, setMode] = useState<Mode>('paper');
  const [econ, setEcon] = useState<Econ | null>(null);
  const [econErr, setEconErr] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string>(STRATEGY_PRESETS[0].id);
  const [legAmounts, setLegAmounts] = useState<Record<string, string>>({});
  const [legs, setLegs] = useState<Leg[] | null>(null);
  const [legErr, setLegErr] = useState<string | null>(null);

  const m = mk(s, pair);
  const spot = s.spots?.[pair] ?? m.spot ?? null;
  const preset = STRATEGY_PRESETS.find((p) => p.id === presetId)!;
  const presetUsesPair = preset.legs.some((l) => l.quote === null);
  const gas: GasReserveCfg = parseGasRes(limits.gasRes) ?? DEFAULT_GAS_RESERVE;

  // Chain filter change (not the first render: a daily pick may be on another chain): move to a market on that chain.
  const shownChain = useRef(chain);
  useEffect(() => {
    if (shownChain.current === chain) return;
    shownChain.current = chain;
    const ms = marketsOf(s).filter((x) => x.tradable && (chain === 'all' || x.chainId === chain));
    if (ms.length && !ms.some((x) => x.key === unflipKey(pair))) setPair(ms[0].key);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pair change: centre a range on the spot of this orientation (±8%, or the daily pick's width).
  const centre = (band: number) => { if (spot) { setLower(String(+(spot * (1 - band)).toPrecision(5))); setUpper(String(+(spot * (1 + band)).toPrecision(5))); } };
  useEffect(() => { centre(prefill && pair === prefill.pair ? prefill.bandPct : 0.08); }, [pair, spot != null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'custom') return;
    const lo = +lower, hi = +upper, g = +count, a = +amount;
    if (!(lo > 0) || !(hi > lo) || !(g >= 2) || !(a > 0)) { setEcon(null); setEconErr(null); return; }
    const t = setTimeout(() => {
      botApi(`econ?quote=${encodeURIComponent(pair)}&lower=${lo}&upper=${hi}&grids=${g}&capital=${a}`)
        .then((e) => { setEcon(e); setEconErr(null); })
        .catch((e) => { setEcon(null); setEconErr(errMsg(e)); });
    }, 250);
    return () => clearTimeout(t);
  }, [tab, pair, lower, upper, count, amount]);

  const amountsKey = JSON.stringify(Object.fromEntries(Object.entries(legAmounts).filter(([, v]) => +v > 0).map(([k, v]) => [k, +v])));
  useEffect(() => {
    if (tab !== 'preset') return;
    setLegErr(null);
    const t = setTimeout(() => {
      botApi(`presets/${presetId}/preview?quote=${encodeURIComponent(pair)}&amounts=${encodeURIComponent(amountsKey)}`)
        .then((r) => setLegs(r.legs as Leg[]))
        .catch((e) => setLegErr(errMsg(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [tab, presetId, pair, amountsKey]);

  const confirmLive = (what: string) => mode !== 'live' || confirm(`Start a LIVE ${what}? It signs real swaps from ${chainOf(s, m.chainId)?.address ?? s.address}.`);

  const startCustom = () => act(async () => {
    if (!confirmLive(`grid on ${m.label}`)) return;
    const r = await botApi('grids', 'POST', {
      mode, stable: pair, lowerPrice: +lower, upperPrice: +upper, gridCount: +count, totalCapitalUsd: +amount,
      limits: limitsBody(limits, !!m.quoteNative), recenter: follow, profits: profitsBody(profits),
    });
    nav({ v: 'grid', id: r.id });
  });
  const legQuoteNative = !!legs?.some((l) => mk(s, l.quote).quoteNative);
  const startPreset = () => act(async () => {
    if (!confirmLive(`${preset.name} preset`)) return;
    const r = await botApi(`presets/${presetId}/start`, 'POST', {
      mode, quote: pair, amounts: JSON.parse(amountsKey), limits: limitsBody(limits, legQuoteNative), recenter: follow, profits: profitsBody(profits),
    });
    nav(r.ids?.length === 1 ? { v: 'grid', id: r.ids[0] } : { v: 'home' });
  });
  const customize = (l: Leg) => {
    setPair(l.quote); setLower(String(l.lowerPrice)); setUpper(String(l.upperPrice)); setCount(String(l.gridCount)); setAmount(legAmounts[l.quote] ?? ''); setTab('custom');
  };

  const customFunds = spendFunds(s, pair, +amount || 0, gas);
  const legFunds = (legs ?? []).map((l) => ({ l, f: spendFunds(s, l.quote, +(legAmounts[l.quote] ?? 0) || 0, gas) }));
  const problem = tab === 'custom'
    ? fundsProblem(customFunds, +amount || 0, mode)
    : legFunds.map(({ l, f }) => fundsProblem(f, +(legAmounts[l.quote] ?? 0) || 0, mode)).find(Boolean) ?? null;
  const canStart = (profits.mode === 'reinvest' || isAddress(profits.to)) && (tab === 'custom'
    ? +amount > 0 && +lower > 0 && +upper > +lower && +count >= 2
    : !!legs && legs.every((l) => +(legAmounts[l.quote] ?? 0) > 0));
  const startKey = tab === 'preset' && legs?.length ? legs[0].quote : pair;

  return (
    <div className="card">
      <div className="seg" role="tablist" aria-label="Grid setup">
        <button type="button" role="tab" aria-selected={tab === 'preset'} className={tab === 'preset' ? 'on' : ''} onClick={() => setTab('preset')}>Preset</button>
        <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>Custom</button>
      </div>

      {tab === 'preset' ? <>
        <div className="presets">
          {STRATEGY_PRESETS.map((p) => (
            <button key={p.id} type="button" className={`preset ${p.id === presetId ? 'on' : ''}`} onClick={() => { setPresetId(p.id); setLegs(null); setLegAmounts({}); }}>
              <b>{p.name}</b><span>{p.blurb}</span>
            </button>
          ))}
        </div>
        {presetUsesPair && <div className="form-row narrow"><PairPicker s={s} value={pair} onChange={setPair} /></div>}
        {legErr && <div className="banner error">{legErr}</div>}
        {!legs && !legErr && <p className="muted small spin">Checking against live pool prices…</p>}
        {legs && (
          <div className="legs">
            {legFunds.map(({ l, f }) => {
              const lm = mk(s, l.quote);
              return (
                <div key={l.quote} className="leg stack" style={{ gap: 8 }}>
                  <div className="actions">
                    <ChainBadge c={chainOf(s, lm.chainId)} testnet={false} /><b>{l.label ?? lm.label}</b>
                    <span className="muted small">±{(l.bandPct * 100).toFixed(0)}% · {l.gridCount} levels · spends {lm.quote}{l.pool ? ` · ${l.pool.dexName} ${l.pool.feeTier != null ? l.pool.feeTier / 10_000 : l.pool.feeBps / 100}%${l.pool.switchTo ? ' (switches to this best pool)' : ''}` : ''}</span>
                    <span className="grow" />
                    {legs.length === 1 && <button type="button" className="btn ghost small-btn" onClick={() => customize(l)}>Customize</button>}
                  </div>
                  <div className="form-row narrow">
                    <AmountField label={`Amount (${lm.quote})`} value={legAmounts[l.quote] ?? ''} f={f} onChange={(v) => setLegAmounts((x) => ({ ...x, [l.quote]: v }))} />
                  </div>
                  {l.econ ? <Verdict e={l.econ} quote={lm.quote} fee={feeLabel(lm)} /> : <p className="muted small">Enter an amount of {lm.quote} to see what each trade nets.</p>}
                </div>
              );
            })}
          </div>
        )}
      </> : <>
        <div className="form-row">
          <PairPicker s={s} value={pair} onChange={setPair} />
          <label><L tip="Lowest grid level. Below it every level has bought and the grid waits for the price to come back.">Lowest price</L><input value={lower} onChange={(e) => setLower(e.target.value)} /></label>
          <label><L tip="Highest grid level. Above it everything is sold and the grid waits (or moves up, with Follow the price up).">Highest price</L><input value={upper} onChange={(e) => setUpper(e.target.value)} /></label>
          <label><L tip="How many slices the range is cut into. The amount is split evenly over them: more levels means smaller trades, closer together, that happen more often.">Levels</L><input value={count} onChange={(e) => setCount(e.target.value)} /></label>
          <AmountField label={`Amount (${m.quote})`} value={amount} f={customFunds} onChange={setAmount} />
        </div>
        <div className="quick">
          <span className="muted small">Range around {spot ? px(spot) : '—'} {m.quote}/{m.base}:</span>
          {BANDS.map((b) => <button key={b} type="button" className="btn small-btn" disabled={!spot} onClick={() => centre(b)}>±{b * 100}%</button>)}
          <span className="muted small">Levels:</span>
          {LEVELS.map((n) => <button key={n} type="button" className={`btn small-btn ${+count === n ? 'primary' : ''}`} onClick={() => setCount(String(n))}>{n}</button>)}
        </div>
        <p className="small"><Orientation m={m} />{m.quoteNative && +amount > 0 ? <span className="muted"> · plus {amt(customFunds.reserve, m.quote)} kept aside for gas</span> : null}</p>
        {econErr && <div className="banner error">{econErr}</div>}
        {econ ? <Verdict e={econ} quote={m.quote} fee={feeLabel(m)} /> : !(+amount > 0) && <p className="muted small">Enter an amount of {m.quote} to see what each trade nets.</p>}
      </>}

      <FollowUp on={follow} set={setFollow} />
      <ProfitsField p={profits} set={setProfits} />

      <details className="more">
        <summary>Advanced</summary>
        <LimitsFields l={limits} set={setLimits} quoteNative={tab === 'preset' ? legQuoteNative : !!m.quoteNative} quote={mk(s, startKey).quote} />
      </details>

      <StartRow s={s} pairKey={startKey} mode={mode} setMode={setMode} busy={busy} disabled={!canStart} problem={problem}
        label={mode === 'live' ? 'Start live grid' : 'Start paper grid'} onStart={tab === 'custom' ? startCustom : startPreset} />
    </div>
  );
}

function TrendForm({ s, nav, act, busy, prefill }: Common & { prefill?: TrendPrefill }) {
  const { chain } = useChainFilter();
  const [pair, setPair] = useState(() => prefill?.pair ?? defaultPair(s, chain));
  const [tf, setTf] = useState<TF>(prefill?.tf ?? '4h');
  const [amount, setAmount] = useState(prefill?.capital ? String(prefill.capital) : '');
  const [cfg, setCfg] = useState<TrendConfig>(prefill?.cfg ?? { ...DEFAULT_TREND });
  const [name, setName] = useState('');
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [mode, setMode] = useState<Mode>('paper');
  useEffect(() => {
    const ms = marketsOf(s).filter((x) => x.tradable && (chain === 'all' || x.chainId === chain));
    if (ms.length && !ms.some((x) => x.key === unflipKey(pair))) setPair(ms[0].key);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = mk(s, pair);
  const rt = 1 - (1 - m.feeBps / 10_000) ** 2;
  const funds = spendFunds(s, pair, +amount || 0, parseGasRes(limits.gasRes) ?? DEFAULT_GAS_RESERVE);
  const noBuyLine = cfg.strategy === 'lines' && !cfg.lines.some((l) => l.rule.startsWith('buy')) ? 'Draw at least one line that buys.' : null;
  const start = () => act(async () => {
    if (mode === 'live' && !confirm(`Start a LIVE trend bot on ${m.label} (${tf})? It signs real swaps from ${chainOf(s, m.chainId)?.address ?? s.address}.`)) return;
    const r = await botApi('trends', 'POST', { mode, quote: pair, tf, cfg, capital: +amount, name: name || undefined, limits: limitsBody(limits, !!m.quoteNative) });
    nav({ v: 'trend', id: r.id });
  });

  return (
    <div className="card">
      <div className="form-row">
        <PairPicker s={s} value={pair} onChange={setPair} />
        <label>Candle size<select value={tf} onChange={(e) => setTf(e.target.value as TF)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Strategy<select value={cfg.strategy} onChange={(e) => setCfg({ ...cfg, strategy: e.target.value as TrendConfig['strategy'] })}>{STRATEGIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        <AmountField label={`Amount (${m.quote})`} value={amount} f={funds} onChange={setAmount} />
      </div>
      <div className="verdict">
        <span>Buys {m.base} with {m.quote} when {strategyRule(cfg)} on a closed {tf} candle. Sells at the stop-loss ({cfg.stopAtr}× ATR below entry){cfg.tpR > 0 ? `, the take-profit (${cfg.tpR}× the stop distance above)` : ''}{cfg.trailAtr > 0 ? `, the trailing stop` : ''} or {cfg.strategy === 'lines' ? 'one of your sell lines' : 'the exit signal'}.</span>
        <span className="detail">A trade only starts if the expected move beats the {pct(rt, 3)} round-trip pool fee ({feeLabel(m)} each way) plus impact, gas and a {pct(cfg.minEdgePct, 2)} margin. Longer candles mean fewer trades, so fees take a smaller share.</span>
      </div>
      {cfg.strategy === 'lines' && <LinesEditor s={s} pair={pair} tf={tf} lines={cfg.lines} onChange={(lines) => setCfg({ ...cfg, lines })} />}
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
      <StartRow s={s} pairKey={pair} mode={mode} setMode={setMode} busy={busy} disabled={!(+amount > 0) || !!noBuyLine} problem={noBuyLine ?? fundsProblem(funds, +amount || 0, mode)}
        label={mode === 'live' ? 'Start live trend bot' : 'Start paper trend bot'} onStart={start} />
    </div>
  );
}

const LP_BANDS = [0.02, 0.05, 0.08, 0.12, 0.2];

/** What the bot swaps before opening ±band around `spot` with `quote` + `base` coins: buy base with quote, or sell base. */
function swapPlan(spot: number, band: number, quote: number, base: number): { share: number; side: 'buy' | 'sell' | null; amount: number } {
  const share = rangeBaseShare(spot, spot * (1 - band), spot * (1 + band));
  const value = quote + base * spot, gap = share * value - base * spot;
  if (Math.abs(gap) <= value * LP_MIN_SWAP_SHARE) return { share, side: null, amount: 0 };
  return gap > 0 ? { share, side: 'buy', amount: gap } : { share, side: 'sell', amount: -gap / spot };
}
/** "Move the range" checkbox for a liquidity bot (re-range both ways), on by default. */
function Rerange({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check follow">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span><b>Move the range with the price</b> <span className="muted">When the price leaves the range (up or down), take the position out and open the same width around the price as soon as the fees it's missing pass what the move costs (gas plus the swap back to the range's mix). A quick dip back into the range doesn't start the count over. At most {LP_MAX_MOVES_PER_DAY} moves in any 24 hours. Each move locks in the coin mix it had.</span></span>
    </label>
  );
}

function LpForm({ s, nav, act, busy, prefill }: Common & { prefill?: LpPrefill }) {
  const { chain } = useChainFilter();
  const lpMarkets = (c: number | 'all') => marketsOf(s).filter((x) => x.tradable && x.lpOk && (c === 'all' || x.chainId === c));
  const [pair, setPair] = useState(() => prefill?.pair ?? lpMarkets(chain)[0]?.key ?? '');
  const [band, setBand] = useState(String((prefill?.bandPct ?? 0.08) * 100));
  const [amount, setAmount] = useState('');
  const [baseAmt, setBaseAmt] = useState('');
  const [rerange, setRerange] = useState(true);
  const [profits, setProfits] = useState<ProfitsChoice>({ mode: 'reinvest', to: '' });
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [mode, setMode] = useState<Mode>('paper');
  const shownChain = useRef(chain);
  useEffect(() => {
    if (shownChain.current === chain) return;
    shownChain.current = chain;
    const ms = lpMarkets(chain);
    if (ms.length && !ms.some((x) => x.key === unflipKey(pair))) setPair(ms[0].key);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pair) return <div className="card"><p className="muted">No pair here can hold a liquidity position. It needs a V3 pool (Uniswap V3 on Ethereum or Robinhood, 9mm V3 on PulseChain). Pick another chain, or add a pair with a V3 pool under Tools → Markets.</p></div>;

  const m = mk(s, pair);
  const spot = s.spots?.[pair] ?? m.spot ?? null;
  const b = +band / 100;
  const bandOk = b >= LP_BAND.min && b <= LP_BAND.max;
  const gasCfg = parseGasRes(limits.gasRes) ?? DEFAULT_GAS_RESERVE;
  const q = +amount || 0, a = +baseAmt || 0;
  const funds = spendFunds(s, pair, q, gasCfg), baseFunds = coinFunds(s, pair, 'base', a, gasCfg);
  const plan = spot && bandOk && q + a > 0 ? swapPlan(spot, b, q, a) : null;
  const start = () => act(async () => {
    if (mode === 'live' && !confirm(`Start a LIVE liquidity position on ${m.label}? It signs real transactions from ${chainOf(s, m.chainId)?.address ?? s.address}.`)) return;
    const r = await botApi('lps', 'POST', {
      mode, market: pair, bandPct: b, capital: q, baseAmount: a, rerange, profits: profitsBody(profits), limits: limitsBody(limits, !!m.quoteNative),
    });
    nav({ v: 'lp', id: r.id });
  });

  return (
    <div className="card">
      <div className="form-row">
        <PairPicker s={s} value={pair} onChange={setPair} only={(x) => !!x.lpOk} />
        <label><L tip="How far the range reaches each side of today's price. Narrower earns more fees per coin while the price is inside, and leaves the range sooner.">Range ± %</L><input value={band} inputMode="decimal" onChange={(e) => setBand(e.target.value.replace(/[%\s]/g, ''))} /></label>
        <AmountField label={`Amount (${m.quote})`} value={amount} f={funds} onChange={setAmount} />
        <AmountField label={`Also use ${m.base} you hold (optional)`} value={baseAmt} f={baseFunds} onChange={setBaseAmt} />
      </div>
      <div className="quick">
        <span className="muted small">Range around {spot ? px(spot) : '—'} {m.quote}/{m.base}:</span>
        {LP_BANDS.map((x) => <button key={x} type="button" className={`btn small-btn ${Math.abs(b - x) < 1e-9 ? 'primary' : ''}`} onClick={() => setBand(String(x * 100))}>±{x * 100}%</button>)}
      </div>
      {!bandOk && <p className="small neg">The range must be between ±{LP_BAND.min * 100}% and ±{LP_BAND.max * 100}%.</p>}
      <div className="verdict ok">
        <span>Puts your coins into the {m.dexName ?? m.dex} {feeLabel(m)} pool between <b>{spot && bandOk ? px(spot * (1 - b)) : '—'}</b> and <b>{spot && bandOk ? px(spot * (1 + b)) : '—'}</b> {m.quote}/{m.base}. {plan
          ? plan.side == null ? <>Your {m.base} and {m.quote} already match the range's mix, so <b>nothing is swapped</b>.</>
            : <>The range needs about {pct(plan.share, 0)} of the value in {m.base}, so it first swaps about <b>{plan.side === 'buy' ? `${humanAmount(plan.amount)} ${m.quote} → ${m.base}` : `${humanAmount(plan.amount)} ${m.base} → ${m.quote}`}</b>{a > 0 ? '' : `. Add ${m.base} you already hold above to swap less`}.</>
          : <>The range needs both coins: what's missing is swapped first. {m.base} you already hold can go in too, so less is swapped.</>}</span>
        <span className="detail">It earns its share of the {feeLabel(m)} fee on every trade while the price is inside the range. Like a grid, it ends up holding more of whichever coin fell. Outside the range it earns nothing until the price comes back or the range moves. Gas: opening is a swap plus about 480k; moving the range is a take-out (about 250k), a swap and a new open; closing is about 250k.</span>
      </div>
      <Rerange on={rerange} set={setRerange} />
      <ProfitsField p={profits} set={setProfits} kind="lp" />
      <details className="more">
        <summary>Advanced</summary>
        <LimitsFields l={limits} set={setLimits} quoteNative={!!m.quoteNative} quote={m.quote} />
      </details>
      <StartRow s={s} pairKey={pair} mode={mode} setMode={setMode} busy={busy} disabled={!(q + a > 0) || q < 0 || a < 0 || !bandOk || !(profits.mode === 'reinvest' || isAddress(profits.to))}
        problem={fundsProblem(funds, q, mode) ?? fundsProblem(baseFunds, a, mode)} label={mode === 'live' ? 'Open live position' : 'Open paper position'} onStart={start} />
    </div>
  );
}

export function NewBot({ s, kind, trendPrefill, gridPrefill, lpPrefill, nav, act, busy }: Common & { kind: BotKind; trendPrefill?: TrendPrefill; gridPrefill?: GridPrefill; lpPrefill?: LpPrefill }) {
  const pick = useMemo(() => [
    ['grid', 'Grid bot', 'Buys a little on each dip and sells it one level higher. Earns when the price swings sideways inside a range.'],
    ['trend', 'Trend bot', 'Buys when a trend starts and sells on a stop, take-profit or exit signal. Earns when the price moves in one direction.'],
    ['lp', 'Liquidity', 'Puts both coins in a V3 pool around the price and earns a share of every trade\'s fee. Earns when lots of trading happens inside the range.'],
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
      {kind === 'grid' && <GridForm key={gridPrefill?.nonce ?? 0} s={s} nav={nav} act={act} busy={busy} prefill={gridPrefill} />}
      {kind === 'trend' && <TrendForm key={trendPrefill?.nonce ?? 0} s={s} nav={nav} act={act} busy={busy} prefill={trendPrefill} />}
      {kind === 'lp' && <LpForm key={lpPrefill?.nonce ?? 0} s={s} nav={nav} act={act} busy={busy} prefill={lpPrefill} />}
    </main>
  );
}
