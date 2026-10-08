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
}

export function buildIntervals(levels: GridLevel[], currentPrice: number): LiveInterval[] {
  const out: LiveInterval[] = [];
  for (let i = 0; i < levels.length - 1; i++) {
    const buyPrice = levels[i].price;
    out.push({
      index: i,
      buyPrice,
      sellPrice: levels[i + 1].price,
      // Same bootstrap as paper: only levels below market start with a buy waiting.
      status: buyPrice < currentPrice ? 'waitingBuy' : 'inactive',
      plsAmount: 0,
      needsRearm: false,
    });
  }
  return out;
}

let qseq = 0;

/**
 * Evaluate a price tick. Returns updated intervals and NEW queued trades.
 * Only one trade per interval can be pending at a time.
 */
export function evaluateTick(
  intervals: LiveInterval[],
  price: number,
  usdPerBuy: number,
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
      queued.push({ id: `q-${++qseq}`, intervalIndex: v.index, side: 'buy', triggerPrice: price, levelPrice: v.buyPrice, amount: usdPerBuy, createdAt: now });
    } else if (v.status === 'holding' && price >= v.sellPrice && v.plsAmount > 0) {
      v = { ...v, status: 'pendingSell' };
      queued.push({ id: `q-${++qseq}`, intervalIndex: v.index, side: 'sell', triggerPrice: price, levelPrice: v.sellPrice, amount: v.plsAmount, createdAt: now });
    }
    return v;
  });
  return { intervals: next, queued };
}

/** User confirmed and the tx succeeded. */
export function onTradeFilled(intervals: LiveInterval[], q: QueuedTrade, plsAmount: number, lotCost?: number): LiveInterval[] {
  return intervals.map((iv) => {
    if (iv.index !== q.intervalIndex) return iv;
    if (q.side === 'buy') return { ...iv, status: 'holding', plsAmount, lotCost, needsRearm: false };
    return { ...iv, status: 'waitingBuy', plsAmount: 0, lotCost: undefined, needsRearm: false };
  });
}

/** User skipped/rejected, or tx failed: revert and require a re-cross before triggering again. */
export function onTradeSkipped(intervals: LiveInterval[], q: QueuedTrade): LiveInterval[] {
  return intervals.map((iv) => {
    if (iv.index !== q.intervalIndex) return iv;
    return { ...iv, status: q.side === 'buy' ? 'waitingBuy' : 'holding', needsRearm: true };
  });
}

/** USD per buy level: capital split evenly across intervals that start with a buy. */
export function usdPerBuyLevel(intervals: LiveInterval[], totalCapitalUsd: number): number {
  const n = intervals.filter((i) => i.status === 'waitingBuy').length;
  return n > 0 ? totalCapitalUsd / n : 0;
}
