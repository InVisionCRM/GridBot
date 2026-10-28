import { describe, expect, it } from 'vitest';
import { formatClockEt } from '../src/v2/format';
import { createSnapshotDesk } from '../src/v2/snapshot-desk';
import { applyDelta } from '../src/v2/use-desk';
import type { BotDesk, DeskDelta, DeskSnapshot } from '../src/v2/metrics';

function bot(id: string): BotDesk {
  return { metrics: { botId: id } } as BotDesk;
}

function snap(ids: string[]): DeskSnapshot {
  return {
    source: 'live',
    portfolio: { asOf: 1, generatedUsd: 1 } as DeskSnapshot['portfolio'],
    bots: ids.map(bot),
    prices: [],
    activity: [],
  };
}

function delta(partial: Partial<DeskDelta>): DeskDelta {
  return {
    asOf: 2,
    portfolio: { asOf: 2, generatedUsd: 2 } as DeskSnapshot['portfolio'],
    bots: [],
    prices: [],
    activity: [],
    ...partial,
  };
}

describe('desk deltas', () => {
  it('adds a new bot and removes one by id, and an empty delta changes nothing', () => {
    const cur = snap(['a', 'b']);
    const added = applyDelta(cur, delta({ bots: [bot('c')] }));
    expect(added.bots.map((b) => b.metrics.botId)).toEqual(['a', 'b', 'c']);
    const removed = applyDelta(added, delta({ removedIds: ['b'] }));
    expect(removed.bots.map((b) => b.metrics.botId)).toEqual(['a', 'c']);
    const held = applyDelta(removed, delta({}));
    expect(held.bots.map((b) => b.metrics.botId)).toEqual(['a', 'c']);
    expect(held.source).toBe('live');
    expect(held.portfolio.asOf).toBe(removed.portfolio.asOf);
  });

  it('keeps the snapshot asOf through a heartbeat', () => {
    const asOf = Date.UTC(2026, 9, 27, 21, 5, 9);
    const cur = snap(['a']);
    cur.source = 'snapshot';
    cur.portfolio = { ...cur.portfolio, asOf };
    const beat = createSnapshotDesk(cur).tick();
    expect(beat.asOf).toBe(asOf);
    expect(beat.portfolio.asOf).toBe(asOf);
    const next = applyDelta(cur, { ...beat, asOf: Date.now(), portfolio: { ...cur.portfolio, asOf: Date.now() } });
    expect(next.portfolio.asOf).toBe(asOf);
    expect(formatClockEt(next.portfolio.asOf)).toBe('5:05 PM ET');
  });

  it('replaces a bot that arrives again and does not resurrect a removed id', () => {
    const cur = snap(['a']);
    const next = applyDelta(cur, delta({ bots: [bot('a'), bot('a')], removedIds: ['a'] }));
    expect(next.bots).toEqual([]);
  });
});
