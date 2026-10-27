/**
 * Replays one bot config on candles or pool minutes. Decisions come from the live code (injected so a test can
 * substitute them): the LP move rule, the grid tick, the trend signal, the token-trader exit. Costs are the
 * shared swap model plus the chain gas table. Results are token units generated per day after fees, gas, taxes
 * and realized rebalancing losses.
 */
import { calculateGridLevels } from '../engine/gridEngine';
import { shouldRecenter, type RecenterState } from '../live/recenter';
import { buildIntervals, buyAmountPerInterval, evaluateTick, onTradeFilled, onTradeSkipped, seedIntervals, type LiveInterval, type QueuedTrade } from '../live/liveGrid';
import type { Candle, TF } from '../market/candles';
import { simBuy, simSell, type CostModel } from '../market/costs';
import { lpShouldMove } from '../market/lpMove';
import { replayLp, type PoolMinute, type ReplayPool } from '../market/lpReplay';
import { runTrendBacktest, type TrendBtOpts } from '../market/backtest';
import { signalAt, type TrendConfig } from '../market/strategy';
import { decideExit, sizeBuy, splitSell } from '../market/tokenTrader';
import { rawPrice, tickAtPrice, type PoolSides } from '../live/v3Liquidity';
import { DEFAULT_FEE_K, lpShareForFeeTier } from './feeModel';
import { gasQuote, type BacktestChain } from './gasModel';
import { type BotSummary, type NamedNumber, type SimFill } from './report';

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDG']);
const day = 86_400;

export interface TokenRef { symbol: string; decimals: number; address?: string }

export interface BotConfig {
  kind: 'lp' | 'grid' | 'trend' | 'token';
  chain: BacktestChain;
  /** DEX id from the saved bot, when the state has one (for example pulsex-v2). */
  dex?: string;
  /** Pool address from the saved bot, when the state has one. */
  pool?: string;
  base: TokenRef;
  quote: TokenRef;
  /** Pool fee in basis points (Uniswap 0.05% = 5, PulseX V2 = 29). */
  feeBps: number;
  /** V3 fee tier in hundredths of a bip (500 = 0.05%). Used for the LP share. Defaults from feeBps × 100. */
  feeTier?: number;
  /** Capital in the quote coin. */
  capital: number;
  buyTaxPct?: number;
  sellTaxPct?: number;
  slippageBps?: number;
  /** Native coin per gas unit. 0 in a fixture that is not measuring gas. */
  gasPriceNative?: number;
  /** Quote per 1 native. Omit when the quote coin is the native coin (WPLS in a HEX/WPLS bot). */
  quotePerNative?: number;
  /** Which pair coin pays gas. ETH/USDC pays in the base coin. HEX/WPLS pays in the quote coin. */
  gasToken?: 'base' | 'quote';
  l1NativePerTx?: number;
  usdPerBase?: number;
  usdPerQuote?: number;
  /** Candle-volume fee scale. Swap-minute replays do not apply it. */
  feeK?: number;
  lpShare?: number;
  bandPct?: number;
  rerange?: boolean;
  dwellMs?: number;
  cooldownMs?: number;
  maxImpact?: number;
  spacing?: number;
  baseIs0?: boolean;
  lowerPrice?: number;
  upperPrice?: number;
  gridCount?: number;
  reinvest?: boolean;
  recenter?: boolean;
  trend?: TrendConfig;
  tf?: TF;
  perTradeUsd?: number;
  totalUsd?: number;
}

export interface HarnessData {
  /** Mid prices, quote per base, oldest first. */
  candles?: Candle[];
  /** Pool minutes from swaps. When present, an LP run uses these instead of candle volume. */
  minutes?: PoolMinute[];
  /** Raw active liquidity, for turning candle volume into a fee per unit of liquidity. */
  poolLiquidity?: number;
  /** V2-style reserves. Grid and token fills pay price impact from this depth. */
  poolDepth?: { quoteReserve: number; baseReserve: number };
  onChain?: NamedNumber[];
}

