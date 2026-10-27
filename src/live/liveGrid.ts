/**
 * Semi-automatic live grid: detects level crossings and QUEUES trades for the user to approve.
 * It never signs anything. Each grid interval i spans levels[i] (buy) → levels[i+1] (sell).
 */
import type { GridLevel } from '../types/grid';

export type IntervalStatus = 'inactive' | 'waitingBuy' | 'pendingBuy' | 'holding' | 'pendingSell';

export interface LiveInterval {
  index: number;
  buyPrice: number;
  sellPrice: number;
  status: IntervalStatus;
  /** PLS held from this interval's buy (for the matching sell) */
  plsAmount: number;
  /** Cost basis (quote spent + buy gas, quote units) of the PLS lot held by this interval */
  lotCost?: number;
  /** Quote this interval spends on its next buy: the start size, plus its profits when they are reinvested */
  buyAmount: number;
  /** After a user skips a trigger, wait for price to move back before re-triggering */
  needsRearm: boolean;
}

export interface QueuedTrade {
  id: string;
  intervalIndex: number;
  side: 'buy' | 'sell';
  triggerPrice: number;
  levelPrice: number;
  /** buy: USD to spend; sell: PLS to sell */
  amount: number;
  createdAt: number;
  /** A one-off test trade started by the user (not part of the grid) */
  manual?: boolean;
  /** Start-up buy: coins for these intervals at or above the price, split between them when it fills */
  seed?: number[];
  /** The seed buy of a range re-center: part of that re-center, which counts as one move */
  recenter?: boolean;
}

let qseq = 0;

/**
 * Every interval gets the same start size (capital ÷ intervals). Below the price an interval waits to buy; at or above
 * it the interval is 'inactive' until seedIntervals gives it coins to sell as the price rises.
 */
export function buildIntervals(levels: GridLevel[], currentPrice: number, buyAmount: number): LiveInterval[] {
  const out: LiveInterval[] = [];
  for (let i = 0; i < levels.length - 1; i++) {
    const buyPrice = levels[i].price;
    out.push({
      index: i,
      buyPrice,
      sellPrice: levels[i + 1].price,
      status: buyPrice < currentPrice ? 'waitingBuy' : 'inactive',
      plsAmount: 0,
      needsRearm: false,
      buyAmount,
    });
  }
  return out;
}

/** Start size per interval: the capital split over every interval (the ones above the price are bought at the start). */
export function buyAmountPerInterval(gridCount: number, totalCapital: number): number {
  return totalCapital / gridCount;
}

/**
 * Coins for the intervals at or above the price, so the whole range trades: nearest-first, intervals are filled from
 * coins the grid already holds (a live restart), the rest are bought in one start-up swap (`job`, null if none).
 * The last held-funded interval may hold less than a full share (the start-up buy lost the pool fee and impact), as
 * long as it is at least half; a smaller remainder is left unused rather than buying that interval twice.
 * `held` = coins + their cost (quote) not assigned to any interval.
 */
export function seedIntervals(intervals: LiveInterval[], price: number, held: { pls: number; cost: number }, now = Date.now()): { intervals: LiveInterval[]; job: QueuedTrade | null } {
  const upper = intervals.filter((i) => i.status === 'inactive' && i.buyPrice >= price).sort((a, b) => a.buyPrice - b.buyPrice);
  const avg = held.pls > 0 ? held.cost / held.pls : 0;
  let left = held.pls;
  const fromHeld = new Map<number, number>(), toBuy: LiveInterval[] = [];
  for (const iv of upper) {
    const coins = iv.buyAmount / price;
    if (left >= coins / 2) { const take = Math.min(coins, left); fromHeld.set(iv.index, take); left -= take; } else toBuy.push(iv);
  }
  const buying = new Set(toBuy.map((i) => i.index));
  const next = intervals.map((iv): LiveInterval => {
    const coins = fromHeld.get(iv.index);
    if (coins != null) return { ...iv, status: 'holding', plsAmount: coins, lotCost: avg * coins };
    return buying.has(iv.index) ? { ...iv, status: 'pendingBuy' } : iv;
  });
  const job: QueuedTrade | null = toBuy.length ? {
    id: `q-${++qseq}`, intervalIndex: toBuy[0].index, side: 'buy', triggerPrice: price, levelPrice: price,
    amount: toBuy.reduce((a, i) => a + i.buyAmount, 0), createdAt: now, seed: toBuy.map((i) => i.index),
  } : null;
  return { intervals: next, job };
}


