/**
 * Trend strategies (long-only spot) + risk rules, shared by the live TrendEngine and the backtester.
 * Signals are evaluated on CLOSED candles only: signalAt(i) reads data ≤ i, so it never repaints.
 */
import { atr, donchian, ema, macd, rsi, type Series } from './indicators';
import { TF_SEC, type Candle, type TF } from './candles';
export { costGate } from './costs';

export type StrategyKind = 'ema' | 'ema_rsi' | 'macd' | 'donchian' | 'lines';
export const STRATEGIES: { id: StrategyKind; label: string }[] = [
  { id: 'ema', label: 'EMA cross' },
  { id: 'ema_rsi', label: 'EMA + RSI' },
  { id: 'macd', label: 'MACD signal cross' },
  { id: 'donchian', label: 'Donchian breakout' },
  { id: 'lines', label: 'My drawn lines' },
];

/** What a drawn line does when a closed candle meets it. */
export type LineRule = 'buy_break' | 'buy_bounce' | 'sell_break' | 'sell_reach';
export const LINE_RULES: { id: LineRule; side: 'buy' | 'sell'; label: string }[] = [
  { id: 'buy_break', side: 'buy', label: 'Buy when a candle closes above it' },
  { id: 'buy_bounce', side: 'buy', label: 'Buy when the price dips to it and closes above' },
  { id: 'sell_break', side: 'sell', label: 'Sell when a candle closes below it' },
  { id: 'sell_reach', side: 'sell', label: 'Sell when the price reaches it' },
];
export const MAX_LINES = 20;

/**
 * A line drawn on the market's chart, in its price units. `level`: horizontal at a.p (support / resistance), there
 * at every time. `trend`: straight through a and b (candle start, seconds), extended to the right; it exists from
 * its later point on, since nobody could have drawn it before that candle.
 */
export interface DrawnLine {
  id: string;
  kind: 'level' | 'trend';
  a: { t: number; p: number };
  b?: { t: number; p: number };
  rule: LineRule;
}

export interface TrendConfig {
  strategy: StrategyKind;
  fast: number; slow: number;
  rsiPeriod: number; rsiMin: number; rsiMax: number;
  macdFast: number; macdSlow: number; macdSignal: number;
  donchianEntry: number; donchianExit: number;
  /** Higher-timeframe filter: only enter when HTF close > HTF EMA */
  htfEnabled: boolean; htfTf: TF; htfEma: number;
  atrPeriod: number;
  /** Initial stop = entry − stopAtr × ATR */
  stopAtr: number;
  /** Take-profit at entry + tpR × (entry − stop); 0 = off */
  tpR: number;
  /** Trailing stop = highest − trailAtr × ATR (ratchets up only); 0 = off */
  trailAtr: number;
  /** Exit after N closed candles in position; 0 = off */
  maxHoldBars: number;
  /** Closed candles to wait after an exit before a new entry */
  cooldownBars: number;
  sizing: 'pct' | 'risk';
  /** pct sizing: % of available allocated capital per entry */
  sizePct: number;
  /** risk sizing: % of bot equity lost if the ATR stop is hit (before costs) */
  riskPct: number;
  /** Expected move used by the cost gate when tpR = 0: ATR × this */
  expectedMoveAtr: number;
  /** Extra edge required over round-trip costs (fraction, 0.0025 = 0.25%) */
  minEdgePct: number;
  /** Drawn lines (strategy 'lines') */
  lines: DrawnLine[];
  /** How close (fraction of the price) a candle's low / high must come to count as touching a line */
  lineTouchPct: number;
}

export const DEFAULT_TREND: TrendConfig = {
  strategy: 'ema', fast: 9, slow: 21,
  rsiPeriod: 14, rsiMin: 50, rsiMax: 75,
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  donchianEntry: 20, donchianExit: 10,
  htfEnabled: false, htfTf: '4h', htfEma: 50,
  atrPeriod: 14, stopAtr: 2, tpR: 2, trailAtr: 0, maxHoldBars: 0, cooldownBars: 2,
  sizing: 'pct', sizePct: 100, riskPct: 1, expectedMoveAtr: 2, minEdgePct: 0.0025,
  lines: [], lineTouchPct: 0.002,
};

