/**
 * One number a capital router can compare across chains. The rate is the same net generation the harness reports
 * (token units per day after fees, gas, taxes and realized rebalancing losses). Confidence comes from rolling
 * sub-windows. The capital curve replays the same window at several sizes: LP fees dilute as our liquidity becomes
 * a larger share of the pool, and grid fills pay more price impact as each order grows against the same depth.
 */
import type { Candle } from '../market/candles';
import type { PoolMinute } from '../market/lpReplay';
import { runBot, type BotConfig, type HarnessData } from './run';

const DAY = 86_400;
/** Sizes tried, as multiples of the configured capital. */
export const CAPITAL_MULTIPLIERS = [0.25, 1, 2, 4, 10] as const;

export interface ScoreRange {
  from: number;
  to: number;
  /** Length of each confidence window. Default 7 days. */
  horizonDays?: number;
  candles?: Candle[];
  minutes?: PoolMinute[];
  poolLiquidity?: number;
  /** Grid and token price impact. The same depth is used at every capital size. */
  poolDepth?: { quoteReserve: number; baseReserve: number };
  /** ISO time the score is as of. Default: the window end. */
  asOf?: string;
  /** Default modeled. onchain only when the caller measured the rate on-chain. */
  source?: 'modeled' | 'onchain';
}

export interface CapitalPoint { capitalUsd: number; usdPerDay: number }

export interface OpportunityScore {
  chain: string;
  dex: string;
  pool: string;
  botType: BotConfig['kind'];
  config: BotConfig;
  ratePerDay: Record<string, number>;
  usdPerDay: number;
  horizonDays: number;
  windowDays: number;
  confidence: { p10UsdPerDay: number; p50UsdPerDay: number; p90UsdPerDay: number; oosStable: boolean };
  source: 'modeled' | 'onchain';
  asOf: string;
  /** Configured capital, in USD. */
  capitalUsd: number;
  /**
   * Largest tried size whose extra USD/day per extra dollar is still at least half the USD/day per dollar at 1x.
   * The step into 0.25x is measured from zero. When the 1x replay does not earn, this stays at the 1x capital.
   */
  maxCapitalUsd: number;
  ratePerDayAt: CapitalPoint[];
}

function sliceOf(data: HarnessData, from: number, to: number): HarnessData {
  return {
    ...data,
    candles: data.candles?.filter((c) => c.t >= from && c.t < to),
    minutes: data.minutes?.filter((m) => m.t >= from && m.t < to),
  };
}

function usable(cfg: BotConfig, data: HarnessData): boolean {
  if (cfg.kind === 'lp') {
    const minutes = data.minutes?.length ?? 0;
    const candles = data.candles?.length ?? 0;
    return minutes >= 2 || (candles >= 2 && (data.poolLiquidity ?? 0) > 0);
  }
  return (data.candles?.length ?? 0) >= 2;
}

function usdPerDayOf(cfg: BotConfig, data: HarnessData): number {
  return runBot(cfg, data).usdPerDay;
}

/** Linear quantile on a sorted sample. One sample returns that sample. */
export function quantile(xs: number[], p: number): number {
  if (!xs.length) throw new Error('no confidence samples');
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function scaled(cfg: BotConfig, mult: number): BotConfig {
  return {
    ...cfg,
    capital: cfg.capital * mult,
    perTradeUsd: cfg.perTradeUsd != null ? cfg.perTradeUsd * mult : undefined,
    totalUsd: cfg.totalUsd != null ? cfg.totalUsd * mult : undefined,
  };
}

/**
 * Largest size whose incoming marginal USD/day per dollar is still >= half the 1x USD/day per dollar.
 * Marginal into a size is (usd at that size − usd at the previous size) / (capital − previous capital).
 */
export function maxCapitalWhereMarginalHolds(points: CapitalPoint[], one: CapitalPoint): number {
  if (!(one.usdPerDay > 0) || !(one.capitalUsd > 0)) return one.capitalUsd;
  const ref = one.usdPerDay / one.capitalUsd;
  let prevUsd = 0;
  let prevCap = 0;
  let best = one.capitalUsd;
  let any = false;
  for (const p of points) {
    const dCap = p.capitalUsd - prevCap;
    const marginal = dCap > 0 ? (p.usdPerDay - prevUsd) / dCap : 0;
    if (marginal >= 0.5 * ref) { best = p.capitalUsd; any = true; }
    prevUsd = p.usdPerDay;
    prevCap = p.capitalUsd;
  }
  return any ? best : one.capitalUsd;
}

export function scoreOpportunity(config: BotConfig, range: ScoreRange): OpportunityScore {
  if (!(range.to > range.from)) throw new Error('the score window is empty');
  const data: HarnessData = {
    candles: range.candles, minutes: range.minutes,
    poolLiquidity: range.poolLiquidity, poolDepth: range.poolDepth,
  };
  const full = sliceOf(data, range.from, range.to);
  if (!usable(config, full)) throw new Error('scoreOpportunity needs candles or pool minutes on the range');
  const horizonDays = range.horizonDays ?? 7;
  if (!(horizonDays > 0)) throw new Error('horizonDays must be > 0');
  const horizon = horizonDays * DAY;
  const windowDays = (range.to - range.from) / DAY;

  const head = runBot(config, full);
  const samples: number[] = [];
  if (range.to - range.from + 1e-6 < horizon) {
    samples.push(head.usdPerDay);
  } else {
    for (let start = range.from; start + horizon <= range.to + 1e-6; start += DAY) {
      const w = sliceOf(data, start, start + horizon);
      if (!usable(config, w)) continue;
      samples.push(usdPerDayOf(config, w));
    }
    if (!samples.length) samples.push(head.usdPerDay);
  }

  let oosStable = false;
  const oosFrom = range.to - range.from > horizon ? range.to - horizon : range.from + (range.to - range.from) / 2;
  const oos = sliceOf(data, oosFrom, range.to);
  if (usable(config, oos)) oosStable = usdPerDayOf(config, oos) > 0;

  const stable = config.quote.symbol === 'USDC' || config.quote.symbol === 'USDT' || config.quote.symbol === 'DAI' || config.quote.symbol === 'USDG';
  const usdPerQuote = config.usdPerQuote ?? (stable ? 1 : 0);
  const capitalUsd = config.capital * (usdPerQuote || 1);

  const ratePerDayAt: CapitalPoint[] = CAPITAL_MULTIPLIERS.map((mult) => {
    const run = runBot(scaled(config, mult), full);
    return { capitalUsd: capitalUsd * mult, usdPerDay: run.usdPerDay };
  });
  const at1 = ratePerDayAt.find((p) => Math.abs(p.capitalUsd - capitalUsd) < 1e-6) ?? { capitalUsd, usdPerDay: head.usdPerDay };

  const ratePerDay: Record<string, number> = {};
  for (const r of head.rates) ratePerDay[r.symbol] = r.perDay;

  return {
    chain: config.chain,
    dex: config.dex ?? '',
    pool: config.pool ?? '',
    botType: config.kind,
    config,
    ratePerDay,
    usdPerDay: head.usdPerDay,
    horizonDays,
    windowDays,
    confidence: {
      p10UsdPerDay: quantile(samples, 0.1),
      p50UsdPerDay: quantile(samples, 0.5),
      p90UsdPerDay: quantile(samples, 0.9),
      oosStable,
    },
    source: range.source ?? 'modeled',
    asOf: range.asOf ?? new Date(range.to * 1000).toISOString(),
    capitalUsd,
    maxCapitalUsd: maxCapitalWhereMarginalHolds(ratePerDayAt, at1),
    ratePerDayAt,
  };
}
