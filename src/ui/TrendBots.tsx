/** Trend bot tab: create (paper/live), live cards with heartbeat/position/stop-TP gauge, detail with chart, equity, signals, trades. */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TREND, STRATEGIES, type TrendConfig } from '../market/strategy';
import { TFS, type TF } from '../market/candles';
import { DEFAULT_GAS_RESERVE, gasReserve, parseGasRes } from '../live/gasReserve';
import { botApi } from './api';
import { AnimatedNumber, Heartbeat, useFlash } from './motion';
import { Chart, EquityChart } from './Chart';
import { ago, cls, dur, num, pct, px, qty, time, usd } from './fmt';
import type { Ticks } from './useStream';
import { ChainBadge, DexTag, Orientation, PairPicker, chainOf, dexName, feeLabel, marketsOf, mk, unflipKey, useChainFilter } from './chains';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface TrendPrefill { pair: string; tf: TF; cfg: TrendConfig; capitalUsd?: number; nonce: number }

const F = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label title={hint}>{label}{children}</label>
);

/** Strategy + exits + sizing editor (shared with the backtester). */
export function TrendConfigEditor({ cfg, onChange, compact = false }: { cfg: TrendConfig; onChange: (c: TrendConfig) => void; compact?: boolean }) {
  const set = (k: keyof TrendConfig, isNum = true) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    onChange({ ...cfg, [k]: e.target.type === 'checkbox' ? !!e.target.checked : isNum ? Number(e.target.value) : e.target.value });
  const n = (k: keyof TrendConfig, label: string, hint?: string, step = 'any') => (
    <F label={label} hint={hint}><input type="number" step={step} value={cfg[k] as number} onChange={set(k)} /></F>
  );
  return (
    <div className="cfg-editor">
      <div className="form-row">
        <F label="Strategy"><select value={cfg.strategy} onChange={set('strategy', false)}>{STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></F>
        {(cfg.strategy === 'ema' || cfg.strategy === 'ema_rsi') && <>{n('fast', 'Fast EMA', '', '1')}{n('slow', 'Slow EMA', '', '1')}</>}
        {cfg.strategy === 'ema_rsi' && <>{n('rsiPeriod', 'RSI len', '', '1')}{n('rsiMin', 'RSI min', 'enter only if RSI ≥ min')}{n('rsiMax', 'RSI max', 'and ≤ max (skip overbought)')}</>}
        {cfg.strategy === 'macd' && <>{n('macdFast', 'MACD fast', '', '1')}{n('macdSlow', 'MACD slow', '', '1')}{n('macdSignal', 'Signal', '', '1')}</>}
        {cfg.strategy === 'donchian' && <>{n('donchianEntry', 'Entry N', 'buy when close > prior N-bar high', '1')}{n('donchianExit', 'Exit N', 'sell when close < prior N-bar low', '1')}</>}
      </div>
      <div className="form-row">
        {n('atrPeriod', 'ATR len', '', '1')}
        {n('stopAtr', 'Stop ×ATR', 'initial stop = entry − k × ATR')}
        {n('tpR', 'TP (R)', 'take-profit at entry + R × stop distance; 0 = off')}
        {n('trailAtr', 'Trail ×ATR', 'trailing stop = highest high − k × ATR, ratchets up; 0 = off')}
        {n('maxHoldBars', 'Max hold', 'exit after N closed candles; 0 = off', '1')}
        {n('cooldownBars', 'Cooldown', 'closed candles to wait after an exit', '1')}
      </div>
      <div className="form-row">
        <F label="Sizing"><select value={cfg.sizing} onChange={set('sizing', false)}><option value="pct">% of capital</option><option value="risk">risk % (ATR stop)</option></select></F>
        {cfg.sizing === 'pct' ? n('sizePct', 'Size %') : n('riskPct', 'Risk %', '% of bot equity lost if the ATR stop is hit')}
        {n('minEdgePct', 'Min edge', 'extra edge over round-trip costs (0.0025 = 0.25%)')}
        {!compact && n('expectedMoveAtr', 'Exp. move ×ATR', 'used by the cost gate when TP is off')}
        <F label="HTF filter" hint="only enter when the higher-timeframe close is above its EMA">
          <span className="inline"><input type="checkbox" checked={cfg.htfEnabled} onChange={set('htfEnabled')} />
            <select value={cfg.htfTf} onChange={set('htfTf', false)} disabled={!cfg.htfEnabled}>{TFS.map((t) => <option key={t}>{t}</option>)}</select>
            <input type="number" style={{ width: 54 }} value={cfg.htfEma} onChange={set('htfEma')} disabled={!cfg.htfEnabled} /></span>
        </F>
      </div>
    </div>
  );
}

function StopGauge({ pos, price }: { pos: AnyObj; price: number | null }) {
  const r = pos.risk;
  const hi = r.tp ?? Math.max(r.highest, r.entry + 2 * (r.entry - r.initialStop));
  const lo = Math.min(r.stop, r.initialStop);
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  return (
    <div className="gauge" title={`stop ${px(r.stop)} · entry ${px(r.entry)}${r.tp ? ` · TP ${px(r.tp)}` : ''}`}>
      <div className="gauge-track" />
      <span className="gauge-stop" style={{ left: at(r.stop) }} />
      <span className="gauge-entry" style={{ left: at(r.entry) }} />
      {r.tp && <span className="gauge-tp" style={{ left: at(r.tp) }} />}
      {price != null && <span className="gauge-price" style={{ left: at(price) }} />}
    </div>
  );
}

function BotCard({ t, sel, onSel, act, busy }: { t: AnyObj; sel: boolean; onSel: () => void; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const flash = useFlash(t.trades.length);
  const pnl = t.pnl.equity - t.capital;
  const k = t.usdPerQuote;
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  const toClose = Math.max(0, t.nextCloseAt - Date.now());
  return (
    <div className={`bot-card ${sel ? 'sel' : ''} ${flash ? 'fill-flash' : ''}`} onClick={onSel}>
      <div className="bot-head">
        <Heartbeat beat={t.priceAt} state={t.lastError ? 'error' : t.status} />
        {t.chainShort && t.chainShort !== 'PLS' ? <span className="chain-badge" style={{ ['--cc' as string]: t.chainColor ?? '#888' }}>{t.chainShort}</span> : null}
        <strong>{t.name}</strong>{t.flipped ? <i className="flip-tag" title={`flipped: long ${t.base}, flat in ${t.quoteSym}`}>⇄</i> : null}{t.custom ? <span className={`risk-dot risk-${t.risk ?? 'unknown'}`} title={`custom · ${t.risk ?? 'unknown'}`} /> : null}
        <DexTag name={t.dexName} feeBps={t.feeBps} feeTier={t.feeTier} />
        <span className={`badge ${t.mode}`}>{t.mode}</span>
        <span className={`st ${t.status}`}>{t.status}{t.inFlight ? ' · tx' : ''}{t.queue.length ? ' · queued' : ''}</span>
        <span className="grow" />
        <AnimatedNumber value={pnl} format={(x) => qty(x, t.quoteSym ?? t.quote, 4)} className={cls(pnl)} />
        <span className={`small ${cls(pnl)}`}>({pct(t.pnl.returnPct, 2, true)})</span>
      </div>
      <div className="bot-body small">
        {t.position ? (
          <>
            <span><b>IN</b> {num(t.position.pls, t.position.pls < 10 ? 6 : 0)} {t.base ?? 'PLS'} @ {px(t.position.entryPrice)} · unreal <span className={cls(t.position.unrealized)}>{qty(t.position.unrealized, t.quoteSym ?? t.quote, 3)} ({pct(t.position.unrealizedPct, 2, true)})</span> · {t.position.bars} bars</span>
            <StopGauge pos={t.position} price={t.price} />
          </>
        ) : <span className="muted">flat · {num(t.cash, 4)} {t.quoteSym ?? t.quote} free{k ? ` (≈${usd(t.cash * k)})` : ''}</span>}
        <span className="muted mono">{t.lastNote || '—'}</span>
        <span className="muted">next {t.tf} close in {dur(toClose)} · {t.stats.count} trades · win {pct(t.stats.winRate, 0)} · blocked {t.blocked}{t.lastError ? <span className="neg"> · {t.lastError}</span> : null}</span>
      </div>
      <div className="actions" onClick={(e) => e.stopPropagation()}>
        {t.status === 'running'
          ? <button type="button" className="btn kill small-btn" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/stop`, 'POST'))}>STOP</button>
          : <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(() => botApi(`trends/${t.id}/resume`, 'POST'))}>Resume</button>}
        <button type="button" className="btn small-btn" disabled={busy || !t.position || t.status !== 'running'} onClick={() => act(async () => { if (confirm(`Close position of ${t.name} at market?`)) await botApi(`trends/${t.id}/close`, 'POST'); })}>Close position</button>
        <button type="button" className="btn small-btn danger" disabled={busy || t.status === 'running' || !!t.inFlight} onClick={() => act(async () => { if (confirm(`Remove ${t.name}?`)) await botApi(`trends/${t.id}`, 'DELETE'); })}>Remove</button>
      </div>
    </div>
  );
}

export function TrendBots({ status: s, ticks, act, busy, prefill, onBacktest }: {
  status: AnyObj; ticks: Ticks | null; act: (fn: () => Promise<unknown>) => void; busy: boolean;
  prefill: TrendPrefill | null; onBacktest: (p: { pair: string; tf: TF; cfg: TrendConfig }) => void;
}) {
  const { chain } = useChainFilter();
  const trends: AnyObj[] = (s.trends ?? []).filter((t: AnyObj) => chain === 'all' || (t.chainId ?? s.legacyChainId) === chain);
  const [sel, setSel] = useState<string | null>(null);
  const [cfg, setCfg] = useState<TrendConfig>({ ...DEFAULT_TREND });
  const [f, setF] = useState({ mode: 'paper', pair: 'DAI', tf: '1h' as TF, capitalUsd: '100', name: '', impact: '3', slippage: '1', deadline: '10', gasRes: '2%' });
  useEffect(() => {
    if (!prefill) return;
    setCfg(prefill.cfg);
    setF((x) => ({ ...x, pair: prefill.pair, tf: prefill.tf, capitalUsd: prefill.capitalUsd ? String(prefill.capitalUsd) : x.capitalUsd }));
  }, [prefill]);
  const cur = useMemo(() => trends.find((t) => t.id === sel) ?? trends[0] ?? null, [trends, sel]);
  useEffect(() => {
    const ms = marketsOf(s).filter((m) => m.tradable && (chain === 'all' || m.chainId === chain));
    if (ms.length && !ms.some((m) => m.key === unflipKey(f.pair))) setF((x) => ({ ...x, pair: ms[0].key }));
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const fm = mk(s, f.pair), fc = chainOf(s, fm.chainId);
  // ≈USD per quote: flipped legacy markets are quoted in PLS itself (DAI per PLS).
  const k = fm.usdPerQuote ?? (fm.flipped && fm.legacy ? s.spots?.DAI ?? null : s.spots?.DAI && s.spots?.[f.pair] ? s.spots.DAI / s.spots[f.pair] : null);
  const capQuote = k ? +f.capitalUsd / k : null;
  const gasRes = parseGasRes(f.gasRes);
  const resAmt = capQuote ? gasReserve(capQuote, gasRes ?? DEFAULT_GAS_RESERVE) : null;
  const start = () => act(async () => {
    if (f.mode === 'live' && !confirm(`Start LIVE trend bot ${fm.label} ${f.tf} on ${fc?.name ?? ''} with ≈$${f.capitalUsd} from ${fc?.address ?? s.address}?`)) return;
    const r = await botApi('trends', 'POST', {
      mode: f.mode, quote: f.pair, tf: f.tf, cfg, name: f.name || undefined,
      capital: capQuote ?? undefined, capitalUsd: capQuote ? undefined : +f.capitalUsd,
      limits: {
        maxPriceImpact: +f.impact / 100, slippageBps: Math.round(+f.slippage * 100), deadlineMinutes: +f.deadline,
        ...(fm.quoteNative && gasRes ? { gasReservePct: gasRes.pct, gasReserveNative: gasRes.fixed } : {}),
      },
    });
    setSel(r.id);
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [key]: e.target.value }));

  return (
    <div className="trend-tab">
      <div className="split">
        <div className="card">
          <h3>Trend bots <span className="muted small">long-only · holds the base or {cur?.quoteSym ?? 'quote'} · signals on closed candles · stops on every poll</span></h3>
          {trends.length === 0 && <p className="muted small">No trend bots yet. Configure one on the right — or backtest first.</p>}
          <div className="bot-list">{trends.map((t) => <BotCard key={t.id} t={{ ...t, chainColor: chainOf(s, t.chainId)?.color }} sel={cur?.id === t.id} onSel={() => setSel(t.id)} act={act} busy={busy} />)}</div>
        </div>
        <div className="card">
          <h3>New trend bot</h3>
          <div className="form-row">
            <F label="Mode"><select value={f.mode} onChange={set('mode')}><option value="paper">paper</option><option value="live" disabled={!(fc?.hasSigner ?? s.hasSigner) || !fm.liveAllowed}>live{fm.liveAllowed ? ((fm.buyTaxPct || fm.sellTaxPct) ? ` (tax ${((fm.buyTaxPct ?? 0)*100).toFixed(1)}/${((fm.sellTaxPct ?? 0)*100).toFixed(1)}%)` : '') : ' (blocked: safety)'}</option></select></F>
            <PairPicker s={s} value={f.pair} onChange={(key) => setF((x) => ({ ...x, pair: key }))} />
            <F label="Timeframe"><select value={f.tf} onChange={set('tf')}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></F>
            <F label="Capital ≈$" hint="converted to the quote token at the live USD rate (stables $1; others via the chain's native/stable market)"><input value={f.capitalUsd} onChange={set('capitalUsd')} /></F>
            <F label="Name"><input value={f.name} placeholder="auto" onChange={set('name')} /></F>
          </div>
          <TrendConfigEditor cfg={cfg} onChange={setCfg} />
          <div className="form-row">
            <F label="Impact cap %"><input value={f.impact} onChange={set('impact')} /></F>
            <F label="Slippage %"><input value={f.slippage} onChange={set('slippage')} /></F>
            <F label="Deadline min"><input value={f.deadline} onChange={set('deadline')} /></F>
            {fm.quoteNative && <F label={`Gas reserve (${fm.quote})`} hint={`"2%" of capital or a fixed amount, e.g. "50000"; never traded`}><input value={f.gasRes} onChange={set('gasRes')} /></F>}
          </div>
          <p className="small"><Orientation m={fm} /> <span className="muted">· long {fm.base} when the trend is up, flat in {fm.quote} otherwise{fm.quoteNative ? (gasRes ? ` · gas reserve ${resAmt != null ? num(resAmt, 2) : '?'} ${fm.quote} kept aside (live start needs capital + reserve)` : ' · bad gas reserve') : ''}</span></p>
          <p className="muted small"><ChainBadge c={fc} /> {fm.label} · {feeLabel(fm)} LP fee. {capQuote ? `≈ ${num(capQuote, 4)} ${fm.quote}. ` : ''}Entries must clear the pool's round-trip fee ({(100 * (1 - (1 - fm.feeBps / 1e4) ** 2)).toFixed(3)}%) + impact + gas (+ L2 data fee) + min edge (cost gate). Inventory is separate from grids; live start requires the signing address to cover every live allocation.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => onBacktest({ pair: f.pair, tf: f.tf, cfg })}>Backtest these settings</button>
            <button type="button" className={`btn ${f.mode === 'live' ? 'danger' : 'primary'}`} disabled={busy} onClick={start}>Start {f.mode}</button>
          </div>
        </div>
      </div>

      {cur && (
        <>
          <div className="card">
            <h3>{cur.name} <span className="muted small">{cur.cfg.strategy} · {cur.tf} · started {cur.startedAt ? time(cur.startedAt) : '—'} @ {px(cur.startPrice)}</span></h3>
            <div className="kpis">
              <div><span>Equity</span><AnimatedNumber value={cur.pnl.equity} format={(x) => `${num(x, 4)} ${cur.quote}`} /></div>
              <div><span>vs HODL {cur.base ?? 'PLS'}</span><b className={cls(cur.hodl ? cur.pnl.equity - cur.hodl : null)}>{cur.hodl ? pct(cur.pnl.equity / cur.hodl - 1, 2, true) : '—'}</b></div>
              <div><span>Realized</span><b className={cls(cur.pnl.realized)}>{qty(cur.pnl.realized, cur.quote, 4)}</b></div>
              <div><span>Unrealized</span><b className={cls(cur.pnl.unrealized)}>{qty(cur.pnl.unrealized, cur.quote, 4)}</b></div>
              <div><span>Win rate</span><b>{pct(cur.stats.winRate, 0)}</b></div>
              <div><span>Profit factor</span><b>{cur.stats.profitFactor == null ? '—' : cur.stats.profitFactor === Infinity ? '∞' : num(cur.stats.profitFactor, 2)}</b></div>
              <div><span>Avg trade</span><b className={cls(cur.stats.avg)}>{qty(cur.stats.avg, cur.quote, 3)}</b></div>
              <div><span>Max DD</span><b className="neg">{pct(cur.stats.maxDrawdown, 1)}</b></div>
              <div><span>Streak</span><b>{cur.stats.streak > 0 ? `${cur.stats.streak}W` : cur.stats.streak < 0 ? `${-cur.stats.streak}L` : '—'} <span className="muted">(max {cur.stats.maxWinStreak}W/{cur.stats.maxLossStreak}L)</span></b></div>
              <div><span>In market</span><b>{pct(cur.stats.timeInMarket, 0)}</b></div>
              <div><span>Fees / gas</span><b>{num(cur.pnl.fees, 5)} / {num(cur.pnl.gas, 5)}</b></div>
              <div><span>Best / worst</span><b><span className="pos">{num(cur.stats.best, 4)}</span> / <span className="neg">{num(cur.stats.worst, 4)}</span></b></div>
            </div>
          </div>
          <div className="split">
            <div className="card"><Chart status={s} ticks={ticks} pairs={[cur.quote]} pair={cur.quote} tf={cur.tf} compact height={340} emaFast={cur.cfg.fast} emaSlow={cur.cfg.slow} /></div>
            <div className="card">
              <h3>Equity &amp; drawdown <span className="muted small">{cur.quote}</span></h3>
              <EquityChart series={[{ name: `equity ${cur.quote}`, data: cur.equityHist ?? [], color: '#7c5cff' }]} />
            </div>
          </div>
          <div className="split">
            <div className="card">
              <h3>Signals</h3>
              <div className="sig-list">
                {cur.signals.map((x: AnyObj, i: number) => (
                  <div key={i} className={`sig sig-${x.kind}`}><span className="muted">{time(x.at)}</span> <b>{x.kind}</b> <span className="mono small">{x.note}</span></div>
                ))}
                {!cur.signals.length && <p className="muted small">Waiting for the next closed {cur.tf} candle. {cur.warm?.need ? `Warm-up ${cur.warm.have}/${cur.warm.need} candles.` : ''}</p>}
              </div>
            </div>
            <div className="card">
              <h3>Trades <span className="muted small">({cur.trades.length})</span></h3>
              <div className="table-wrap"><table>
                <thead><tr><th>Time</th><th>Side</th><th>Reason</th><th>{cur.base ?? 'PLS'}</th><th>{cur.quoteSym ?? cur.quote}</th><th>DEX</th><th>Exec</th><th>Slip</th><th>Tax</th><th>Gas</th><th>Net</th><th>Hold</th></tr></thead>
                <tbody>{cur.trades.map((t: AnyObj) => (
                  <tr key={t.id} className={t.failed ? 'failed-row' : ''}>
                    <td>{time(t.timestamp)}</td><td className={`side ${t.side}`}>{t.side}</td><td>{t.reason}</td>
                    <td>{num(t.plsAmount, 0)}</td><td>{num(t.stableAmount, 5)}</td><td className="small nowrap">{dexName(s, cur.chainId, t.dex)}</td><td>{px(t.execPrice ?? t.price)}</td>
                    <td>{pct(t.slippagePct, 3)}</td><td title={t.outSource ? `out via ${t.outSource}` : ''}>{t.taxPct != null && t.taxPct > 0.0005 ? pct(t.taxPct, 2) : '—'}</td><td>{num(t.gasUsd, 6)}</td>
                    <td className={cls(t.side === 'sell' ? t.realizedPnlUsd : null)}>{t.side === 'sell' ? qty(t.realizedPnlUsd, cur.quote, 4) : ''}</td>
                    <td>{t.holdMs ? dur(t.holdMs) : ''}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p className="muted small">Last update {ago(cur.priceAt)} · price {px(cur.price)} {cur.quoteSym ?? cur.quote}/{cur.base ?? 'PLS'}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

