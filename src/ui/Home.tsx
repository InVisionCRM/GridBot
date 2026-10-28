/** Home: net worth, the book chart, a joined strip, the bots, then the two cards that used to live only under More. */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { bestLiveBot, BotRow, feesTodayOf, generatedByMode, generatedParts, listBots, pnlUnits, sharedUnits, todaySeries, totalGeneratedUsd, useRowActions } from './botRow';
import { metricsOf, unitsText } from './deskStats';
import { AreaChart, Donut, Meter, Sparkline } from './charts';
import { chainOf, chains, useChainFilter } from './chains';
import { cls, pct } from './fmt';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import { coinNum, holdingsByToken, inEth, useEthUsd } from './units';
import { useCount } from './motion';
import type { Opportunity } from '../market/scan';
import { isSafe, tryIt, useOpportunities, wayOf } from './Opportunities';
import { bookUsd, equitySpan, portfolioSeries, seriesChange, type DeskRange } from './series';
import type { AnyObj, Nav } from './model';
import { SafetyChecking } from './SafetyChecking';

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

/** Net worth in ETH: the dollar total ÷ ETH's price (see units.tsx for which price). */
function HeroWorth({ value }: { value: number | null }) {
  const ethUsd = useEthUsd();
  const eth = value != null && ethUsd ? value / ethUsd : null;
  const shown = useCount(eth);
  if (eth == null || shown == null) return <p className="home-num">—</p>;
  const text = coinNum(shown, 5);
  const dot = text.lastIndexOf('.');
  return (
    <p className="home-num" data-testid="home-networth">
      {dot < 0 ? text : <>{text.slice(0, dot)}<span className="cents">{text.slice(dot)}</span></>}<span className="cents"> ETH</span>
    </p>
  );
}

/** Bots only (paper, or no wallet read): each bot's current value in its own quote coin, summed per coin. */
function botsByToken(bots: AnyObj[]): { sym: string; amount: number }[] {
  const m = new Map<string, number>();
  for (const b of bots) {
    const q = b.metrics?.quote;
    if (!q?.symbol || typeof q.currentValue !== 'number' || !(q.currentValue > 0)) continue;
    m.set(q.symbol, (m.get(q.symbol) ?? 0) + q.currentValue);
  }
  return [...m.entries()].map(([sym, amount]) => ({ sym, amount }));
}

