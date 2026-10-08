/**
 * Price chart (lightweight-charts v5): candles + volume, EMA / Donchian / Bollinger overlays, RSI and MACD panes,
 * grid levels as price lines, fill markers, trend entries/exits, stop/TP lines. Live: the last candle follows
 * the SSE price ticks; markers/lines refresh on status pushes without rebuilding the chart (zoom is kept).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { bollinger, donchian, ema, macd, rsi } from '../market/indicators';
import { TFS, TF_SEC, type Candle, type TF } from '../market/candles';
import { http } from './api';
import { px, num, ago } from './fmt';
import type { Ticks } from './useStream';
import { ChainBadge, MarketOptions, chainOf, feeLabel, flipKey, isFlipKey, mk, orientedKey, unflipKey } from './chains';
import { IND, T, alpha, chartBase } from './theme';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const C = { up: T.profit, down: T.loss, fast: IND.fast, slow: IND.slow, dc: IND.band, bb: IND.band, grid: alpha(T.muted, 0.45), stop: T.loss, tp: T.profit, entry: T.text, flat: alpha(T.muted, 0.35) };
const fmtPx = (p: number) => px(p, 5);
const ts = (s: number) => s as UTCTimestamp;

export interface ChartProps {
  status: AnyObj | null;
  ticks: Ticks | null;
  pairs: string[];
  pair?: string;
  tf?: TF;
  onPairChange?: (p: string) => void;
  height?: number;
  compact?: boolean;
  /** EMA lengths for the overlay (e.g. from a selected trend bot) */
  emaFast?: number;
  emaSlow?: number;
  /** Backtest trades to mark (entry ▲ / exit ▼ with reason and %) */
  btTrades?: { entryT: number; exitT: number; pnlPct: number; reason: string }[];
}

