/**
 * Optional gates for an LP bot's auto-move and for rolling fees back into the position.
 *
 * Every knob defaults off. With `DEFAULT_RANGE_POLICY` the move decision is the live bot's
 * current one: the first reading whose tick is outside the range moves immediately (the
 * price-impact cap still applies in the engine, not here). With `DEFAULT_COMPOUND_POLICY`
 * fees are not collected between moves.
 *
 * Saved bots omit these objects. Callers treat a missing object as the defaults, so an old
 * config loads and decides exactly as it did before the fields existed.
 */
import { LP_BAND } from './lp';

export interface LpRangePolicy {
  /** Minutes the price must stay past the move boundary. 0 = the first reading (today). */
  dwellMin: number;
  /**
   * Minutes after a move before another auto-move is allowed. 0 = no cooldown (today):
   * the next time the price leaves, it can move on that reading. The opening of the
   * position is not a move, so the first auto-move is never held by this.
   */
  cooldownMin: number;
  /**
   * Extra fraction of price past each edge before a move is allowed.
   * 0 = the range edge itself (today). 0.002 = 0.2% beyond the edge.
   */
  bufferPct: number;
  /**
   * When > 0, a new range's half-width is max(bandPct, atrMult × ATR / price), clamped to
   * the bot's allowed band. 0 = the configured band only (today). ATR is Wilder's, from
   * `market/indicators.ts`.
   */
  atrMult: number;
  /** Wilder ATR period. Used only when atrMult > 0. */
  atrPeriod: number;
  /** Move only when expected fees over feeHorizonH exceed estimated gas + swap cost. */
  costCheck: boolean;
  /** Hours of recent fee pace the cost check looks ahead. */
  feeHorizonH: number;
  /**
   * Warn while the price is inside and this close to leaving, as a fraction of the
   * centre-to-edge distance. 0.2 = the outer 20% (past 80% of the way from the centre).
   * 0 = no warning (today).
   */
  nearEdgeFrac: number;
}

export interface LpCompoundPolicy {
  /** Collect uncollected fees and add them back into the same range. */
  enabled: boolean;
  /** Fees must be worth at least this many times the estimated collect-and-add gas. */
  gasMultiple: number;
}

export const DEFAULT_RANGE_POLICY: LpRangePolicy = {
  dwellMin: 0,
  cooldownMin: 0,
  bufferPct: 0,
  atrMult: 0,
  atrPeriod: 14,
  costCheck: false,
  feeHorizonH: 24,
  nearEdgeFrac: 0,
};

export const DEFAULT_COMPOUND_POLICY: LpCompoundPolicy = {
  enabled: false,
  gasMultiple: 10,
};

/**
 * Named dwell/cooldown setups. Nothing selects them on its own: a bot uses one only
 * after the settings say so. They are not a ranking.
 *  - A: ±2% band, move after 12h straight outside, then wait 24h before another move.
 *  - B: ±3% band, move after 4h straight outside, then wait 12h before another move.
 */
export interface LpMovePreset {
  id: 'a' | 'b';
  label: string;
  bandPct: number;
  dwellMin: number;
  cooldownMin: number;
}

export const LP_PRESET_A: LpMovePreset = {
  id: 'a', label: 'Preset A', bandPct: 0.02, dwellMin: 12 * 60, cooldownMin: 24 * 60,
};
export const LP_PRESET_B: LpMovePreset = {
  id: 'b', label: 'Preset B', bandPct: 0.03, dwellMin: 4 * 60, cooldownMin: 12 * 60,
};
export const LP_MOVE_PRESETS: readonly LpMovePreset[] = [LP_PRESET_A, LP_PRESET_B];

/** A fee pace younger than this is not a pace yet: the cost check waits. */
export const COST_MIN_HOURS = 10 / 60;

export type RangeWait = 'in' | 'buffer' | 'off' | 'dwell' | 'cooldown' | 'need-cost' | 'cost';

