/** Backtester UI: trend or grid on stored candles, realistic costs, metrics vs buy & hold, sweep heatmap, "Use these settings". */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_TREND, type TrendConfig } from '../market/strategy';
import { TFS, type TF } from '../market/candles';
import { http, botApi } from './api';
import { Orientation, PairPicker, chainOf, ChainBadge, feeLabel, mk, unflipKey } from './chains';
import { Chart, EquityChart } from './Chart';
import { TrendConfigEditor } from './TrendConfig';
import { IND, T, alpha } from './theme';
import type { AnyObj, BtPrefill } from './model';
import { cls, dur, num, pct, px, qty, time, usd } from './fmt';

const AXES: Record<string, [string, string]> = { ema: ['fast', 'slow'], ema_rsi: ['fast', 'slow'], macd: ['macdFast', 'macdSlow'], donchian: ['donchianEntry', 'donchianExit'] };
const AXIS_DEFAULTS: Record<string, string> = {
  fast: '5,8,10,13,20,30', slow: '20,30,40,50,80,100', macdFast: '6,8,12,16', macdSlow: '20,26,35,50',
  donchianEntry: '10,20,30,55', donchianExit: '5,10,15,20', stopAtr: '1,1.5,2,3,4', tpR: '0,1,2,3,5', trailAtr: '0,1.5,2,3,4',
};

function Metric({ k, v, sub, c }: { k: string; v: string; sub?: string; c?: string }) {
  return <div className="metric"><span>{k}</span><b className={c}>{v}</b>{sub && <small className="muted">{sub}</small>}</div>;
}

