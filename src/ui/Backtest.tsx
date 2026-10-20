/** Backtester UI: trend or grid on stored candles, realistic costs, metrics vs buy & hold, sweep heatmap, "Use these settings". */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_TREND, type TrendConfig } from '../market/strategy';
import { SWEEP_AXES, type SweepKey } from '../market/backtest';
import { TFS, type TF } from '../market/candles';
import { http, botApi } from './api';
import { Orientation, PairPicker, chainOf, ChainBadge, feeLabel, mk, unflipKey } from './chains';
import { Chart, EquityChart } from './Chart';
import { TrendConfigEditor } from './TrendConfig';
import { LinesEditor } from './LinesEditor';
import { IND, T, alpha } from './theme';
import type { AnyObj, BtPrefill } from './model';
import { cls, dur, num, pct, px, qty, time, usd } from './fmt';
import { L, Tip } from './Tip';
import { humanAmount } from '../live/amount';

const AXIS_DEFAULTS: Record<SweepKey, string> = {
  fast: '5,8,10,13,20,30', slow: '20,30,40,50,80,100', macdFast: '6,8,12,16', macdSlow: '20,26,35,50',
  donchianEntry: '10,20,30,55', donchianExit: '5,10,15,20', stopAtr: '1,1.5,2,3,4', tpR: '0,1,2,3,5', trailAtr: '0,1.5,2,3,4',
};

function Metric({ k, v, sub, c, tip }: { k: string; v: string; sub?: string; c?: string; tip: string }) {
  return <div className="metric"><span><L tip={tip}>{k}</L></span><b className={c}>{v}</b>{sub && <small className="muted">{sub}</small>}</div>;
}