export interface EngineDeps {
  lpShouldMove: typeof lpShouldMove;
  replayLp: typeof replayLp;
  calculateGridLevels: typeof calculateGridLevels;
  buildIntervals: typeof buildIntervals;
  buyAmountPerInterval: typeof buyAmountPerInterval;
  seedIntervals: typeof seedIntervals;
  evaluateTick: typeof evaluateTick;
  onTradeFilled: typeof onTradeFilled;
  onTradeSkipped: typeof onTradeSkipped;
  shouldRecenter: typeof shouldRecenter;
  runTrendBacktest: typeof runTrendBacktest;
  signalAt: typeof signalAt;
  decideExit: typeof decideExit;
  sizeBuy: typeof sizeBuy;
  splitSell: typeof splitSell;
  simBuy: typeof simBuy;
  simSell: typeof simSell;
}

export const liveEngines: EngineDeps = {
  lpShouldMove, replayLp, calculateGridLevels, buildIntervals, buyAmountPerInterval, seedIntervals,
  evaluateTick, onTradeFilled, onTradeSkipped, shouldRecenter, runTrendBacktest, signalAt,
  decideExit, sizeBuy, splitSell, simBuy, simSell,
};

const kindWord = { lp: 'liquidity', grid: 'grid', trend: 'trend', token: 'token trader' } as const;

function costsOf(cfg: BotConfig, depth: { quoteReserve: number; plsReserve: number } | null): CostModel {
  return {
    feeBps: cfg.feeBps,
    pool: depth,
    gasPricePls: cfg.gasPriceNative ?? 0,
    approval: 'exact',
    slippageBps: cfg.slippageBps ?? 0,
    gasUnits: { approve: 60_000, swap: cfg.chain === 'ethereum' ? 180_000 : 220_000 },
    extraPlsPerSwap: cfg.l1NativePerTx ?? 0,
    buyTaxPct: cfg.buyTaxPct ?? 0,
    sellTaxPct: cfg.sellTaxPct ?? 0,
  };
}

function sellOf(mid: number, feeBps: number): number {
  return mid * (1 - feeBps / 10_000);
}

function usdOf(cfg: BotConfig, price: number): { base: number; quote: number } {
  const quote = cfg.usdPerQuote ?? (STABLES.has(cfg.quote.symbol) ? 1 : 0);
  const base = cfg.usdPerBase ?? (quote > 0 ? price * quote : 0);
  return { base, quote };
}

function priceChanges(cfg: BotConfig, start: number, end: number): { symbol: string; pct: number }[] {
  const out: { symbol: string; pct: number }[] = [];
  if (STABLES.has(cfg.quote.symbol)) out.push({ symbol: cfg.quote.symbol, pct: 0 });
  out.push({ symbol: cfg.base.symbol, pct: STABLES.has(cfg.base.symbol) ? 0 : (start > 0 ? end / start - 1 : 0) });
  return out;
}

function depthOf(data: HarnessData): { quoteReserve: number; plsReserve: number } | null {
  const d = data.poolDepth;
  if (!d || !(d.quoteReserve > 0) || !(d.baseReserve > 0)) return null;
  return { quoteReserve: d.quoteReserve, plsReserve: d.baseReserve };
}

function finish(cfg: BotConfig, g: {
  base: number; quote: number; days: number; moves: number; movesWord: BotSummary['movesWord'];
  timeInRange: number; timeWord: BotSummary['timeWord']; feeUsd: number;
  priceStart: number; priceEnd: number; netVsHold: number;
}, extra?: { onChain?: NamedNumber[]; modelNotes?: NamedNumber[]; simFills?: SimFill[] }): BotSummary {
  if (!(g.days > 0)) throw new Error('the window is empty');
  const usd = usdOf(cfg, g.priceEnd);
  const usdPerDay = (g.base * usd.base + g.quote * usd.quote) / g.days;
  const capitalUsd = cfg.capital * (usd.quote || 1);
  const tier = cfg.feeTier ?? cfg.feeBps * 100;
  const modelNotes: NamedNumber[] = [...(extra?.modelNotes ?? [])];
  if (cfg.kind === 'lp') {
    modelNotes.unshift(
      { label: 'Fee model k', value: cfg.feeK ?? DEFAULT_FEE_K, source: 'modeled' },
      { label: 'LP share', value: lpShareForFeeTier(tier, cfg.lpShare), source: 'modeled' },
    );
  }
  return {
    title: `${cfg.base.symbol}/${cfg.quote.symbol} ${kindWord[cfg.kind]}`,
    kind: cfg.kind,
    rates: [
      { symbol: cfg.quote.symbol, perDay: g.quote / g.days, source: 'modeled' },
      { symbol: cfg.base.symbol, perDay: g.base / g.days, source: 'modeled' },
    ],
    usdPerDay, usdSource: 'modeled',
    moves: g.moves, movesWord: g.movesWord,
    timeInRange: g.timeInRange, timeWord: g.timeWord,
    feeApr: capitalUsd > 0 ? (g.feeUsd / capitalUsd) * (365 / g.days) : 0,
    priceChange: priceChanges(cfg, g.priceStart, g.priceEnd),
    netVsHold: { amount: g.netVsHold, symbol: cfg.quote.symbol },
    modelNotes, onChain: extra?.onChain ?? [], simFills: extra?.simFills ?? [],
  };
}