export function validateTrendConfig(c: TrendConfig): string[] {
  const e: string[] = [];
  const int = (k: keyof TrendConfig, lo: number, hi: number) => {
    const v = c[k] as number;
    if (!Number.isInteger(v) || v < lo || v > hi) e.push(`${k} must be an integer ${lo}–${hi}`);
  };
  if (!STRATEGIES.some((s) => s.id === c.strategy)) e.push('unknown strategy');
  int('fast', 2, 200); int('slow', 3, 400);
  if (c.fast >= c.slow) e.push('fast must be < slow');
  int('rsiPeriod', 2, 100); int('macdFast', 2, 100); int('macdSlow', 3, 200); int('macdSignal', 2, 100);
  if (c.macdFast >= c.macdSlow) e.push('macdFast must be < macdSlow');
  int('donchianEntry', 2, 400); int('donchianExit', 2, 400); int('htfEma', 2, 400); int('atrPeriod', 2, 100);
  int('maxHoldBars', 0, 10_000); int('cooldownBars', 0, 10_000);
  if (!(c.stopAtr > 0 && c.stopAtr <= 20)) e.push('stopAtr must be in (0, 20]');
  if (!(c.tpR >= 0 && c.tpR <= 50)) e.push('tpR must be 0–50');
  if (!(c.trailAtr >= 0 && c.trailAtr <= 20)) e.push('trailAtr must be 0–20');
  if (!(c.sizePct > 0 && c.sizePct <= 100)) e.push('sizePct must be in (0, 100]');
  if (!(c.riskPct > 0 && c.riskPct <= 100)) e.push('riskPct must be in (0, 100]');
  if (!(c.rsiMin >= 0 && c.rsiMax <= 100 && c.rsiMin < c.rsiMax)) e.push('RSI band must satisfy 0 ≤ min < max ≤ 100');
  if (!(c.expectedMoveAtr > 0)) e.push('expectedMoveAtr must be > 0');
  if (!(c.minEdgePct >= 0 && c.minEdgePct < 0.5)) e.push('minEdgePct must be 0–0.5');
  if (!(c.lineTouchPct >= 0 && c.lineTouchPct <= 0.05)) e.push('lineTouchPct must be 0–0.05');
  e.push(...validateLines(c.lines));
  if (c.strategy === 'lines' && !c.lines.some((l) => LINE_RULES.find((r) => r.id === l.rule)?.side === 'buy')) e.push('Draw at least one line that buys.');
  return e;
}

function validateLines(lines: DrawnLine[]): string[] {
  if (!Array.isArray(lines)) return ['lines must be a list'];
  if (lines.length > MAX_LINES) return [`at most ${MAX_LINES} lines`];
  const point = (q: { t: number; p: number } | undefined) => !!q && Number.isInteger(q.t) && q.t > 0 && Number.isFinite(q.p) && q.p > 0;
  const e: string[] = [];
  lines.forEach((l, i) => {
    const n = `line ${i + 1}`;
    if (typeof l.id !== 'string' || !l.id) e.push(`${n}: missing id`);
    if (!LINE_RULES.some((r) => r.id === l.rule)) e.push(`${n}: unknown rule`);
    if (l.kind !== 'level' && l.kind !== 'trend') e.push(`${n}: kind must be level or trend`);
    if (!point(l.a)) e.push(`${n}: needs a point with a time and a price above 0`);
    if (l.kind === 'trend' && (!point(l.b) || l.b!.t === l.a?.t)) e.push(`${n}: a trend line needs two points at different times`);
  });
  return e;
}

/** The line's price at time t (seconds), wherever it is drawn (charts). */
export function lineValue(l: DrawnLine, t: number): number {
  if (l.kind === 'level' || !l.b) return l.a.p;
  return l.a.p + ((l.b.p - l.a.p) * (t - l.a.t)) / (l.b.t - l.a.t);
}
/** The line's price at time t where it can trade: a trend line only from its later point on; null before. */
export function lineAt(l: DrawnLine, t: number): number | null {
  if (l.kind === 'trend' && l.b && t < Math.max(l.a.t, l.b.t)) return null;
  return lineValue(l, t);
}