/** Each slice of the result in the coin it spends: what price moves did, then everything the swaps paid. */
function Breakdown({ m, sym }: { m: AnyObj; sym: string }) {
  const rows: [string, number, string][] = [
    ['Price moves', m.priceEffect, 'What the coins gained or lost because the price changed, before any costs. A grid also earns here: each completed trade sells one level higher than it bought.'],
    ['Pool fees', -m.fees, 'The pool\'s fee on every swap (this pool: the LP fee shown above). Liquidity providers earn it.'],
    ['Price impact', -m.impact, 'Every swap moves the pool\'s price against you, more the bigger the swap is next to the coins the pool holds near the price. Small trades pay almost nothing; trades as big as the pool lose most of their value.'],
    ['Slippage', -m.slippage, 'The extra worse price assumed on every swap (the Slip bps setting), for the price moving before your swap lands.'],
    ['Gas', -m.gas, 'Network fees for every swap and approval at today\'s gas price.'],
  ];
  const total = m.endEquity - m.startEquity, big = Math.max(...rows.map((r) => Math.abs(r[1])), Math.abs(total), 1e-12);
  return (
    <div className="bd">
      <h4><L tip="The result split into what the price did and what each cost took. They add up to the result exactly.">Where the result came from</L></h4>
      {rows.map(([k, v, tip]) => (
        <div key={k} className="bd-row">
          <span><L tip={tip}>{k}</L></span>
          <span className="bd-bar"><i className={v >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(v) / big) * 100}%` }} /></span>
          <b className={cls(v)}>{qty(v, sym, 4)}</b>
        </div>
      ))}
      <div className="bd-row bd-total"><span>Result</span><span /><b className={cls(total)}>{qty(total, sym, 5)}</b></div>
    </div>
  );
}

/** One trade (a grid level, or a trend bot's whole amount) next to the coins the pool holds near the price. */
function SizeWarning({ m, sym, usdPer, levels }: { m: AnyObj; sym: string; usdPer: number | null; levels: number | null }) {
  const tooDeep = m.poolDepth != null && m.tradeSize > 0.25 * m.poolDepth;
  if (!(m.tradeImpactPct > 0.02) && !tooDeep) return null;
  const amt = (x: number) => `${humanAmount(x)} ${sym}${usdPer ? ` (≈ ${usd(x * usdPer)})` : ''}`;
  // constant-product impact ≈ size ÷ (depth + size): under 1% when one trade is below depth ÷ 99
  const ok1 = m.poolDepth != null ? m.poolDepth / 99 : null;
  return (
    <div className="banner error">
      <span className="grow">
        <b>Too big for this pool.</b> One trade here is {amt(m.tradeSize)}{m.poolDepth != null ? <> and the pool holds about {amt(m.poolDepth)} near the price</> : null}, so each trade moves the price about <b>{pct(m.tradeImpactPct, 1)}</b> against you.
        {' '}That is where this result comes from: <b>{qty(-m.impact, sym, 4)}</b> lost to price impact. Holding loses {pct(m.bhEntryImpactPct, 1)} the same way, just from its one buy at the start.
        {ok1 != null && <> Keep one trade under about {amt(ok1)}{levels ? <> (an amount under {amt(ok1 * levels)} with {levels} levels)</> : null} to pay less than 1% impact.</>}
        {tooDeep && <> The real cost would be even higher: most of a V3 pool's coins sit in a narrow band around the price, and a trade this big runs past them.</>}
      </span>
    </div>
  );
}

export function Backtest({ status: s, prefill, onUse }: { status: AnyObj; prefill: BtPrefill | null; onUse: (p: { pair: string; tf: TF; cfg: TrendConfig; capital: number; created?: string }) => void }) {
  const [kind, setKind] = useState<'trend' | 'grid'>('trend');
  const [pair, setPair] = useState('DAI');
  const [tf, setTf] = useState<TF>('4h');
  const [days, setDays] = useState('0');
  const [amount, setAmount] = useState('');
  const [cfg, setCfg] = useState<TrendConfig>({ ...DEFAULT_TREND });
  const [grid, setGrid] = useState({ lower: '', upper: '', count: '12' });
  const [costs, setCosts] = useState({ useImpact: true, useGas: true, slippageBps: '10' });
  const [res, setRes] = useState<AnyObj | null>(null);
  const [sweep, setSweep] = useState<AnyObj | null>(null);
  const [axes, setAxes] = useState<{ x: SweepKey; xs: string; y: SweepKey; ys: string }>({ x: 'fast', xs: AXIS_DEFAULTS.fast, y: 'slow', ys: AXIS_DEFAULTS.slow });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<AnyObj[]>([]);

  useEffect(() => { if (prefill) { setKind('trend'); setPair(prefill.pair); setTf(prefill.tf); setCfg(prefill.cfg); } }, [prefill]);
  useEffect(() => { const [x, y] = SWEEP_AXES[cfg.strategy]; setAxes({ x, xs: AXIS_DEFAULTS[x], y, ys: AXIS_DEFAULTS[y] }); }, [cfg.strategy]);
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
      const body = { pair, tf, ...range(), capital: +amount, costs: costBody() };
      setRes(kind === 'trend'
        ? await http('/api/backtest/trend', 'POST', { ...body, cfg: c })
        : await http('/api/backtest/grid', 'POST', { ...body, lowerPrice: +grid.lower, upperPrice: +grid.upper, gridCount: +grid.count }));
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(''); }
  };
  const runSweep = async () => {
    setBusy('Sweeping parameters…'); setErr(null);
    try {
      const list = (v: string) => v.split(',').map((x) => +x.trim()).filter((x) => Number.isFinite(x));
      setSweep(await http('/api/backtest/sweep', 'POST', { pair, tf, ...range(), capital: +amount, cfg, costs: costBody(), xKey: axes.x, xs: list(axes.xs), yKey: axes.y, ys: list(axes.ys) }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const pick = (x: number, y: number) => { const c = { ...cfg, [axes.x]: x, [axes.y]: y }; setCfg(c); void run(c); };
  const use = async (create: boolean) => {
    if (!create) return onUse({ pair, tf, cfg, capital: +amount });
    setBusy('Creating paper bot…');
    try {
      const pm0 = mk(s, pair);
      const r = await botApi('trends', 'POST', { mode: 'paper', quote: pair, tf, cfg, capital: +amount, name: `BT ${cfg.strategy.toUpperCase()} ${pm0.label} ${tf}` });
      onUse({ pair, tf, cfg, capital: +amount, created: r.id });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  const m = res?.metrics;
  const pm = mk(s, res?.pair ?? pair);
  const sym = pm.quote;
  const series = res ? [
    { name: kind === 'trend' ? 'strategy' : 'grid', data: res.equity.map((e: AnyObj) => [e.t * 1000, e.v]) as [number, number][], color: T.text },
    { name: `holding ${pm.base}`, data: res.equity.map((e: AnyObj) => [e.t * 1000, e.bh]) as [number, number][], color: IND.slow, dashed: true },
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
          <label><L tip="Grid: buys a little on each dip and sells it one level higher, inside a price range. Trend: buys when a trend starts and sells at a stop, take-profit or exit signal.">Type</L><select value={kind} onChange={(e) => setKind(e.target.value as 'trend' | 'grid')}><option value="trend">Trend strategy</option><option value="grid">Grid config</option></select></label>
          <PairPicker s={s} value={pair} onChange={setPair} />
          <label><L tip="Candle size to replay. A grid checks each candle's high and low for level crossings; a trend strategy decides on each closed candle.">Timeframe</L><select value={tf} onChange={(e) => setTf(e.target.value as TF)}>{TFS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label><L tip="How much of the stored history to replay, counting back from the latest candle.">Period</L><select value={days} onChange={(e) => setDays(e.target.value)}><option value="0">all stored</option><option value="7">7 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label>
          <label><L tip={`How much to test with, in ${mk(s, pair).quote} (the coin it spends), not in dollars. Use what you would really put in: price impact grows with the size of each trade.`}>Amount ({mk(s, pair).quote})</L><input value={amount} placeholder="0" inputMode="decimal" onChange={(e) => setAmount(e.target.value.replace(/,/g, ''))} />
            {+amount > 0 && mk(s, pair).usdPerQuote ? <span className="muted">≈ {usd(+amount * mk(s, pair).usdPerQuote!)} at today's price</span> : null}</label>
          <label><L tip="Charge price impact: a swap moves the pool's price against you, more the bigger it is. Uses the coins the pool holds near today's price. Leave on.">Impact</L><input type="checkbox" checked={costs.useImpact} onChange={(e) => setCosts((c) => ({ ...c, useImpact: e.target.checked }))} /></label>
          <label><L tip="Charge network gas for every swap and approval at today's gas price. Leave on.">Gas</L><input type="checkbox" checked={costs.useGas} onChange={(e) => setCosts((c) => ({ ...c, useGas: e.target.checked }))} /></label>
          <label><L tip="Extra worse price assumed on every swap, in basis points: 10 = 0.10%. Covers the price moving between the quote and the swap landing.">Slippage (bps)</L><input value={costs.slippageBps} onChange={(e) => setCosts((c) => ({ ...c, slippageBps: e.target.value }))} /></label>
        </div>
        <p className="small"><Orientation m={mk(s, pair)} /> <span className="muted">· {kind === 'grid' ? `levels in ${mk(s, pair).quote}/${mk(s, pair).base}, capital & PnL in ${mk(s, pair).quote}` : `long ${mk(s, pair).base} / flat in ${mk(s, pair).quote}`}{mk(s, pair).flipped ? ' · candles = original inverted (high ↔ 1/low)' : ''}</span></p>
        <p className="muted small">Data: {pairSummary ? `${pairSummary.count} ${tf} candles${pairSummary.from ? ` · ${time(pairSummary.from * 1000)} → ${time(pairSummary.to * 1000)}` : ''} · ${pairSummary.source ?? '—'}` : 'loading…'}</p>
        {kind === 'trend' && cfg.strategy === 'lines' && <LinesEditor s={s} pair={pair} tf={tf} lines={cfg.lines} onChange={(lines) => setCfg({ ...cfg, lines })} />}
        {kind === 'trend' ? <TrendConfigEditor cfg={cfg} onChange={setCfg} /> : (
          <div className="form-row">
            <label><L tip="Lowest grid level. Below it every level has bought and the grid waits for the price to come back.">Lowest price</L><input value={grid.lower} onChange={(e) => setGrid((g) => ({ ...g, lower: e.target.value }))} /></label>
            <label><L tip="Highest grid level. Above it everything is sold and the grid waits.">Highest price</L><input value={grid.upper} onChange={(e) => setGrid((g) => ({ ...g, upper: e.target.value }))} /></label>
            <label><L tip="How many slices the range is cut into. The amount is split evenly over them, so more levels means smaller trades that happen more often.">Levels</L><input value={grid.count} onChange={(e) => setGrid((g) => ({ ...g, count: e.target.value }))} /></label>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" disabled={!!busy || !(+amount > 0)} title={+amount > 0 ? '' : 'Enter an amount first'} onClick={() => run()}>Run backtest</button>
          {kind === 'trend' && <button type="button" className="btn" disabled={!!busy || !(+amount > 0)} onClick={runSweep}>Parameter sweep</button>}
          {busy && <span className="muted small spin">{busy}</span>}
        </div>
        {err && <div className="banner warn">{err}</div>}
      </div>

      {res && m && (
        <>
          <div className="card">
            <h3>Result <Tip>Replays the stored candles of this pair as if the bot had run then. Every swap pays this pool's fee, price impact (from the coins the pool holds near today's price), the slippage setting and today's gas. Past results don't promise future ones.</Tip> <span className="muted small"><ChainBadge c={chainOf(s, pm.chainId)} /> {pm.label} ({feeLabel(pm)} LP fee) {res.tf} · {res.candles} candles{res.spikes ? <> · <L tip="One big trade in a thin pool can print a price far from the real one for a moment, and the pool is put straight back. The test clips those prints to the pair's normal range, because no bot could have bought or sold there. The price chart below still shows them as they were printed.">{res.spikes} spike{res.spikes === 1 ? '' : 's'} clipped</L></> : null} · {time(res.from * 1000)} → {time(res.to * 1000)} ({num(m.days, 1)} days) · amount {num(res.capital, 4)} {sym}</span></h3>
            <SizeWarning m={m} sym={sym} usdPer={res.usdPerQuote ?? null} levels={kind === 'grid' ? +grid.count : null} />
            <div className="metrics">
              <Metric k="Return" tip="Profit or loss at the end as a share of the amount, after every cost. Coins still held at the end are valued at the last price." v={pct(m.totalReturn, 2, true)} c={cls(m.totalReturn)} sub={`holding ${pm.base}: ${pct(m.bhReturn, 2, true)}`} />
              <Metric k="vs holding" tip={`Return minus what buying ${pm.base} with the whole amount at the start and just holding it would have returned (same fees and impact).`} v={pct(m.totalReturn - m.bhReturn, 2, true)} c={cls(m.totalReturn - m.bhReturn)} />
              <Metric k="Per year" tip="The return scaled to a year (CAGR). Only shown for tests of 30 days or more: a short test scaled up would exaggerate." v={m.cagr == null ? 'test < 30 days' : pct(m.cagr, 1, true)} />
              <Metric k="Worst drop" tip="Max drawdown: the biggest fall in the bot's value from a high point to a later low." v={pct(m.maxDrawdown, 2)} c="neg" sub={`holding: ${pct(m.bhMaxDrawdown, 1)}`} />
              <Metric k="Trades" tip={kind === 'grid' ? 'Completed buy → sell round trips (one level bought and sold one level higher).' : 'Completed buy → sell round trips. Blocked = signals skipped because the expected move would not cover the costs.'} v={String(m.trades)} sub={m.blockedByCost ? `${m.blockedByCost} blocked by cost` : undefined} />
              <Metric k="Win rate" tip="Share of completed trades that made money after all costs." v={pct(m.winRate, 1)} />
              <Metric k="Profit factor" tip="Money made by winning trades ÷ money lost by losing ones. Above 1 means it made more than it lost; 0 means every trade lost." v={m.profitFactor == null ? '—' : num(m.profitFactor, 2)} />
              <Metric k="Avg win / loss" tip="Average result of a winning trade and of a losing one, in the coin it spends." v={`${m.avgWin == null ? '—' : num(m.avgWin, 4)} / ${m.avgLoss == null ? '—' : num(m.avgLoss, 4)}`} sub={sym} />
              <Metric k="Per trade" tip="Expectancy: the average result of one completed trade, in the coin and as a share of what that trade put in." v={qty(m.expectancy, sym, 4)} c={cls(m.expectancy)} sub={pct(m.expectancyPct, 2, true) + ' of the trade'} />
              <Metric k="Sharpe / Sortino" tip="Return for each unit of up-and-down swinging, scaled to a year. Sharpe counts every swing, Sortino only the drops. Above 1 is good; negative means it lost money." v={`${num(m.sharpe, 2)} / ${num(m.sortino, 2)}`} />
              <Metric k="Time holding" tip={`Exposure: the share of the time the bot held ${pm.base} (its value then moves with the price).`} v={pct(m.exposure, 1)} />
              <Metric k="One trade's impact" tip="How far one trade of this test's size moves the pool's price at the start. Under 1% is fine; above a few % the size is too big for the pool." v={pct(m.tradeImpactPct, 2)} c={m.tradeImpactPct > 0.02 ? 'neg' : ''} sub={`${humanAmount(m.tradeSize)} ${sym} per trade`} />
            </div>
            <Breakdown m={m} sym={sym} />
            <h4 className="muted small">Price · {kind === 'trend' ? 'trade entries (▲) / exits (▼, reason, net %)' : 'grid round-trips'} · latest 1500 candles</h4>
            <Chart status={s} ticks={null} pairs={[res.pair]} pair={res.pair} tf={(res.tf ?? tf) as TF} height={360} compact
              btTrades={res.trades} drawn={res.cfg?.strategy === 'lines' ? res.cfg.lines : undefined} emaFast={kind === 'trend' && res.cfg?.strategy?.startsWith('ema') ? res.cfg.fast : undefined} emaSlow={kind === 'trend' && res.cfg?.strategy?.startsWith('ema') ? res.cfg.slow : undefined} />
            <h4 className="muted small"><L tip={`The bot's value over time (solid) and the same amount simply bought as ${pm.base} at the start and held (dashed).`}>Value vs holding {pm.base}</L></h4>
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
              <thead><tr><th>Bought</th><th>Sold</th><th>Why sold</th><th>Buy price</th><th>Sell price</th><th>{pm.base}</th><th>Cost <Tip>What the buy cost, including its gas, in {sym}.</Tip></th><th>Result <Tip>What the sell brought in minus the cost, after every fee, impact and gas, in {sym}.</Tip></th><th>%</th><th>Fees <Tip>Pool fees of the buy and the sell.</Tip></th><th>Gas</th><th>Held</th></tr></thead>
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
            <label>X<select value={axes.x} onChange={(e) => setAxes((a) => ({ ...a, x: e.target.value as SweepKey, xs: AXIS_DEFAULTS[e.target.value as SweepKey] }))}>{Object.keys(AXIS_DEFAULTS).map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="wide">X values<input value={axes.xs} onChange={(e) => setAxes((a) => ({ ...a, xs: e.target.value }))} /></label>
            <label>Y<select value={axes.y} onChange={(e) => setAxes((a) => ({ ...a, y: e.target.value as SweepKey, ys: AXIS_DEFAULTS[e.target.value as SweepKey] }))}>{Object.keys(AXIS_DEFAULTS).map((x) => <option key={x}>{x}</option>)}</select></label>
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
