/**
 * Opportunities: the busy pools on the chains, each with one number, what it is expected to earn next week, best first
 * (server: market/scanner.ts; the estimate is market/scan.ts bestWay, fitted on the walk-forward in the README). Each
 * row says how to use the pool (grid or liquidity) and opens New bot with that setting; details are one tap away.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { ago, num, pct } from './fmt';
import { ChainBadge, DexTag, chainOf, useChainFilter } from './chains';
import { errMsg, type AnyObj, type Nav } from './model';
import { L, Tip } from './Tip';
import { bestWay, expectedGrid, expectedLp, type Opportunity } from '../market/scan';

type Way = 'best' | 'grid' | 'lp';
interface Filters { way: Way; safeOnly: boolean; q: string }
const DEFAULTS: Filters = { way: 'best', safeOnly: true, q: '' };
const PAGE = 25;
/** A weekly price move this big is flagged on the row: it can outweigh what the bot earns */
const BIG_MOVE = 0.2;

function loadFilters(): Filters {
  try {
    const f = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('opps2') ?? '{}') as Partial<Filters>), q: '' };
    return { ...f, way: (['best', 'grid', 'lp'] as const).includes(f.way) ? f.way : 'best', safeOnly: f.safeOnly !== false };
  } catch { return DEFAULTS; }
}
function saveFilters(f: Filters) {
  try { localStorage.setItem('opps2', JSON.stringify({ ...f, q: '' })); } catch { /* storage unavailable */ }
}

const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`);
const dollars = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x) >= 100 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(2)}`;

/** Built-in markets carry no report (null): they were checked when they were added to the app. */
export const isSafe = (o: Opportunity) => o.liveAllowed && (o.risk == null || o.risk === 'low');

/** The way a row shows a pool, and its estimate: the better one, or the strategy picked. */
export function wayOf(o: Opportunity, way: Way): { how: 'grid' | 'lp'; expected: number } | null {
  if (way === 'best') return bestWay(o);
  const e = way === 'grid' ? expectedGrid(o) : expectedLp(o);
  return e == null ? null : { how: way, expected: e };
}

/** "Checking Robinhood Chain (2 of 3): pools 5 of 51" */
export function scanStep(g: AnyObj | null): string {
  if (!g) return 'Checking pools…';
  return `Checking ${g.chain} (${g.chainNo} of ${g.chains}): ${g.phase === 'finding pools' ? 'finding the busiest pools' : g.phase === 'checking new tokens' ? `safety check ${g.done + 1} of ${g.total}` : `pool ${g.done + 1} of ${g.total}`}…`;
}

/** The scan's answer, re-asked every 4 s while a scan runs (pools appear as they are checked). */
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

/** Opens New bot with the pool and its setting; a token not in the app yet is added first (safety re-checked). */
export function tryIt(o: Opportunity, how: 'grid' | 'lp', nav: Nav, act: (fn: () => Promise<unknown>) => void) {
  act(async () => {
    const key: string = o.key ?? (await http<{ key: string }>('/api/opportunities/use', 'POST', { chainId: o.chainId, ...o.ref })).key;
    if (how === 'grid') nav({ v: 'new', kind: 'grid', gridPrefill: { pair: key, bandPct: o.grid!.bandPct, gridCount: o.grid!.gridCount, nonce: Date.now() } });
    else nav({ v: 'new', kind: 'lp', lpPrefill: { pair: key, bandPct: o.lp!.bandPct, nonce: Date.now() } });
  });
}

/** Only shown when a pool isn't plainly safe; tap the ⓘ for why. */
export function RiskTag({ o }: { o: Opportunity }) {
  if (!o.liveAllowed) return <span className="tag risk-bad" title={o.riskWhy ?? ''}>paper only</span>;
  if (o.risk && o.risk !== 'low') return <span className="risk-wrap"><span className="tag risk-mid">risk {o.risk}</span>{o.riskWhy && <Tip label="Why this risk?">{o.riskWhy}</Tip>}</span>;
  return null;
}

/** One sentence on how the pool would be used. */
const howLine = (o: Opportunity, how: 'grid' | 'lp') => (how === 'grid'
  ? `Grid ±${num(o.grid!.bandPct * 100, 0)}% with ${o.grid!.gridCount} levels · the price swings about ${pct(o.swingPct, 0)} a day`
  : `Liquidity ±${num(o.lp!.bandPct * 100, 0)}% · in range ${pct(o.lp!.inRangePct, 0)} of last week`);

