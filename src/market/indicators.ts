/**
 * Indicator math. Every function returns an array aligned with its input; entries before the
 * indicator is defined are null. Value at index i only uses inputs ≤ i (no look-ahead / no repaint).
 */
export type Series = (number | null)[];
export interface OHLC { o: number; h: number; l: number; c: number }

export function sma(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values (TA-Lib / TradingView convention). */
export function ema(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

/** EMA over a series with leading nulls (used for MACD signal). */
function emaSparse(v: Series, n: number): Series {
  const first = v.findIndex((x) => x != null);
  const out: Series = new Array(v.length).fill(null);
  if (first < 0) return out;
  const e = ema(v.slice(first) as number[], n);
  for (let i = 0; i < e.length; i++) out[first + i] = e[i];
  return out;
}

/** Wilder RSI. First value at index n. */
export function rsi(close: number[], n = 14): Series {
  const out: Series = new Array(close.length).fill(null);
  if (close.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = val();
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

export function macd(close: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast), es = ema(close, slow);
  const line: Series = close.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null));
  const sig = emaSparse(line, signal);
  const hist: Series = line.map((m, i) => (m != null && sig[i] != null ? m - sig[i]! : null));
  return { line, signal: sig, hist };
}

export function trueRange(c: OHLC[]): number[] {
  return c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
}

/** Wilder ATR. First value at index n−1 = mean of the first n true ranges. */
export function atr(c: OHLC[], n = 14): Series {
  const tr = trueRange(c);
  const out: Series = new Array(c.length).fill(null);
  if (c.length < n) return out;
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  out[n - 1] = a;
  for (let i = n; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

/** Donchian channel over the last n bars INCLUDING bar i. Breakout logic uses index i−1 (prior bars). */
export function donchian(c: OHLC[], n = 20) {
  const upper: Series = new Array(c.length).fill(null), lower: Series = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (c[j].h > h) h = c[j].h; if (c[j].l < l) l = c[j].l; }
    upper[i] = h; lower[i] = l;
  }
  return { upper, lower, mid: upper.map((u, i) => (u != null ? (u + lower[i]!) / 2 : null)) };
}

/** Bollinger bands (population stdev). */
export function bollinger(close: number[], n = 20, k = 2) {
  const mid = sma(close, n);
  const upper: Series = new Array(close.length).fill(null), lower: Series = new Array(close.length).fill(null);
  for (let i = n - 1; i < close.length; i++) {
    const m = mid[i]!;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - m) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = m + k * sd; lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** Kaufman efficiency ratio: |net move| / path length over n bars. ~1 = clean trend, ~0 = chop. */
export function efficiencyRatio(close: number[], n = 20): Series {
  const out: Series = new Array(close.length).fill(null);
  for (let i = n; i < close.length; i++) {
    let path = 0;
    for (let j = i - n + 1; j <= i; j++) path += Math.abs(close[j] - close[j - 1]);
    out[i] = path > 0 ? Math.abs(close[i] - close[i - n]) / path : 0;
  }
  return out;
}
