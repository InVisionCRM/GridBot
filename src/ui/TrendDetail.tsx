/** One trend bot: position with stop / take-profit on the chart, profit vs holding, signals, trades, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { AnimatedNumber, StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { ago, cls, dur, num, pct, px, qty, time, usd } from './fmt';
import { ChainBadge, DexTag, chainOf, dexName } from './chains';
import { STRATEGIES } from '../market/strategy';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { strategyRule } from './TrendConfig';
import { T } from './theme';
import { quoteSym, trendPnlUsd, type AnyObj, type Nav } from './model';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

function StopGauge({ pos, price }: { pos: AnyObj; price: number | null }) {
  const r = pos.risk;
  const hi = r.tp ?? Math.max(r.highest, r.entry + 2 * (r.entry - r.initialStop));
  const lo = Math.min(r.stop, r.initialStop);
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  return (
    <div className="gauge" title={`stop ${px(r.stop)} · entry ${px(r.entry)}${r.tp ? ` · take-profit ${px(r.tp)}` : ''}`}>
      <div className="gauge-track" />
      <span className="gauge-stop" style={{ left: at(r.stop) }} />
      <span className="gauge-entry" style={{ left: at(r.entry) }} />
      {r.tp && <span className="gauge-tp" style={{ left: at(r.tp) }} />}
      {price != null && <span className="gauge-price" style={{ left: at(price) }} />}
    </div>
  );
}

export function TrendDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const t: AnyObj | undefined = (s.trends ?? []).find((x: AnyObj) => x.id === id);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!t) return null;

  const k: number | null = t.usdPerQuote ?? null;
  const q = quoteSym(t), base = t.base ?? 'PLS';
  const pnl = trendPnlUsd(t);
  const hold = t.hodl && k ? (t.hodl - t.capital) * k : null;
  const money = (x: number) => (k ? usd(x * k, true) : qty(x, q, 4));
  const running = t.status === 'running';
  const pos = t.position;
  const stratLabel = STRATEGIES.find((x) => x.id === t.cfg.strategy)?.label ?? t.cfg.strategy;
  const remove = () => act(async () => { if (confirm(`Remove ${t.name} and its history?`)) { await botApi(`trends/${t.id}`, 'DELETE'); nav({ v: 'home' }); } });
  const closePos = () => act(async () => { if (confirm(`Sell ${t.name}'s ${base} at market now?`)) await botApi(`trends/${t.id}/close`, 'POST'); });

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <StatusDot beat={t.priceAt} state={t.lastError ? 'error' : t.status} />
        <ChainBadge c={chainOf(s, t.chainId ?? s.legacyChainId)} testnet={false} />
        <h2>{t.name}</h2>
        <span className="tag">Trend</span>
        {t.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={t.dexName} feeBps={t.feeBps} feeTier={t.feeTier} />
        <span className={`st ${t.status}`}>{running ? 'Running' : 'Stopped'}{t.inFlight ? ' · swap in flight' : ''}</span>
        <span className="grow" />
        {running
          ? <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/stop`, 'POST'))}>Stop</button>
          : <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/resume`, 'POST'))}>Resume</button>}
        <button type="button" className="btn" disabled={busy || !pos || !running} onClick={closePos}>Sell now</button>
        <button type="button" className="btn danger" disabled={busy || running || !!t.inFlight} title={running ? 'Stop it first' : ''} onClick={remove}>Remove</button>
      </div>

      <div className="notices">
        {t.lastError && <div className="banner error"><span className="grow">{t.lastError}</span></div>}
        {!running && pos && <div className="banner"><span className="grow"><b>Stopped while holding {base}.</b> The stop-loss and take-profit are not watched until you resume.</span></div>}
      </div>

      <div className="kpi-row">
        <div className="kpi"><span>Profit</span><div className={`kpi-v ${cls(pnl ?? t.pnl.equity - t.capital)}`}>{pnl != null ? <AnimatedNumber value={pnl} format={(x) => usd(x, true)} /> : qty(t.pnl.equity - t.capital, q, 4)}</div><span className="sub">{pct(t.pnl.returnPct, 2, true)} · {money(t.pnl.realized)} banked</span></div>
        <div className="kpi"><span>If you'd held {base}</span><div className="kpi-v">{hold != null ? usd(hold, true) : '—'}</div><span className="sub">{hold != null && pnl != null ? (pnl >= hold ? `bot ahead by ${usd(pnl - hold)}` : `holding ahead by ${usd(hold - pnl)}`) : 'buying at the start price'}</span></div>
        <div className="kpi"><span>Trades</span><div className="kpi-v">{t.stats.count}</div><span className="sub">{t.stats.count ? `${pct(t.stats.winRate, 0)} profitable` : 'none closed yet'} · {t.blocked} skipped by the cost check</span></div>
        <div className="kpi"><span>Worst drop</span><div className="kpi-v">{pct(t.stats.maxDrawdown, 1)}</div><span className="sub">from the bot's peak value</span></div>
        <div className="kpi"><span>Fees + gas</span><div className="kpi-v">{money(-(t.pnl.fees + t.pnl.gas))}</div><span className="sub">paid so far</span></div>
      </div>

      <div className="split wide-left">
        <div className="card">
          <Chart status={s} ticks={ticks} pairs={[t.quote]} pair={t.quote} tf={t.tf} compact height={400}
            emaFast={t.cfg.strategy.startsWith('ema') ? t.cfg.fast : undefined} emaSlow={t.cfg.strategy.startsWith('ema') ? t.cfg.slow : undefined} />
          <p className="muted small">Arrows mark buys and sells. While holding, the chart shows the entry, stop-loss (or trailing stop) and take-profit lines.</p>
        </div>
        <div className="stack">
          <div className="card">
            <h3>{pos ? `Holding ${base}` : 'Waiting for a signal'}</h3>
            {pos ? <>
              <p className="small">{num(pos.pls, pos.pls < 10 ? 6 : 2)} {base} bought at {px(pos.entryPrice)} · {pos.bars} candles ago · open {k ? usd(pos.unrealized * k, true) : qty(pos.unrealized, q, 4)} ({pct(pos.unrealizedPct, 2, true)})</p>
              <StopGauge pos={pos} price={t.price} />
              <p className="muted small">Stop {px(pos.risk.stop)}{pos.risk.stop > pos.risk.initialStop ? ' (trailing)' : ''} · entry {px(pos.risk.entry)}{pos.risk.tp ? ` · take-profit ${px(pos.risk.tp)}` : ''} · price {px(t.price)}</p>
            </> : (
              <p className="small">{stratLabel}: buys when {strategyRule(t.cfg)}. Next {t.tf} candle closes in {dur(Math.max(0, t.nextCloseAt - Date.now()))}.{t.warm?.need ? ` Warming up: ${t.warm.have}/${t.warm.need} candles.` : ''}</p>
            )}
            <p className="muted small mono">{t.lastNote || ''}</p>
          </div>
          <div className="card">
            <h3>Signals</h3>
            <div className="sig-list">
              {t.signals.map((x: AnyObj, i: number) => <div key={i} className={`sig sig-${x.kind}`}><span className="muted">{time(x.at)}</span> <b>{x.kind}</b> <span className="small">{x.note}</span></div>)}
              {!t.signals.length && <p className="muted small">None yet.</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h3>Trades <span className="muted small">{t.trades.length}</span></h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Time</th><th>Side</th><th>Why</th><th>{base}</th><th>Price</th><th>Profit</th><th>Held</th><th>DEX</th></tr></thead>
            <tbody>{t.trades.map((x: AnyObj) => (
              <tr key={x.id} className={x.failed ? 'failed-row' : ''}>
                <td>{time(x.timestamp)}</td><td className={`side ${x.side}`}>{x.side}</td><td className="txt">{x.reason}</td>
                <td>{num(x.plsAmount, x.plsAmount < 10 ? 6 : 0)}</td><td>{px(x.execPrice ?? x.price)}</td>
                <td className={cls(x.side === 'sell' ? x.realizedPnlUsd : null)}>{x.side === 'sell' ? money(x.realizedPnlUsd) : ''}</td>
                <td>{x.holdMs ? dur(x.holdMs) : ''}</td><td className="txt nowrap">{dexName(s, t.chainId, x.dex)}</td>
              </tr>
            ))}{!t.trades.length && <tr><td colSpan={8} className="txt muted">No trades yet.</td></tr>}</tbody>
          </table></div>
          <p className="muted small">Last price {ago(t.priceAt)} · {px(t.price)} {q}/{base}</p>
        </div>
        <div className="card"><h3>Log</h3><BotLog events={events} botId={t.id} /></div>
      </div>

      <div className="card">
        <h3>Value over time <span className="muted small">{q}</span></h3>
        <EquityChart series={[{ name: `value ${q}`, data: t.equityHist ?? [], color: T.text }]} />
      </div>
    </main>
  );
}