function poolOf(cfg: BotConfig): ReplayPool {
  return {
    baseIs0: cfg.baseIs0 !== false,
    baseDecimals: cfg.base.decimals,
    quoteDecimals: cfg.quote.decimals,
    spacing: cfg.spacing ?? (cfg.feeTier === 500 ? 10 : 1),
    swapFee: cfg.feeBps / 10_000,
  };
}

/** Candle volume → the minute rows replayLp already understands. Fees are the candle model (k × volume × share). */
export function minutesFromCandles(candles: Candle[], cfg: BotConfig, poolLiquidity: number): PoolMinute[] {
  if (!(poolLiquidity > 0)) throw new Error('candle LP replay needs the pool active liquidity');
  const sides: PoolSides = { baseIs0: cfg.baseIs0 !== false, baseDecimals: cfg.base.decimals, quoteDecimals: cfg.quote.decimals };
  const tier = cfg.feeTier ?? cfg.feeBps * 100;
  const share = lpShareForFeeTier(tier, cfg.lpShare);
  const k = cfg.feeK ?? DEFAULT_FEE_K;
  const fee = cfg.feeBps / 10_000;
  return candles.map((c) => {
    const tick = (p: number) => tickAtPrice(rawPrice(p, sides));
    const ticks = [tick(c.l), tick(c.h), tick(c.c)];
    const totalQuote = Math.max(0, c.v) * fee * share * k;
    const up = c.c >= c.o;
    const quoteHuman = up ? totalQuote : 0;
    const baseHuman = up ? 0 : totalQuote / c.c;
    const rawPer = (human: number, decimals: number) => (human * 10 ** decimals) / poolLiquidity;
    const fBase = rawPer(baseHuman, cfg.base.decimals);
    const fQuote = rawPer(quoteHuman, cfg.quote.decimals);
    return {
      t: c.t, lo: Math.min(...ticks), hi: Math.max(...ticks), c: tick(c.c),
      f0: sides.baseIs0 ? fBase : fQuote, f1: sides.baseIs0 ? fQuote : fBase,
      liq: poolLiquidity, n: 1,
    };
  });
}

function lpGasQuote(cfg: BotConfig, action: 'v3Open' | 'v3Move' | 'swap' | 'approve', price: number): number {
  const quotePerNative = cfg.quotePerNative ?? (cfg.gasToken === 'quote' ? 1 : price);
  return gasQuote(cfg.chain, action, cfg.gasPriceNative ?? 0, quotePerNative, cfg.l1NativePerTx ?? 0);
}

