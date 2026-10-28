/**
 * Backtester over stored candles (grid units: quote per PLS, sell-side). No look-ahead:
 *  - signals on candle i's CLOSE, filled at candle i+1's OPEN;
 *  - stops/TP checked intrabar from i+1 on (gap through → fill at the open); if stop and TP are both inside
 *    one candle the stop is assumed first (conservative);
 *  - trailing stop ratchets with a candle's high only AFTER that candle's exit checks.
 * Costs per swap: LP fee, price impact from current reserves (approximation), gas, assumed slippage.
 */
import { calculateGridLevels } from '../engine/gridEngine';
import { TF_SEC, type Candle, type TF } from './candles';
import { simBuy, simSell, type CostModel } from './costs';
import {
  computeIndicators, costGate, expectedMovePct, htfAllows, openRisk, positionSize, signalAt, trail, validateTrendConfig, warmup,
  type ExitReason, type RiskState, type TrendConfig,
} from './strategy';

export { costGate };

export interface BtTrade {
  entryT: number; exitT: number; entryPrice: number; exitPrice: number;
  pls: number; cost: number; proceeds: number; pnl: number; pnlPct: number;
  fees: number; gas: number; bars: number; reason: ExitReason | 'grid';
}

export interface BtMetrics {
  startEquity: number; endEquity: number; totalReturn: number; cagr: number | null;
  maxDrawdown: number; winRate: number | null; profitFactor: number | null;
  avgWin: number | null; avgLoss: number | null; expectancy: number | null; expectancyPct: number | null;
  sharpe: number | null; sortino: number | null; exposure: number; trades: number;
  /** What the completed buy → sell trades made after every cost, in the quote coin (a trend bot's trade still open at the end is closed at the last price); coins a grid still holds aren't in it */
  earned: number;
  /** Paid on every swap of the run (also the buys of coins still held at the end), in the quote coin */
  fees: number; impact: number; slippage: number; gas: number;
  /** What price moves did: profit + everything paid (profit = price − fees − impact − slippage − gas) */
  priceEffect: number;
  days: number;
  blockedByCost: number;
  /** How far one trade of the backtest's size moves the pool price at the start */
  tradeImpactPct: number;
  /** One trade's size (grid: a level; trend: the whole amount) and the quote coin the pool holds near the price (null = impact off) */
  tradeSize: number; poolDepth: number | null;
}

/** Everything the swaps of a run paid, in the quote coin. */
export interface Spent { fees: number; impact: number; slippage: number; gas: number }
const newSpent = (): Spent => ({ fees: 0, impact: 0, slippage: 0, gas: 0 });
function pay(s: Spent, r: { fee: number; impactQuote: number; slipQuote: number; gasQuote: number }) {
  s.fees += r.fee; s.impact += r.impactQuote; s.slippage += r.slipQuote; s.gas += r.gasQuote;
}

export interface BtResult {
  kind: 'trend' | 'grid';
  tf: TF;
  metrics: BtMetrics;
  equity: { t: number; v: number }[];
  trades: BtTrade[];
  notes: string[];
  /** Set when markOpen leaves the last position unsold. Absent on a normal run. */
  open?: { pls: number; cost: number; price: number } | null;
}

export function maxDrawdown(v: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const x of v) { if (x > peak) peak = x; if (peak > 0) dd = Math.max(dd, 1 - x / peak); }
  return dd;
}