/**
 * Evaluate a price tick. Returns updated intervals and NEW queued trades.
 * Only one trade per interval can be pending at a time.
 */
export function evaluateTick(
  intervals: LiveInterval[],
  price: number,
  now = Date.now(),
): { intervals: LiveInterval[]; queued: QueuedTrade[] } {
  const queued: QueuedTrade[] = [];
  const next = intervals.map((iv) => {
    let v = { ...iv };
    // Re-arm once price moves back across the level after a skip
    if (v.needsRearm) {
      if (v.status === 'waitingBuy' && price > v.buyPrice) v.needsRearm = false;
      if (v.status === 'holding' && price < v.sellPrice) v.needsRearm = false;
      if (v.needsRearm) return v;
    }
    if (v.status === 'waitingBuy' && price <= v.buyPrice) {
      v = { ...v, status: 'pendingBuy' };
      queued.push({ id: `q-${++qseq}`, intervalIndex: v.index, side: 'buy', triggerPrice: price, levelPrice: v.buyPrice, amount: v.buyAmount, createdAt: now });
    } else if (v.status === 'holding' && price >= v.sellPrice && v.plsAmount > 0) {
      v = { ...v, status: 'pendingSell' };
      queued.push({ id: `q-${++qseq}`, intervalIndex: v.index, side: 'sell', triggerPrice: price, levelPrice: v.sellPrice, amount: v.plsAmount, createdAt: now });
    }
    return v;
  });
  return { intervals: next, queued };
}

/**
 * The tx succeeded. A buy holds its coins (a start-up buy splits them between its intervals by buy size); a sell waits
 * to buy again with `nextBuyAmount` (its profit added when reinvesting).
 */
export function onTradeFilled(intervals: LiveInterval[], q: QueuedTrade, plsAmount: number, lotCost?: number, nextBuyAmount?: number): LiveInterval[] {
  if (q.seed) {
    const ids = new Set(q.seed);
    const total = intervals.filter((iv) => ids.has(iv.index)).reduce((a, iv) => a + iv.buyAmount, 0);
    return intervals.map((iv) => {
      if (!ids.has(iv.index)) return iv;
      const share = iv.buyAmount / total;
      return { ...iv, status: 'holding', plsAmount: plsAmount * share, lotCost: lotCost != null ? lotCost * share : undefined, needsRearm: false };
    });
  }
  return intervals.map((iv) => {
    if (iv.index !== q.intervalIndex) return iv;
    if (q.side === 'buy') return { ...iv, status: 'holding', plsAmount, lotCost, needsRearm: false };
    return { ...iv, status: 'waitingBuy', plsAmount: 0, lotCost: undefined, needsRearm: false, buyAmount: nextBuyAmount ?? iv.buyAmount };
  });
}

/**
 * User skipped/rejected, or tx failed: revert and require a re-cross before triggering again. A start-up buy that
 * didn't happen leaves its intervals as ordinary waiting buys (they buy once the price comes back down through them).
 */
export function onTradeSkipped(intervals: LiveInterval[], q: QueuedTrade): LiveInterval[] {
  const ids = new Set(q.seed ?? [q.intervalIndex]);
  return intervals.map((iv) => {
    if (!ids.has(iv.index)) return iv;
    return { ...iv, status: q.side === 'buy' ? 'waitingBuy' : 'holding', needsRearm: true };
  });
}

/** The levels the price meets next: the highest armed buy at or below the price and the lowest sell of held coins. */
export function nextLevels(intervals: Pick<LiveInterval, 'status' | 'needsRearm' | 'buyPrice' | 'sellPrice'>[], price: number): { buy: number | null; sell: number | null } {
  const buys = intervals.filter((i) => i.status === 'waitingBuy' && !i.needsRearm && i.buyPrice <= price).map((i) => i.buyPrice);
  const sells = intervals.filter((i) => i.status === 'holding' && !i.needsRearm).map((i) => i.sellPrice);
  return { buy: buys.length ? Math.max(...buys) : null, sell: sells.length ? Math.min(...sells) : null };
}