function runLp(cfg: BotConfig, data: HarnessData, e: EngineDeps): BotSummary {
  if (!(cfg.bandPct && cfg.bandPct > 0)) throw new Error('an LP bot needs bandPct');
  const minutes = data.minutes ?? minutesFromCandles(data.candles ?? [], cfg, data.poolLiquidity ?? 0);
  const pool = poolOf(cfg);
  const priceGuess = cfg.quotePerNative ?? 1;
  const gasOpen = lpGasQuote(cfg, 'v3Open', priceGuess) + lpGasQuote(cfg, 'swap', priceGuess) + 2 * lpGasQuote(cfg, 'approve', priceGuess);
  const gasMove = lpGasQuote(cfg, 'v3Move', priceGuess) + lpGasQuote(cfg, 'approve', priceGuess);
  const r = e.replayLp(minutes, pool, {
    bandPct: cfg.bandPct,
    rerange: cfg.rerange !== false,
    capital: cfg.capital,
    gasOpen, gasMove,
    maxImpact: cfg.maxImpact ?? 0.05,
    buyTax: cfg.buyTaxPct ?? 0,
    sellTax: cfg.sellTaxPct ?? 0,
    dwellMs: cfg.dwellMs ?? 0,
    cooldownMs: cfg.cooldownMs ?? 0,
    shouldMove: e.lpShouldMove,
  });
  const price = r.priceEnd > 0 ? r.priceEnd : priceGuess;
  const gasBase = cfg.gasToken === 'base' && price > 0 ? r.gas / price : 0;
  const gasQuoteAmt = cfg.gasToken === 'base' ? 0 : r.gas;
  const usd = usdOf(cfg, price);
  const feeUsd = r.feeCoins.base * usd.base + r.feeCoins.quote * usd.quote;
  const endValue = r.endCoins.base * price + r.endCoins.quote - r.gas;
  const holdValue = r.startCoins.base * price + r.startCoins.quote;
  return finish(cfg, {
    base: r.feeCoins.base - gasBase,
    quote: r.feeCoins.quote - gasQuoteAmt - r.swapCost - r.moveLoss,
    days: r.days, moves: r.moves, movesWord: 'Moves',
    timeInRange: r.inRange, timeWord: 'Time in range',
    feeUsd, priceStart: r.priceStart, priceEnd: price,
    netVsHold: endValue - holdValue,
  }, { onChain: data.onChain });
}

function runGrid(cfg: BotConfig, data: HarnessData, e: EngineDeps): BotSummary {
  const candles = data.candles ?? [];
  if (candles.length < 2) throw new Error('need at least 2 candles');
  if (!(cfg.lowerPrice && cfg.upperPrice && cfg.gridCount)) throw new Error('a grid needs lowerPrice, upperPrice and gridCount');
  const costs = costsOf(cfg, depthOf(data));
  const px = (mid: number) => sellOf(mid, cfg.feeBps);
  let lower = cfg.lowerPrice, upper = cfg.upperPrice;
  let levels = e.calculateGridLevels(lower, upper, cfg.gridCount);
  const per = e.buyAmountPerInterval(cfg.gridCount, cfg.capital);
  let intervals = e.buildIntervals(levels, px(candles[0].o), per);
  let quote = cfg.capital;
  let base = 0;
  let fills = 0;
  let feeQuote = 0;
  let realized = 0;
  const simFills: SimFill[] = [];
  const take = (q: QueuedTrade, levelPrice: number, t: number) => {
    if (q.side === 'buy') {
      if (!(quote >= q.amount)) { intervals = e.onTradeSkipped(intervals, q); return; }
      const b = e.simBuy(q.amount, levelPrice, costs);
      quote -= q.amount + b.gasQuote;
      feeQuote += b.fee;
      base += b.pls;
      intervals = e.onTradeFilled(intervals, q, b.pls, q.amount + b.gasQuote);
      simFills.push({ t, side: 'buy', price: b.execPrice, baseAmount: b.pls, quoteAmount: q.amount, feeQuote: b.fee });
    } else {
      const lot = intervals.find((i) => i.index === q.intervalIndex);
      const s = e.simSell(q.amount, levelPrice, costs);
      const proceeds = s.quote - s.gasQuote;
      const cost = lot?.lotCost ?? q.amount * levelPrice;
      quote += proceeds;
      realized += proceeds - cost;
      feeQuote += s.fee;
      base -= q.amount;
      const next = cfg.reinvest === false ? lot?.buyAmount : (lot?.buyAmount ?? 0) + (proceeds - cost);
      intervals = e.onTradeFilled(intervals, q, 0, undefined, next);
      simFills.push({ t, side: 'sell', price: s.execPrice, baseAmount: q.amount, quoteAmount: s.quote, feeQuote: s.fee });
    }
    fills++;
  };
  const seeded = e.seedIntervals(intervals, px(candles[0].o), { pls: 0, cost: 0 }, candles[0].t * 1000);
  intervals = seeded.intervals;
  if (seeded.job) take(seeded.job, seeded.job.levelPrice, candles[0].t);
  let prev = px(candles[0].o);
  let inBars = 0;
  let recenter: RecenterState = { enabled: !!cfg.recenter, aboveSince: null, lastAt: null, count: 0 };
  for (const bar of candles) {
    const path = bar.c >= bar.o ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c];
    for (const mid of path) {
      const p = px(mid);
      if (p === prev) continue;
      const ev = e.evaluateTick(intervals, p, bar.t * 1000);
      intervals = ev.intervals;
      for (const q of ev.queued) take(q, q.levelPrice, bar.t);
      prev = p;
    }
    const close = px(bar.c);
    if (close >= lower && close <= upper) inBars++;
    if (recenter.enabled) {
      const flat = intervals.every((i: LiveInterval) => i.status === 'inactive' || i.status === 'waitingBuy');
      const d = e.shouldRecenter(recenter, close, upper, bar.t * 1000, flat);
      recenter = { ...recenter, aboveSince: d.aboveSince };
      if (d.move) {
        const band = (upper - lower) / (upper + lower);
        lower = close * (1 - band);
        upper = close * (1 + band);
        levels = e.calculateGridLevels(lower, upper, cfg.gridCount);
        const perLevel = intervals.reduce((a, i) => a + i.buyAmount, 0) / cfg.gridCount;
        intervals = e.buildIntervals(levels, close, perLevel);
        const seed = e.seedIntervals(intervals, close, { pls: 0, cost: 0 }, bar.t * 1000);
        intervals = seed.intervals;
        if (seed.job) take(seed.job, close, bar.t);
        recenter = { enabled: true, aboveSince: null, lastAt: bar.t * 1000, count: recenter.count + 1 };
      }
    }
  }
  const priceEnd = candles[candles.length - 1].c;
  const endValue = base * priceEnd + quote;
  return finish(cfg, {
    base: 0, quote: realized,
    days: (candles[candles.length - 1].t - candles[0].t) / day,
    moves: fills, movesWord: 'Fills',
    timeInRange: inBars / candles.length, timeWord: 'Time in range',
    feeUsd: feeQuote * (usdOf(cfg, priceEnd).quote || 1),
    priceStart: candles[0].o, priceEnd,
    netVsHold: endValue - cfg.capital,
  }, { onChain: data.onChain, simFills });
}