function metrics(eq: { t: number; v: number }[], trades: BtTrade[], tf: TF, capital: number, inPosBars: number, blocked: number, spent: Spent, size: { trade: number; impact: number; pool: number | null }): BtMetrics {
  const end = eq.length ? eq[eq.length - 1].v : capital;
  const days = eq.length > 1 ? (eq[eq.length - 1].t - eq[0].t) / 86_400 : 0;
  // Measured from the amount put in: a costly start (a start-up buy's price impact) is a drop and a loss like any other
  const vals = [capital, ...eq.map((e) => e.v)];
  const rets: number[] = [];
  for (let i = 1; i < vals.length; i++) rets.push(vals[i] / vals[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const dsd = Math.sqrt(rets.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / (rets.length || 1));
  const perYear = (365 * 86_400) / TF_SEC[tf];
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    startEquity: capital, endEquity: end, totalReturn: end / capital - 1,
    cagr: days >= 30 ? (end / capital) ** (365 / days) - 1 : null,
    maxDrawdown: maxDrawdown(vals),
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: trades.length ? (gl > 0 ? gw / gl : null) : null,
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
    expectancy: trades.length ? (gw - gl) / trades.length : null,
    expectancyPct: trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : null,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : null,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(perYear) : null,
    exposure: eq.length ? inPosBars / eq.length : 0,
    trades: trades.length,
    earned: gw - gl,
    ...spent,
    priceEffect: end - capital + spent.fees + spent.impact + spent.slippage + spent.gas,
    days,
    blockedByCost: blocked,
    tradeImpactPct: size.impact, tradeSize: size.trade, poolDepth: size.pool,
  };
}

export interface TrendBtOpts {
  capital: number; costs: CostModel; htf?: Candle[];
  /** Leave a position open at the last close instead of booking it as a trade. The harness uses this so a mark is not counted as tokens generated. */
  markOpen?: boolean;
  /** Defaults to the live signal function. The harness injects this so a backtest cannot drift onto a copy of the rules. */
  signalAt?: typeof signalAt;
}

export function runTrendBacktest(k: Candle[], cfg: TrendConfig, tf: TF, o: TrendBtOpts): BtResult {
  const errs = validateTrendConfig(cfg);
  if (errs.length) throw new Error(errs.join('; '));
  const need = warmup(cfg);
  if (k.length < need + 2) throw new Error(`need ≥ ${need + 2} candles, have ${k.length}`);
  const ind = computeIndicators(k, cfg);
  const s = TF_SEC[tf];
  const start = need - 1;
  const spent = newSpent();
  let cash = o.capital;
  let pos: { pls: number; cost: number; entryT: number; fees: number; gas: number; risk: RiskState; bars: number } | null = null;
  let pending: { kind: 'enter'; atr: number } | { kind: 'exit'; reason: ExitReason } | null = null;
  let cooldownUntil = -1;
  let inPos = 0, blocked = 0;
  const trades: BtTrade[] = [];
  const eq: BtResult['equity'] = [];

  const exit = (t: number, price: number, reason: ExitReason, i: number) => {
    const p = pos!;
    const sres = simSell(p.pls, price, o.costs);
    pay(spent, sres);
    const proceeds = sres.quote - sres.gasQuote;
    cash += proceeds;
    const pnl = proceeds - p.cost;
    trades.push({
      entryT: p.entryT, exitT: t, entryPrice: p.risk.entry, exitPrice: price, pls: p.pls, cost: p.cost, proceeds, pnl,
      pnlPct: pnl / p.cost, fees: p.fees + sres.fee, gas: p.gas + sres.gasQuote, bars: p.bars, reason,
    });
    pos = null;
    cooldownUntil = i + cfg.cooldownBars;
  };

  for (let i = start; i < k.length; i++) {
    const bar = k[i];
    // 1) Fill orders decided at the previous close, at this bar's open
    if (pending?.kind === 'enter' && !pos) {
      const risk = openRisk(bar.o, pending.atr, cfg);
      const equity = cash;
      const size = Math.min(cash, positionSize(cash, equity, risk.entry, risk.stop, cfg));
      const gate = costGate(expectedMovePct(risk, cfg), size, bar.o, o.costs, cfg.minEdgePct);
      if (!gate.ok) blocked++;
      else {
        const b = simBuy(size, bar.o, o.costs);
        pay(spent, b);
        cash -= size + b.gasQuote;
        pos = { pls: b.pls, cost: size + b.gasQuote, entryT: bar.t, fees: b.fee, gas: b.gasQuote, risk, bars: 0 };
      }
    } else if (pending?.kind === 'exit' && pos) {
      exit(bar.t, bar.o, pending.reason, i);
    }
    pending = null;

    // 2) Intrabar stop / TP (stop first if both)
    if (pos) {
      const r = pos.risk;
      if (bar.o <= r.stop) exit(bar.t, bar.o, r.stop > r.initialStop ? 'trail' : 'stop', i);
      else if (bar.l <= r.stop) exit(bar.t, r.stop, r.stop > r.initialStop ? 'trail' : 'stop', i);
      else if (r.tp != null && bar.o >= r.tp) exit(bar.t, bar.o, 'tp', i);
      else if (r.tp != null && bar.h >= r.tp) exit(bar.t, r.tp, 'tp', i);
      else trail(r, bar.h, cfg);
    }

    // 3) Decide on this bar's close (executes next open)
    if (i < k.length - 1) {
      const sig = (o.signalAt ?? signalAt)(ind, k, i, cfg);
      if (pos) {
        pos.bars++;
        if (sig.exit) pending = { kind: 'exit', reason: 'signal' };
        else if (cfg.maxHoldBars > 0 && pos.bars >= cfg.maxHoldBars) pending = { kind: 'exit', reason: 'maxhold' };
      } else if (sig.enter && i >= cooldownUntil && ind.atr[i] != null) {
        if (!o.htf || htfAllows(o.htf, bar.t + s, cfg).ok) pending = { kind: 'enter', atr: ind.atr[i]! };
      }
    }
    if (pos) inPos++;
    eq.push({ t: bar.t, v: cash + (pos ? pos.pls * bar.c : 0) });
  }
  let open: { pls: number; cost: number; price: number } | null = null;
  if (pos) {
    const last = k[k.length - 1];
    if (o.markOpen) open = { pls: pos.pls, cost: pos.cost, price: last.c };
    else {
      exit(last.t, last.c, 'end', k.length - 1);
      eq[eq.length - 1].v = cash;
    }
  }
  return {
    kind: 'trend', tf, metrics: metrics(eq, trades, tf, o.capital, inPos, blocked, spent, { trade: o.capital, impact: simBuy(o.capital, k[start].o, o.costs).impactPct, pool: o.costs.pool?.quoteReserve ?? null }), equity: eq, trades, open,
    notes: [
      'Signals on candle close, filled at the next open; stops/TP intrabar (stop first if both hit in one candle).',
      'Price impact uses CURRENT pool reserves re-centred at each historical price (approximation).',
      `Costs per swap: ${o.costs.feeBps / 100}% LP fee, impact, gas at the current gas price, ${o.costs.slippageBps} bps assumed slippage.`,
      'An open position at the end is closed at the last close (reason "end").',
      ...(cfg.strategy === 'lines' ? ['Your lines were drawn today, knowing what the price did: a backtest of them looks better than they will do live. A trend line only trades after its later point; a level trades over the whole test.'] : []),
    ],
  };
}

export interface GridBtConfig {
  lowerPrice: number; upperPrice: number; gridCount: number; capital: number;
  /** A level's profit is added to its next buy (the live default); false = fixed sizes, profit set aside */
  reinvest?: boolean;
}

/**
 * Grid backtest, same rules as the live grid (liveGrid.ts): the capital is split over every level; the levels below
 * the first open wait to buy, the ones at or above it get their coins from one start-up buy at that open. Each candle
 * is walked o→l→h→c (bullish) or o→h→l→c (bearish); fills at the level price (optimistic vs live polling).
 */
export function runGridBacktest(k: Candle[], g: GridBtConfig, tf: TF, costs: CostModel): BtResult {
  if (k.length < 2) throw new Error('need ≥ 2 candles');
  const levels = calculateGridLevels(g.lowerPrice, g.upperPrice, g.gridCount).map((l) => l.price);
  const p0 = k[0].o;
  const per = g.capital / g.gridCount;
  const iv = levels.slice(0, -1).map((b, i) => ({ buy: b, sell: levels[i + 1], state: (b < p0 ? 'wait' : 'hold') as 'wait' | 'hold', pls: 0, cost: 0, t: 0, fee: 0, gas: 0, size: per, entry: b }));
  if (!iv.some((x) => x.state === 'wait')) throw new Error('the first price is below the range');
  const spent = newSpent();
  let cash = g.capital, inPos = 0;
  const up = iv.filter((x) => x.state === 'hold');
  if (up.length) {
    const amt = per * up.length, b = simBuy(amt, p0, costs), n = up.length;
    pay(spent, b);
    cash -= amt + b.gasQuote;
    for (const x of up) Object.assign(x, { pls: b.pls / n, cost: (amt + b.gasQuote) / n, t: k[0].t, fee: b.fee / n, gas: b.gasQuote / n, entry: p0 });
  }
  const trades: BtTrade[] = [];
  const eq: BtResult['equity'] = [];
  const visit = (from: number, to: number, t: number) => {
    if (to < from) { // falling: buys from high to low
      for (const x of [...iv].reverse()) if (x.state === 'wait' && x.buy <= from && x.buy >= to && cash >= x.size) {
        const b = simBuy(x.size, x.buy, costs);
        pay(spent, b);
        cash -= x.size + b.gasQuote;
        Object.assign(x, { state: 'hold', pls: b.pls, cost: x.size + b.gasQuote, t, fee: b.fee, gas: b.gasQuote, entry: x.buy });
      }
    } else {
      for (const x of iv) if (x.state === 'hold' && x.sell >= from && x.sell <= to) {
        const s = simSell(x.pls, x.sell, costs);
        pay(spent, s);
        const proceeds = s.quote - s.gasQuote;
        cash += proceeds;
        trades.push({ entryT: x.t, exitT: t, entryPrice: x.entry, exitPrice: x.sell, pls: x.pls, cost: x.cost, proceeds, pnl: proceeds - x.cost, pnlPct: (proceeds - x.cost) / x.cost, fees: x.fee + s.fee, gas: x.gas + s.gasQuote, bars: 0, reason: 'grid' });
        Object.assign(x, { state: 'wait', pls: 0, cost: 0, size: g.reinvest === false ? x.size : x.size + proceeds - x.cost });
      }
    }
  };
  let prev = k[0].o;
  for (const bar of k) {
    const path = bar.c >= bar.o ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c];
    for (const p of path) { if (p !== prev) visit(prev, p, bar.t); prev = p; }
    const held = iv.reduce((a, x) => a + x.pls, 0);
    if (held > 0) inPos++;
    eq.push({ t: bar.t, v: cash + held * bar.c });
  }
  return {
    kind: 'grid', tf, metrics: metrics(eq, trades, tf, g.capital, inPos, 0, spent, { trade: per, impact: simBuy(per, p0, costs).impactPct, pool: costs.pool?.quoteReserve ?? null }), equity: eq, trades,
    notes: [
      'Grid fills assumed exactly at level prices (live fills happen at the polled price past the level).',
      'Candle path assumed o→l→h→c for up candles, o→h→l→c for down candles.',
      'Price impact uses CURRENT pool reserves re-centred at each historical price (approximation).',
      'Open lots at the end are marked to the last close (not sold).',
    ],
  };
}