export interface RangeMoveInput {
  /** Pool rule: tick < tickLower or tick >= tickUpper. This is today's trigger. */
  tickOut: boolean;
  price: number;
  lower: number;
  upper: number;
  /** null when the previous reading was inside the move boundary. */
  outSince: number | null;
  /**
   * When the last range move finished, ms. null = none yet. Ignored when cooldownMin is 0,
   * so a recent move does not change today's decision.
   */
  lastMoveAt?: number | null;
  now: number;
  rerange: boolean;
  policy: LpRangePolicy;
  /**
   * Estimated gas + swap cost, quote. Omit (`undefined`) to be asked for a quote.
   * `null` means the quote failed. Ignored unless costCheck is on.
   */
  moveCost?: number | null;
  /** Recent in-range fee pace, quote per hour. `null` = not enough history yet. */
  feePerHour?: number | null;
}

export interface RangeMoveDecision {
  move: boolean;
  /** null when the price is back inside the move boundary. */
  outSince: number | null;
  /** null when the decision is to move. */
  wait: RangeWait | null;
  /** Inside the range and inside the near-edge band. Never true while the defaults are on. */
  nearEdge: boolean;
  /** 1 at the centre of the range, 0 on an edge, negative outside. */
  toEdge: number | null;
}

export function rangePolicy(p?: Partial<LpRangePolicy> | null): LpRangePolicy {
  return { ...DEFAULT_RANGE_POLICY, ...(p ?? {}) };
}

export function compoundPolicy(p?: Partial<LpCompoundPolicy> | null): LpCompoundPolicy {
  return { ...DEFAULT_COMPOUND_POLICY, ...(p ?? {}) };
}

