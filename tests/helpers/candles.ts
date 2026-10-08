import type { Candle } from '../../src/market/candles';
/** Deterministic candles from a close path: o = previous close, h/l = ±wick around the body. */
export function candlesFromCloses(closes: number[], t0 = 1_700_000_000 - (1_700_000_000 % 3600), step = 3600, wick = 0.002): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: t0 + i * step, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, v: 100 };
  });
}
export function rng(seed = 42) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
/** Trend up, chop, trend down: gives EMA crosses. */
export function wavePath(n = 400, p0 = 0.00001, seed = 3) {
  const r = rng(seed);
  const out: number[] = [];
  let p = p0;
  for (let i = 0; i < n; i++) { p *= 1 + 0.006 * Math.sin(i / 10) + (r() - 0.5) * 0.01; out.push(p); }
  return out;
}
