/** One trend bot: position with stop / take-profit on the chart, profit in the coin it spends, signals, trades, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { AnimatedNumber, StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { StatTable } from './StatTable';
import { ago, cls, dur, num, pct, px, qty, time, usd } from './fmt';
import { ChainBadge, DexTag, chainOf, dexName } from './chains';
import { STRATEGIES } from '../market/strategy';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { showHalt } from './haltText';
import { strategyRule } from './TrendConfig';
import { LinesEditor } from './LinesEditor';
import { T } from './theme';
import { quoteSym, type AnyObj, type Nav } from './model';
import { Amt, Usd } from './money';
import { metricsOf } from './deskStats';
import { L } from './Tip';

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

  const m = metricsOf(t);
  const k: number | null = m?.quote.usdPerQuote ?? t.usdPerQuote ?? null;
  const q = quoteSym(t), base = t.base ?? 'PLS';
  // From the server's metrics (src/metrics/botMetrics.ts), not recomputed here.
  const gen: number | null = m?.quote.realized ?? null;
  const profit: number | null = m?.quote.totalPnl ?? null;
  const running = t.status === 'running';
  const closing = !!t.closing;
  const pos = t.position;
  const stratLabel = STRATEGIES.find((x) => x.id === t.cfg.strategy)?.label ?? t.cfg.strategy;
  const remove = () => act(async () => { if (confirm(`Remove ${t.name} and its history?`)) { await botApi(`trends/${t.id}`, 'DELETE'); nav({ v: 'home' }); } });
  const closePos = () => { if (confirm(`Sell ${t.name}'s ${base} at market now?`)) act(() => botApi(`trends/${t.id}/sell`, 'POST')); };
  const doClose = () => {
    if (t.mode === 'live' && !confirm(`Close ${t.name}? It sells the open trade, with the same price-impact and slippage limits.`)) return;
    act(() => botApi(`trends/${t.id}/close`, 'POST', undefined, 'row-close'));
  };

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <div className="detail-id">
          <StatusDot beat={t.priceAt} state={closing ? 'closing' : t.lastError ? 'error' : t.status} />
          <h2>{t.name}</h2>
          <ChainBadge c={chainOf(s, t.chainId ?? s.legacyChainId)} testnet={false} />
          <span className="tag">Trend</span>
          {t.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
          <DexTag name={t.dexName} feeBps={t.feeBps} feeTier={t.feeTier} />
          <span className={`st ${closing ? 'closing' : t.status}`}>{closing ? 'Closing…' : running ? 'Running' : 'Stopped'}{t.inFlight ? ' · swap in flight' : ''}</span>
        </div>
        <div className="detail-actions">
          {running
            ? <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/stop`, 'POST', undefined, 'row-stop'))}>Stop</button>
            : <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/resume`, 'POST'))}>Resume</button>}
          <button type="button" className="btn" disabled={busy || !pos || !running || closing} onClick={closePos}>Sell now</button>
          <button type="button" className="btn danger" disabled={busy || closing} onClick={doClose}>{closing ? 'Closing…' : 'Close'}</button>
          <button type="button" className="btn danger" disabled={busy || running || !!t.inFlight} title={running ? 'Stop it first' : ''} onClick={remove}>Remove</button>
        </div>
      </div>
      {showHalt(t, closing) && <p className="bot-why">{showHalt(t, closing)}</p>}

      <div className="notices">
        {t.lastError && <div className="banner error"><span className="grow">{t.lastError}</span></div>}
        {!running && pos && <div className="banner"><span className="grow"><b>Stopped while holding {base}.</b> The stop-loss and take-profit are not watched until you resume.</span></div>}
      </div>

      <div className="kpi-row detail-stats">
        <div className="kpi"><span><L tip={m?.calc ?? 'Generated'}>Generated</L></span><div className={`kpi-v ${cls(gen)}`}>{gen == null ? '—' : <AnimatedNumber value={gen} format={(x) => qty(x, q, 5)} />}</div><span className="sub">closed trades, after fees and gas{m?.generatedUsd != null && <span className="usd"> ≈ {usd(m.generatedUsd, true)}</span>}</span></div>
        <div className="kpi"><span><L tip={m?.calc ?? 'Total P&L'}>Total P&amp;L</L></span><div className={`kpi-v ${cls(profit)}`}>{profit == null ? '—' : qty(profit, q, 5)}</div><span className="sub">{pct(m?.totalPnlPct ?? null, 2, true)}{profit != null && <Usd v={profit} k={k} />} · unrealized <Amt v={m?.quote.unrealized ?? null} sym={q} k={null} sig={4} /></span></div>
        <div className="kpi"><span>Trades</span><div className="kpi-v">{t.stats.count}</div><span className="sub">{t.stats.count ? `${pct(t.stats.winRate, 0)} profitable` : 'none closed yet'} · {t.blocked} skipped by the cost check</span></div>
        <div className="kpi"><span>Worst drop</span><div className="kpi-v">{pct(t.stats.maxDrawdown, 1)}</div><span className="sub">from the bot's peak value</span></div>
        <div className="kpi"><span>Fees + gas</span><div className="kpi-v"><Amt v={-(t.pnl.fees + t.pnl.gas)} sym={q} k={k} sig={4} /></div><span className="sub">paid so far</span></div>
      </div>

      <div className="split wide-left">
        <div className="card">
          {t.cfg.strategy === 'lines'
            ? <LinesEditor s={s} ticks={ticks} pair={t.quote} tf={t.tf} lines={t.cfg.lines} busy={busy} height={480}
                onChange={(lines) => act(() => botApi(`trends/${t.id}/lines`, 'PUT', { lines }))} />
            : <Chart status={s} ticks={ticks} pairs={[t.quote]} pair={t.quote} tf={t.tf} compact desk height={480}
                emaFast={t.cfg.strategy.startsWith('ema') ? t.cfg.fast : undefined} emaSlow={t.cfg.strategy.startsWith('ema') ? t.cfg.slow : undefined} />}
          <p className="muted small">Arrows mark buys and sells. While holding, the chart shows the entry, stop-loss (or trailing stop) and take-profit lines.{t.cfg.strategy === 'lines' ? ' Line changes apply from the next closed candle.' : ''}</p>
          <StatTable b={t} s={s} />
        </div>
        <div className="stack">
          <div className="card">
            <h3>{pos ? `Holding ${base}` : 'Waiting for a signal'}</h3>
            {pos ? <>
              <p className="small">{num(pos.pls, pos.pls < 10 ? 6 : 2)} {base} bought at {px(pos.entryPrice)} · {pos.bars} candles ago · open <Amt v={pos.unrealized} sym={q} k={k} sig={4} /> ({pct(pos.unrealizedPct, 2, true)})</p>
              <StopGauge pos={pos} price={t.price} />
              <p className="muted small">Stop {px(pos.risk.stop)}{pos.risk.stop > pos.risk.initialStop ? ' (trailing)' : ''} · entry {px(pos.risk.entry)}{pos.risk.tp ? ` · take-profit ${px(pos.risk.tp)}` : ''} · price {px(t.price)}</p>
            </> : (
              <p className="small">{stratLabel}: buys when {strategyRule(t.cfg)}. Next {t.tf} candle closes in {dur(Math.max(0, t.nextCloseAt - Date.now()))}.{t.warm && t.warm.have < t.warm.need ? ` Warming up: ${t.warm.have}/${t.warm.need} candles.` : ''}</p>
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
                <td className={cls(x.side === 'sell' ? x.realizedPnlUsd : null)}>{x.side === 'sell' ? <Amt v={x.realizedPnlUsd} sym={q} k={k} sig={4} /> : ''}</td>
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
