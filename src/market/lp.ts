/**
 * Liquidity-position backtest (pure): what a range position in the pool would have done over the same hourly
 * candles the grid scan uses, to compare grid vs LP vs hold before any money goes in.
 *
 * Model (each step verified 2026-10-17, see chains.ts for the fee shares):
 *  - Candle volume is in QUOTE units (GeckoTerminal currency=token: a HEX/WPLS pool's 24 h sum was 55.4 B WPLS
 *    = $313.5 k vs the pool's $314.4 k). Fees paid by traders in an hour = volume × pool fee.
 *  - Liquidity providers keep `lpShare` of that (the rest goes to the protocol).
 *  - Your cut = your liquidity ÷ (yours + the pool's active liquidity), only while the price is inside your range.
 *    The pool's liquidity is TODAY's (V2 reserves, V3 active range) held constant over the window — the same
 *    approximation the grid cost model makes for depth.
 *  - In-range share of an hour = the part of the candle's low–high span (log scale) inside the range.
 *  - Opening: swap part of the capital into the base coin (fee, impact, gas via simBuy), approve both tokens,
 *    add liquidity; closing gas is charged at the end. No re-ranging inside the window (the grid test doesn't
 *    recenter either). Value is marked at the candle's sell-side price, like the grid's open lots.
 */
import { buyHold, maxDrawdown } from './backtest';
import type { Candle } from './candles';
import { simBuy, type CostModel } from './costs';
import { MIN_SCAN_CANDLES, SETUP_BANDS } from './scan';

/**
 * Gas per liquidity action, rounded up from medians of real transactions (2026-10-17):
 * V3 open (position mint) 9mm 480 k, Ethereum 402 k, Robinhood 410–510 k; close (decrease + collect) 197–276 k.
 * V2 add 157 k (PulseX V2 DAI/WPLS), remove 215 k (PulseX V2 HEX/WPLS).
 */
/** A swap to the range's mix smaller than this share of the value isn't worth its fee and gas: the leftover stays idle. */
export const LP_MIN_SWAP_SHARE = 0.01;
/** A liquidity bot moves its range at most this many times in any 24 hours: a guard in case the cost or the missed fees are misjudged in a choppy market. */
export const LP_MAX_MOVES_PER_DAY = 8;
/** Ranges a liquidity bot allows: ±1% … ±50% around the price. */
export const LP_BAND = { min: 0.01, max: 0.5 };
export const LP_GAS = { v3: { open: 480_000, close: 250_000 }, v2: { open: 170_000, close: 215_000 } } as const;

/** Ranges tried for a V3 position (± around the start price); null = full range (the only option on V2). */
export const LP_BANDS: (number | null)[] = [...SETUP_BANDS, null];

export interface LpSetup {
  /** ± range around the start price; null = full range */
  bandPct: number | null;
  /** Net result over the window (fees + price change − opening and closing costs) */
  returnPct: number;
  /** Fees earned ÷ capital */
  feesPct: number;
  /** Average share of each hour the price spent inside the range */
  inRangePct: number;
  /** Your share of the pool's active liquidity while in range */
  poolSharePct: number;
  maxDrawdownPct: number;
  holdPct: number;
  days: number;
}

export interface LpOpts { kind: 'v2' | 'v3'; capital: number; bandPct: number | null; lpShare: number }

/**
 * LP share from a V3 pool's slot0().feeProtocol (average of the two swap directions).
 * uniswap: N per direction in 4 bits, protocol takes 1/N (0 = off). Measured: 68 → 0.2500 of the fee on single swaps.
 * pancake: per direction in 16 bits, protocol takes N / 10 000. Measured: 3200 → 0.3200, 3300 → 0.3300.
 */
export function lpShareFromFeeProtocol(feeProtocol: number, enc: 'uniswap' | 'pancake'): number {
  if (!Number.isInteger(feeProtocol) || feeProtocol < 0) throw new Error(`bad feeProtocol ${feeProtocol}`);
  const [a, b] = enc === 'uniswap' ? [feeProtocol % 16, feeProtocol >> 4] : [feeProtocol % 65536, Math.floor(feeProtocol / 65536)];
  const cut = (n: number) => {
    if (enc === 'pancake') { if (n > 10_000) throw new Error(`bad pancake feeProtocol ${feeProtocol}`); return n / 10_000; }
    if (n !== 0 && (n < 4 || n > 10)) throw new Error(`bad uniswap feeProtocol ${feeProtocol}`);
    return n ? 1 / n : 0;
  };
  return 1 - (cut(a) + cut(b)) / 2;
}

