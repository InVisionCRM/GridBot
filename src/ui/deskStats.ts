/** Read-only figures for the desk table and the stat block under a chart. Missing inputs stay null. */
import { analyzeSpacing } from '../live/spacing';
import type { AnyObj } from './model';
import { bookUsd, quoteUsd } from './series';
import { estimates, type EstimateSet } from '../shared/generated';
import { generatedOf } from './generatedView';

export const MIN_AGE_MS = 60_000;
export const DAY_MS = 86_400_000;

export interface Extrapolation { amount: number; pct: number | null }

/** Linear extrapolation of the P&L so far. Null until the bot has been running at least a minute. */
export function extrapolate(pnl: number, invested: number, age: number, windowMs: number): Extrapolation | null {
  if (!(age >= MIN_AGE_MS) || !(windowMs > 0) || !Number.isFinite(pnl)) return null;
  const amount = pnl * (windowMs / age);
  if (!Number.isFinite(amount)) return null;
  const pct = invested > 0 && Number.isFinite(invested) ? (pnl / invested) * (windowMs / age) : null;
  return { amount, pct: pct != null && Number.isFinite(pct) ? pct : null };
}

/** Milliseconds since start. Null when the start time is missing or in the future. */
export function ageMs(startedAt: number | null | undefined, now: number): number | null {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 || startedAt > now) return null;
  return now - startedAt;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function usdOf(quote: number | null, k: number): number | null {
  if (quote == null || !(k > 0)) return null;
  return quote * k;
}

export interface MoveParts { fills: number | null; recenters: number | null; trades: number | null; n: number | null; text: string | null }

/** Fills, round trips, and re-centers the payload actually carries. A capped trade list is not treated as the full count. */
export function moveParts(b: AnyObj): MoveParts {
  if (b.kind === 'lp') {
    const n = num(b.reranges);
    return { fills: null, recenters: n, trades: null, n, text: n == null ? null : `${n} re-center${n === 1 ? '' : 's'}` };
  }
  if (b.kind === 'trend' || b.kind === 'trader' || b.kind === 'sniper') {
    const n = num(b.moveCount);
    const word = b.kind === 'trend' ? 'trade' : 'trade';
    return { fills: null, recenters: null, trades: n, n, text: n == null ? null : `${n} ${word}${n === 1 ? '' : 's'}` };
  }
  const fills = num(b.moveCount);
  const recenters = num(b.recenter?.count);
  if (fills == null && recenters == null) return { fills: null, recenters: null, trades: null, n: null, text: null };
  const n = (fills ?? 0) + (recenters ?? 0);
  const bits: string[] = [];
  if (fills != null) bits.push(`${fills} fill${fills === 1 ? '' : 's'}`);
  if (recenters) bits.push(`${recenters} re-center${recenters === 1 ? '' : 's'}`);
  return { fills, recenters, trades: null, n, text: bits.join(' · ') || null };
}

export function winRateOf(b: AnyObj): number | null {
  if (b.kind === 'grid') {
    const trips = num(b.stats?.roundTrips);
    const wins = num(b.stats?.wins);
    if (trips == null || wins == null || trips <= 0) return null;
    return wins / trips;
  }
  if (b.kind === 'trend') {
    const r = num(b.stats?.winRate);
    return r;
  }
  return null;
}

export interface DeskFacts {
  ageMs: number | null;
  investedUsd: number | null;
  valueUsd: number | null;
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  realizedPct: number | null;
  unrealizedPct: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Generated (net of costs, in tokens) ÷ age in days × 1, 7, 365 (shared estimates); null under a day. Never from the price move. */
  est: EstimateSet;
  moves: MoveParts;
  winRate: number | null;
  feesPaidUsd: number | null;
  feesEarnedUsd: number | null;
  timeInRange: number | null;
  range: { lower: number; upper: number } | null;
  spacingFrac: number | null;
  bandPct: number | null;
  lastMoveAt: number | null;
  chain: string | null;
  dex: string | null;
  pool: string | null;
}

function lastMove(b: AnyObj): number | null {
  const direct = num(b.lastMoveAt);
  if (direct != null && direct > 0) return direct;
  if (b.kind === 'lp') {
    const at = num(b.lastRerangeAt);
    return at != null && at > 0 ? at : null;
  }
  let max = 0;
  for (const t of (b.trades ?? []) as AnyObj[]) {
    const ts = num(t.timestamp) ?? num(t.t);
    if (ts != null && ts > max) max = ts;
  }
  return max > 0 ? max : null;
}

function rangeOf(b: AnyObj): { lower: number; upper: number } | null {
  if (b.kind === 'grid' && b.config && num(b.config.upperPrice) != null && num(b.config.lowerPrice) != null && b.config.upperPrice > b.config.lowerPrice) {
    return { lower: b.config.lowerPrice, upper: b.config.upperPrice };
  }
  if (b.kind === 'lp' && b.position && num(b.position.upper) != null && num(b.position.lower) != null && b.position.upper > b.position.lower) {
    return { lower: b.position.lower, upper: b.position.upper };
  }
  return null;
}

