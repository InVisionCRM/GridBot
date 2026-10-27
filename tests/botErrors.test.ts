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
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 });
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

describe('A token balance that fails to read is an error, never 0', () => {
  it('the wallet shows it as unread, and a live start refuses instead of skipping the funds check', async () => {
    const P0 = 0.00001;
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    const dai = NET.quotes.find((q) => q.symbol === 'DAI')!.address.toLowerCase();
    const call = chain.call.bind(chain);
    chain.call = async (tx) => {
      if (tx.to.toLowerCase() === dai && tx.data.startsWith('0x70a08231')) throw new Error('request timeout (code=TIMEOUT, version=6.17.0)'); // balanceOf
      return call(tx);
    };
    await bot.refreshWallet(true);
    const coins = bot.status().wallets.find((w) => w.chainId === NET.chainId)!.coins;
    expect(coins.find((c) => c.symbol === 'DAI')).toMatchObject({ amount: null, error: expect.stringMatching(/request timeout/) });
    await expect(bot.add({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 }))
      .rejects.toThrow(/Couldn't read your DAI balance \(request timeout.*nothing was started/);
    // once it reads again, the start goes through
    chain.call = call;
    await expect(bot.add({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 })).resolves.toBeTruthy();
  });
});