function runTrend(cfg: BotConfig, data: HarnessData, e: EngineDeps): BotSummary {
  const candles = data.candles ?? [];
  if (candles.length < 2) throw new Error('need at least 2 candles');
  if (!cfg.trend) throw new Error('a trend bot needs a trend config');
  const tf = cfg.tf ?? '1h';
  const costs = costsOf(cfg, depthOf(data));
  const mapped = candles.map((c) => ({ ...c, o: sellOf(c.o, cfg.feeBps), h: sellOf(c.h, cfg.feeBps), l: sellOf(c.l, cfg.feeBps), c: sellOf(c.c, cfg.feeBps) }));
  const opts: TrendBtOpts = { capital: cfg.capital, costs, markOpen: true, signalAt: e.signalAt };
  const r = e.runTrendBacktest(mapped, cfg.trend, tf, opts);
  const realized = r.trades.reduce((a, t) => a + t.pnl, 0);
  const feeQuote = r.trades.reduce((a, t) => a + t.fees, 0);
  const priceEnd = candles[candles.length - 1].c;
  const openBase = r.open?.pls ?? 0;
  const openValue = openBase * sellOf(priceEnd, cfg.feeBps);
  const endQuote = cfg.capital + realized;
  const simFills: SimFill[] = r.trades.flatMap((t) => [
    { t: t.entryT, side: 'buy' as const, price: t.entryPrice, baseAmount: t.pls, quoteAmount: t.cost, feeQuote: t.fees / 2 },
    { t: t.exitT, side: 'sell' as const, price: t.exitPrice, baseAmount: t.pls, quoteAmount: t.proceeds, feeQuote: t.fees / 2 },
  ]);
  return finish(cfg, {
    base: 0, quote: realized,
    days: (candles[candles.length - 1].t - candles[0].t) / day,
    moves: r.trades.length, movesWord: 'Fills',
    timeInRange: r.metrics.exposure, timeWord: 'Time in a position',
    feeUsd: feeQuote * (usdOf(cfg, priceEnd).quote || 1),
    priceStart: candles[0].o, priceEnd,
    netVsHold: endQuote + openValue - cfg.capital,
  }, { onChain: data.onChain, simFills });
}

