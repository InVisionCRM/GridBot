/**
 * Opportunities: every busy pool on the chains, replayed over the last 7 days as a grid and as a liquidity position
 * (server: market/scanner.ts). Grids are ranked by how much the price swings, liquidity by what it earned after costs
 * (gridRank / lpRank, from the walk-forward in the README). The coin's own price move is shown apart and never ranks
 * a pool. Filters: strategy, safety, pool size, a coin; the chain comes from the top bar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { ago, cls, num, pct, qty, time } from './fmt';
import { ChainBadge, DexTag, chainOf, useChainFilter } from './chains';
import { errMsg, type AnyObj, type Nav } from './model';
import { L, Tip } from './Tip';
import { Usd } from './money';
import { gridRank, lpRank, type Opportunity } from '../market/scan';

type Strategy = 'grid' | 'lp';
type Safety = 'safe' | 'medium' | 'all';
interface Filters { strategy: Strategy; safety: Safety; minLiq: number; q: string }
const DEFAULTS: Filters = { strategy: 'grid', safety: 'all', minLiq: 0, q: '' };
const PAGE = 25;
/** A weekly price move this big is coloured on the card: a grid on a coin that fell this far is holding a lot of it */
const BIG_MOVE = 0.2;
const LIQ = [[0, 'Any size'], [10_000, '$10K+'], [50_000, '$50K+'], [250_000, '$250K+'], [1_000_000, '$1M+']] as const;

function loadFilters(): Filters {
  try {
    const f = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('opps') ?? '{}') as Partial<Filters>), q: '' };
    return { ...f, strategy: f.strategy === 'lp' ? 'lp' : 'grid' };
  } catch { return DEFAULTS; }
}
function saveFilters(f: Filters) {
  try { localStorage.setItem('opps', JSON.stringify({ ...f, q: '' })); } catch { /* storage unavailable */ }
}

