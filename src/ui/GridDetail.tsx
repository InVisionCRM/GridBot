/** One grid: profit vs holding, chart with levels and fills, its own log, change range (restarts on its own pair). */
import { useEffect, useState } from 'react';
import { formatPrice } from '../lib/format';
import { http, botApi } from './api';
import { AnimatedNumber, StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { cls, num, pct, px, qty, time, usd } from './fmt';
import { ChainBadge, DexTag, Orientation, chainOf, dexName, explorerTx, feeLabel, mk } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { T } from './theme';
import { errMsg, gridName, gridPnlUsd, quoteSym, rangeState, type AnyObj, type Nav } from './model';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

export function BotLog({ events, botId }: { events: ActivityEvent[]; botId: string }) {
  const list = events.filter((e) => e.botId === botId && e.type !== 'tick').slice(-60).reverse();
  return (
    <ul className="feed-list">
      {list.map((e) => <li key={e.id} className={`lv-${e.level}`}><time>{new Date(e.t).toLocaleTimeString()}</time><span>{e.msg}</span></li>)}
      {!list.length && <li><span className="muted">Nothing yet. Fills, skips and errors for this bot appear here.</span></li>}
    </ul>
  );
}

/** Change the range of a stopped grid; always restarts on the grid's own pair and mode. */
function ChangeRange({ g, act, busy }: { g: AnyObj; act: Props['act']; busy: boolean }) {
  const k: number | null = g.usdPerQuote ?? null;
  const [lower, setLower] = useState(String(g.config.lowerPrice));
  const [upper, setUpper] = useState(String(g.config.upperPrice));
  const [count, setCount] = useState(String(g.config.gridCount));
  const [capUsd, setCapUsd] = useState(k ? String(+(g.config.totalCapitalUsd * k).toFixed(2)) : '');
  const [econ, setEcon] = useState<AnyObj | null>(null);
  const [econErr, setEconErr] = useState<string | null>(null);
  const capQuote = k ? +capUsd / k : null;
  useEffect(() => {
    const lo = +lower, hi = +upper, n = +count;
    if (!(lo > 0) || !(hi > lo) || !(n >= 2) || !(capQuote! > 0)) { setEcon(null); return; }
    const t = setTimeout(() => {
      botApi(`econ?quote=${encodeURIComponent(g.stable)}&lower=${lo}&upper=${hi}&grids=${n}&capital=${capQuote}`)
        .then((e) => { setEcon(e); setEconErr(null); }).catch((e) => { setEcon(null); setEconErr(errMsg(e)); });
    }, 250);
    return () => clearTimeout(t);
  }, [lower, upper, count, capQuote, g.stable]);
  const recentre = (band: number) => { if (g.price) { setLower(String(+(g.price * (1 - band)).toPrecision(5))); setUpper(String(+(g.price * (1 + band)).toPrecision(5))); } };
  const running = g.status === 'running';
  const restart = () => act(async () => {
    if (g.mode === 'live' && !confirm(`Restart this LIVE grid with the new range? It signs real swaps.`)) return;
    await botApi(`grids/${g.id}/start`, 'POST', { mode: g.mode, stable: g.stable, lowerPrice: +lower, upperPrice: +upper, gridCount: +count, totalCapitalUsd: capQuote });
  });
  const money = (q: number) => (k ? usd(q * k, true) : qty(q, quoteSym(g), 4));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="form-row">
        <label>Lowest price<input value={lower} onChange={(e) => setLower(e.target.value)} /></label>
        <label>Highest price<input value={upper} onChange={(e) => setUpper(e.target.value)} /></label>
        <label>Levels<input value={count} onChange={(e) => setCount(e.target.value)} /></label>
        <label>Capital ($)<input value={capUsd} onChange={(e) => setCapUsd(e.target.value)} disabled={!k} /></label>
      </div>
      <div className="quick">
        <span className="muted small">Centre on today's price {g.price ? px(g.price) : '—'}:</span>
        {[0.05, 0.08, 0.12, 0.2].map((b) => <button key={b} type="button" className="btn small-btn" disabled={!g.price} onClick={() => recentre(b)}>±{b * 100}%</button>)}
      </div>
      {econErr && <div className="banner error">{econErr}</div>}
      {econ && <div className={`verdict ${econ.ok ? 'ok' : 'bad'}`}>{econ.ok
        ? <span>Each completed buy-then-sell nets about <b>{money(econ.netPerRoundTrip)}</b> ({pct(econ.netPct, 2)}). Levels are {pct(econ.spacingPct, 2)} apart.</span>
        : <span><b className="neg">Not profitable at this size.</b> {econ.reasons.join(' ')}</span>}</div>}
      <div className="actions">
        <button type="button" className={`btn ${g.mode === 'live' ? 'live' : 'primary'}`} disabled={busy || running || !econ?.ok} onClick={restart}>Restart with this range</button>
        <span className="muted small">{running ? 'Stop the grid first.' : `Restarts as ${g.mode} on ${gridName(g)}. ${g.base} the old levels still hold stays in this grid's totals.`}</span>
      </div>
    </div>
  );
}

