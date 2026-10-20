/**
 * OHLCV candles in the grid's units: QUOTE per PLS, sell-side (fee-inclusive) like Quoter.getPrice().
 * t = bucket start, unix seconds (UTC). v = volume (see source notes; 0 for poll-only candles).
 */
export type TF = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const TFS: TF[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const TF_SEC: Record<TF, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };
/** Max candles kept per series */
export const TF_CAP: Record<TF, number> = { '1m': 3000, '5m': 4000, '15m': 4000, '1h': 5000, '4h': 3000, '1d': 1500 };

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; /** gap-filled */ f?: 1; /** one-off print clipped (trimSpikes) */ s?: 1 }

export const isTF = (x: unknown): x is TF => typeof x === 'string' && (TFS as string[]).includes(x);
export const bucketStart = (tsSec: number, tf: TF) => Math.floor(tsSec / TF_SEC[tf]) * TF_SEC[tf];

/** Apply a live price tick to a series (mutates and returns it). Out-of-order ticks for old buckets are ignored. */
export function applyTick(series: Candle[], price: number, tsSec: number, tf: TF, volume = 0): Candle[] {
  if (!(price > 0)) return series;
  const t = bucketStart(tsSec, tf);
  const last = series[series.length - 1];
  if (last && last.t === t) {
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += volume;
    delete last.f;
  } else if (!last || t > last.t) {
    series.push({ t, o: last ? last.c : price, h: Math.max(price, last ? last.c : price), l: Math.min(price, last ? last.c : price), c: price, v: volume });
  }
  return series;
}

/** Aggregate lower-timeframe candles into tf buckets. Input must be sorted. */
export function aggregate(candles: Candle[], tf: TF): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const t = bucketStart(k.t, tf);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v;
      if (!k.f) delete last.f;
    } else out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, ...(k.f ? { f: 1 as const } : {}) });
  }
  return out;
}

/** Forward-fill missing buckets with flat candles (o=h=l=c=prev close, v=0, f=1). Up to `until` (inclusive bucket). */
export function fillGaps(candles: Candle[], tf: TF, until?: number): Candle[] {
  if (!candles.length) return [];
  const s = TF_SEC[tf];
  const out: Candle[] = [];
  for (const k of candles) {
    const prev = out[out.length - 1];
    if (prev) for (let t = prev.t + s; t < k.t; t += s) out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0, f: 1 });
    out.push(k);
  }
  if (until != null) {
    const end = bucketStart(until, tf);
    let prev = out[out.length - 1];
    for (let t = prev.t + s; t <= end; t += s) { prev = { t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0, f: 1 }; out.push(prev); }
  }
  return out;
}

/**
 * How far a candle may reach past its own price path, in the pair's usual moves (median non-zero close-to-close change),
 * before the excess is a one-off print. Measured 2026-10-20: 44 real exchange series (Crypto.com BTC, ETH, SOL, DOGE,
 * PEPE, LINK vs USDT, ETH/BTC and USDT/USD; 1m to 1D; 13,200 candles) never passed 17.7. The stored Uniswap WBTC/ETH
 * 0.01% candle of 2026-10-18 03:00 UTC printed +26% while the real market moved 0.2% that hour.
 */
export const SPIKE_MOVES = 20;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Clip one-off prints: one big trade in a thin pool prints a wick (or an open or close) far from where the price was,
 * arbitrage puts the pool straight back, and a replay that fills there books trades no bot could have made. Each close
 * is checked against the median of itself and its two neighbours (a jump that comes straight back is a print, a real
 * move stays), then the candle is held within SPIKE_MOVES usual moves of that cleaned path. The first and last closes
 * have one neighbour and are kept (their wicks are still clipped). Clipped candles are marked s: 1. Input must be sorted.
 */
export function trimSpikes(candles: Candle[]): Candle[] {
  const moves: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const m = Math.abs(Math.log(candles[i].c / candles[i - 1].c));
    if (m > 0) moves.push(m);
  }
  if (candles.length < 3 || !moves.length) return candles;
  const reach = Math.exp(SPIKE_MOVES * median(moves)), last = candles.length - 1;
  const path = candles.map((k, i) => (i === 0 || i === last ? k.c : median([candles[i - 1].c, k.c, candles[i + 1].c])));
  return candles.map((k, i) => {
    const from = i === 0 ? k.o : path[i - 1];
    const lo = Math.min(from, path[i]) / reach, hi = Math.max(from, path[i]) * reach;
    if (k.l >= lo && k.h <= hi) return k;
    const clip = (v: number) => Math.min(hi, Math.max(lo, v));
    return { ...k, o: clip(k.o), h: clip(k.h), l: clip(k.l), c: clip(k.c), s: 1 as const };
  });
}

/** What every replay (backtests, the daily scan) runs on: closed candles, one-off prints clipped, gaps filled flat. */
export function replayCandles(raw: Candle[], tf: TF, nowSec: number): Candle[] {
  return fillGaps(trimSpikes(closedOnly(raw, tf, nowSec)), tf);
}

/** Merge incoming candles over existing by t (incoming wins, except the live open bucket keeps the wider range). */
export function mergeCandles(existing: Candle[], incoming: Candle[], cap = Infinity, openBucket?: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const k of existing) m.set(k.t, k);
  for (const k of incoming) {
    const old = m.get(k.t);
    if (old && openBucket != null && k.t === openBucket) {
      m.set(k.t, { ...k, h: Math.max(k.h, old.h), l: Math.min(k.l, old.l), c: old.c });
    } else m.set(k.t, { ...k });
  }
  const out = [...m.values()].sort((a, b) => a.t - b.t);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Only candles whose bucket has fully closed at `nowSec`. Signals use these exclusively (no repaint). */
export function closedOnly(candles: Candle[], tf: TF, nowSec: number): Candle[] {
  let i = candles.length;
  while (i > 0 && candles[i - 1].t + TF_SEC[tf] > nowSec) i--;
  return i === candles.length ? candles : candles.slice(0, i);
}

export function sliceRange(candles: Candle[], from?: number, to?: number): Candle[] {
  return candles.filter((k) => (from == null || k.t >= from) && (to == null || k.t <= to));
}

/**
 * Candles of the flipped orientation (1 / price): o' = 1/o, h' = 1/l, l' = 1/h, c' = 1/c — the high and low swap,
 * so ranges, ATR and stops stay correct (1/close alone would lose the wicks). Volume is re-expressed in the new
 * quote (the old base) at the candle's typical price (h + l + c) / 3 — an approximation, volume is informational.
 */
export function invertCandles(candles: Candle[]): Candle[] {
  const out: Candle[] = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const tp = (k.h + k.l + k.c) / 3;
    out[i] = { t: k.t, o: 1 / k.o, h: 1 / k.l, l: 1 / k.h, c: 1 / k.c, v: tp > 0 ? k.v / tp : 0, ...(k.f ? { f: 1 as const } : {}) };
  }
  return out;
}
