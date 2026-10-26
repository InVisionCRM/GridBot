/**
 * Liquidity-position replay over a pool's real trades (pure): what a liquidity bot with a given range and move setting
 * would have done, minute by minute, under the live bot's rules (lpEngine).
 *
 *  - Data: the pool's Swap events folded into minutes (addSwaps). A swap's fee is its amount in × the fee tier × the
 *    share liquidity providers keep, and one unit of in-range liquidity earns that ÷ the pool's active liquidity at the
 *    swap. Swap by swap this matched what the live Robinhood WETH/USDG positions collected within 0.4% (2026-10-22);
 *    folded into minutes, within about 5%.
 *  - Fees: in range, the position earns L / (L + pool liquidity) of what one unit earned, for the share of the minute's
 *    ticks (low to high) inside its range.
 *  - Moves (rerange on): like the bot, as soon as a minute ends outside the range the position comes out at that price
 *    and opens ±band around it; a swap over the price-impact cap blocks the move. Fees are added back in at each move.
 *  - Swaps pay the pool fee and a price impact worked out from the minute's active liquidity (inside one tick range,
 *    so a thin pool's impact is understated); a gap under LP_MIN_SWAP_SHARE of the value isn't swapped.
 *  - Fees are counted in the coin they were paid in (and their worth in the quote coin when earned).
 *  - Lost to moves: a position sells the coin that rises and buys the one that falls. A move takes it out at that mix and
 *    opens again, which makes the difference to the coins it went in with final (valued at the move's price). A range
 *    that stays keeps it open, and gets it back if the price returns, so it is not counted for a range still open.
 *  - Earned after costs = fees − gas − what the swaps cost − lost to moves, in the quote coin. The coins' own price move
 *    is left out: it happens to the coins whether or not they sit in a pool.
 *
 * The timing of a move decides a lot: in a 12-day check a move a minute later put the next range 29 ticks lower and
 * changed that setup's result by $15. So one replay is one path.
 */
import { LP_MIN_SWAP_SHARE } from './lp';
import { amountsForLiquidity, coinsOfRaw, liquidityForAmounts, marketPrice, rangeTicks, rawOfCoins, sqrtPriceAt, type PoolSides } from '../live/v3Liquidity';

/** One minute of a V3 pool's trading. */
export interface PoolMinute {
  /** Minute start (unix s) */
  t: number;
  /** Lowest and highest tick the price was at in the minute (where it started included), and the tick it ended at */
  lo: number; hi: number; c: number;
  /** Fees one unit of in-range liquidity earned in the minute (raw token0 / token1, after the protocol's cut) */
  f0: number; f1: number;
  /** The pool's active liquidity, averaged over the minute's swaps, and how many swaps there were */
  liq: number; n: number;
}

/** A decoded Swap event: when (unix s), amounts (raw, signed: positive = into the pool), active liquidity and tick after it. */
export interface PoolSwap { t: number; a0: number; a1: number; liq: number; tick: number }

/**
 * Fold swaps (oldest first, after everything already in `minutes`) into minutes. `feeTier` is in hundredths of a bip
 * (100 = 0.01 %), `lpShare` the part of the fee liquidity providers keep, `lastTick` where the price was before the
 * first swap (null = unknown). Returns where the price is after the last swap.
 */
export function addSwaps(minutes: PoolMinute[], swaps: PoolSwap[], o: { feeTier: number; lpShare: number; lastTick: number | null }): number | null {
  const fee = (o.feeTier / 1e6) * o.lpShare;
  let last = o.lastTick;
  for (const s of swaps) {
    const t = Math.floor(s.t / 60) * 60;
    let m = minutes[minutes.length - 1];
    if (m && t < m.t) throw new Error(`swap at ${s.t} is older than the last minute ${m.t}`);
    if (!m || m.t !== t) {
      const from = last ?? s.tick;
      m = { t, lo: from, hi: from, c: from, f0: 0, f1: 0, liq: 0, n: 0 };
      minutes.push(m);
    }
    if (s.liq > 0) {
      if (s.a0 > 0) m.f0 += (s.a0 * fee) / s.liq;
      else if (s.a1 > 0) m.f1 += (s.a1 * fee) / s.liq;
    }
    m.liq = (m.liq * m.n + s.liq) / (m.n + 1);
    m.n++;
    m.lo = Math.min(m.lo, s.tick); m.hi = Math.max(m.hi, s.tick); m.c = s.tick;
    last = s.tick;
  }
  return last;
}

export interface ReplayPool extends PoolSides {
  spacing: number;
  /** Fee of the pool the bot's swaps go through, as a fraction (0.0001 = 0.01 %) */
  swapFee: number;
}