function Row({ s, o, w, rank, nav, act, busy }: { s: AnyObj; o: Opportunity; w: { how: 'grid' | 'lp'; expected: number }; rank: number; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const last = w.how === 'grid' ? o.grid!.earnedPct : o.lp!.earnedPct;
  const dexName = chainOf(s, o.chainId)?.dexes?.find((d: AnyObj) => d.id === o.dex)?.name ?? o.dex;
  return (
    <article className="opp2" style={{ animationDelay: `${Math.min(rank, 12) * 30}ms` }}>
      <button type="button" className="opp2-main" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="opp-rank">{rank}</span>
        <span className="opp2-name">
          <span className="opp2-title"><ChainBadge c={chainOf(s, o.chainId)} testnet={false} /><b>{o.label}</b><span className={`tag ${w.how === 'lp' ? 'way-lp' : 'way-grid'}`}>{w.how === 'lp' ? 'Liquidity' : 'Grid'}</span><RiskTag o={o} />{Math.abs(o.movePct) >= BIG_MOVE && <span className="tag risk-mid" title="The estimate counts what the bot earns, not the coin's own price. A coin that moved this much can lose (or gain) more than the bot earns.">price {pct(o.movePct, 0, true)} this week</span>}</span>
          <span className="small muted">{howLine(o, w.how)}</span>
        </span>
        <span className="opp2-num"><b className="pos">≈ {pct(w.expected, 1, true)}</b><span className="small muted">a week · {dollars(w.expected * o.usd)} on {money(o.usd)}</span></span>
      </button>
      <button type="button" className="btn small-btn primary opp2-try" disabled={busy} onClick={() => tryIt(o, w.how, nav, act)}>Try</button>
      {open && (
        <div className="opp2-more small">
          <span>Last week it would have earned <b>{pct(last, 2, true)}</b> ({dollars(last * o.usd)})</span>
          {o.activity && <span>{money(o.activity.liquidityUsd)} in the pool · {money(o.activity.volume24Usd)} traded today</span>}
          <span>Price {pct(o.movePct, 1, true)} this week (not counted: that isn't the bot's doing)</span>
          <span className="inline"><DexTag name={dexName} feeBps={o.feeBps} />{o.key == null && <span className="mono muted" title="A coin not in the app yet: two coins can share a name, this is the one at this address">{o.ref.address.slice(0, 6)}…{o.ref.address.slice(-4)}</span>}</span>
          {!o.liveAllowed && o.riskWhy && <span className="neg">Failed the safety check: {o.riskWhy}</span>}
        </div>
      )}
    </article>
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
      .filter((o) => (!f.safeOnly || isSafe(o)) && (!q || o.label.toLowerCase().includes(q)))
      .flatMap((o) => { const w = wayOf(o, f.way); return w ? [{ o, w }] : []; })
      .sort((a, b) => b.w.expected - a.w.expected);
  }, [all, f]);

  if (err) return <main className="stack"><div className="banner error"><span className="grow">Opportunities: {err}</span></div></main>;
  if (!p) return <main className="stack"><p className="muted">Loading…</p></main>;
  const testUsd = usd ?? String(p.testUsd);
  const scan = () => act(async () => { await http('/api/opportunities/scan', 'POST', { testUsd: Number(testUsd) }); setP({ ...p, running: true }); });
  const errors = ((p.chains ?? []) as AnyObj[]).filter((c) => (chain === 'all' || c.chainId === chain) && c.error);

  return (
    <main className="stack opps">
      <section className="card opp-head">
        <div className="card-head">
          <h2>Opportunities</h2>
          <span className="muted small">{p.running ? scanStep(p.progress) : p.at ? `updated ${ago(p.at)}` : 'not checked yet'}</span>
        </div>
        <p className="small">
          <L tip="From the last 7 days of each pool's real trades. A grid's estimate comes from how much its price swings; a liquidity range's from what it earned after costs last week, scaled to what usually repeats. Checked on 92 real pools over 4 weeks (October 2026): the top tenth was expected to earn 7.2% (grid) and 14.1% (liquidity) and earned 7.4% and 12.5%. Single pools vary a lot: start in paper.">What each pool is likely to earn in the next week</L>, best first, with {money(p.testUsd)} put in.
        </p>
        <div className="opp-filters">
          <div className="seg" role="radiogroup" aria-label="Strategy">
            {([['best', 'Best way'], ['grid', 'Grid'], ['lp', 'Liquidity']] as const).map(([v, t]) => (
              <button key={v} type="button" role="radio" aria-checked={f.way === v} className={f.way === v ? 'on' : ''} onClick={() => set({ way: v })}>{t}</button>
            ))}
          </div>
          <label className="check-pill"><input type="checkbox" checked={f.safeOnly} onChange={(e) => set({ safeOnly: e.target.checked })} /> Safe only</label>
          <input className="opp-q" value={f.q} placeholder="Find a coin" aria-label="Find a coin" onChange={(e) => set({ q: e.target.value })} />
        </div>
      </section>

      {errors.map((c) => <div key={c.chainId} className="banner error"><span className="grow">{c.name}: {c.error}</span></div>)}
      {p.running && !list.length && <p className="small muted">Checking the busiest pools on each chain. GeckoTerminal allows only a few requests a minute, so a full check takes up to an hour; pools appear here as they're checked.</p>}
      <div className="opp-list">
        {list.slice(0, shown).map(({ o, w }, i) => <Row key={`${o.chainId}-${o.key ?? o.ref.pool}-${w.how}`} s={s} o={o} w={w} rank={i + 1} nav={nav} act={act} busy={busy} />)}
      </div>
      {list.length > shown && <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more</button>}
      {!p.running && p.at && !list.length && <p className="small muted">No pool matches. {f.safeOnly ? 'Turn off Safe only to see riskier ones.' : ''}</p>}
      {!p.at && !p.running && <p className="small muted">{s.copy ? `Nothing checked yet. ${s.copy.host}'s app runs the first check soon.` : 'Nothing checked yet. The first check starts on its own when the app starts.'}</p>}

      {!s.copy && (
        <details className="more">
          <summary>Check again</summary>
          <div className="actions">
            <label className="small muted test-usd"><L tip="Every pool is tested with this much, in dollars. Use what you plan to put in: price impact and your share of a pool depend on it.">Test with $</L><input value={testUsd} inputMode="decimal" onChange={(e) => setUsd(e.target.value.replace(/[$,\s]/g, ''))} /></label>
            <button type="button" className="btn small-btn" disabled={busy || p.running} onClick={scan}>{p.running ? 'Checking…' : 'Check now'}</button>
            <span className="small muted">It runs by itself once a day.</span>
          </div>
        </details>
      )}
    </main>
  );
}
