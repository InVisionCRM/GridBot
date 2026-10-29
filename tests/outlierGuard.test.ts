/**
 * The poll's outlier guard (a price > 20% from the last 1m close is held until 3 polls confirm it) applies to
 * everything that reads the price, not just the candles:
 * - a013: a grid never trades on, or republishes as the spot, a price the guard held back; it waits the poll out.
 * - b006: a flipped market (HEX~) is accepted only when its original (HEX) was accepted in the same poll.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001, QH = 0.0075;
const spots = (bot: MultiBot) => (bot as unknown as { hub: { spots: Record<string, number> } }).hub.spots;

describe('a held-back poll price reaches nothing', () => {
  it('grid: no trade on the spike, and the spot keeps the last accepted price (a013)', async () => {
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.6, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 });
    await bot.tickAll();
    const trades = bot.status().grids.find((g) => g.id === id)!.trades.length;
    const before = spots(bot).DAI;
    chain.setPrice(P0 * 0.5); // a glitch: half the price for one poll
    await bot.tickAll();
    expect(bot.status().grids.find((g) => g.id === id)!.trades.length).toBe(trades);
    expect(spots(bot).DAI).toBe(before);
  });

  it('flipped market: HEX~ is held back with HEX (b006)', async () => {
    const chain = new MockChain(P0, { quoteDepth: 100_000_000 });
    chain.setPrice(QH, 'HEX');
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
    await bot.addTrend({ mode: 'paper', quote: 'HEX~', tf: '1h', cfg: {}, capital: 100_000 });
    await bot.tickAll();
    const flip = spots(bot)['HEX~'];
    expect(flip).toBeGreaterThan(0);
    chain.setPrice(QH * 0.5, 'HEX');
    await bot.tickAll();
    expect(spots(bot)['HEX~']).toBe(flip);
  });
});
