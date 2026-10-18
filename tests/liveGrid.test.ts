import { describe, expect, it } from 'vitest';
import { calculateGridLevels } from '../src/engine/gridEngine';
import { buildIntervals, buyAmountPerInterval, evaluateTick, onTradeFilled, onTradeSkipped, seedIntervals } from '../src/live/liveGrid';

const levels = calculateGridLevels(100, 110, 10);

describe('live grid triggers (semi-auto)', () => {
  it('arms the intervals below the price; every interval gets capital ÷ intervals', () => {
    const iv = buildIntervals(levels, 105, buyAmountPerInterval(10, 40));
    expect(iv).toHaveLength(10);
    expect(iv.filter((i) => i.status === 'waitingBuy').map((i) => i.buyPrice)).toEqual([100, 101, 102, 103, 104]);
    expect(iv.filter((i) => i.status === 'inactive').map((i) => i.buyPrice)).toEqual([105, 106, 107, 108, 109]);
    expect(iv.every((i) => i.buyAmount === 4)).toBe(true);
  });

  it('queues (does not execute) a buy when price crosses down, only once', () => {
    let iv = buildIntervals(levels, 105, 4);
    const t1 = evaluateTick(iv, 103.5);
    expect(t1.queued.map((q) => [q.side, q.levelPrice])).toEqual([['buy', 104]]);
    iv = t1.intervals;
    expect(iv[4].status).toBe('pendingBuy');
    expect(evaluateTick(iv, 103.4).queued).toHaveLength(0); // still pending, no duplicate
  });

  it('after a buy fill, queues the sell one level up', () => {
    let iv = buildIntervals(levels, 105, 4);
    const { intervals, queued } = evaluateTick(iv, 104);
    iv = onTradeFilled(intervals, queued[0], 0.0385);
    expect(iv[4].status).toBe('holding');
    expect(evaluateTick(iv, 104.9).queued).toHaveLength(0);
    const s = evaluateTick(iv, 105);
    expect(s.queued[0].side).toBe('sell');
    expect(s.queued[0].amount).toBe(0.0385);
    iv = onTradeFilled(s.intervals, s.queued[0], 0);
    expect(iv[4].status).toBe('waitingBuy');
  });

  it('a big drop queues several buys at once', () => {
    const { queued } = evaluateTick(buildIntervals(levels, 105, 4), 101.5);
    expect(queued.map((q) => q.levelPrice)).toEqual([102, 103, 104]);
  });

  it('skipping requires the price to re-cross before re-triggering', () => {
    let iv = buildIntervals(levels, 105, 4);
    const t1 = evaluateTick(iv, 104);
    iv = onTradeSkipped(t1.intervals, t1.queued[0]);
    expect(iv[4].status).toBe('waitingBuy');
    expect(iv[4].needsRearm).toBe(true);
    expect(evaluateTick(iv, 103.9).queued).toHaveLength(0);
    iv = evaluateTick(iv, 104.5).intervals; // moves back above → re-armed
    expect(iv[4].needsRearm).toBe(false);
    expect(evaluateTick(iv, 104).queued).toHaveLength(1);
  });

  it('start-up buy: the intervals at or above the price get coins in one buy, split by size when it fills', () => {
    const iv = buildIntervals(levels, 105, 4);
    const { intervals, job } = seedIntervals(iv, 105, { pls: 0, cost: 0 });
    expect(job).toMatchObject({ side: 'buy', amount: 20, seed: [5, 6, 7, 8, 9], intervalIndex: 5 });
    expect(intervals.filter((i) => i.status === 'pendingBuy').map((i) => i.index)).toEqual([5, 6, 7, 8, 9]);
    const filled = onTradeFilled(intervals, job!, 0.19, 20.1);
    const up = filled.filter((i) => i.index >= 5);
    expect(up.every((i) => i.status === 'holding')).toBe(true);
    expect(up.reduce((a, i) => a + i.plsAmount, 0)).toBeCloseTo(0.19, 12);
    expect(up[0].lotCost).toBeCloseTo(20.1 / 5, 12);
    // each then sells at its own level as the price rises
    expect(evaluateTick(filled, 106).queued.map((q) => [q.side, q.levelPrice])).toEqual([['sell', 106]]);
  });

  it('coins the grid already holds fill the nearest upper intervals first; only the rest is bought', () => {
    const iv = buildIntervals(levels, 105, 4);
    const coins = 4 / 105; // one interval's worth at this price
    const { intervals, job } = seedIntervals(iv, 105, { pls: coins * 2.4, cost: 10 });
    // 2 full shares, then 0.4 of a share is under half: left unused, that interval is bought
    expect(intervals.filter((i) => i.status === 'holding').map((i) => i.index)).toEqual([5, 6]);
    expect(intervals[5].lotCost).toBeCloseTo((10 / (coins * 2.4)) * coins, 12);
    expect(job).toMatchObject({ amount: 12, seed: [7, 8, 9] });
    // what a start-up buy left after the pool fee (≈99.7% of 5 shares) covers all 5 on a restart: nothing is re-bought
    const again = seedIntervals(buildIntervals(levels, 105, 4), 105, { pls: coins * 5 * 0.997, cost: 20 });
    expect(again.job).toBeNull();
    expect(again.intervals[9].plsAmount).toBeCloseTo(coins * 0.985, 12);
  });

  it('a start-up buy that did not happen leaves its intervals as ordinary waiting buys', () => {
    const { intervals, job } = seedIntervals(buildIntervals(levels, 105, 4), 105, { pls: 0, cost: 0 });
    const back = onTradeSkipped(intervals, job!);
    expect(back.filter((i) => i.index >= 5).every((i) => i.status === 'waitingBuy' && i.needsRearm)).toBe(true);
    // they buy once the price has come back up through them and down again
    expect(evaluateTick(back, 104.5).queued).toHaveLength(0);
  });

  it("a sell's next buy size is whatever the engine passes (profit reinvested), otherwise unchanged", () => {
    let iv = buildIntervals(levels, 105, 4);
    const buy = evaluateTick(iv, 104).queued[0];
    iv = onTradeFilled(evaluateTick(iv, 104).intervals, buy, 0.0384, 4);
    const sell = evaluateTick(iv, 105).queued[0];
    expect(onTradeFilled(iv, sell, 0, undefined, 4.09)[4]).toMatchObject({ status: 'waitingBuy', buyAmount: 4.09 });
    expect(onTradeFilled(iv, sell, 0)[4].buyAmount).toBe(4);
  });
});
