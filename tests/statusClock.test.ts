import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

// Review #43 finding 2: status() must read the injected clock, the same one that stamps each engine's priceAt / startedAt.
describe('status() metrics use the injected clock', () => {
  it('a clock ahead of the wall clock: metrics are as of the last reading, ages and rates from the same clock', async () => {
    let clock = 1_900_000_000_000; // years after the real wall clock
    const chain = new MockChain(1e-5);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), now: () => clock });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.9e-5, upperPrice: 1.1e-5, gridCount: 10, totalCapitalQuote: 30 });
    await bot.tickAll();
    clock += 6 * 3600_000;
    chain.setPrice(1.02e-5);
    await bot.tickAll();
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.priceAt).toBe(clock);
    expect(g.metrics.asOf).toBe(clock);
    expect(g.metrics.ageSec).toBeGreaterThan(0);
    expect(g.metrics.ageSec).toBeLessThanOrEqual(6 * 3600 + 1);
  });
});