export interface ReplayOpts {
  /** ± range around the price at each open */
  bandPct: number;
  rerange: boolean;
  /** What goes in (quote), all in the quote coin before the opening swap */
  capital: number;
  /** Gas in quote for opening (approvals + mint + the swap's gas) and for one move (take out + approvals + mint + swap gas) */
  gasOpen: number;
  gasMove: number;
  /** Largest price impact a swap may have (fraction) */
  maxImpact: number;
}

export interface Coins { base: number; quote: number }

export interface ReplayResult {
  bandPct: number;
  rerange: boolean;
  days: number;
  /** Fees earned in each coin, and their worth in the quote coin at the minute they were earned */
  feeCoins: Coins; fees: number;
  /** Gas paid and what the swaps cost (pool fee + impact), quote */
  gas: number; swapCost: number;
  moves: number;
  /** Times a due move was held back by the price-impact cap (each stretch out of range counts once) */
  blocked: number;
  /** Share of the minutes with trades that the price spent inside the range */
  inRange: number;
  /** What moves locked in (see above), quote */
  moveLoss: number;
  /** Earned after costs: fees − gas − swap costs − lost to moves, quote */
  net: number;
}
/** One range as the replay API answers it: the replay, and a position opened now with the same money (its coins, and its share of the pool's active liquidity) */
export type ReplayRow = ReplayResult & { coinsNow: Coins; poolShareNow: number };
const DAY_S = 86_400;

const priceAt = (tick: number, pool: PoolSides) => marketPrice(sqrtPriceAt(tick) ** 2, pool);
/** The coins liquidity L holds in [tl, tu) with the price at `tick` */
const heldBy = (L: number, tl: number, tu: number, tick: number, pool: PoolSides): Coins => {
  const a = amountsForLiquidity(sqrtPriceAt(tick), sqrtPriceAt(tl), sqrtPriceAt(tu), L);
  return coinsOfRaw(a.amount0, a.amount1, pool);
};

/**
 * A position opened at `tick` with `capital` (quote) in ±band, before costs: its liquidity (the pool's raw units, so it
 * compares with the pool's active liquidity) and the coins it holds.
 */
export function positionFor(capital: number, bandPct: number, tick: number, pool: ReplayPool): { L: number; coins: Coins } {
  const p = priceAt(tick, pool);
  const { tickLower: tl, tickUpper: tu } = rangeTicks(p * (1 - bandPct), p * (1 + bandPct), pool.spacing, pool);
  const per = heldBy(1e18, tl, tu, tick, pool), share = (per.base * p) / (per.base * p + per.quote);
  const r = rawOfCoins({ base: (share * capital) / p, quote: (1 - share) * capital }, pool);
  const L = liquidityForAmounts(sqrtPriceAt(tick), sqrtPriceAt(tl), sqrtPriceAt(tu), r.a0, r.a1);
  return { L, coins: heldBy(L, tl, tu, tick, pool) };
}

