import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { ActivityBus } from '../src/server/bot/activity';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
// Old field name on purpose: callers using `totalCapitalUsd` keep working (it was always the quote-coin amount).
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 };

describe('closing a live grid whose market is unavailable', () => {
  it('stops it with a stopped event and a stop-audit record (coins stay in the wallet)', async () => {
    const chain = new MockChain(P0);
    const store = new MemoryStore<MultiState>();
    const a = new MultiBot({ net: NET, reader: chain, signer: chain, store, log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    const id = await a.add({ mode: 'live', stable: 'DAI', ...base });
    await a.tickAll();
    expect(a.status().grids[0].mode).toBe('live');
    // the next process can't price this market (e.g. it was removed from the config)
    const saved = JSON.parse(JSON.stringify(store.load())) as MultiState;
    const g = saved.grids.find((x) => x.id === id)!;
    g.stable = 'GONE';
    const store2 = new MemoryStore<MultiState>();
    store2.save(saved);
    const activity = new ActivityBus(400);
    const b = new MultiBot({ net: NET, reader: chain, signer: chain, store: store2, log: new Logger(true), maxRetries: 1, retryDelayMs: 0, activity });
    const out = b.closeGrid(id);
    expect(out).toMatchObject({ closing: false });
    const after = b.status().grids.find((x) => x.id === id)!;
    expect(after.status).toBe('stopped');
    expect(after.halt).toMatchObject({ what: 'close' });
    const ev = activity.recent(400).find((e) => e.type === 'stopped' && e.botId === id);
    expect(ev?.msg).toMatch(/can't close/);
    expect((ev!.data as { halt: unknown }).halt).toEqual(after.halt);
  });
});