export type SweepKey = 'fast' | 'slow' | 'macdFast' | 'macdSlow' | 'donchianEntry' | 'donchianExit' | 'stopAtr' | 'tpR' | 'trailAtr';
export const SWEEP_AXES: Record<TrendConfig['strategy'], [SweepKey, SweepKey]> = {
  ema: ['fast', 'slow'], ema_rsi: ['fast', 'slow'], macd: ['macdFast', 'macdSlow'], donchian: ['donchianEntry', 'donchianExit'], lines: ['stopAtr', 'tpR'],
};
export interface SweepRow { x: number; y: number; totalReturn: number; maxDrawdown: number; trades: number; profitFactor: number | null; sharpe: number | null; winRate: number | null }
export interface SweepResult { xKey: SweepKey; yKey: SweepKey; xs: number[]; ys: number[]; rows: SweepRow[]; best: SweepRow | null; notes: string[] }

/** Grid search over two parameters. Invalid combos (e.g. fast ≥ slow) are skipped. */
export function sweepTrend(k: Candle[], base: TrendConfig, tf: TF, xKey: SweepKey, xs: number[], yKey: SweepKey, ys: number[], o: TrendBtOpts): SweepResult {
  if (xs.length * ys.length > 400) throw new Error('sweep too large (max 400 combinations)');
  const rows: SweepRow[] = [];
  for (const x of xs) for (const y of ys) {
    const cfg = { ...base, [xKey]: x, [yKey]: y } as TrendConfig;
    if (validateTrendConfig(cfg).length) continue;
    try {
      const r = runTrendBacktest(k, cfg, tf, o).metrics;
      rows.push({ x, y, totalReturn: r.totalReturn, maxDrawdown: r.maxDrawdown, trades: r.trades, profitFactor: r.profitFactor, sharpe: r.sharpe, winRate: r.winRate });
    } catch { /* not enough data for this combo */ }
  }
  const ranked = rows.filter((r) => r.trades >= 3).sort((a, b) => b.totalReturn - a.totalReturn);
  return {
    xKey, yKey, xs, ys, rows, best: ranked[0] ?? null,
    notes: [
      `${rows.length} combinations on the same ${k.length} candles. The best cell is in-sample: picking the max of many runs overfits.`,
      'Prefer a broad plateau of good cells over a lone peak, and confirm on a later, unseen period (walk-forward) before going live.',
      'Combos with fewer than 3 trades are not eligible for "best".',
    ],
  };
}
