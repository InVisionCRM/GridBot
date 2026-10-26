/** Home: net worth, a short summary, the bots, then the two cards that used to live only under More. */
import { useEffect, useState } from 'react';
import { http } from './api';
import { BotRow, feesTodayUsd, listBots, todaySeries, totalPnlUsd, useRowActions } from './botRow';
import { Meter, Sparkline } from './charts';
import { chainOf, useChainFilter } from './chains';
import { cls, pct, usd } from './fmt';
import { formatUsdAmount, type HoldingsSnapshot } from '../live/holdingsMath';
import { AnimatedNumber } from './motion';
import type { Opportunity } from '../market/scan';
import { isSafe, tryIt, useOpportunities, wayOf } from './Opportunities';
import type { AnyObj, Nav } from './model';

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

export function Home({ s, nav, holdings, act }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null; act: (fn: () => Promise<unknown>) => void }) {
  const { chain } = useChainFilter();
  const { err, pause, close } = useRowActions();
  const bots = listBots(s, chain).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  const paused = bots.filter((b) => b.status === 'stopped').length;
  const live = bots.filter((b) => b.mode === 'live').length;
  const paper = bots.length - live;
  const worth = !holdings || !holdings.hasSigner ? null
    : chain === 'all' ? (holdings.netWorthExDustUsd ?? holdings.netWorthUsd)
    : (holdings.chains.find((c) => c.chainId === chain)?.usd ?? null);
  const series = todaySeries(bots, holdings?.hasSigner === false);
  const today = series[series.length - 1] ?? 0;
  const pnl = totalPnlUsd(bots);
  const fees = feesTodayUsd(bots);
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
  const best = picks[0]?.w.expected ?? 0;

  return (
    <main className="home">
      <section className="home-fig" aria-label="Net worth">
        <div>
          <p className="home-k">Net worth</p>
          <p className="home-num">{worth == null ? '—' : <AnimatedNumber value={worth} format={formatUsdAmount} />}</p>
          <p className={`home-day ${holdings?.hasSigner === false || !holdings ? 'muted' : cls(today)}`}>
            {holdings == null && 'Reading…'}
            {holdings?.hasSigner === false && 'Paper · '}
            {holdings && <>Today {usd(today, true)}</>}
          </p>
        </div>
        {holdings && <Sparkline points={series} />}
      </section>

      <section className="strip" aria-label="Summary">
        <div><span>P&amp;L</span><b className={cls(pnl)}>{pnl == null ? '—' : <AnimatedNumber value={pnl} format={(x) => usd(x, true)} />}</b></div>
        <div><span>Fees today</span><b>{<AnimatedNumber value={fees} format={(x) => usd(x, true)} />}</b></div>
        <div><span>Bots</span><b>{running} running · {paused} paused</b></div>
        <div><span>Live / paper</span><b>{live} live · {paper} paper</b></div>
      </section>

      {err && <p className="note bad">{err}</p>}
      <section aria-label="Bots">
        {bots.map((b) => <BotRow key={b.id} s={s} b={b} nav={nav} pause={pause} close={close} />)}
        {!bots.length && <p className="muted home-empty">No bots{chain !== 'all' ? ' on this chain' : ''}. <button type="button" className="text-link" onClick={() => nav({ v: 'bots' })}>Start one</button></p>}
      </section>

      <details className="glance" open>
        <summary>Best this week</summary>
        {picks.map(({ o, w }) => (
          <button key={`${o.chainId}-${o.key ?? o.add?.pool}`} type="button" className="pick" onClick={() => tryIt(o, w.how, nav, act)}>
            <span className="pick-name">{o.label}<small>{chainOf(s, o.chainId)?.short} · {w.how === 'lp' ? 'Liquidity' : 'Grid'}</small></span>
            <Meter value={best > 0 ? w.expected / best : 0} />
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