/** Drawn-lines signal on closed candle i: any buy line that fires enters, any sell line that fires exits. */
function linesSignal(k: Candle[], i: number, c: TrendConfig): { enter: boolean; exit: boolean; note: string } {
  if (i < 1) return { enter: false, exit: false, note: 'waiting for a second candle' };
  const cur = k[i], prev = k[i - 1], tol = c.lineTouchPct;
  const fired: string[] = [];
  let enter = false, exit = false, nearest = '', nearD = Infinity;
  for (const [n, l] of c.lines.entries()) {
    const v = lineAt(l, cur.t), v0 = lineAt(l, prev.t);
    if (v == null || v0 == null) continue;
    const hit = l.rule === 'buy_break' ? cur.c > v && prev.c <= v0
      : l.rule === 'buy_bounce' ? cur.l <= v * (1 + tol) && cur.c > v && prev.c > v0
      : l.rule === 'sell_break' ? cur.c < v && prev.c >= v0
      : cur.h >= v * (1 - tol) && prev.c < v0;
    const name = `line ${n + 1} at ${f(v)}`;
    if (hit) {
      fired.push(`${name} (${LINE_RULES.find((r) => r.id === l.rule)!.label.toLowerCase()})`);
      if (l.rule === 'buy_break' || l.rule === 'buy_bounce') enter = true; else exit = true;
    }
    const d = Math.abs(v / cur.c - 1);
    if (d < nearD) { nearD = d; nearest = `nearest ${name}, ${(d * 100).toFixed(2)}% ${v >= cur.c ? 'above' : 'below'}`; }
  }
  const note = `close ${f(cur.c)} · ${fired.length ? `fired ${fired.join('; ')}` : nearest || 'no line in effect yet'}`;
  return { enter, exit, note };
}

/** Candles needed before the first signal. */
export function warmup(c: TrendConfig): number {
  const base = c.strategy === 'macd' ? c.macdSlow + c.macdSignal
    : c.strategy === 'donchian' ? Math.max(c.donchianEntry, c.donchianExit) + 1
    : c.strategy === 'lines' ? 2
    : c.slow + 1;
  return Math.max(base, c.atrPeriod, c.strategy === 'ema_rsi' ? c.rsiPeriod + 1 : 0) + 1;
}

export interface Ind {
  fast: Series; slow: Series; rsi: Series; macd: Series; macdSig: Series;
  dcHi: Series; dcLo: Series; atr: Series;
}

export function computeIndicators(k: Candle[], c: TrendConfig): Ind {
  const close = k.map((x) => x.c);
  const m = macd(close, c.macdFast, c.macdSlow, c.macdSignal);
  return {
    fast: ema(close, c.fast), slow: ema(close, c.slow), rsi: rsi(close, c.rsiPeriod),
    macd: m.line, macdSig: m.signal,
    dcHi: donchian(k, c.donchianEntry).upper, dcLo: donchian(k, c.donchianExit).lower,
    atr: atr(k, c.atrPeriod),
  };
}

const crossUp = (a: Series, b: Series, i: number) => i > 0 && a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i]! > b[i]! && a[i - 1]! <= b[i - 1]!;
const crossDown = (a: Series, b: Series, i: number) => i > 0 && a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i]! < b[i]! && a[i - 1]! >= b[i - 1]!;
const f = (x: number | null) => (x == null ? '—' : x.toPrecision(5));