/** Fraction of a candle's low–high span (log scale) inside [pa, pb]; a flat candle counts fully when inside. */
export function inRangeShare(lo: number, hi: number, pa: number, pb: number): number {
  if (!(hi > lo)) return lo >= pa && lo <= pb ? 1 : 0;
  const a = Math.max(lo, pa), b = Math.min(hi, pb);
  return b > a ? Math.log(b / a) / Math.log(hi / lo) : 0;
}

/** One position held over `k` (hourly candles, oldest first, sell-side prices) opened at the first open. */
export function runLpBacktest(k: Candle[], o: LpOpts, costs: CostModel): LpSetup {
  if (k.length < 2) throw new Error('need ≥ 2 candles');
  if (!costs.pool) throw new Error('LP test needs the pool depth');
  if (o.kind === 'v2' && o.bandPct != null) throw new Error('a V2 position is always full range');
  if (!(o.lpShare >= 0 && o.lpShare <= 1)) throw new Error(`bad LP share ${o.lpShare}`);
  const f = costs.feeBps / 10_000;
  const mid = (p: number) => p / (1 - f);
  const p0 = mid(k[0].o);
  const pa = o.bandPct == null ? 0 : p0 * (1 - o.bandPct), pb = o.bandPct == null ? Infinity : p0 * (1 + o.bandPct);
  // Token amounts per unit of liquidity at price p (base, quote).
  const per = (p: number) => {
    const s = Math.sqrt(Math.min(Math.max(p, pa), pb));
    return { x: 1 / s - (Number.isFinite(pb) ? 1 / Math.sqrt(pb) : 0), y: s - Math.sqrt(pa) };
  };
  const gasQuote = (units: number, price: number) => (units * costs.gasPricePls + (costs.extraPlsPerSwap ?? 0)) * price;
  const gas = LP_GAS[o.kind];

  const a0 = per(p0);
  const baseShare = (a0.x * p0) / (a0.x * p0 + a0.y);
  const buy = simBuy(o.capital * baseShare, k[0].o, costs);
  const approvals = costs.approval === 'exact' ? 2 * (costs.gasUnits?.approve ?? 0) : 0;
  const quoteLeft = o.capital * (1 - baseShare) - buy.gasQuote - gasQuote(gas.open + approvals, k[0].o);
  if (!(quoteLeft > 0)) throw new Error('opening costs more than the test amount');
  const L = Math.min(buy.pls / a0.x, quoteLeft / a0.y);
  const idleBase = buy.pls - L * a0.x, idleQuote = quoteLeft - L * a0.y;
  const poolL = Math.sqrt(costs.pool.quoteReserve * costs.pool.plsReserve);
  const share = L / (L + poolL);

  let fees = 0, inRange = 0;
  const eq: number[] = [];
  for (const c of k) {
    const r = inRangeShare(mid(c.l), mid(c.h), pa, pb);
    inRange += r;
    fees += c.v * f * o.lpShare * share * r;
    const a = per(mid(c.c));
    eq.push(L * (a.x * c.c + a.y) + idleBase * c.c + idleQuote + fees);
  }
  const last = k[k.length - 1];
  const end = eq[eq.length - 1] - gasQuote(gas.close, last.c);
  const bh = buyHold(k, 0, o.capital, costs);
  return {
    bandPct: o.bandPct, returnPct: end / o.capital - 1, feesPct: fees / o.capital, inRangePct: inRange / k.length,
    poolSharePct: share, maxDrawdownPct: maxDrawdown(eq), holdPct: (bh.pls * last.c + bh.cashLeft) / o.capital - 1,
    days: (last.t - k[0].t) / 86_400,
  };
}

/** Best range for a position over `k` (V2: full range only). */
export function bestLp(k: Candle[], costs: CostModel, capital: number, kind: 'v2' | 'v3', lpShare: number): LpSetup {
  if (k.length < MIN_SCAN_CANDLES) throw new Error(`only ${k.length} hourly candles (need ${MIN_SCAN_CANDLES})`);
  let best: LpSetup | null = null;
  for (const bandPct of kind === 'v2' ? [null] : LP_BANDS) {
    const s = runLpBacktest(k, { kind, capital, bandPct, lpShare }, costs);
    if (!best || s.returnPct > best.returnPct) best = s;
  }
  return best!;
}
