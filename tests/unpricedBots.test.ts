/**
 * Audit a033: a bot with no dollar rate (after a restart, or while its market's read fails) is unknown, never $0. No
 * portfolio snapshot is taken until every bot is priced, so its whole P&L can't later show up as "Today".
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
describe('an unpriced bot in Analytics', () => {
  it('no snapshot while unpriced; its dollars are unknown and counted; the period change is unknown', async () => {
    let now = 1_800_000_000_000;
    const chain = new MockChain(P0);
    const store = new MemoryStore<MultiState>();
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0, now: () => now });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 });
    const priced = (bot as unknown as { usdPerQuote: (k: string) => number | null }).usdPerQuote.bind(bot);
    (bot as unknown as { usdPerQuote: () => null }).usdPerQuote = () => null;
    await bot.tickAll();
    expect(store.data!.portfolio.paper).toHaveLength(0);
    const ov = bot.overview('paper');
    expect(ov.totals.unpriced).toBe(1);
    expect(ov.bots.find((b) => b.id === id)!.valueUsd).toBeNull();
    expect(ov.periods.today.equityChange).toBeNull();
    (bot as unknown as { usdPerQuote: typeof priced }).usdPerQuote = priced;
    now += 61_000;
    await bot.tickAll();
    expect(store.data!.portfolio.paper).toHaveLength(1);
    expect(bot.overview('paper').totals.unpriced).toBe(0);
  });
});