function Limits({ g, act, busy }: { g: AnyObj; act: Props['act']; busy: boolean }) {
  const L = g.limits ?? {};
  const [impact, setImpact] = useState(String((L.maxPriceImpact ?? 0.03) * 100));
  const [slip, setSlip] = useState(String((L.slippageBps ?? 100) / 100));
  const [deadline, setDeadline] = useState(String(L.deadlineMinutes ?? 10));
  const apply = () => act(() => botApi(`grids/${g.id}/limits`, 'PUT', { maxPriceImpact: +impact / 100, slippageBps: Math.round(+slip * 100), deadlineMinutes: +deadline }));
  return (
    <div className="form-row">
      <label title="Skip a trade if it would move the pool price more than this">Max price impact %<input value={impact} onChange={(e) => setImpact(e.target.value)} /></label>
      <label title="If the price moves more than this before the swap is mined, it reverts and only gas is lost">Slippage %<input value={slip} onChange={(e) => setSlip(e.target.value)} /></label>
      <label title="Minutes a swap stays valid on-chain">Deadline (min)<input value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
      <div className="actions"><button type="button" className="btn" disabled={busy} onClick={apply}>Apply now</button></div>
    </div>
  );
}

function Fills({ s, g }: { s: AnyObj; g: AnyObj }) {
  const [all, setAll] = useState(false);
  const q = quoteSym(g), base = g.base ?? 'PLS', k: number | null = g.usdPerQuote ?? null;
  const net = (t: AnyObj) => t.roundTripNet ?? t.realizedPnlUsd;
  const tx = (h: string) => (h && !h.startsWith('paper')
    ? <a href={explorerTx(s, g.chainId, h)} target="_blank" rel="noreferrer">{h.slice(0, 10)}…</a>
    : <span className="muted">{h ? 'paper' : ''}</span>);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Fills <span className="muted small">{g.trades.length}</span></h3>
        <label className="check small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All columns</label>
      </div>
      <div className="table-wrap"><table>
        <thead>{all
          ? <tr><th>Time</th><th>Side</th><th>Level</th><th>{base}</th><th>{q}</th><th title="price when the level was crossed">Trigger</th><th title="router quote after known tax">Quote</th><th title="from the receipt / balance change">Executed</th><th title="+ = worse than quote">Slip</th><th>Tax</th><th>Gas ({q})</th><th title="proceeds − sell gas − the matched buy's cost">Trade profit</th><th>DEX</th><th>Tx</th></tr>
          : <tr><th>Time</th><th>Side</th><th>{base}</th><th>Price</th><th>Trade profit</th><th>Tx</th></tr>}
        </thead>
        <tbody>
          {g.trades.map((t: AnyObj) => {
            const profit = t.side === 'sell' || t.failed ? net(t) : null;
            const profitTxt = profit == null ? '' : k ? usd(profit * k, true) : qty(profit, q, 4);
            return all ? (
              <tr key={t.id} className={t.failed ? 'failed-row' : ''}>
                <td>{time(t.timestamp)}</td><td className={`side ${t.side}`}>{t.side}{t.failed ? ' ✗' : ''}</td><td className="muted">{t.intervalIndex}</td>
                <td>{num(t.plsAmount, t.plsAmount < 10 ? 6 : 2)}</td><td>{num(t.stableAmount, 6)}</td>
                <td>{t.triggerPrice ? formatPrice(t.triggerPrice) : '—'}</td><td>{t.quotedPrice ? formatPrice(t.quotedPrice) : '—'}</td>
                <td title={t.fromReceipt === false && !t.paper ? 'receipt log missing: minimum-out used' : ''}>{t.execPrice ?? t.price ? formatPrice(t.execPrice ?? t.price) : '—'}{t.fromReceipt === false && !t.paper ? '*' : ''}</td>
                <td className={(t.slippagePct ?? 0) > 0.001 ? 'neg' : ''}>{t.slippagePct != null ? pct(t.slippagePct, 3) : '—'}</td>
                <td>{t.taxPct != null && t.taxPct > 0.0005 ? pct(t.taxPct, 2) : '—'}</td><td>{num(t.gasUsd, 8)}</td>
                <td className={cls(profit)}>{profitTxt}</td><td className="txt nowrap">{dexName(s, g.chainId, t.dex)}</td><td>{tx(t.txHash)}</td>
              </tr>
            ) : (
              <tr key={t.id} className={t.failed ? 'failed-row' : ''}>
                <td>{time(t.timestamp)}</td><td className={`side ${t.side}`}>{t.side}{t.failed ? ' ✗' : ''}</td>
                <td>{num(t.plsAmount, t.plsAmount < 10 ? 6 : 2)}</td><td>{t.execPrice ?? t.price ? formatPrice(t.execPrice ?? t.price) : '—'}</td>
                <td className={cls(profit)}>{profitTxt}</td><td>{tx(t.txHash)}</td>
              </tr>
            );
          })}
          {!g.trades.length && <tr><td colSpan={all ? 14 : 6} className="txt muted">No fills yet. The first buy happens when the price drops to the next level below.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

export function GridDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const g: AnyObj | undefined = s.grids.find((x: AnyObj) => x.id === id);
  const [hold, setHold] = useState<number | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http('/api/analytics/overview').then((o) => {
      const b = o.bots.find((x: AnyObj) => x.id === id);
      if (!dead) setHold(b && b.hodlUsd != null ? b.hodlUsd - b.capitalUsd : null);
    }).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [id]);
  if (!g) return null;

  const k: number | null = g.usdPerQuote ?? null;
  const q = quoteSym(g);
  const pnl = gridPnlUsd(g);
  const rs = rangeState(g);
  const running = g.status === 'running';
  const money = (x: number) => (k ? usd(x * k, true) : qty(x, q, 4));
  const remove = () => act(async () => { if (confirm(`Remove the ${gridName(g)} grid and its history? ${g.base} it still holds stays in your wallet.`)) { await botApi(`grids/${g.id}`, 'DELETE'); nav({ v: 'home' }); } });

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <StatusDot beat={g.priceAt} state={g.lastError ? 'error' : g.status} />
        <ChainBadge c={chainOf(s, g.chainId ?? s.legacyChainId)} testnet={false} />
        <h2>{gridName(g)}</h2>
        <span className="tag">Grid</span>
        {g.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={g.dexName} feeBps={g.feeBps} feeTier={g.feeTier} />
        <span className={`st ${g.status}`}>{running ? 'Running' : 'Stopped'}{g.inFlight ? ' · swap in flight' : ''}</span>
        <span className="grow" />
        {running
          ? <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`grids/${g.id}/stop`, 'POST'))}>Stop</button>
          : g.config && <button type="button" className="btn primary" disabled={busy || g.available === false} onClick={() => act(() => botApi(`grids/${g.id}/resume`, 'POST'))}>Resume</button>}
        <button type="button" className="btn danger" disabled={busy || running || !!g.inFlight} title={running ? 'Stop it first' : ''} onClick={remove}>Remove</button>
      </div>

      <div className="notices">
        {g.available === false && <div className="banner error"><span className="grow">This market isn't available on the running server (its chain may be turned off in .env).</span></div>}
        {g.lastError && <div className="banner error"><span className="grow">{g.lastError}</span></div>}
        {g.spacingWarn && <div className="banner"><span className="grow">{g.spacingWarn}</span></div>}
        {running && rs === 'above' && <div className="banner"><span className="grow"><b>Price is above the range.</b> Every level has sold, so the grid waits in {q}. Stop it and change the range to keep trading.</span></div>}
        {running && rs === 'below' && <div className="banner"><span className="grow"><b>Price is below the range.</b> Every level has bought, so the grid holds {g.base} until the price recovers. Stop it and change the range to keep trading.</span></div>}
      </div>

      <div className="kpi-row">
        <div className="kpi"><span>Profit</span><div className={`kpi-v ${cls(pnl ?? g.pnl.realized + g.pnl.unrealized)}`}>{pnl != null ? <AnimatedNumber value={pnl} format={(x) => usd(x, true)} /> : qty(g.pnl.realized + g.pnl.unrealized, q, 4)}</div><span className="sub">{money(g.pnl.realized)} banked · {money(g.pnl.unrealized)} open</span></div>
        <div className="kpi"><span>If you'd held</span><div className="kpi-v">{hold != null ? usd(hold, true) : '—'}</div><span className="sub">{hold != null && pnl != null ? (pnl >= hold ? `grid ahead by ${usd(pnl - hold)}` : `holding ahead by ${usd(hold - pnl)}`) : 'buying at the start price'}</span></div>
        <div className="kpi"><span>Completed trades</span><div className="kpi-v">{g.stats.roundTrips}</div><span className="sub">avg {money(g.stats.avgNet)} each · {g.stats.wins} profitable</span></div>
        <div className="kpi"><span>Price</span><div className="kpi-v">{g.price ? px(g.price) : '—'}</div><span className="sub">{g.config ? `range ${px(g.config.lowerPrice)}–${px(g.config.upperPrice)}` : ''} {q}/{g.base}</span></div>
        <div className="kpi"><span>Holding</span><div className="kpi-v">{num(g.pnl.plsHeld, g.pnl.plsHeld < 10 ? 6 : 2)}</div><span className="sub">{g.base} bought by this grid</span></div>
      </div>

      <div className="card">
        <Chart status={s} ticks={ticks} pairs={[g.stable]} pair={g.stable} compact height={380} />
        <p className="muted small"><Orientation m={{ base: g.base ?? 'PLS', quote: q, flipped: g.flipped, label: g.label }} compact /> · dotted lines are the grid levels · arrows are fills · pool fee {feeLabel(mk(s, g.stable))} per swap</p>
      </div>

      {g.config && (
        <div className="card">
          <details className="more" open={rs === 'above' || rs === 'below'}>
            <summary>Change range</summary>
            <ChangeRange key={`${g.config.lowerPrice}-${g.config.upperPrice}-${g.config.gridCount}`} g={g} act={act} busy={busy} />
          </details>
          <details className="more">
            <summary>Safety limits</summary>
            <Limits g={g} act={act} busy={busy} />
          </details>
        </div>
      )}

      <div className="split">
        <div className="card">
          <h3>Levels</h3>
          <div className="table-wrap"><table><tbody>
            {[...g.intervals].reverse().map((iv: AnyObj) => (
              <tr key={iv.index}>
                <td className="muted">#{iv.index}</td><td>{formatPrice(iv.buyPrice)} → {formatPrice(iv.sellPrice)}</td>
                <td className={`st ${iv.status}`}>{({ waitingBuy: 'waiting to buy', pendingBuy: 'buying', holding: 'holding', pendingSell: 'selling', inactive: 'inactive' } as Record<string, string>)[iv.status] ?? iv.status}{iv.needsRearm ? ' (re-arm)' : ''}</td>
                <td>{iv.plsAmount ? `${num(iv.plsAmount, iv.plsAmount < 10 ? 6 : 0)} ${g.base}` : ''}</td>
              </tr>
            ))}
            {!g.intervals.length && <tr><td className="txt muted">No levels.</td></tr>}
          </tbody></table></div>
        </div>
        <div className="card"><h3>Log</h3><BotLog events={events} botId={g.id} /></div>
      </div>

      <Fills s={s} g={g} />

      <div className="card">
        <h3>Value over time <span className="muted small">{q}</span></h3>
        <EquityChart series={[{ name: `value ${q}`, data: g.equityHist ?? [], color: T.text }]} />
      </div>
    </main>
  );
}
