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
  fees: number; gas: number; days: number;
  bhReturn: number; bhMaxDrawdown: number; blockedByCost: number;
}

export interface BtResult {
  kind: 'trend' | 'grid';
  tf: TF;
  metrics: BtMetrics;
  equity: { t: number; v: number; bh: number }[];
  trades: BtTrade[];
  notes: string[];
}

export function maxDrawdown(v: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const x of v) { if (x > peak) peak = x; if (peak > 0) dd = Math.max(dd, 1 - x / peak); }
  return dd;
}

function metrics(eq: { t: number; v: number; bh: number }[], trades: BtTrade[], tf: TF, capital: number, inPosBars: number, blocked: number): BtMetrics {
  const end = eq.length ? eq[eq.length - 1].v : capital;
  const days = eq.length > 1 ? (eq[eq.length - 1].t - eq[0].t) / 86_400 : 0;
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) rets.push(eq[i].v / eq[i - 1].v - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const dsd = Math.sqrt(rets.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / (rets.length || 1));
  const perYear = (365 * 86_400) / TF_SEC[tf];
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const bh = eq.map((e) => e.bh);
  return {
    startEquity: capital, endEquity: end, totalReturn: end / capital - 1,
    cagr: days >= 30 ? (end / capital) ** (365 / days) - 1 : null,
    maxDrawdown: maxDrawdown(eq.map((e) => e.v)),
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
    fees: trades.reduce((a, t) => a + t.fees, 0),
    gas: trades.reduce((a, t) => a + t.gas, 0),
    days,
    bhReturn: bh.length ? bh[bh.length - 1] / capital - 1 : 0,
    bhMaxDrawdown: maxDrawdown(bh),
    blockedByCost: blocked,
  };
}

/** Buy & hold PLS from the first tradable open, same cost model. */
function buyHold(k: Candle[], start: number, capital: number, m: CostModel) {
  const b = simBuy(capital, k[start].o, m);
  return { pls: b.pls, cashLeft: -b.gasQuote };
}

export interface TrendBtOpts { capital: number; costs: CostModel; htf?: Candle[] }

export function runTrendBacktest(k: Candle[], cfg: TrendConfig, tf: TF, o: TrendBtOpts): BtResult {
  const errs = validateTrendConfig(cfg);
  if (errs.length) throw new Error(errs.join('; '));
  const need = warmup(cfg);
  if (k.length < need + 2) throw new Error(`need ≥ ${need + 2} candles, have ${k.length}`);
  const ind = computeIndicators(k, cfg);
  const s = TF_SEC[tf];
  const start = need - 1;
  const bh = buyHold(k, start, o.capital, o.costs);
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
      const sig = signalAt(ind, k, i, cfg);
      if (pos) {
        pos.bars++;
        if (sig.exit) pending = { kind: 'exit', reason: 'signal' };
        else if (cfg.maxHoldBars > 0 && pos.bars >= cfg.maxHoldBars) pending = { kind: 'exit', reason: 'maxhold' };
      } else if (sig.enter && i >= cooldownUntil && ind.atr[i] != null) {
        if (!o.htf || htfAllows(o.htf, bar.t + s, cfg).ok) pending = { kind: 'enter', atr: ind.atr[i]! };
      }
    }
    if (pos) inPos++;
    eq.push({ t: bar.t, v: cash + (pos ? pos.pls * bar.c : 0), bh: bh.pls * bar.c + bh.cashLeft });
  }
  if (pos) {
    const last = k[k.length - 1];
    exit(last.t, last.c, 'end', k.length - 1);
    eq[eq.length - 1].v = cash;
  }
  return {
    kind: 'trend', tf, metrics: metrics(eq, trades, tf, o.capital, inPos, blocked), equity: eq, trades,
    notes: [
      'Signals on candle close, filled at the next open; stops/TP intrabar (stop first if both hit in one candle).',
      'Price impact uses CURRENT pool reserves re-centred at each historical price (approximation).',
      `Costs per swap: ${o.costs.feeBps / 100}% LP fee, impact, gas at the current gas price, ${o.costs.slippageBps} bps assumed slippage.`,
      'An open position at the end is closed at the last close (reason "end").',
    ],
  };
}

export interface GridBtConfig { lowerPrice: number; upperPrice: number; gridCount: number; capital: number }

/**
 * Grid backtest: intervals below the first open start with a buy (same bootstrap as live). Each candle is
 * walked o→l→h→c (bullish) or o→h→l→c (bearish); fills at the level price (optimistic vs live polling).
 */
export function runGridBacktest(k: Candle[], g: GridBtConfig, tf: TF, costs: CostModel): BtResult {
  if (k.length < 2) throw new Error('need ≥ 2 candles');
  const levels = calculateGridLevels(g.lowerPrice, g.upperPrice, g.gridCount).map((l) => l.price);
  const p0 = k[0].o;
  const iv = levels.slice(0, -1).map((b, i) => ({ buy: b, sell: levels[i + 1], state: (b < p0 ? 'wait' : 'off') as 'wait' | 'hold' | 'off', pls: 0, cost: 0, t: 0, fee: 0, gas: 0 }));
  const nBuy = iv.filter((x) => x.state === 'wait').length;
  if (!nBuy) throw new Error('no grid levels below the first price');
  const per = g.capital / nBuy;
  const bh = buyHold(k, 0, g.capital, costs);
  let cash = g.capital, inPos = 0;
  const trades: BtTrade[] = [];
  const eq: BtResult['equity'] = [];
  const visit = (from: number, to: number, t: number) => {
    if (to < from) { // falling: buys from high to low
      for (const x of [...iv].reverse()) if (x.state === 'wait' && x.buy <= from && x.buy >= to && cash >= per) {
        const b = simBuy(per, x.buy, costs);
        cash -= per + b.gasQuote;
        Object.assign(x, { state: 'hold', pls: b.pls, cost: per + b.gasQuote, t, fee: b.fee, gas: b.gasQuote });
      }
    } else {
      for (const x of iv) if (x.state === 'hold' && x.sell >= from && x.sell <= to) {
        const s = simSell(x.pls, x.sell, costs);
        const proceeds = s.quote - s.gasQuote;
        cash += proceeds;
        trades.push({ entryT: x.t, exitT: t, entryPrice: x.buy, exitPrice: x.sell, pls: x.pls, cost: x.cost, proceeds, pnl: proceeds - x.cost, pnlPct: (proceeds - x.cost) / x.cost, fees: x.fee + s.fee, gas: x.gas + s.gasQuote, bars: 0, reason: 'grid' });
        Object.assign(x, { state: 'wait', pls: 0, cost: 0 });
      }
    }
  };
  let prev = k[0].o;
  for (const bar of k) {
    const path = bar.c >= bar.o ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c];
    for (const p of path) { if (p !== prev) visit(prev, p, bar.t); prev = p; }
    const held = iv.reduce((a, x) => a + x.pls, 0);
    if (held > 0) inPos++;
    eq.push({ t: bar.t, v: cash + held * bar.c, bh: bh.pls * bar.c + bh.cashLeft });
  }
  return {
    kind: 'grid', tf, metrics: metrics(eq, trades, tf, g.capital, inPos, 0), equity: eq, trades,
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
  ema: ['fast', 'slow'], ema_rsi: ['fast', 'slow'], macd: ['macdFast', 'macdSlow'], donchian: ['donchianEntry', 'donchianExit'],
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
