import { describe, expect, it } from 'vitest';
import { calculateGridLevels } from '../src/engine/gridEngine';
import { buildIntervals, evaluateTick, onTradeFilled, onTradeSkipped, usdPerBuyLevel } from '../src/live/liveGrid';

const levels = calculateGridLevels(100, 110, 10);

describe('live grid triggers (semi-auto)', () => {
  it('arms only intervals whose buy level is below the price', () => {
    const iv = buildIntervals(levels, 105);
    expect(iv).toHaveLength(10);
    expect(iv.filter((i) => i.status === 'waitingBuy').map((i) => i.buyPrice)).toEqual([100, 101, 102, 103, 104]);
    expect(usdPerBuyLevel(iv, 20)).toBe(4);
  });

  it('queues (does not execute) a buy when price crosses down, only once', () => {
    let iv = buildIntervals(levels, 105);
    const t1 = evaluateTick(iv, 103.5, 4);
    expect(t1.queued.map((q) => [q.side, q.levelPrice])).toEqual([['buy', 104]]);
    iv = t1.intervals;
    expect(iv[4].status).toBe('pendingBuy');
    expect(evaluateTick(iv, 103.4, 4).queued).toHaveLength(0); // still pending, no duplicate
  });

  it('after a buy fill, queues the sell one level up', () => {
    let iv = buildIntervals(levels, 105);
    const { intervals, queued } = evaluateTick(iv, 104, 4);
    iv = onTradeFilled(intervals, queued[0], 0.0385);
    expect(iv[4].status).toBe('holding');
    expect(evaluateTick(iv, 104.9, 4).queued).toHaveLength(0);
    const s = evaluateTick(iv, 105, 4);
    expect(s.queued[0].side).toBe('sell');
    expect(s.queued[0].amount).toBe(0.0385);
    iv = onTradeFilled(s.intervals, s.queued[0], 0);
    expect(iv[4].status).toBe('waitingBuy');
  });

  it('a big drop queues several buys at once', () => {
    const { queued } = evaluateTick(buildIntervals(levels, 105), 101.5, 4);
    expect(queued.map((q) => q.levelPrice)).toEqual([102, 103, 104]);
  });

  it('skipping requires the price to re-cross before re-triggering', () => {
    let iv = buildIntervals(levels, 105);
    const t1 = evaluateTick(iv, 104, 4);
    iv = onTradeSkipped(t1.intervals, t1.queued[0]);
    expect(iv[4].status).toBe('waitingBuy');
    expect(iv[4].needsRearm).toBe(true);
    expect(evaluateTick(iv, 103.9, 4).queued).toHaveLength(0);
    iv = evaluateTick(iv, 104.5, 4).intervals; // moves back above → re-armed
    expect(iv[4].needsRearm).toBe(false);
    expect(evaluateTick(iv, 104, 4).queued).toHaveLength(1);
  });
});