/** One liquidity bot over `rows` (oldest first): opens at the first minute's last price. */
export function replayLp(rows: PoolMinute[], pool: ReplayPool, o: ReplayOpts): ReplayResult {
  if (rows.length < 2) throw new Error('need at least 2 minutes of trades');
  if (!(o.bandPct > 0 && o.bandPct < 1)) throw new Error(`bad range ±${o.bandPct}`);
  if (!(o.capital > 0)) throw new Error('capital must be > 0');
  const price = (tick: number) => priceAt(tick, pool);
  const val = (c: Coins, p: number) => c.base * p + c.quote;
  const held = (L: number, tl: number, tu: number, tick: number) => heldBy(L, tl, tu, tick, pool);
  /** Price impact of putting `amountIn` (human, of the coin going in) into the pool at `tick` with liquidity `liq`. */
  const impact = (amountIn: number, baseIn: boolean, tick: number, liq: number) => {
    if (!(liq > 0)) return Infinity;
    const raw = amountIn * 10 ** (baseIn ? pool.baseDecimals : pool.quoteDecimals);
    const in0 = baseIn === pool.baseIs0, s = sqrtPriceAt(tick);
    // inside one tick range: token1 in moves √P by Δ/L, token0 in moves 1/√P by Δ/L; the price moves about twice that
    return 2 * (in0 ? (raw * s) / liq : raw / (s * liq));
  };
  /** The swap from `have` to the mix of a range around `tick`: what it costs and whether the impact cap stops it. */
  const plan = (have: Coins, tl: number, tu: number, tick: number, liq: number) => {
    const p = price(tick), per = held(1e18, tl, tu, tick), value = val(have, p);
    const share = (per.base * p) / (per.base * p + per.quote), gap = share * value - have.base * p;
    if (Math.abs(gap) <= value * LP_MIN_SWAP_SHARE) return { gap: 0, cost: 0, impact: 0, share, value };
    const imp = gap > 0 ? impact(gap, false, tick, liq) : impact(-gap / p, true, tick, liq);
    return { gap, cost: Math.abs(gap) * (pool.swapFee + imp / 2), impact: imp, share, value };
  };

  let gas = 0, swapCost = 0, fees = 0, moves = 0, blocked = 0, inTime = 0, moveLoss = 0;
  let pos = { tl: 0, tu: 0, L: 0 }, idle: Coins = { base: 0, quote: 0 }, owed: Coins = { base: 0, quote: 0 };
  const feeCoins: Coins = { base: 0, quote: 0 };
  /** The coins the open position went in with */
  let putIn: Coins = { base: 0, quote: 0 };
  /** Swap `have` to the range's mix around `tick`, pay `gasQuote`, open the position; the rest stays idle. */
  const open = (have: Coins, tick: number, liq: number, gasQuote: number) => {
    const p = price(tick);
    const { tickLower: tl, tickUpper: tu } = rangeTicks(p * (1 - o.bandPct), p * (1 + o.bandPct), pool.spacing, pool);
    const s = plan(have, tl, tu, tick, liq);
    const after = s.value - s.cost - gasQuote;
    if (!(after > 0)) throw new Error('opening costs more than the amount put in');
    // swapped: the range's mix of what's left; not swapped: the same coins, less the gas
    const k = after / s.value;
    const coins = s.gap !== 0 ? { base: (s.share * after) / p, quote: (1 - s.share) * after } : { base: have.base * k, quote: have.quote * k };
    swapCost += s.cost;
    gas += gasQuote;
    const r = rawOfCoins(coins, pool);
    const L = liquidityForAmounts(sqrtPriceAt(tick), sqrtPriceAt(tl), sqrtPriceAt(tu), r.a0, r.a1);
    const used = held(L, tl, tu, tick);
    pos = { tl, tu, L };
    putIn = used;
    idle = { base: Math.max(0, coins.base - used.base), quote: coins.quote - used.quote };
  };

  const first = rows[0];
  open({ base: 0, quote: o.capital }, first.c, first.liq, o.gasOpen);
  let heldBack = false;

  for (let i = 1; i < rows.length; i++) {
    const m = rows[i], p = price(m.c);
    const span = m.hi - m.lo + 1, inside = Math.max(0, Math.min(m.hi, pos.tu - 1) - Math.max(m.lo, pos.tl) + 1);
    const r = inside / span;
    inTime += r;
    const dil = m.liq > 0 ? m.liq / (m.liq + pos.L) : 0;
    const could = coinsOfRaw(pos.L * m.f0 * dil, pos.L * m.f1 * dil, pool);
    const earned = { base: could.base * r, quote: could.quote * r };
    owed = { base: owed.base + earned.base, quote: owed.quote + earned.quote };
    feeCoins.base += earned.base; feeCoins.quote += earned.quote;
    fees += val(earned, p);

    const out = m.c < pos.tl || m.c >= pos.tu;
    if (!out) heldBack = false;
    if (!o.rerange || !out) continue;
    const c = held(pos.L, pos.tl, pos.tu, m.c);
    const have = { base: c.base + idle.base + owed.base, quote: c.quote + idle.quote + owed.quote };
    const next = rangeTicks(p * (1 - o.bandPct), p * (1 + o.bandPct), pool.spacing, pool);
    const s = plan(have, next.tickLower, next.tickUpper, m.c, m.liq);
    // like the bot: a swap over the impact cap blocks the move
    if (s.impact > o.maxImpact) { if (!heldBack) blocked++; heldBack = true; continue; }
    heldBack = false;
    moveLoss += val(putIn, p) - val(c, p);
    owed = { base: 0, quote: 0 };
    open(have, m.c, m.liq, o.gasMove);
    moves++;
  }

  const lastRow = rows[rows.length - 1];
  return {
    bandPct: o.bandPct, rerange: o.rerange, days: (lastRow.t - first.t) / DAY_S,
    feeCoins, fees, gas, swapCost, moves, blocked, inRange: inTime / (rows.length - 1), moveLoss,
    net: fees - gas - swapCost - moveLoss,
  };
}

/** Each range with moves on and off, over all of `rows`. */
export function replayTable(rows: PoolMinute[], pool: ReplayPool, base: Omit<ReplayOpts, 'bandPct' | 'rerange'>, bands: number[]): ReplayResult[] {
  return bands.flatMap((bandPct) => [true, false].map((rerange) => replayLp(rows, pool, { ...base, bandPct, rerange })));
}