function spacingOf(b: AnyObj): { frac: number | null; band: number | null } {
  if (b.kind === 'grid' && b.config && num(b.config.gridCount) != null && num(b.config.lowerPrice) != null && num(b.config.upperPrice) != null && b.config.upperPrice > b.config.lowerPrice && b.config.gridCount >= 2) {
    return { frac: analyzeSpacing(b.config.lowerPrice, b.config.upperPrice, b.config.gridCount).worstSpacingFrac, band: null };
  }
  if (b.kind === 'lp' && num(b.config?.bandPct) != null) return { frac: null, band: b.config.bandPct };
  return { frac: null, band: null };
}

/** Dollars and percents already on the bot (sorting only; nothing renders them). Estimates scale Generated in tokens across 24h, 7d and 365d. */
export function botFacts(b: AnyObj, now = Date.now(), extra?: { chain?: string | null; dex?: string | null; pool?: string | null }): DeskFacts {
  const k = b.kind === 'trader' || b.kind === 'sniper' ? (quoteUsd(b) || 1) : quoteUsd(b);
  const started = num(b.startedAt) ?? num(b.openedAt);
  const age = ageMs(started, now);
  const trader = b.kind === 'trader' || b.kind === 'sniper';
  const investedQuote = trader ? null
    : b.kind === 'grid' ? num(b.config?.totalCapitalUsd)
    : b.kind === 'trend' ? num(b.capital)
    : b.kind === 'lp' ? (num(b.startValue) ?? num(b.config?.capital))
    : null;
  // Grid capital (config.totalCapitalUsd) is in quote units despite its name: equity = capital + realized + unrealized
  // in the quote coin (engine.ts), and the server's USD rollups multiply it by usdPerQuote (multi.ts). Convert it here too.
  const investedUsd = trader ? num(b.spentUsd) : usdOf(investedQuote, k);
  const valueUsd = bookUsd(b);
  let realizedQuote: number | null = null;
  let unrealizedQuote: number | null = null;
  if (b.kind === 'grid' || b.kind === 'trend') {
    realizedQuote = num(b.pnl?.realized);
    unrealizedQuote = num(b.pnl?.unrealized);
  } else if (b.kind === 'lp' && b.pnl) {
    realizedQuote = num(b.pnl.net);
    unrealizedQuote = num(b.pnl.price);
  }
  const realizedUsd = trader ? null : usdOf(realizedQuote, k);
  const unrealizedUsd = trader ? num(b.pnlUsd) ?? num(b.pnl?.unrealized) : usdOf(unrealizedQuote, k);
  const realizedPct = realizedQuote != null && investedQuote != null && investedQuote > 0 ? realizedQuote / investedQuote : null;
  const unrealizedPct = trader
    ? (unrealizedUsd != null && investedUsd != null && investedUsd > 0 ? unrealizedUsd / investedUsd : null)
    : (unrealizedQuote != null && investedQuote != null && investedQuote > 0 ? unrealizedQuote / investedQuote : null);
  const pnlUsd = realizedUsd == null && unrealizedUsd == null ? null : (realizedUsd ?? 0) + (unrealizedUsd ?? 0);
  const pnlPct = b.kind === 'trend' && num(b.pnl?.returnPct) != null ? b.pnl.returnPct
    : b.kind === 'lp' && num(b.pnl?.net) != null && investedQuote != null && investedQuote > 0 ? b.pnl.net / investedQuote
    : investedUsd != null && investedUsd > 0 && pnlUsd != null ? pnlUsd / investedUsd : null;
  let feesPaid: number | null = null;
  let feesEarned: number | null = null;
  if (b.kind === 'grid') {
    const fee = num(b.stats?.totalFees);
    const gas = num(b.stats?.totalGas);
    feesPaid = fee == null && gas == null ? null : usdOf((fee ?? 0) + (gas ?? 0), k);
  } else if (b.kind === 'trend') {
    const fee = num(b.pnl?.fees);
    const gas = num(b.pnl?.gas);
    feesPaid = fee == null && gas == null ? null : usdOf((fee ?? 0) + (gas ?? 0), k);
  } else if (b.kind === 'lp') {
    const gas = num(b.totals?.gas);
    const swap = num(b.totals?.swapCost);
    feesPaid = gas == null && swap == null ? null : usdOf((gas ?? 0) + (swap ?? 0), k);
    feesEarned = usdOf(num(b.pnl?.fees), k);
  }
  const space = spacingOf(b);
  const inRange = num(b.timeInRange);
  return {
    ageMs: age,
    investedUsd,
    valueUsd,
    realizedUsd,
    unrealizedUsd,
    realizedPct,
    unrealizedPct,
    pnlUsd,
    pnlPct,
    est: estimates(generatedOf(b)?.tokens ?? [], age == null ? null : age / 1000),
    moves: moveParts(b),
    winRate: winRateOf(b),
    feesPaidUsd: feesPaid,
    feesEarnedUsd: feesEarned,
    timeInRange: inRange != null && inRange >= 0 && inRange <= 1 ? inRange : null,
    range: rangeOf(b),
    spacingFrac: space.frac,
    bandPct: space.band,
    lastMoveAt: lastMove(b),
    chain: extra?.chain ?? (typeof b.chainShort === 'string' ? b.chainShort : null),
    dex: extra?.dex ?? (typeof b.dexName === 'string' ? b.dexName : null),
    pool: extra?.pool ?? (typeof b.pool === 'string' ? b.pool : null),
  };
}
