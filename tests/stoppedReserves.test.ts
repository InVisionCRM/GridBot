/**
 * Audit a038: a stopped (not archived) live grid or trend still owns its coins: they stay in allocations(), so Convert,
 * the swap desk, the smart trader and new live starts can't spend them. Restarting the same grid does not count its
 * own coins twice, and Resume checks the wallet still holds what the live bots count.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain } from './helpers/mockChain';

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 400 };
function make() {
  const chain = new MockChain(P0);
  chain.setBal('DAI', 1000);
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
  return { chain, bot };
}
const daiOf = (bot: MultiBot, id: string) => bot.allocations().rows.find((r) => r.token === 'DAI')?.bots.find((b) => b.id === id)?.amount ?? 0;

describe('a stopped live bot keeps its coins reserved', () => {
  it('grid: stopped, its DAI and held PLS stay allocated', async () => {
    const { chain, bot } = make();
    const id = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    const before = bot.allocations().rows.map((r) => [r.token, r.bots.find((b) => b.id === id)?.amount ?? 0]);
    expect(before.length).toBeGreaterThan(0);
    bot.stop(id);
    expect(bot.status().grids.find((g) => g.id === id)!.status).toBe('stopped');
    expect(bot.allocations().rows.map((r) => [r.token, r.bots.find((b) => b.id === id)?.amount ?? 0])).toEqual(before);
  });

  it('trend: a stopped one still counts its cash, so a second live trend for the rest of the wallet is refused', async () => {
    const { bot } = make();
    const a = await bot.addTrend({ mode: 'live', quote: 'DAI', tf: '1h', cfg: {}, capital: 600 });
    bot.stopTrend(a);
    expect(daiOf(bot, a)).toBe(600);
    await expect(bot.addTrend({ mode: 'live', quote: 'DAI', tf: '1h', cfg: {}, capital: 600 })).rejects.toThrow(/Not enough DAI/);
  });

  it('restarting the same stopped grid does not count its own coins twice', async () => {
    const { bot } = make();
    const id = await bot.add({ mode: 'live', stable: 'DAI', ...base, totalCapitalQuote: 700 });
    bot.stop(id);
    await expect(bot.start(id, { mode: 'live', stable: 'DAI', ...base, totalCapitalQuote: 700 })).resolves.toBeUndefined();
  });

  it('Resume checks the wallet still holds what the live bots count', async () => {
    const { chain, bot } = make();
    const id = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    bot.stop(id);
    chain.setBal('DAI', 100); // spent elsewhere while it was stopped
    await expect(bot.resume(id)).rejects.toThrow(/DAI/);
    expect(bot.status().grids.find((g) => g.id === id)!.status).toBe('stopped');
  });
});
