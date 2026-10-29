/**
 * Analytics reads each bot's own metrics (audit a022) and counts what the bots hold now over open bots only (a011).
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { portfolioKpis } from '../src/ui/Analytics';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
const PAYEE = '0x00000000000000000000000000000000000beef1';

describe('Analytics rows', () => {
  it("a grid that paid profit out: value and P&L are the bot page's, not capital + realized + unrealized (a022)", async () => {
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30, profits: { mode: 'send', to: PAYEE } });
    for (let i = 0; i < 6; i++) { chain.setPrice(P0 * (i % 2 ? 1.005 : 0.975)); await bot.tickAll(); }
    const m = bot.metricsFor(id)!;
    expect(m.quote.paidOut).toBeGreaterThan(0);
    const row = bot.overview('paper').bots.find((b) => b.id === id)!;
    expect(row.value).toBeCloseTo(m.quote.currentValue!, 9);
    expect(row.equity - row.capital).toBeCloseTo(m.quote.totalPnl!, 9);
    expect(row.realized).toBeCloseTo(m.quote.realized!, 9);
  });

  it('a closed bot stays in the history but not in value, allocated or open positions (a011)', () => {
    const k = portfolioKpis([
      { status: 'running', value: 31, capital: 30, unrealized: 1, realized: 0.5, fees: 0.1, gas: 0.01, metrics: { quote: { symbol: 'DAI' } } },
      { status: 'closed', value: 1020, capital: 1000, unrealized: 0, realized: 20, fees: 2, gas: 0.2, metrics: { quote: { symbol: 'DAI' } } },
    ]);
    expect(k.value).toEqual({ DAI: 31 });
    expect(k.allocated).toEqual({ DAI: 30 });
    expect(k.unrealized).toEqual({ DAI: 1 });
    expect(k.openCount).toBe(1);
    expect(k.realized!.DAI).toBeCloseTo(20.5, 9);
    expect(k.fees!.DAI).toBeCloseTo(2.1, 9);
  });
});