export function Backtest({ status: s, prefill, onUse }: { status: AnyObj; prefill: BtPrefill | null; onUse: (p: { pair: string; tf: TF; cfg: TrendConfig; capitalUsd: number; created?: string }) => void }) {
  const [kind, setKind] = useState<'trend' | 'grid'>('trend');
  const [pair, setPair] = useState('DAI');
  const [tf, setTf] = useState<TF>('4h');
  const [days, setDays] = useState('0');
  const [capUsd, setCapUsd] = useState('100');
  const [cfg, setCfg] = useState<TrendConfig>({ ...DEFAULT_TREND });
  const [grid, setGrid] = useState({ lower: '', upper: '', count: '12' });
  const [costs, setCosts] = useState({ useImpact: true, useGas: true, slippageBps: '10' });
  const [res, setRes] = useState<AnyObj | null>(null);
  const [sweep, setSweep] = useState<AnyObj | null>(null);
  const [axes, setAxes] = useState({ x: 'fast', xs: AXIS_DEFAULTS.fast, y: 'slow', ys: AXIS_DEFAULTS.slow });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<AnyObj[]>([]);

  useEffect(() => { if (prefill) { setKind('trend'); setPair(prefill.pair); setTf(prefill.tf); setCfg(prefill.cfg); } }, [prefill]);
  useEffect(() => { const [x, y] = AXES[cfg.strategy]; setAxes({ x, xs: AXIS_DEFAULTS[x], y, ys: AXIS_DEFAULTS[y] }); }, [cfg.strategy]);
  useEffect(() => { void http('/api/market/summary').then((r) => setSummary(r.series)).catch(() => undefined); }, [res]);
  // Grid range defaults to ±15 % of spot in the selected orientation (HEX/PLS ≈ 1 / PLS/HEX); re-centred on a pair/flip change.
  const lastPair = useRef(pair);
  useEffect(() => {
    const p = s.spots?.[pair] ?? mk(s, pair).spot;
    const changed = lastPair.current !== pair;
    lastPair.current = pair;
    if (p && (!grid.lower || changed)) setGrid((g) => ({ ...g, lower: String(+(p * 0.85).toPrecision(5)), upper: String(+(p * 1.15).toPrecision(5)) }));
  }, [s.spots, pair]); // eslint-disable-line react-hooks/exhaustive-deps

  const range = () => (+days > 0 ? { from: Math.floor(Date.now() / 1000) - +days * 86_400 } : {});
  const costBody = () => ({ useImpact: costs.useImpact, useGas: costs.useGas, slippageBps: +costs.slippageBps });
  const run = async (c = cfg) => {
    setBusy('Running backtest…'); setErr(null);
    try {
      const body = { pair, tf, ...range(), capitalUsd: +capUsd, costs: costBody() };
      setRes(kind === 'trend'
        ? await http('/api/backtest/trend', 'POST', { ...body, cfg: c })
        : await http('/api/backtest/grid', 'POST', { ...body, lowerPrice: +grid.lower, upperPrice: +grid.upper, gridCount: +grid.count }));
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(''); }
  };
  const runSweep = async () => {
    setBusy('Sweeping parameters…'); setErr(null);
    try {
      const list = (v: string) => v.split(',').map((x) => +x.trim()).filter((x) => Number.isFinite(x));
      setSweep(await http('/api/backtest/sweep', 'POST', { pair, tf, ...range(), capitalUsd: +capUsd, cfg, costs: costBody(), xKey: axes.x, xs: list(axes.xs), yKey: axes.y, ys: list(axes.ys) }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const pick = (x: number, y: number) => { const c = { ...cfg, [axes.x]: x, [axes.y]: y }; setCfg(c); void run(c); };
  const use = async (create: boolean) => {
    if (!create) return onUse({ pair, tf, cfg, capitalUsd: +capUsd });
    setBusy('Creating paper bot…');
    try {
      const pm0 = mk(s, pair);
      const k = pm0.usdPerQuote ?? (pm0.flipped && pm0.legacy ? s.spots?.DAI ?? null : s.spots?.DAI && s.spots?.[pair] ? s.spots.DAI / s.spots[pair] : null);
      const r = await botApi('trends', 'POST', { mode: 'paper', quote: pair, tf, cfg, capital: k ? +capUsd / k : undefined, capitalUsd: k ? undefined : +capUsd, name: `BT ${cfg.strategy.toUpperCase()} ${mk(s, pair).label} ${tf}` });
      onUse({ pair, tf, cfg, capitalUsd: +capUsd, created: r.id });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  const m = res?.metrics;
  const pm = mk(s, res?.pair ?? pair);
  const sym = pm.quote;
  const k = res?.usdPerQuote;
  const series = res ? [
    { name: kind === 'trend' ? 'strategy' : 'grid', data: res.equity.map((e: AnyObj) => [e.t * 1000, e.v]) as [number, number][], color: T.text },
    { name: `buy & hold ${pm.base}`, data: res.equity.map((e: AnyObj) => [e.t * 1000, e.bh]) as [number, number][], color: IND.slow, dashed: true },
  ] : [];
  // Flipped series are the original's candles inverted: same count / range / source.
  const pairSummary = summary.find((x) => x.pair === unflipKey(pair))?.series.find((x: AnyObj) => x.tf === tf);

  // heatmap scale
  const rows: AnyObj[] = sweep?.rows ?? [];
  const maxAbs = Math.max(0.0001, ...rows.map((r) => Math.abs(r.totalReturn)));
  const cell = (x: number, y: number) => rows.find((r) => r.x === x && r.y === y);
  const color = (v: number) => alpha(v >= 0 ? T.profit : T.loss, 0.12 + 0.6 * Math.min(1, Math.abs(v) / maxAbs));

  return (
    <div className="bt-tab">
      <div className="card">
        <h3>Backtest <span className="muted small">stored candles · no look-ahead · fee + impact + gas + slippage</span></h3>
        <div className="form-row">
          <label>Type<select value={kind} onChange={(e) => setKind(e.target.value as 'trend' | 'grid')}><option value="trend">Trend strategy</option><option value="grid">Grid config</option></select></label>
          <PairPicker s={s} value={pair} onChange={setPair} />
          <label>Timeframe<select value={tf} onChange={(e) => setTf(e.target.value as TF)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label>Period<select value={days} onChange={(e) => setDays(e.target.value)}><option value="0">all stored</option><option value="7">7 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
          <label>Capital ≈$<input value={capUsd} onChange={(e) => setCapUsd(e.target.value)} /></label>
          <label title="price impact from CURRENT pool reserves"><span>Impact</span><input type="checkbox" checked={costs.useImpact} onChange={(e) => setCosts((c) => ({ ...c, useImpact: e.target.checked }))} /></label>
          <label title="gas at the current gas price"><span>Gas</span><input type="checkbox" checked={costs.useGas} onChange={(e) => setCosts((c) => ({ ...c, useGas: e.target.checked }))} /></label>
          <label>Slip bps<input value={costs.slippageBps} onChange={(e) => setCosts((c) => ({ ...c, slippageBps: e.target.value }))} /></label>
        </div>
        <p className="small"><Orientation m={mk(s, pair)} /> <span className="muted">· {kind === 'grid' ? `levels in ${mk(s, pair).quote}/${mk(s, pair).base}, capital & PnL in ${mk(s, pair).quote}` : `long ${mk(s, pair).base} / flat in ${mk(s, pair).quote}`}{mk(s, pair).flipped ? ' · candles = original inverted (high ↔ 1/low)' : ''}</span></p>
        <p className="muted small">Data: {pairSummary ? `${pairSummary.count} ${tf} candles${pairSummary.from ? ` · ${time(pairSummary.from * 1000)} → ${time(pairSummary.to * 1000)}` : ''} · ${pairSummary.source ?? '—'}` : 'loading…'}</p>
        {kind === 'trend' ? <TrendConfigEditor cfg={cfg} onChange={setCfg} /> : (
          <div className="form-row">
            <label>Lower<input value={grid.lower} onChange={(e) => setGrid((g) => ({ ...g, lower: e.target.value }))} /></label>
            <label>Upper<input value={grid.upper} onChange={(e) => setGrid((g) => ({ ...g, upper: e.target.value }))} /></label>
            <label>Grids<input value={grid.count} onChange={(e) => setGrid((g) => ({ ...g, count: e.target.value }))} /></label>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => run()}>Run backtest</button>
          {kind === 'trend' && <button type="button" className="btn" disabled={!!busy} onClick={runSweep}>Parameter sweep</button>}
          {busy && <span className="muted small spin">{busy}</span>}
        </div>
        {err && <div className="banner warn">{err}</div>}
      </div>

      {res && m && (
        <>
          <div className="card">
            <h3>Result <span className="muted small"><ChainBadge c={chainOf(s, pm.chainId)} /> {pm.label} ({feeLabel(pm)} LP fee) {res.tf} · {res.candles} candles · {time(res.from * 1000)} → {time(res.to * 1000)} ({num(m.days, 1)} days) · capital {num(res.capital, 4)} {sym}{k ? ` ≈ ${usd(res.capital * k)}` : ''}</span></h3>
            <div className="metrics">
              <Metric k="Return" v={pct(m.totalReturn, 2, true)} c={cls(m.totalReturn)} sub={`B&H ${pm.base} ${pct(m.bhReturn, 2, true)}`} />
              <Metric k="vs B&H" v={pct(m.totalReturn - m.bhReturn, 2, true)} c={cls(m.totalReturn - m.bhReturn)} />
              <Metric k="CAGR" v={m.cagr == null ? 'n/a <30d' : pct(m.cagr, 1, true)} />
              <Metric k="Max drawdown" v={pct(m.maxDrawdown, 2)} c="neg" sub={`B&H ${pct(m.bhMaxDrawdown, 1)}`} />
              <Metric k="Trades" v={String(m.trades)} sub={m.blockedByCost ? `${m.blockedByCost} blocked by cost` : undefined} />
              <Metric k="Win rate" v={pct(m.winRate, 1)} />
              <Metric k="Profit factor" v={m.profitFactor == null ? '—' : num(m.profitFactor, 2)} />
              <Metric k="Avg win / loss" v={`${num(m.avgWin, 4)} / ${num(m.avgLoss, 4)}`} sub={sym} />
              <Metric k="Expectancy" v={qty(m.expectancy, sym, 4)} c={cls(m.expectancy)} sub={pct(m.expectancyPct, 2, true) + ' / trade'} />
              <Metric k="Sharpe / Sortino" v={`${num(m.sharpe, 2)} / ${num(m.sortino, 2)}`} sub="annualized, per-bar" />
              <Metric k="Exposure" v={pct(m.exposure, 1)} />
              <Metric k="Fees / gas" v={`${num(m.fees, 4)} / ${num(m.gas, 5)}`} sub={sym} />
            </div>
            <h4 className="muted small">Price · {kind === 'trend' ? 'trade entries (▲) / exits (▼, reason, net %)' : 'grid round-trips'} · latest 1500 candles</h4>
            <Chart status={null} ticks={null} pairs={[res.pair]} pair={res.pair} tf={(res.tf ?? tf) as TF} height={360} compact
              btTrades={res.trades} emaFast={kind === 'trend' && res.cfg?.strategy?.startsWith('ema') ? res.cfg.fast : undefined} emaSlow={kind === 'trend' && res.cfg?.strategy?.startsWith('ema') ? res.cfg.slow : undefined} />
            <h4 className="muted small">Equity vs buy &amp; hold {pm.base}</h4>
            <EquityChart series={series} height={300} format={(v) => num(v, 3)} />
            <ul className="notes small muted">{res.notes.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            {kind === 'trend' && (
              <div className="actions">
                <button type="button" className="btn primary" disabled={!!busy} onClick={() => use(true)}>Use these settings → start paper bot</button>
                <button type="button" className="btn" onClick={() => use(false)}>Edit as a new trend bot</button>
              </div>
            )}
          </div>
          <div className="card">
            <h3>Trades <span className="muted small">({res.trades.length})</span></h3>
            <div className="table-wrap tall"><table>
              <thead><tr><th>Entry</th><th>Exit</th><th>Reason</th><th>Entry px</th><th>Exit px</th><th>{pm.base}</th><th>Cost</th><th>Net</th><th>%</th><th>Fees</th><th>Gas</th><th>Held</th></tr></thead>
              <tbody>{[...res.trades].reverse().map((t: AnyObj, i: number) => (
                <tr key={i}><td>{time(t.entryT * 1000)}</td><td>{time(t.exitT * 1000)}</td><td>{t.reason}</td><td>{px(t.entryPrice)}</td><td>{px(t.exitPrice)}</td>
                  <td>{num(t.pls, 0)}</td><td>{num(t.cost, 4)}</td><td className={cls(t.pnl)}>{qty(t.pnl, '', 4).trim()}</td><td className={cls(t.pnlPct)}>{pct(t.pnlPct, 2, true)}</td>
                  <td>{num(t.fees, 5)}</td><td>{num(t.gas, 6)}</td><td>{t.bars ? `${t.bars} bars` : dur((t.exitT - t.entryT) * 1000)}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
        </>
      )}

      {kind === 'trend' && (
        <div className="card">
          <h3>Parameter sweep <span className="muted small">heatmap of total return · click a cell to load it</span></h3>
          <div className="form-row">
            <label>X<select value={axes.x} onChange={(e) => setAxes((a) => ({ ...a, x: e.target.value, xs: AXIS_DEFAULTS[e.target.value] }))}>{Object.keys(AXIS_DEFAULTS).map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="wide">X values<input value={axes.xs} onChange={(e) => setAxes((a) => ({ ...a, xs: e.target.value }))} /></label>
            <label>Y<select value={axes.y} onChange={(e) => setAxes((a) => ({ ...a, y: e.target.value, ys: AXIS_DEFAULTS[e.target.value] }))}>{Object.keys(AXIS_DEFAULTS).map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="wide">Y values<input value={axes.ys} onChange={(e) => setAxes((a) => ({ ...a, ys: e.target.value }))} /></label>
          </div>
          {sweep && (
            <>
              <div className="heat-wrap"><table className="heat">
                <thead><tr><th>{sweep.yKey} ↓ / {sweep.xKey} →</th>{sweep.xs.map((x: number) => <th key={x}>{x}</th>)}</tr></thead>
                <tbody>{sweep.ys.map((y: number) => (
                  <tr key={y}><th>{y}</th>{sweep.xs.map((x: number) => {
                    const r = cell(x, y);
                    const best = sweep.best && sweep.best.x === x && sweep.best.y === y;
                    return r ? (
                      <td key={x} className={best ? 'best' : ''} style={{ background: color(r.totalReturn) }} onClick={() => pick(x, y)}
                        title={`${sweep.xKey}=${x} ${sweep.yKey}=${y}\nreturn ${pct(r.totalReturn, 2)} · maxDD ${pct(r.maxDrawdown, 1)}\ntrades ${r.trades} · win ${pct(r.winRate, 0)} · PF ${num(r.profitFactor, 2)} · Sharpe ${num(r.sharpe, 2)}`}>
                        {pct(r.totalReturn, 1, true)}<small>{r.trades}t</small>
                      </td>
                    ) : <td key={x} className="na">—</td>;
                  })}</tr>
                ))}</tbody>
              </table></div>
              <div className="overfit">
                <strong>Overfitting warning.</strong> {sweep.notes.join(' ')}
                {sweep.best && <> Best in-sample: {sweep.xKey}={sweep.best.x}, {sweep.yKey}={sweep.best.y} → {pct(sweep.best.totalReturn, 2, true)} ({sweep.best.trades} trades).</>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