function finite(v: unknown, fallback: number): number {
  if (typeof v !== 'number' && typeof v !== 'string') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Reject a bad edit. Omitted fields stay at the defaults, which reproduce today's behaviour. */
export function checkRangePolicy(p?: Partial<LpRangePolicy> | null): LpRangePolicy {
  const d = rangePolicy(p ?? {});
  const dwellMin = finite(d.dwellMin, NaN);
  const cooldownMin = finite(d.cooldownMin, NaN);
  const bufferPct = finite(d.bufferPct, NaN);
  const atrMult = finite(d.atrMult, NaN);
  const atrPeriod = finite(d.atrPeriod, NaN);
  const feeHorizonH = finite(d.feeHorizonH, NaN);
  const nearEdgeFrac = finite(d.nearEdgeFrac, NaN);
  if (!(dwellMin >= 0 && dwellMin <= 7 * 24 * 60)) throw new Error('Dwell must be between 0 and 10080 minutes.');
  if (!(cooldownMin >= 0 && cooldownMin <= 7 * 24 * 60)) throw new Error('Cooldown must be between 0 and 10080 minutes.');
  if (!(bufferPct >= 0 && bufferPct <= 0.05)) throw new Error('Price buffer must be between 0 and 5%.');
  if (!(atrMult >= 0 && atrMult <= 10)) throw new Error('ATR multiple must be between 0 and 10.');
  if (!Number.isInteger(atrPeriod) || atrPeriod < 2 || atrPeriod > 200) throw new Error('ATR period must be a whole number from 2 to 200.');
  if (!(feeHorizonH >= 1 && feeHorizonH <= 24 * 14)) throw new Error('Fee horizon must be between 1 and 336 hours.');
  if (!(nearEdgeFrac >= 0 && nearEdgeFrac <= 0.5)) throw new Error('Near-edge warning must be between 0 and 50% of the way to the edge.');
  return {
    dwellMin, cooldownMin, bufferPct, atrMult, atrPeriod, costCheck: d.costCheck === true,
    feeHorizonH, nearEdgeFrac,
  };
}

export function checkCompoundPolicy(p?: Partial<LpCompoundPolicy> | null): LpCompoundPolicy {
  const d = compoundPolicy(p ?? {});
  const gasMultiple = finite(d.gasMultiple, NaN);
  if (!(gasMultiple >= 1 && gasMultiple <= 1_000_000)) throw new Error('Compound multiple must be between 1 and 1000000.');
  return { enabled: d.enabled === true, gasMultiple };
}

/** 1 at the centre, 0 on an edge, negative once the price has left the range. */
export function toEdgeFrac(price: number, lower: number, upper: number): number | null {
  if (!(upper > lower) || !(price > 0)) return null;
  const half = (upper - lower) / 2;
  const mid = (lower + upper) / 2;
  return 1 - Math.abs(price - mid) / half;
}

/**
 * Half-width to open. atrMult 0 returns `bandPct` unchanged (no clamp), so a default
 * policy mints the same ticks as today.
 */
export function effectiveBand(bandPct: number, atrAbs: number | null, price: number, mult: number): number {
  if (!(mult > 0)) return bandPct;
  if (atrAbs == null || !(atrAbs > 0) || !(price > 0)) return bandPct;
  const width = Math.max(bandPct, (mult * atrAbs) / price);
  if (width < LP_BAND.min) return LP_BAND.min;
  if (width > LP_BAND.max) return LP_BAND.max;
  return width;
}

/**
 * Quote per hour of time the position was inside the range.
 * `earningMs` must leave out time spent outside: that time earns nothing, and dividing
 * by wall-clock age makes the pace fall the longer a move is postponed.
 * Null until 10 minutes have been spent in range.
 */
export function feePace(feesQuote: number, earningMs: number): number | null {
  const hours = earningMs / 3_600_000;
  if (!(hours >= COST_MIN_HOURS) || !(feesQuote >= 0) || !Number.isFinite(feesQuote)) return null;
  return feesQuote / hours;
}

function nearEdge(frac: number, tickOut: boolean, toEdge: number | null): boolean {
  if (!(frac > 0) || tickOut || toEdge == null || toEdge < 0) return false;
  return toEdge <= frac;
}

/**
 * Whether an auto-move should start. The price-impact cap is not applied here: the engine
 * (and the replay) still refuse a swap that would cross it, after this returns `move: true`.
 */
export function decideRangeMove(i: RangeMoveInput): RangeMoveDecision {
  const pol = i.policy;
  const toEdge = toEdgeFrac(i.price, i.lower, i.upper);
  const near = nearEdge(pol.nearEdgeFrac, i.tickOut, toEdge);
  // bufferPct 0 must not consult price: today's trigger is the tick test alone.
  const pastBuffer = !(pol.bufferPct > 0) || i.price <= i.lower * (1 - pol.bufferPct) || i.price >= i.upper * (1 + pol.bufferPct);
  const armed = i.tickOut && pastBuffer;

  if (!i.tickOut) return { move: false, outSince: null, wait: 'in', nearEdge: near, toEdge };
  if (!armed) return { move: false, outSince: null, wait: 'buffer', nearEdge: false, toEdge };
  const outSince = i.outSince ?? i.now;
  if (!i.rerange) return { move: false, outSince, wait: 'off', nearEdge: false, toEdge };
  if (i.now - outSince < pol.dwellMin * 60_000) return { move: false, outSince, wait: 'dwell', nearEdge: false, toEdge };
  // cooldownMin 0 does not read lastMoveAt: a move a moment ago still moves again, as today.
  if (pol.cooldownMin > 0 && i.lastMoveAt != null && i.now - i.lastMoveAt < pol.cooldownMin * 60_000) {
    return { move: false, outSince, wait: 'cooldown', nearEdge: false, toEdge };
  }
  if (pol.costCheck) {
    if (i.moveCost === undefined || i.feePerHour === undefined) {
      return { move: false, outSince, wait: 'need-cost', nearEdge: false, toEdge };
    }
    const gain = i.feePerHour == null || i.moveCost == null ? 0 : i.feePerHour * pol.feeHorizonH;
    if (!(i.moveCost != null && i.feePerHour != null && gain > i.moveCost)) {
      return { move: false, outSince, wait: 'cost', nearEdge: false, toEdge };
    }
  }
  return { move: true, outSince, wait: null, nearEdge: false, toEdge };
}

export interface CompoundDecision {
  compound: boolean;
  /** Fees required, quote. Infinity when compounding is off (it never fires). */
  need: number;
}

/** Collect and re-add only when enabled and waiting fees cover `gasMultiple` × gas. */
export function decideCompound(feesQuote: number, gasQuote: number, policy: LpCompoundPolicy): CompoundDecision {
  if (!policy.enabled) return { compound: false, need: Infinity };
  const need = policy.gasMultiple * gasQuote;
  const compound = feesQuote > 0 && gasQuote >= 0 && Number.isFinite(need) && feesQuote >= need;
  return { compound, need };
}