export function Chart(p: ChartProps) {
  const [pair, setPair] = useState(p.pair ?? p.pairs[0] ?? 'DAI');
  const pm = mk(p.status ?? {}, pair);
  const [tf, setTf] = useState<TF>(p.tf ?? '1h');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [meta, setMeta] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ov, setOv] = useState({ ema: true, dc: false, bb: false, vol: true, rsi: !p.compact, macd: false, bots: true });
  const [legend, setLegend] = useState<Candle | null>(null);
  const [backfill, setBackfill] = useState('');
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fast = p.emaFast ?? 9, slow = p.emaSlow ?? 21;

  useEffect(() => { if (p.pair) setPair(p.pair); }, [p.pair]);
  useEffect(() => { if (p.tf) setTf(p.tf); }, [p.tf]);

  // load candles (and refresh every minute: picks up GeckoTerminal backfills / closes)
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/market/candles?pair=${encodeURIComponent(pair)}&tf=${tf}&limit=1500`)
      .then((r) => { if (!dead) { setCandles(r.candles); setMeta(r.meta); setErr(null); } })
      .catch((e) => !dead && setErr((e as Error).message));
    void load();
    const id = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(id); };
  }, [pair, tf]);

  // build chart
  useEffect(() => {
    if (!el.current || !candles.length) return;
    const ch = createChart(el.current, {
      height: p.height ?? 460, autoSize: true,
      ...chartBase,
      grid: { vertLines: { color: alpha(T.line, 0.6) }, horzLines: { color: alpha(T.line, 0.6) } },
      timeScale: { borderColor: T.line, timeVisible: tf !== '1d', secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: fmtPx, timeFormatter: (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) },
    });
    chart.current = ch;
    const priceFormat = { type: 'custom' as const, formatter: fmtPx, minMove: 1e-12 };
    const k = candles;
    const data = k.map((x) => ({ time: ts(x.t), open: x.o, high: x.h, low: x.l, close: x.c, ...(x.f ? { color: C.flat, wickColor: C.flat, borderColor: C.flat } : {}) }));
    const c = ch.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down, priceFormat }, 0);
    c.setData(data);
    cs.current = c;
    markers.current = createSeriesMarkers(c, []);
    const closes = k.map((x) => x.c);
    const line = (vals: (number | null)[], color: string, pane = 0, width = 1, style: LineStyle = LineStyle.Solid, title = '') => {
      const s = ch.addSeries(LineSeries, { color, lineWidth: width as 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat, title }, pane);
      s.setData(vals.map((v, i) => (v == null ? { time: ts(k[i].t) } : { time: ts(k[i].t), value: v })));
      return s;
    };
    if (ov.vol) {
      const v = ch.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 0);
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(k.map((x) => ({ time: ts(x.t), value: x.v, color: alpha(x.c >= x.o ? C.up : C.down, 0.3) })));
    }
    if (ov.ema) { line(ema(closes, fast), C.fast, 0, 2, LineStyle.Solid, `EMA${fast}`); line(ema(closes, slow), C.slow, 0, 2, LineStyle.Solid, `EMA${slow}`); }
    if (ov.dc) { const d = donchian(k, 20); line(d.upper, C.dc, 0, 1, LineStyle.Dashed); line(d.lower, C.dc, 0, 1, LineStyle.Dashed); }
    if (ov.bb) { const b = bollinger(closes, 20, 2); line(b.upper, C.bb, 0, 1, LineStyle.Dotted); line(b.mid, C.bb, 0, 1, LineStyle.Dotted); line(b.lower, C.bb, 0, 1, LineStyle.Dotted); }
    let pane = 1;
    if (ov.rsi) {
      const r = line(rsi(closes, 14), IND.rsi, pane, 1, LineStyle.Solid, 'RSI14');
      r.applyOptions({ priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      r.createPriceLine({ price: 70, color: alpha(C.down, 0.5), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      r.createPriceLine({ price: 30, color: alpha(C.up, 0.5), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      pane++;
    }
    if (ov.macd) {
      const m = macd(closes);
      const h = ch.addSeries(HistogramSeries, { priceFormat, lastValueVisible: false, priceLineVisible: false }, pane);
      h.setData(m.hist.map((v, i) => (v == null ? { time: ts(k[i].t) } : { time: ts(k[i].t), value: v, color: alpha(v >= 0 ? C.up : C.down, 0.5) })));
      line(m.line, IND.macd, pane, 1, LineStyle.Solid, 'MACD');
      line(m.signal, IND.signal, pane, 1, LineStyle.Solid, 'signal');
      pane++;
    }
    const panes = ch.panes();
    panes.forEach((pn, i) => pn.setStretchFactor(i === 0 ? 3 : 1));
    ch.subscribeCrosshairMove((e) => {
      const d = e.seriesData.get(c) as AnyObj | undefined;
      setLegend(d ? { t: e.time as number, o: d.open, h: d.high, l: d.low, c: d.close, v: 0 } : null);
    });
    ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, k.length - (p.compact ? 120 : 200)), to: k.length + 3 });
    return () => { ch.remove(); chart.current = null; cs.current = null; markers.current = null; lines.current = []; };
  }, [candles, ov.ema, ov.dc, ov.bb, ov.vol, ov.rsi, ov.macd, fast, slow, p.height, p.compact, tf]); // eslint-disable-line react-hooks/exhaustive-deps

  // live last candle from SSE ticks (mutates the loaded array in place: no chart rebuild, zoom kept)
  useEffect(() => {
    // Flipped charts read the original's inverted series, so they follow the original's tick inverted.
    const o = isFlipKey(pair) ? p.ticks?.prices?.[unflipKey(pair)] : undefined;
    const price = isFlipKey(pair) ? (o && o > 0 ? 1 / o : undefined) : p.ticks?.prices?.[pair];
    if (!price || !cs.current || !candles.length) return;
    const b = Math.floor(p.ticks!.t / 1000 / TF_SEC[tf]) * TF_SEC[tf];
    let last = candles[candles.length - 1];
    if (b < last.t) return;
    if (b > last.t) { last = { t: b, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 }; candles.push(last); }
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price;
    cs.current.update({ time: ts(last.t), open: last.o, high: last.h, low: last.l, close: last.c });
  }, [p.ticks]); // eslint-disable-line react-hooks/exhaustive-deps

  // bot overlays: grid levels, fills, trend entries/exits, stop/TP
  const botsHere = useMemo(() => {
    const s = p.status;
    if (!s) return { grids: [] as AnyObj[], trends: [] as AnyObj[] };
    return { grids: (s.grids ?? []).filter((g: AnyObj) => g.stable === pair && g.config), trends: (s.trends ?? []).filter((t: AnyObj) => t.quote === pair) };
  }, [p.status, pair]);
  useEffect(() => {
    const c = cs.current;
    if (!c || !markers.current) return;
    for (const l of lines.current) c.removePriceLine(l);
    lines.current = [];
    if (!ov.bots || !candles.length) { markers.current.setMarkers([]); return; }
    const s0 = candles[0].t, tfs = TF_SEC[tf];
    const snap = (ms: number) => Math.floor(ms / 1000 / tfs) * tfs;
    const mk: SeriesMarker<Time>[] = [];
    for (const g of botsHere.grids) {
      if (g.status === 'running') {
        const lv = new Set<number>();
        for (const iv of g.intervals ?? []) { lv.add(iv.buyPrice); lv.add(iv.sellPrice); }
        for (const price of lv) lines.current.push(c.createPriceLine({ price, color: C.grid, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' }));
      }
      for (const t of g.trades ?? []) {
        if (t.failed || snap(t.timestamp) < s0) continue;
        mk.push({ time: ts(snap(t.timestamp)), position: t.side === 'buy' ? 'belowBar' : 'aboveBar', color: t.side === 'buy' ? C.up : C.down, shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', size: 0.6, text: '' });
      }
    }
    for (const t of botsHere.trends) {
      for (const tr of t.trades ?? []) {
        if (tr.failed || snap(tr.timestamp) < s0) continue;
        const buy = tr.side === 'buy';
        mk.push({ time: ts(snap(tr.timestamp)), position: buy ? 'belowBar' : 'aboveBar', color: buy ? C.entry : tr.realizedPnlUsd >= 0 ? C.up : C.down, shape: buy ? 'arrowUp' : 'arrowDown', size: 1.3, text: buy ? 'buy' : `${tr.reason} ${tr.realizedPnlUsd >= 0 ? '+' : ''}${num(tr.realizedPnlUsd, 3)}` });
      }
      if (t.position) {
        const r = t.position.risk;
        lines.current.push(c.createPriceLine({ price: r.entry, color: C.entry, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'entry' }));
        lines.current.push(c.createPriceLine({ price: r.stop, color: C.stop, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: r.stop > r.initialStop ? 'trail' : 'stop' }));
        if (r.tp) lines.current.push(c.createPriceLine({ price: r.tp, color: C.tp, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'TP' }));
      }
    }
    for (const t of p.btTrades ?? []) {
      // backtest times are candle open times in seconds
      if (snap(t.exitT * 1000) < s0) continue;
      if (snap(t.entryT * 1000) >= s0) mk.push({ time: ts(snap(t.entryT * 1000)), position: 'belowBar', color: C.entry, shape: 'arrowUp', size: 1.1, text: 'buy' });
      mk.push({ time: ts(snap(t.exitT * 1000)), position: 'aboveBar', color: t.pnlPct >= 0 ? C.up : C.down, shape: 'arrowDown', size: 1.1, text: `${t.reason} ${t.pnlPct >= 0 ? '+' : ''}${(t.pnlPct * 100).toFixed(1)}%` });
    }
    mk.sort((a, b) => (a.time as number) - (b.time as number));
    markers.current.setMarkers(mk);
  }, [botsHere, candles, ov.bots, tf, p.btTrades]);

  const toggle = (k: keyof typeof ov) => setOv((o) => ({ ...o, [k]: !o[k] }));
  const changePair = (x: string) => { setPair(x); p.onPairChange?.(x); };
  const last = candles[candles.length - 1];
  const lg = legend ?? last;
  const runBackfill = async (source: 'gecko' | 'onchain') => {
    setBackfill('starting…');
    try { await http('/api/market/backfill', 'POST', { pair, source, days: 30 }); setBackfill(`${source} backfill running — see activity feed`); } catch (e) { setBackfill((e as Error).message); }
  };

  return (
    <div className="chart-wrap">
      <div className="chart-bar">
        {p.pairs.length > 6
          ? <select className="pair-select" value={unflipKey(pair)} onChange={(e) => changePair(orientedKey(e.target.value, isFlipKey(pair)))} aria-label="market"><MarketOptions s={p.status ?? {}} all includeKey={pair} flipped={isFlipKey(pair)} /></select>
          : p.pairs.length > 1 ? <div className="seg">{p.pairs.map((x) => { const k = orientedKey(x, isFlipKey(pair)); return <button key={x} type="button" className={unflipKey(x) === unflipKey(pair) ? 'on' : ''} onClick={() => changePair(k)}>{mk(p.status ?? {}, k).legacy ? mk(p.status ?? {}, k).label : mk(p.status ?? {}, k).label.replace(/·.*/, '')}</button>; })}</div> : null}
        {!p.compact && <button type="button" className={`flip-btn ${isFlipKey(pair) ? 'on' : ''}`} aria-pressed={isFlipKey(pair)} aria-label="flip base and quote" title={`Flip → ${mk(p.status ?? {}, flipKey(pair)).label} (inverted OHLC: high ↔ 1/low)`} onClick={() => changePair(flipKey(pair))}>⇄</button>}
        <div className="seg">{TFS.map((x) => <button key={x} type="button" className={x === tf ? 'on' : ''} onClick={() => setTf(x)}>{x}</button>)}</div>
        <div className="seg">
          {([['ema', `EMA ${fast}/${slow}`], ['dc', 'Donchian'], ['bb', 'Bollinger'], ['vol', 'Vol'], ['rsi', 'RSI'], ['macd', 'MACD'], ['bots', 'Bots']] as const).map(([k, l]) => (
            <button key={k} type="button" className={ov[k] ? 'on' : ''} onClick={() => toggle(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="chart-legend">
        <ChainBadge c={chainOf(p.status ?? {}, pm.chainId)} testnet={false} /><strong>{pm.label.replace(/·.*/, '')}</strong> <span className="muted">{tf}</span>
        {lg && <> · O <b>{px(lg.o)}</b> H <b>{px(lg.h)}</b> L <b>{px(lg.l)}</b> C <b className={lg.c >= lg.o ? 'pos' : 'neg'}>{px(lg.c)}</b></>}
        <span className="muted small"> · {candles.length} candles · {meta?.source ?? 'no data'}{meta?.updatedAt ? ` · upd ${ago(meta.updatedAt * 1000)}` : ''} · units {pm.quote}/{pm.base} (sell-side, after {feeLabel(pm)} LP fee)</span>
      </div>
      {err && <div className="banner warn">{err}</div>}
      {!candles.length && !err && (
        <div className="empty-chart">
          <p>No stored candles for {pm.label} {tf} yet. Live polls build candles from now on; backfill history:</p>
          <div className="actions">
            <button type="button" className="btn small-btn primary" onClick={() => runBackfill('gecko')}>Backfill from GeckoTerminal</button>
            <button type="button" className="btn small-btn" onClick={() => runBackfill('onchain')}>Rebuild 30 days on-chain</button>
          </div>
          {backfill && <p className="muted small">{backfill}</p>}
        </div>
      )}
      <div ref={el} className="chart" style={{ height: candles.length ? p.height ?? 460 : 0 }} />
    </div>
  );
}

/** Equity (+ optional benchmark) line chart with a drawdown pane. Points are [ms, value]. */
export function EquityChart({ series, height = 260, drawdown = true, format = (v: number) => num(v, 2) }: { series: { name: string; data: [number, number][]; color: string; dashed?: boolean }[]; height?: number; drawdown?: boolean; format?: (v: number) => string }) {
  const el = useRef<HTMLDivElement>(null);
  const key = series.map((s) => `${s.name}:${s.data.length}:${s.data[s.data.length - 1]?.[1] ?? ''}`).join('|');
  useEffect(() => {
    if (!el.current) return;
    const ch = createChart(el.current, {
      height, autoSize: true,
      ...chartBase,
      grid: { vertLines: { visible: false }, horzLines: { color: alpha(T.line, 0.6) } },
      timeScale: { borderColor: T.line, timeVisible: true },
      localization: { priceFormatter: format },
    });
    const uniq = (d: [number, number][]) => {
      const m = new Map<number, number>();
      for (const [t, v] of d) m.set(Math.floor(t / 1000), v);
      return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: ts(t), value: v }));
    };
    for (const s of series) {
      if (!s.data.length) continue;
      const l = ch.addSeries(LineSeries, { color: s.color, lineWidth: 2, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, title: s.name }, 0);
      l.setData(uniq(s.data));
    }
    if (drawdown && series[0]?.data.length) {
      let peak = -Infinity;
      const dd = series[0].data.map(([t, v]) => { peak = Math.max(peak, v); return [t, peak > 0 ? -(1 - v / peak) * 100 : 0] as [number, number]; });
      const d = ch.addSeries(HistogramSeries, { color: alpha(T.loss, 0.5), priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false, title: 'drawdown' }, 1);
      d.setData(uniq(dd));
      ch.panes()[0]?.setStretchFactor(3);
    }
    ch.timeScale().fitContent();
    return () => ch.remove();
  }, [key, height, drawdown]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!series.some((s) => s.data.length > 1)) return <div className="muted small empty-eq">Equity history appears after the first minute of running.</div>;
  return <div ref={el} className="eq-chart" style={{ height }} />;
}
