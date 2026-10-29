/**
 * Audit a028: sells go out in exact token units (15 significant digits), so a big float lot (22 277 121.742108688 PLS)
 * sells a hair less than booked and leaves ~3e-7 PLS of rounding behind. That is not a holding: Close archives at
 * once instead of sending a swap for it.
 */
import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
describe('closing a grid that sold everything', () => {
  it('rounding dust left by exact-unit sells is not a holding: Close archives, no swap is sent', async () => {
    const chain = new MockChain(P0);
    chain.setBal('DAI', 5000);
    const engine = new GridEngine({ net: NET, reader: chain, signer: chain, store: new MemoryStore<BotState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    await engine.start({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 2000 });
    chain.setPrice(P0 * 0.895);
    for (let i = 0; i < 10; i++) await engine.tick();
    expect(engine.state.intervals.filter((i) => i.status === 'holding').length).toBeGreaterThan(0);
    chain.setPrice(P0 * 1.105); // above every level's sell price
    for (let i = 0; i < 10 && engine.state.intervals.some((x) => x.status === 'holding'); i++) await engine.tick();
    expect(engine.state.intervals.filter((i) => i.status === 'holding')).toHaveLength(0);
    const sent = chain.sent.length;
    expect(engine.requestClose()).toBe(false);
    expect(engine.state.archivedAt).not.toBeNull();
    await engine.tick();
    expect(chain.sent.length).toBe(sent);
  });
});
