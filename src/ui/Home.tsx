/** Home: net worth, the book chart, a joined strip, the bots, then the two cards that used to live only under More. */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { BotRow, listBots, startOfDay, todaySeries, useRowActions } from './botRow';
import { AreaChart, Donut, Meter, Sparkline } from './charts';
import { chainOf, chains, useChainFilter } from './chains';
import { cls, pct } from './fmt';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import { formatTokens, generatedOf, generatedPct, generatedValueInQuote, sharedTotals, sumTokens, type TokenQty } from './generatedView';
import { quoteSym } from './model';
import type { Opportunity } from '../market/scan';
import { isSafe, tryIt, useOpportunities, wayOf } from './Opportunities';
import { bookUsd, equitySpan, feeSeries, portfolioSeries, type DeskRange } from './series';
import type { AnyObj, Nav } from './model';
import { SafetyChecking } from './SafetyChecking';

const RANGES: DeskRange[] = ['1H', '1D', '1W', '1M', 'ALL'];

function useJson(path: string) {
  const [data, setData] = useState<AnyObj | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http<AnyObj>(path).then((d) => { if (!dead) setData(d); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => { dead = true; clearInterval(t); };
  }, [path]);
  return data;
}

/** What the bots hold now, one figure per coin they count in (value in the bot's quote coin; no dollars). */
function botValues(bots: AnyObj[]): TokenQty[] {
  return sumTokens(bots.map((b) => {
    const k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
    const v = bookUsd(b);
    return v == null || k == null ? null : [{ symbol: String(quoteSym(b) ?? ''), amount: v / k }];
  }));
}

/** Pool fees paid on fills since local midnight, per quote coin (no dollars). */
function feesToday(bots: AnyObj[]): TokenQty[] {
  const from = startOfDay();
  return sumTokens(bots.map((b) => {
    let sum = 0;
    for (const tr of (b.trades ?? []) as AnyObj[]) if (!tr.failed && tr.timestamp >= from && typeof tr.feeQuote === 'number') sum += tr.feeQuote;
    return sum ? [{ symbol: String(quoteSym(b) ?? ''), amount: sum }] : null;
  }));
}

