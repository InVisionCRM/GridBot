import { describe, expect, it } from 'vitest';
import { atr, bollinger, donchian, ema, efficiencyRatio, macd, rsi, sma, trueRange } from '../src/market/indicators';
import { candlesFromCloses, rng } from './helpers/candles';

// StockCharts' Wilder RSI(14) worked example
const SC_CLOSE = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
const SC_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];

describe('indicators vs known values', () => {
  it('SMA / EMA (SMA-seeded)', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(sma(v, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ema(v, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]); // linear input: EMA(3) lags by one
    const e = ema([22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39], 10);
    expect(e[9]).toBeCloseTo(22.221, 3); // StockCharts EMA(10) seed = SMA(10)
    expect(e[10]).toBeCloseTo(22.208, 3);
    expect(e[11]).toBeCloseTo(22.241, 3);
  });

  it('RSI(14) matches the Wilder/StockCharts table', () => {
    const r = rsi(SC_CLOSE, 14);
    expect(r.slice(0, 14).every((x) => x == null)).toBe(true);
    SC_RSI.forEach((want, j) => expect(r[14 + j]!, `rsi[${14 + j}]`).toBeCloseTo(want, 1));
  });

  it('MACD = EMA12 − EMA26, signal = EMA9 of MACD, hist = MACD − signal', () => {
    const c = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 10 + Math.sin(i / 5) + i * 0.05)).map((k) => k.c);
    const m = macd(c);
    const e12 = ema(c, 12), e26 = ema(c, 26);
    expect(m.line[24]).toBeNull();
    expect(m.line[25]).toBeCloseTo(e12[25]! - e26[25]!, 12);
    expect(m.signal[25 + 7]).toBeNull();
    const first9 = m.line.slice(25, 34) as number[];
    expect(m.signal[33]).toBeCloseTo(first9.reduce((a, b) => a + b, 0) / 9, 12);
    expect(m.signal[34]).toBeCloseTo(m.line[34]! * 0.2 + m.signal[33]! * 0.8, 12);
    expect(m.hist[50]).toBeCloseTo(m.line[50]! - m.signal[50]!, 12);
    expect(macd(new Array(60).fill(5)).line[40]).toBeCloseTo(0, 12);
  });

  it('ATR (Wilder) with gaps in true range', () => {
    const k = [
      { o: 9, h: 10, l: 8, c: 9 }, { o: 9, h: 11, l: 9, c: 10 }, { o: 10, h: 12, l: 9.5, c: 11 },
      { o: 11, h: 11.5, l: 10, c: 10.5 }, { o: 14.5, h: 15, l: 14, c: 14.5 },
    ];
    expect(trueRange(k)).toEqual([2, 2, 2.5, 1.5, 4.5]);
    const a = atr(k, 3);
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo(6.5 / 3, 12);
    expect(a[3]).toBeCloseTo((6.5 / 3 * 2 + 1.5) / 3, 12);
    expect(a[4]).toBeCloseTo((a[3]! * 2 + 4.5) / 3, 12);
  });

  it('Donchian / Bollinger / efficiency ratio', () => {
    const k = candlesFromCloses([1, 3, 2, 5, 4], 0, 60, 0);
    const d = donchian(k, 3);
    expect(d.upper).toEqual([null, null, 3, 5, 5]);
    expect(d.lower).toEqual([null, null, 1, 1, 2]); // lows = min(open, close)
    const b = bollinger(new Array(25).fill(7), 20, 2);
    expect(b.upper[24]).toBe(7); expect(b.lower[24]).toBe(7);
    const b2 = bollinger([1, 2, 3, 4], 4, 2);
    expect(b2.upper[3]).toBeCloseTo(2.5 + 2 * Math.sqrt(1.25), 12);
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)[4]).toBe(1);
    expect(efficiencyRatio([1, 2, 1, 2, 1], 4)[4]).toBe(0);
  });

  it('no repaint: values on a prefix equal values on the full series', () => {
    const r = rng(9);
    const closes = Array.from({ length: 150 }, (_, i) => 1 + i * 0.001 + (r() - 0.5) * 0.05);
    const k = candlesFromCloses(closes);
    const full = { e: ema(closes, 9), r: rsi(closes, 14), m: macd(closes).signal, a: atr(k, 14), d: donchian(k, 20).upper, b: bollinger(closes).upper };
    for (const i of [30, 60, 99, 149]) {
      const pc = closes.slice(0, i + 1), pk = k.slice(0, i + 1);
      expect(ema(pc, 9)[i]).toBeCloseTo(full.e[i]!, 14);
      expect(rsi(pc, 14)[i]).toBeCloseTo(full.r[i]!, 12);
      expect(macd(pc).signal[i]).toBeCloseTo(full.m[i]!, 14);
      expect(atr(pk, 14)[i]).toBeCloseTo(full.a[i]!, 14);
      expect(donchian(pk, 20).upper[i]).toBe(full.d[i]);
      expect(bollinger(pc).upper[i]).toBeCloseTo(full.b[i]!, 14);
    }
  });
});