/** Entry / exit signal on closed candle i (uses only indices ≤ i). */
export function signalAt(ind: Ind, k: Candle[], i: number, c: TrendConfig): { enter: boolean; exit: boolean; note: string } {
  switch (c.strategy) {
    case 'ema':
    case 'ema_rsi': {
      let enter = crossUp(ind.fast, ind.slow, i);
      const exit = crossDown(ind.fast, ind.slow, i);
      let note = `EMA${c.fast} ${f(ind.fast[i])} ${ind.fast[i] != null && ind.slow[i] != null && ind.fast[i]! > ind.slow[i]! ? '>' : '<'} EMA${c.slow} ${f(ind.slow[i])}`;
      if (c.strategy === 'ema_rsi') {
        const r = ind.rsi[i];
        note += ` · RSI ${r == null ? '—' : r.toFixed(1)}`;
        if (enter && (r == null || r < c.rsiMin || r > c.rsiMax)) { enter = false; note += ' (RSI filter)'; }
      }
      return { enter, exit, note };
    }
    case 'macd':
      return {
        enter: crossUp(ind.macd, ind.macdSig, i), exit: crossDown(ind.macd, ind.macdSig, i),
        note: `MACD ${f(ind.macd[i])} vs signal ${f(ind.macdSig[i])}`,
      };
    case 'donchian': {
      const hi = i > 0 ? ind.dcHi[i - 1] : null, lo = i > 0 ? ind.dcLo[i - 1] : null;
      return {
        enter: hi != null && k[i].c > hi, exit: lo != null && k[i].c < lo,
        note: `close ${f(k[i].c)} · ${c.donchianEntry}-bar high ${f(hi)} · ${c.donchianExit}-bar low ${f(lo)}`,
      };
    }
    case 'lines':
      return linesSignal(k, i, c);
  }
}

/** HTF trend filter: closed HTF candles at time `atSec` (close of the LTF bar), close > EMA(htfEma). */
export function htfAllows(htf: Candle[], atSec: number, c: TrendConfig): { ok: boolean; note: string } {
  if (!c.htfEnabled) return { ok: true, note: '' };
  const s = TF_SEC[c.htfTf];
  let n = 0;
  while (n < htf.length && htf[n].t + s <= atSec) n++;
  const closed = htf.slice(0, n);
  const e = ema(closed.map((x) => x.c), c.htfEma);
  const last = closed[closed.length - 1], ev = e[e.length - 1];
  if (!last || ev == null) return { ok: false, note: `HTF ${c.htfTf} warming up` };
  return { ok: last.c > ev, note: `HTF ${c.htfTf} close ${f(last.c)} ${last.c > ev ? '>' : '<'} EMA${c.htfEma} ${f(ev)}` };
}

// ── Risk ────────────────────────────────────────────────────────────────
export interface RiskState {
  /** Reference entry price (quote/PLS, sell-side units) */
  entry: number;
  atr: number;
  stop: number;
  initialStop: number;
  tp: number | null;
  highest: number;
}

export function openRisk(entry: number, atrV: number, c: TrendConfig): RiskState {
  const stop = entry - c.stopAtr * atrV;
  return { entry, atr: atrV, stop, initialStop: stop, tp: c.tpR > 0 ? entry + c.tpR * (entry - stop) : null, highest: entry };
}

/** Ratchet the trailing stop with a new high. Returns true if the stop moved. */
export function trail(r: RiskState, high: number, c: TrendConfig): boolean {
  if (high > r.highest) r.highest = high;
  if (!(c.trailAtr > 0)) return false;
  const s = r.highest - c.trailAtr * r.atr;
  if (s > r.stop) { r.stop = s; return true; }
  return false;
}

export type ExitReason = 'signal' | 'stop' | 'trail' | 'tp' | 'maxhold' | 'end' | 'manual';

/** Exit check against a live price (sell-side units). */
export function priceExit(r: RiskState, price: number): ExitReason | null {
  if (price <= r.stop) return r.stop > r.initialStop ? 'trail' : 'stop';
  if (r.tp != null && price >= r.tp) return 'tp';
  return null;
}

/** Quote amount to spend on an entry. */
export function positionSize(available: number, equity: number, entry: number, stop: number, c: TrendConfig): number {
  if (c.sizing === 'pct') return available * (c.sizePct / 100);
  const distPct = (entry - stop) / entry;
  if (!(distPct > 0)) return 0;
  return Math.min(available, (equity * (c.riskPct / 100)) / distPct);
}

/** Expected favourable move (fraction) used by the cost gate. */
export function expectedMovePct(r: RiskState, c: TrendConfig): number {
  return r.tp != null ? (r.tp - r.entry) / r.entry : (c.expectedMoveAtr * r.atr) / r.entry;
}