export function Home({ s, nav, holdings, act }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null; act: (fn: () => Promise<unknown>) => void }) {
  const { chain } = useChainFilter();
  const { err, pause, close, checking } = useRowActions();
  const [range, setRange] = useState<DeskRange>('1D');
  const bots = listBots(s, chain).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  const worth = !holdings || !holdings.hasSigner ? null
    : chain === 'all' ? (holdings.netWorthExDustUsd ?? holdings.netWorthUsd)
    : (holdings.chains.find((c) => c.chainId === chain)?.usd ?? null);
  const book = useMemo(() => bots.reduce((a, b) => a + (bookUsd(b) ?? 0), 0), [bots]);
  const shownWorth = worth ?? (holdings?.hasSigner === false ? book : null);
  const ethUsd = useEthUsd();
  // A desk without a signer has only paper bots, and their book value is what the Net worth card shows. With a signer
  // the card is the wallet: until the wallet is read there is nothing to show, and the chart and chip follow live bots'
  // equity only, since a paper loss changes nothing the wallet holds.
  const paperDesk = holdings?.hasSigner === false;
  const tokens = useMemo(() => (holdings?.hasSigner ? holdingsByToken(holdings, chain).slice(0, 6) : paperDesk ? botsByToken(bots) : []), [holdings, chain, bots, paperDesk]);
  const seriesBots = useMemo(() => (paperDesk ? bots : bots.filter((b) => b.mode === 'live')), [bots, paperDesk]);
  const series = useMemo(() => {
    const hist = portfolioSeries(seriesBots, range);
    if (hist.length > 2 && hist.some((p) => p !== hist[0])) return hist;
    if (range === '1H' || range === '1D') {
      const day = todaySeries(seriesBots, paperDesk);
      if (day.length > 1 && day.some((p) => p !== 0)) return day;
    }
    return hist;
  }, [seriesBots, range, paperDesk]);
  const chg = seriesChange(series);
  const span = equitySpan(seriesBots);
  const month = useMemo(() => portfolioSeries(seriesBots, '1M'), [seriesBots]);
  // Live and paper are never mixed: the headline is live bots only, in units per coin; paper is a separate small line
  const gen = generatedByMode(bots);
  const paperGen = sharedUnits(bots.filter((b) => b.mode !== 'live').map((b) => metricsOf(b)?.generated));
  const livePnl = pnlUnits(bots, 'live');
  // a coin only one live bot counts is that bot's own figure, already on its row below: the headline keeps the coins
  // two or more live bots share and points to the rows for the rest (each figure once; same rule as the paper line)
  const liveBots = bots.filter((b) => b.mode === 'live');
  const liveShared = sharedUnits(liveBots.map((b) => metricsOf(b)?.generated));
  const pnlShared = sharedUnits(liveBots.map((b) => { const m = metricsOf(b); return m?.quote.symbol && m.quote.totalPnl != null ? { [m.quote.symbol]: m.quote.totalPnl } : null; }));
  const genFrom = liveBots.filter((b) => Object.keys(metricsOf(b)?.generated ?? {}).length);
  const onRows = genFrom.length === 1 ? `on ${genFrom[0].label || genFrom[0].name || genFrom[0].base} below` : 'on the rows below';
  const genTone = totalGeneratedUsd(bots, 'live'); // sign only (colour); no dollars on screen
  const today = useMemo(() => feesTodayOf(s, bots), [s, bots]);
  const feesLine = today.liveSeries;
  const best = bestLiveBot(bots);
  const bestGen = best ? generatedParts(best) : null;
  const slices = useMemo(() => {
    if (holdings?.hasSigner) {
      return holdings.chains
        .filter((c) => (chain === 'all' || c.chainId === chain) && c.usd > 0)
        .map((c) => ({ key: String(c.chainId), label: c.short, usd: c.usd, color: c.color, units: holdingsByToken(holdings, c.chainId).map((t) => `${coinNum(t.amount)} ${t.sym}`).join(' + ') }));
    }
    if (!paperDesk) return [];
    const map = new Map<number, number>();
    for (const b of bots) {
      const v = bookUsd(b);
      if (v == null) continue;
      const id = (b.chainId ?? s.legacyChainId) as number;
      map.set(id, (map.get(id) ?? 0) + v);
    }
    return [...map.entries()].filter(([, v]) => v > 0).map(([id, v]) => {
      const c = chainOf(s, id) ?? chains(s).find((x) => x.id === id);
      return { key: String(id), label: c?.short ?? String(id), usd: v, color: c?.color ?? '#F0B90B', units: botsByToken(bots.filter((b) => (b.chainId ?? s.legacyChainId) === id)).map((t) => `${coinNum(t.amount)} ${t.sym}`).join(' + ') };
    });
  }, [holdings, chain, bots, s, paperDesk]);
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
                {paperDesk && 'Paper'}
                {shownWorth != null && (
                  <span className={`chip ${cls(chg.delta)}`}>{inEth(chg.delta, ethUsd, true, 3)} {chg.pct == null ? '' : pct(chg.pct, 2, true)}</span>
                )}
              </p>
              {tokens.length > 0 && (
                <p className="home-sub units" data-testid="home-networth-tokens" title="What the net worth is made of, per coin (wallet, positions and fees owed; dust left out)">
                  {tokens.map((t) => `${coinNum(t.amount)} ${t.sym}`).join(' · ')}
                </p>
              )}
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
          <b className={`units ${cls(liveShared ? genTone : null)}`} data-testid="home-generated">{liveShared ? unitsText(liveShared, 3) : gen.live ? <span className="muted" data-testid="home-generated-rows">{onRows}</span> : '—'}</b>
          {(pnlShared || !livePnl) && <small className="muted fees-sub units" title="Total P&L of your live bots, per quote coin: current value + paid out − capital in, price change included.">P&L {pnlShared ? unitsText(pnlShared, 3) : '—'}</small>}
          {paperGen && <small className="muted fees-sub units" data-testid="home-generated-paper" title="Paper bots' Generated, kept apart from the live headline: the coins two or more paper bots count in (a coin only one bot counts is on its row below).">paper {unitsText(paperGen, 3)}</small>}
          <Sparkline points={span >= 20 * 86_400_000 ? month : series} width={120} height={32} />
        </div>
        <div>
          <span title={FEES_TODAY_CALC}>Fees earned today</span>
          <b className="units">{unitsText(today.liveEarned, 3)}</b>
          {(Object.keys(today.paperEarned).length > 0 || Object.keys(today.livePaid).length > 0) && (
            <small className="muted fees-sub units">
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
          {/* no number twice: with one live bot earning, its Generated is the headline's */}
          {best && bestGen && <small className="muted fees-sub units">{gen.live && unitsText(best.metrics?.generated, 3) === unitsText(gen.live, 3) ? 'all of the live Generated' : bestGen.text}</small>}
          {best && <Sparkline points={portfolioSeries([best], 'ALL').length > 2 ? portfolioSeries([best], 'ALL') : [0, bestGen?.usd ?? 0]} width={120} height={32} />}
          {!best && bots.length > 0 && <small className="muted fees-sub">live bots only</small>}
        </div>
      </section>

      {checking && <SafetyChecking what="Checking safety before resuming…" />}
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
