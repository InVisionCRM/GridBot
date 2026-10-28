import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { CandleBar, FillMark } from './metrics';
import { T, chartBase } from '../ui/theme';

const ts = (s: number) => s as UTCTimestamp;

/** Live candles. Levels and the LP band come from the server payload. */
export function CandlePane({
  candles, levels, fills, flashLevel,
}: {
  candles: CandleBar[];
  levels: number[];
  fills: FillMark[];
  flashLevel: number | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const seeded = useRef(false);
  const [ripples, setRipples] = useState<{ id: string; y: number }[]>([]);
  const seen = useRef(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = createChart(el, {
      height: el.clientHeight || 320,
      autoSize: true,
      ...chartBase,
      grid: { vertLines: { color: 'rgba(43,49,57,0.65)' }, horzLines: { color: 'rgba(43,49,57,0.65)' } },
      timeScale: { borderColor: T.line, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: T.line },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: T.profit, downColor: T.loss, borderUpColor: T.profit, borderDownColor: T.loss,
      wickUpColor: T.profit, wickDownColor: T.loss, priceLineColor: T.warn,
    });
    chart.current = c;
    series.current = s;
    return () => { c.remove(); chart.current = null; series.current = null; markersApi.current = null; seeded.current = false; };
  }, []);

  useEffect(() => {
    const s = series.current;
    const c = chart.current;
    if (!s || !c || !candles.length) return;
    const bars = candles.map((k) => ({ time: ts(k.t), open: k.o, high: k.h, low: k.l, close: k.c }));
    if (!seeded.current) {
      s.setData(bars);
      seeded.current = true;
      c.timeScale().fitContent();
    } else {
      const last = bars[bars.length - 1];
      s.update(last);
    }
    for (const line of lines.current) s.removePriceLine(line);
    lines.current = [];
    for (const price of levels) {
      const hot = flashLevel != null && price === flashLevel;
      lines.current.push(s.createPriceLine({
        price, color: hot ? T.warn : 'rgba(132,142,156,0.55)', lineWidth: hot ? 2 : 1,
        lineStyle: 2, axisLabelVisible: false, title: '',
      }));
    }
    const markers: SeriesMarker<Time>[] = fills.slice(-16).map((f) => ({
      time: ts(f.t),
      position: f.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: f.side === 'buy' ? T.profit : T.loss,
      shape: 'circle',
      size: 0.7,
    }));
    if (!markersApi.current) markersApi.current = createSeriesMarkers(s, markers);
    else markersApi.current.setMarkers(markers);
    if (fills.length > seen.current) {
      const y = s.priceToCoordinate(fills[fills.length - 1].price);
      if (y != null) {
        const id = fills[fills.length - 1].id;
        setRipples((r) => [...r.slice(-4), { id, y }]);
        window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 700);
      }
    }
    seen.current = fills.length;
  }, [candles, levels, fills, flashLevel]);

  return (
    <div className="candle-host">
      <div ref={host} className="candle-el" />
      {ripples.map((r) => <i key={r.id} className="fill-ripple" style={{ top: r.y }} />)}
    </div>
  );
}