export function Home({ s, nav, holdings, act }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null; act: (fn: () => Promise<unknown>) => void }) {
  const { chain } = useChainFilter();
  const { err, pause, close, checking } = useRowActions();
  const [range, setRange] = useState<DeskRange>('1D');
  const bots = listBots(s, chain).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  // Crypto units only on Home (Kyle): what the bots hold, per coin. The wallet's net worth is on Holdings.
  const held = useMemo(() => botValues(bots), [bots]);
  const series = useMemo(() => {
    const hist = portfolioSeries(bots, range);
    if (hist.length > 2 && hist.some((p) => p !== hist[0])) return hist;
    if (range === '1H' || range === '1D') {
      const day = todaySeries(bots, holdings?.hasSigner === false);
      if (day.length > 1 && day.some((p) => p !== 0)) return day;
    }
    return hist;
  }, [bots, range, holdings?.hasSigner]);
  const span = equitySpan(bots);
  const month = useMemo(() => portfolioSeries(bots, '1M'), [bots]);
  // Generated, net of costs, per coin (generated.ts); token traders have no such figure yet
  const gens = bots.map((b) => generatedOf(b));
  // coins two or more bots count in; one bot's own coin is on its row below
  const generated = sharedTotals(gens.map((g) => g?.tokens));
  const genSign = generated.length === 1 ? generated[0].amount : null;
  const fees = feesToday(bots);
  const feesLine = useMemo(() => feeSeries(bots), [bots]);
  // Best bot: by the Generated its row shows (an LP's base part at the pool price), across coins in dollars for ordering
  // only, else by Gen. %; never the engine's separate pnl.net, which can disagree with the row
  const score = (b: AnyObj) => {
    const q = generatedValueInQuote(b), k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
    return (q != null && k != null ? q * k : generatedPct(b)) ?? -Infinity;
  };
  const best = bots.slice().sort((a, b) => score(b) - score(a))[0];
  const bestPnl = best ? { usd: Number.isFinite(score(best)) ? score(best) : null, pct: generatedPct(best) } : null;
  const slices = useMemo(() => {
    if (holdings?.hasSigner) {
      return holdings.chains
        .filter((c) => (chain === 'all' || c.chainId === chain) && c.usd > 0)
        .map((c) => ({ key: String(c.chainId), label: c.short, usd: c.usd, color: c.color }));
    }
    const map = new Map<number, number>();
    for (const b of bots) {
      const v = bookUsd(b);
      if (v == null) continue;
      const id = (b.chainId ?? s.legacyChainId) as number;
      map.set(id, (map.get(id) ?? 0) + v);
    }
    return [...map.entries()].filter(([, v]) => v > 0).map(([id, v]) => {
      const c = chainOf(s, id) ?? chains(s).find((x) => x.id === id);
      return { key: String(id), label: c?.short ?? String(id), usd: v, color: c?.color ?? '#F0B90B' };
    });
  }, [holdings, chain, bots, s]);
  const { p } = useOpportunities();
  const picks = ((p?.chains ?? []) as AnyObj[])
    .filter((c) => chain === 'all' || c.chainId === chain)
    .flatMap((c) => (c.items ?? []) as Opportunity[])
    .filter((o) => isSafe(o))
    .flatMap((o) => { const w = wayOf(o, 'best'); return w ? [{ o, w }] : []; })
    .sort((a, b) => b.w.expected - a.w.expected)
    .slice(0, 3);
  const auto = useJson('/api/autopilot');
  const trader = useJson('/api/token-trader');
  const top = picks[0]?.w.expected ?? 0;
  const paper = holdings?.hasSigner === false;

  return (
    <main className="home">
      <div className="hero-grid">
        <section className="card hero-card" aria-label="Net worth">
          <div className="home-hero">
            <div>
              <p className="home-k">In bots now</p>
              <p className="home-num home-coins">{held.length ? held.map((t) => <span key={t.symbol}>{formatTokens([t], false)}</span>) : '—'}</p>
              <p className="home-sub">
                {holdings == null && 'Reading…'}
                {paper && 'Paper'}
              </p>
            </div>
            <div className="seg" role="tablist" aria-label="Range">
              {RANGES.map((r) => (
                <button key={r} type="button" className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
          </div>
          <AreaChart points={series} />
        </section>
        <section className="card alloc-card" aria-label="Allocation">
          <p className="home-k">Allocation</p>
          <Donut slices={slices} />
        </section>
      </div>

      <section className="join" aria-label="Summary">
        <div>
          <span>Generated, net of costs</span>
          {/* one bot: its row below has this same figure (each figure once per screen) */}
          <b className={cls(genSign)} title={gens.some((g) => g == null) ? 'Bots without a generated figure in tokens are left out' : undefined}>{!generated.length || bots.length === 1 ? <span className="muted">in the rows below</span> : formatTokens(generated, true, 4)}</b>
          <Sparkline points={span >= 20 * 86_400_000 ? month : series} width={120} height={32} />
        </div>
        <div>
          <span>Fees today</span>
          <b>{fees.length ? formatTokens(fees, false, 4) : '—'}</b>
          <Sparkline points={feesLine} width={120} height={32} />
        </div>
        <div>
          <span>Bots</span>
          <b>{running}/{bots.length || 0}</b>
          <span className="segs" aria-hidden="true">{(bots.length ? bots : [{ id: '0', status: '' }]).slice(0, 12).map((b) => <i key={b.id} className={b.status === 'running' ? 'on' : ''} />)}</span>
        </div>
        <div>
          <span>Best bot</span>
          <b className={cls(bestPnl?.usd ?? bestPnl?.pct)}>{best ? (best.label || best.name || best.base) : '—'}</b>
          {best && <Sparkline points={portfolioSeries([best], 'ALL').length > 2 ? portfolioSeries([best], 'ALL') : [0, bestPnl?.usd ?? 0]} width={120} height={32} />}
        </div>
      </section>

      {checking && <SafetyChecking what="Checking safety before resuming…" />}
      {err && <p className="note bad">{err}</p>}
      <section className="desk" aria-label="Bots">
        {!!bots.length && (
          <div className="desk-head" aria-hidden="true">
            <span>Pair</span><span /><span>Range</span><span>Invested</span><span>Generated</span><span />
          </div>
        )}
        {bots.map((b) => <BotRow key={b.id} s={s} b={b} nav={nav} pause={pause} close={close} columns />)}
        {!bots.length && <p className="muted home-empty">No bots{chain !== 'all' ? ' on this chain' : ''}. <button type="button" className="text-link" onClick={() => nav({ v: 'bots' })}>Start one</button></p>}
      </section>

      <details className="glance" open>
        <summary>Best this week</summary>
        {picks.map(({ o, w }) => (
          <button key={`${o.chainId}-${o.key ?? o.ref.pool}`} type="button" className="pick" onClick={() => tryIt(o, w.how, nav, act)}>
            <span className="pick-name">{o.label}<small>{chainOf(s, o.chainId)?.short} · {w.how === 'lp' ? 'Liquidity' : 'Grid'}</small></span>
            <Meter value={top > 0 ? w.expected / top : 0} />
            <b className="pos">{pct(w.expected, 1, true)}</b>
          </button>
        ))}
        {!picks.length && <p className="muted home-empty">{p ? 'No safe pools in this check.' : 'Checking pools…'}</p>}
      </details>

      <details className="glance" open>
        <summary>Smart trader</summary>
        <button type="button" className="pick" onClick={() => nav({ v: 'auto' })}>
          <span className="pick-name">
            {auto ? (auto.on ? `On · ${auto.mode}` : 'Off') : '…'}
            <small>
              {auto ? `${(auto.accounts ?? []).reduce((n: number, a: AnyObj) => n + (a.bots?.length ?? 0), 0)} bots · ${auto.budgets?.length ? auto.budgets.map((b: AnyObj) => `${b.amount} ${b.coin}`).join(', ') : 'no budget'}` : ' '}
            </small>
          </span>
          <b>{auto?.on ? 'Open' : 'Set up'}</b>
        </button>
        <button type="button" className="pick" onClick={() => nav({ v: 'auto' })}>
          <span className="pick-name">
            Token trader
            <small>{trader ? `${trader.on ? 'On' : 'Off'} · sniper ${trader.options?.sniper?.on ? 'on' : 'off'}` : '…'}</small>
          </span>
          <b>Open</b>
        </button>
      </details>
    </main>
  );
}
