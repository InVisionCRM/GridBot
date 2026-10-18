import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain } from './helpers/mockChain';

describe('A bot error clears once the next tick gets through', () => {
  it('one RPC timeout shows on the grid, and is gone after the next good tick (it used to stay until a restart)', async () => {
    const P0 = 0.00001;
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 });
    const grid = () => bot.status().grids.find((g) => g.id === id)!;

    const call = chain.call.bind(chain);
    chain.call = async () => { throw Object.assign(new Error('request timeout (code=TIMEOUT, version=6.17.0)'), { code: 'TIMEOUT' }); };
    await bot.tickAll();
    expect(grid().lastError).toMatch(/request timeout/);

    chain.call = call;
    await bot.tickAll();
    expect(grid().lastError).toBeNull();
  });
});
