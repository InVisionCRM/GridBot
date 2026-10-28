/** Home: net worth, the book chart, a joined strip, the bots, then the two cards that used to live only under More. */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { bestLiveBot, BotRow, feesTodayOf, generatedByMode, generatedParts, listBots, pnlUnits, todaySeries, totalGeneratedUsd, useRowActions } from './botRow';
import { unitsText } from './deskStats';
import { AreaChart, Donut, Meter, Sparkline } from './charts';
import { chainOf, chains, useChainFilter } from './chains';
import { cls, pct, usd } from './fmt';
import { formatUsdAmount, type HoldingsSnapshot } from '../live/holdingsMath';
import { useCount } from './motion';
import type { Opportunity } from '../market/scan';
import { isSafe, tryIt, useOpportunities, wayOf } from './Opportunities';
import { bookUsd, equitySpan, portfolioSeries, seriesChange, type DeskRange } from './series';
import type { AnyObj, Nav } from './model';

const GEN_CALC = 'Generated: what your live bots made, net of costs, per coin (liquidity fees after gas, swap fees and range-move losses; grid and trend round-trip profit after fees and gas). Paper bots are shown under it, never added in. Price moves on coins held are not in it; they are in P&L (live bots, per quote coin).';
const FEES_TODAY_CALC = 'Fees your live liquidity bots earned since local midnight (collected + still in the position), per quote coin, worked out on the server. Paper bots and pool fees grid/trend trades paid are shown under it, never added in.';

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

function HeroWorth({ value }: { value: number | null }) {
  const shown = useCount(value);
  if (value == null || shown == null) return <p className="home-num">—</p>;
  const text = formatUsdAmount(shown);
  const dot = text.lastIndexOf('.');
  return (
    <p className="home-num">
      {dot < 0 ? text : <>{text.slice(0, dot)}<span className="cents">{text.slice(dot)}</span></>}
    </p>
  );
}

export function Home({ s, nav, holdings, act }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null; act: (fn: () => Promise<unknown>) => void }) {
  const { chain } = useChainFilter();
  const { err, pause, close } = useRowActions();
  const [range, setRange] = useState<DeskRange>('1D');
  const bots = listBots(s, chain).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  const worth = !holdings || !holdings.hasSigner ? null
    : chain === 'all' ? (holdings.netWorthExDustUsd ?? holdings.netWorthUsd)
    : (holdings.chains.find((c) => c.chainId === chain)?.usd ?? null);
  const book = useMemo(() => bots.reduce((a, b) => a + (bookUsd(b) ?? 0), 0), [bots]);
  const shownWorth = worth ?? (holdings?.hasSigner === false ? book : null);
  const series = useMemo(() => {
    const hist = portfolioSeries(bots, range);
    if (hist.length > 2 && hist.some((p) => p !== hist[0])) return hist;
    if (range === '1H' || range === '1D') {
      const day = todaySeries(bots, holdings?.hasSigner === false);
      if (day.length > 1 && day.some((p) => p !== 0)) return day;
    }
    return hist;
  }, [bots, range, holdings?.hasSigner]);
  const chg = seriesChange(series);
  const span = equitySpan(bots);
  const month = useMemo(() => portfolioSeries(bots, '1M'), [bots]);
  // Live and paper are never mixed: the headline is live bots only, in units per coin; paper is a separate small line
  const gen = generatedByMode(bots);
  const livePnl = pnlUnits(bots, 'live');
  const genTone = totalGeneratedUsd(bots, 'live'); // sign only (colour); no dollars on screen
  const today = useMemo(() => feesTodayOf(s, bots), [s, bots]);
  const feesLine = today.liveSeries;
  const best = bestLiveBot(bots);
  const bestGen = best ? generatedParts(best) : null;
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
              <p className="home-k">Net worth</p>
              <HeroWorth value={shownWorth} />
              <p className="home-sub">
                {holdings == null && 'Reading…'}
                {paper && 'Paper'}
                {holdings && (
                  <span className={`chip ${cls(chg.delta)}`}>{usd(chg.delta, true)} {chg.pct == null ? '' : pct(chg.pct, 2, true)}</span>
                )}
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
          <span title={GEN_CALC}>Generated</span>
          <b className={cls(gen.live ? genTone : null)} data-testid="home-generated">{gen.live ? unitsText(gen.live, 3) : '—'}</b>
          <small className="muted fees-sub" title="Total P&L of your live bots, per quote coin: current value + paid out − capital in, price change included.">P&L {livePnl ? unitsText(livePnl, 3) : '—'}</small>
          {gen.paper && <small className="muted fees-sub" data-testid="home-generated-paper" title="Paper bots' Generated, kept apart from the live headline.">paper {unitsText(gen.paper, 3)}</small>}
          <Sparkline points={span >= 20 * 86_400_000 ? month : series} width={120} height={32} />
        </div>
        <div>
          <span title={FEES_TODAY_CALC}>Fees earned today</span>
          <b>{unitsText(today.liveEarned, 3)}</b>
          {(Object.keys(today.paperEarned).length > 0 || Object.keys(today.livePaid).length > 0) && (
            <small className="muted fees-sub">
              {[Object.keys(today.paperEarned).length ? `paper ${unitsText(today.paperEarned, 3)}` : '', Object.keys(today.livePaid).length ? `trade fees paid ${unitsText(today.livePaid, 3, false)}` : ''].filter(Boolean).join(' · ')}
            </small>
          )}
          <Sparkline points={feesLine.length > 1 ? feesLine : [0, 0]} width={120} height={32} />
        </div>
        <div>
          <span>Bots</span>
          <b>{running}/{bots.length || 0}</b>
          <span className="segs" aria-hidden="true">{(bots.length ? bots : [{ id: '0', status: '' }]).slice(0, 12).map((b) => <i key={b.id} className={b.status === 'running' ? 'on' : ''} />)}</span>
        </div>
        <div>
          <span>Best bot</span>
          <b className={cls(bestGen?.usd)}>{best ? (best.label || best.name || best.base) : '—'}</b>
          {best && bestGen && <small className="muted fees-sub">{bestGen.text}</small>}
          {best && <Sparkline points={portfolioSeries([best], 'ALL').length > 2 ? portfolioSeries([best], 'ALL') : [0, bestGen?.usd ?? 0]} width={120} height={32} />}
          {!best && bots.length > 0 && <small className="muted fees-sub">live bots only</small>}
        </div>
      </section>

      {err && <p className="note bad">{err}</p>}
      <section className="desk" aria-label="Bots">
        {!!bots.length && (
          <div className="desk-head" aria-hidden="true">
            <span>Pair</span><span /><span>Range</span><span>Value</span><span>Generated</span><span />
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