const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`);

/** Built-in markets carry no report (null): they were checked when they were added to the app. */
const isSafe = (o: Opportunity) => o.liveAllowed && (o.risk == null || o.risk === 'low');
const upToMedium = (o: Opportunity) => o.liveAllowed && (o.risk == null || o.risk === 'low' || o.risk === 'medium');

/** Where a pool ranks for a strategy; null = it isn't in that list (no grid earned, or no liquidity test). */
const rankOf = (o: Opportunity, s: Strategy): number | null => (s === 'grid' ? gridRank(o) : lpRank(o));

/** "Scanning Robinhood Chain (2 of 3): testing pairs 5 of 11…" */
export function scanStep(g: AnyObj | null): string {
  if (!g) return 'Scanning…';
  return `Scanning ${g.chain} (${g.chainNo} of ${g.chains}): ${g.phase}${g.phase === 'finding pools' ? '' : ` ${g.done + 1} of ${g.total}`}…`;
}

/** The scan's answer, re-asked every 4 s while a scan runs. */
export function useOpportunities() {
  const [p, setP] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => http('/api/opportunities').then((x) => { setP(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!p?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [p?.running, load]);
  return { p, setP, err };
}

/** Opens New bot with the pool and the setting that earned; a token not in the app yet is added first (safety re-checked). */
export function tryIt(o: Opportunity, how: 'grid' | 'lp', nav: Nav, act: (fn: () => Promise<unknown>) => void) {
  act(async () => {
    const key: string = o.key ?? (await http<{ key: string }>('/api/opportunities/use', 'POST', { chainId: o.chainId, ...o.add })).key;
    if (how === 'grid') nav({ v: 'new', kind: 'grid', gridPrefill: { pair: key, bandPct: o.grid!.bandPct, gridCount: o.grid!.gridCount, nonce: Date.now() } });
    else nav({ v: 'new', kind: 'lp', lpPrefill: { pair: key, bandPct: o.lp!.bandPct, nonce: Date.now() } });
  });
}

/** The safety check's verdict; tap the ⓘ for why (a token that failed says why on the card itself). */
export function RiskTag({ o }: { o: Opportunity }) {
  if (!o.liveAllowed) return <span className="tag risk-bad">paper only</span>;
  if (o.risk && o.risk !== 'low') return <span className="risk-wrap"><span className="tag risk-mid">risk {o.risk}</span>{o.riskWhy && <Tip label="Why this risk?">{o.riskWhy}</Tip>}</span>;
  return <span className="tag risk-ok" title={o.riskWhy ?? 'A market already in the app'}>safe</span>;
}

function OppCard({ s, o, rank, strategy, nav, act, busy }: { s: AnyObj; o: Opportunity; rank: number; strategy: Strategy; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const earned = strategy === 'grid' ? o.grid!.earnedPct : o.lp!.earnedPct;
  const k = o.usd / o.capital; // dollars per spend coin when scanned
  const dexName = chainOf(s, o.chainId)?.dexes?.find((d: AnyObj) => d.id === o.dex)?.name ?? o.dex;
  const g = o.grid, l = o.lp;
  return (
    <article className="opp" style={{ animationDelay: `${Math.min(rank, 12) * 40}ms` }}>
      <span className="opp-rank">{rank}</span>
      <div className="opp-main">
        <div className="opp-name">
          <ChainBadge c={chainOf(s, o.chainId)} testnet={false} />
          <b>{o.label}</b>
          {o.add && <span className="tag mono" title={`A coin not in the app yet: ${o.add.address}. Two coins can share a name; this is the one at this address.`}>{o.add.address.slice(0, 6)}…{o.add.address.slice(-4)}</span>}
          <DexTag name={dexName} feeBps={o.feeBps} />
          <RiskTag o={o} />
        </div>
        {!o.liveAllowed && o.riskWhy && <p className="small neg">Failed the safety check: {o.riskWhy}</p>}
        <div className="opp-ways">
          {strategy === 'grid'
            ? <span><b>Swings {pct(o.swingPct, 0)} a day</b> · grid ±{num(g!.bandPct * 100, 0)}%, {g!.gridCount} levels · {g!.roundTrips} trades last week</span>
            : <span><b>±{num(l!.bandPct * 100, 0)}% range</b> · in range {pct(l!.inRangePct, 0)} of the time · {pct(l!.poolSharePct, l!.poolSharePct < 0.001 ? 3 : 2)} of the pool · fees {pct(l!.feesPct, 2, true)}</span>}
        </div>
        <div className="small muted">
          {o.activity ? `${money(o.activity.liquidityUsd)} in the pool · ${money(o.activity.volume24Usd)} traded today · ` : ''}
          <span className={Math.abs(o.movePct) >= BIG_MOVE ? cls(o.movePct) : ''} title={o.movePct <= -BIG_MOVE ? 'A big drop: a grid buys on the way down and holds what it bought until the price comes back.' : undefined}>price {pct(o.movePct, 1, true)} this week</span> (not counted)
        </div>
      </div>
      <div className="opp-earn">
        <b className={cls(earned)}>{qty(earned * o.capital, o.spend, 4)}</b>
        <span className="small">{pct(earned, 2, true)} earned last week<Usd v={earned * o.capital} k={k} /></span>
      </div>
      <div className="opp-act">
        <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => tryIt(o, strategy, nav, act)}>{strategy === 'grid' ? 'Try grid' : 'Try liquidity'}</button>
      </div>
    </article>
  );
}

function Seg<T extends string | number>({ label, tip, value, set, opts }: { label: string; tip: string; value: T; set: (v: T) => void; opts: readonly (readonly [T, string])[] }) {
  return (
    <div className="seg-field">
      <span className="k"><L tip={tip}>{label}</L></span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {opts.map(([v, t]) => <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => set(v)}>{t}</button>)}
      </div>
    </div>
  );
}

export function Opportunities({ s, nav, act, busy }: { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const { chain } = useChainFilter();
  const { p, setP, err } = useOpportunities();
  const [f, setF] = useState<Filters>(loadFilters);
  const set = (x: Partial<Filters>) => { const n = { ...f, ...x }; setF(n); saveFilters(n); setShown(PAGE); };
  const [shown, setShown] = useState(PAGE);
  const [usd, setUsd] = useState<string | null>(null);

  const all = useMemo(() => ((p?.chains ?? []) as AnyObj[]).filter((c) => chain === 'all' || c.chainId === chain).flatMap((c) => c.items as Opportunity[]), [p, chain]);
  const list = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return all
      .filter((o) => rankOf(o, f.strategy) != null)
      .filter((o) => (f.safety === 'safe' ? isSafe(o) : f.safety === 'medium' ? upToMedium(o) : true))
      .filter((o) => f.minLiq === 0 || (o.activity?.liquidityUsd ?? 0) >= f.minLiq)
      .filter((o) => !q || o.label.toLowerCase().includes(q))
      .sort((a, b) => rankOf(b, f.strategy)! - rankOf(a, f.strategy)!);
  }, [all, f]);

  if (err) return <main className="stack"><div className="banner error"><span className="grow">Opportunities: {err}</span></div></main>;
  if (!p) return <main className="stack"><p className="muted">Loading opportunities…</p></main>;
  const testUsd = usd ?? String(p.testUsd);
  const scan = () => act(async () => { await http('/api/opportunities/scan', 'POST', { testUsd: Number(testUsd) }); setP({ ...p, running: true }); });
  const chainsShown: AnyObj[] = (p.chains ?? []).filter((c: AnyObj) => chain === 'all' || c.chainId === chain);
  const nothing = all.filter((o) => rankOf(o, f.strategy) == null).length;

  return (
    <main className="stack opps">
      <section className="card opp-head">
        <div className="card-head">
          <h2>Opportunities</h2>
          <span className="muted small">{p.running ? scanStep(p.progress) : p.at ? `scanned ${ago(p.at)} · next ${time(p.nextAt)}` : 'not scanned yet'}</span>
          <span className="grow" />
          {s.copy
            ? <span className="small muted">{s.copy.host}'s app scans once a day for everyone.</span>
            : <>
              <label className="small muted test-usd"><L tip="Every pool is tested with this much, in dollars. Use what you plan to put in: price impact and your share of a pool depend on it.">Test with $</L><input value={testUsd} inputMode="decimal" onChange={(e) => setUsd(e.target.value.replace(/[$,\s]/g, ''))} /></label>
              <button type="button" className="btn small-btn" disabled={busy || p.running} onClick={scan}>{p.running ? 'Scanning…' : 'Scan now'}</button>
            </>}
        </div>
        <p className="small muted">
          The busiest pools on each chain, replayed over the last 7 days of real prices as a grid and as a liquidity position, with each pool's fee, price impact and gas, at ${p.testUsd.toLocaleString('en-US')}.
          {f.strategy === 'grid'
            ? <> Grids are ranked by <L tip="The hourly high-low ranges added up, per day. Tested on 90 real pools over 4 weeks (October 2026): how much a pool swung predicted next week's grid earnings better than last week's own grid result, and far better than its price change, which predicted nothing.">how much the price swings</L> back and forth, among pools where a grid earned from its trades at this size.</>
            : <> Liquidity is ranked by <L tip="Fees minus the opening swap and gas. Tested on 48 real V3 pools over 4 weeks (October 2026): last week's figure predicted the next week's closely (rank correlation 0.85); the top tenth earned 13% the next week on average, every one of them positive.">what it earned after costs</L> last week.</>}
          {' '}The coin's own price move is left out. A good week doesn't promise the next, so start in paper.
        </p>
        <div className="opp-filters">
          <Seg label="Strategy" tip="Grid: buys low and sells high between levels; works on any pool. Liquidity: earns a share of the pool's fees; needs a V3 pool." value={f.strategy} set={(v) => set({ strategy: v })}
            opts={[['grid', 'Grid'], ['lp', 'Liquidity']] as const} />
          <Seg label="Safety" tip="Safe: passed the honeypot and tax check with low risk. Up to medium adds tokens with some risk (a tax, a proxy contract). All also shows tokens that failed: those are paper only." value={f.safety} set={(v) => set({ safety: v })}
            opts={[['safe', 'Safe'], ['medium', 'Up to medium'], ['all', 'All']] as const} />
          <Seg label="Pool size" tip="Liquidity in the pool, in dollars. Bigger pools move less when you trade and are harder to fake." value={f.minLiq} set={(v) => set({ minLiq: v })} opts={LIQ} />
          <label className="opp-search"><span className="k">Coin</span><input value={f.q} placeholder="HEX, ETH…" onChange={(e) => set({ q: e.target.value })} /></label>
        </div>
      </section>

      {chainsShown.some((c) => c.error) && chainsShown.filter((c) => c.error).map((c) => <div key={c.chainId} className="banner error"><span className="grow">{c.name}: {c.error}</span></div>)}
      <p className="small muted opp-count">
        {list.length ? `${Math.min(shown, list.length)} of ${list.length} pools` : 'No pool matches these filters.'}
        {nothing > 0 ? ` · ${nothing} more with no ${f.strategy === 'grid' ? 'grid that earned' : 'liquidity result'} this week` : ''}
      </p>
      <div className="opp-list">
        {list.slice(0, shown).map((o, i) => <OppCard key={`${o.chainId}-${o.add?.pool ?? o.key}`} s={s} o={o} rank={i + 1} strategy={f.strategy} nav={nav} act={act} busy={busy} />)}
      </div>
      {list.length > shown && <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more</button>}
      {!p.at && !p.running && <p className="small muted">{s.copy ? `No scan yet. ${s.copy.host}'s app runs the first one soon.` : 'No scan yet. Press Scan now: it takes a while (GeckoTerminal allows a few requests a minute).'}</p>}

      {chainsShown.filter((c) => c.skipped.length).map((c) => (
        <details key={c.chainId} className="more">
          <summary>{c.name}: pools left out ({c.skipped.length})</summary>
          <ul className="skip-list">{c.skipped.map((x: AnyObj, i: number) => <li key={i}><b>{x.name}</b> {x.why}</li>)}</ul>
        </details>
      ))}
    </main>
  );
}