function runToken(cfg: BotConfig, data: HarnessData, e: EngineDeps): BotSummary {
  const candles = data.candles ?? [];
  if (candles.length < 2) throw new Error('need at least 2 candles');
  const c0 = candles[0];
  const depth = depthOf(data) ?? { quoteReserve: Math.max(cfg.capital * 50, 1), plsReserve: Math.max(cfg.capital * 50, 1) / c0.c };
  const costs = costsOf(cfg, depth);
  const usd = usdOf(cfg, c0.c);
  const usdPerSpend = usd.quote || 1;
  const size = e.sizeBuy({
    perTradeUsd: cfg.perTradeUsd ?? cfg.capital * usdPerSpend,
    totalUsd: cfg.totalUsd ?? cfg.capital * usdPerSpend,
    openUsd: 0,
    quoteReserve: costs.pool!.quoteReserve,
    usdPerSpend,
    feeBps: cfg.feeBps,
    buyTax: cfg.buyTaxPct ?? 0,
    price: sellOf(c0.c, cfg.feeBps),
    maxImpact: cfg.maxImpact ?? 0.05,
  });
  if (!size) throw new Error('the pool is too thin for this token buy');
  const buy = e.simBuy(size.spend, sellOf(c0.c, cfg.feeBps), costs);
  let tokens = buy.pls;
  const entry = tokens;
  let proceeds = 0;
  let feeQuote = buy.fee;
  let sells = 0;
  const simFills: SimFill[] = [{ t: c0.t, side: 'buy', price: buy.execPrice, baseAmount: buy.pls, quoteAmount: size.spend, feeQuote: buy.fee }];
  let tp1 = false, tp2 = false;
  let peak = c0.c;
  for (const c of candles.slice(1)) {
    if (c.c > peak) peak = c.c;
    const d = e.decideExit({
      entryPrice: c0.c, price: c.c, peak, openedAt: c0.t * 1000, now: c.t * 1000,
      entryVolume: c0.v, volume: c.v, entryLiq: costs.pool!.quoteReserve, liq: costs.pool!.quoteReserve,
      sellTax: cfg.sellTaxPct ?? 0, entrySellTax: cfg.sellTaxPct ?? 0, sellSimOk: true,
      tp1Done: tp1, tp2Done: tp2, remainingFrac: entry > 0 ? tokens / entry : 0,
    });
    if (d.action !== 'sell' || !(tokens > 0)) continue;
    const qty = Math.min(tokens, entry * d.frac);
    for (const part of e.splitSell(qty, costs.pool!.plsReserve, cfg.feeBps, cfg.maxImpact ?? 0.05)) {
      const s = e.simSell(part, sellOf(c.c, cfg.feeBps), costs);
      proceeds += s.quote - s.gasQuote;
      feeQuote += s.fee;
      tokens -= part;
      sells++;
      simFills.push({ t: c.t, side: 'sell', price: s.execPrice, baseAmount: part, quoteAmount: s.quote, feeQuote: s.fee });
    }
    if (d.why.includes('take profit') && !tp1) tp1 = true;
    else if (d.why.includes('take profit')) tp2 = true;
  }
  const sold = entry - tokens;
  const soldFrac = entry > 0 ? sold / entry : 0;
  const spent = (size.spend + buy.gasQuote) * soldFrac;
  const realized = proceeds - spent;
  const priceEnd = candles[candles.length - 1].c;
  const endValue = (cfg.capital - size.spend - buy.gasQuote) + proceeds + tokens * sellOf(priceEnd, cfg.feeBps);
  return finish(cfg, {
    base: 0, quote: realized,
    days: (candles[candles.length - 1].t - candles[0].t) / day,
    moves: sells + 1, movesWord: 'Fills',
    timeInRange: tokens > entry * 1e-6 ? 1 : sells / candles.length, timeWord: 'Time in a position',
    feeUsd: feeQuote * (usdOf(cfg, priceEnd).quote || 1),
    priceStart: c0.c, priceEnd,
    netVsHold: endValue - cfg.capital,
  }, { onChain: data.onChain, simFills });
}

export function runBot(cfg: BotConfig, data: HarnessData, engines: EngineDeps = liveEngines): BotSummary {
  if (cfg.kind === 'lp') return runLp(cfg, data, engines);
  if (cfg.kind === 'grid') return runGrid(cfg, data, engines);
  if (cfg.kind === 'trend') return runTrend(cfg, data, engines);
  return runToken(cfg, data, engines);
}
