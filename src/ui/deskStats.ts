/** Read-only figures for the desk table and the stat block under a chart. Missing inputs stay null. */
import { analyzeSpacing } from '../live/spacing';
import type { AnyObj } from './model';

// Estimate rules live with the server's metrics (one definition); re-exported for callers and tests.
export { ageMs, DAY_MS, estHint, estNeedMs, extrapolate, MAX_SCALE, MIN_AGE_MS } from '../metrics/botMetrics';
import type { BotMetrics } from '../metrics/botMetrics';

export interface Extrapolation { amount: number; pct: number | null }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  /** Generated (the headline) scaled to 24h / 7d / 365d, in dollars; pct only on 365d (= APR). */
  est: { h24: Extrapolation | null; d7: Extrapolation | null; d365: Extrapolation | null };
  /** Why an estimate is a dash: "needs 7d of history". */
  estHint: { h24: string | null; d7: string | null; d365: string | null };
  aprPct: number | null;
  /** Headline: units generated per token, and their dollar value at today's mid price. */
  generated: Record<string, number> | null;
  generatedUsd: number | null;
  generatedRate: BotMetrics['generatedRate'] | null;
  priceChangeUsd: number | null;
  /** How the server calculated the money figures (tooltip). */
  calc: string | null;
  moves: MoveParts;
  winRate: number | null;
  feesPaidUsd: number | null;
  feesEarnedUsd: number | null;
  /** The same in the bot's quote coin (`quoteSym`), which is what the pages show (crypto units only). */
  feesPaid: number | null;
  feesEarned: number | null;
  quoteSym: string | null;
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

/** The server's money figures for a bot (BotMetrics), or null when the payload has none. */
export function metricsOf(b: AnyObj): BotMetrics | null {
  return b && typeof b.metrics === 'object' && b.metrics ? (b.metrics as BotMetrics) : null;
}

/**
 * Figures for the desk table and the stat table. Every dollar / percent / estimate comes from the server's
 * `metrics` (src/metrics/botMetrics.ts); this only reshapes them and adds non-money facts (range, spacing, moves).
 */
export function botFacts(b: AnyObj, _now = Date.now(), extra?: { chain?: string | null; dex?: string | null; pool?: string | null }): DeskFacts {
  const m = metricsOf(b);
  const ex = (v: number | null | undefined, pct: number | null = null): Extrapolation | null => (v == null ? null : { amount: v, pct });
  const space = spacingOf(b);
  const inRange = num(b.timeInRange);
  // Everything that came off what the bot earned: gas + swap fees, and for an LP the range-move losses too (so
  // fees earned − fees paid = Generated, at event prices). Grid / trend losing round trips are already in their profit.
  const paid = m && (m.swapCostUsd != null || m.gasUsd != null)
    ? (m.swapCostUsd ?? 0) + (m.gasUsd ?? 0) + (m.kind === 'lp' ? m.realizedRebalanceLossUsd ?? 0 : 0) : null;
  const q = m?.quote;
  const paidQ = q && (q.swapCost != null || q.gas != null)
    ? (q.swapCost ?? 0) + (q.gas ?? 0) + (m!.kind === 'lp' ? q.rebalanceLoss ?? 0 : 0) : null;
  return {
    ageMs: m?.ageSec == null ? null : m.ageSec * 1000,
    investedUsd: m?.capitalInUsd ?? null,
    valueUsd: m?.currentValueUsd ?? null,
    realizedUsd: m?.realizedUsd ?? null,
    unrealizedUsd: m?.unrealizedUsd ?? null,
    realizedPct: null,
    unrealizedPct: null,
    pnlUsd: m?.totalPnlUsd ?? null,
    pnlPct: m?.totalPnlPct ?? null,
    est: { h24: ex(m?.est.d1), d7: ex(m?.est.d7), d365: ex(m?.est.d365, m?.aprPct ?? null) },
    estHint: { h24: m?.est.needs.d1 ?? null, d7: m?.est.needs.d7 ?? null, d365: m?.est.needs.d365 ?? null },
    aprPct: m?.aprPct ?? null,
    generated: m?.generated ?? null,
    generatedUsd: m?.generatedUsd ?? null,
    generatedRate: m?.generatedRate ?? null,
    priceChangeUsd: m?.priceChangeUsd ?? null,
    calc: m?.calc ?? null,
    moves: moveParts(b),
    winRate: winRateOf(b),
    feesPaidUsd: paid,
    feesEarnedUsd: m?.feesEarnedUsd ?? null,
    feesPaid: paidQ,
    feesEarned: q?.feesEarned ?? null,
    quoteSym: q?.symbol ?? null,
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

/** "+0.00626 ETH · +41.46 USDC": units per token, signed, zero legs dropped (all zero → "0"). Null → dash. */
/** The figures in a formatted string as numbers, without sign, "$" and separators ("−$1,234.50" → ["1234.5"]); zero is not a figure. */
export function figuresOf(text: string | null | undefined): string[] {
  return (String(text ?? '').match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((t) => Number(t.replace(/,/g, ''))).filter((n) => n !== 0).map(String);
}

/**
 * True when `extra` adds no figure that `shown` doesn't already have, e.g. "≈ $23.75" beside "−23.75 USDG" (a stablecoin's
 * dollar value prints the same number). Used to leave such echoes out: no number twice on a screen.
 */
export function echoes(shown: string | null | undefined, extra: string | null | undefined): boolean {
  const have = new Set(figuresOf(shown));
  const add = figuresOf(extra);
  return add.length > 0 && add.every((f) => have.has(f));
}

export function unitsText(gen: Record<string, number> | null | undefined, max = 2, signed = true): string {
  if (!gen) return '—';
  const legs = Object.entries(gen).filter(([, u]) => Number.isFinite(u) && u !== 0);
  if (!legs.length) return '0';
  const f = (u: number) => {
    const a = Math.abs(u);
    const d = a >= 1000 ? 0 : a >= 1 ? 2 : Math.min(8, 2 - Math.floor(Math.log10(a)));
    return `${u > 0 ? (signed ? '+' : '') : '−'}${a.toLocaleString('en-US', { maximumFractionDigits: d })}`;
  };
  return legs.slice(0, max).map(([k, u]) => `${f(u)} ${k}`).join(' · ') + (legs.length > max ? ' …' : '');
}
