/**
 * Paper buys quote the pool, and a pool that can only take a dust-sized buy is skipped (Kyle, 2026-10-30). A paper run
 * bought a $0.005 pool at GeckoTerminal's price (2.4e-16), the pool's own price was 1.0e-14, and the first mark booked a
 * +4079% take profit, twice.
 */
import { describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { MIN_BUY_SHARE, TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';

setEthUsdSource(() => 2500);
const NOW = 1_800_000_000_000;
const gecko: FreshPool = {
  chainId: 8453, pool: '0x' + 'eb'.repeat(20), dex: 'uniswap-v2-base', kind: 'v2', token: '0x' + '05'.repeat(20), spend: '0x' + '42'.repeat(20),
  tokenSymbol: '.AI', spendSymbol: 'WETH', liquidityUsd: 9_000, volumeUsd: 1_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
  quoteReserve: 2, tokenReserve: 8e15, feeBps: 30, price: 2.4e-16, usdPerSpend: 2_500,
};
const clean: GateInput = {
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
  liquidityUsd: 9_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
};
function run(o: { now: { price: number; quoteReserve: number; tokenReserve: number } | Error; tokensFor?: (spend: number) => number; mark?: number }) {
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => NOW,
    sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => [gecko], assess: async () => clean, resolve: async () => null,
    poolNow: async () => { if (o.now instanceof Error) throw o.now; return o.now; },
    quoteBuy: async (_p, spend) => ({ tokens: (o.tokensFor ?? ((s) => s / 1e-14))(spend), impact: 0.01 }),
    mark: o.mark != null ? async () => ({ price: o.mark! }) : undefined,
  });
  t.configure({ perTradeUsd: 50, totalUsd: 500, risk: 'any' });
  t.turnOn();
  return t;
}

describe('paper buys quote the pool', () => {
  it("are sized from the pool's depth now and fill at its quote: the entry is the pool's price, not GeckoTerminal's", async () => {
    const t = run({ now: { price: 1e-14, quoteReserve: 2, tokenReserve: 2e14 }, tokensFor: (s) => (s / 1e-14) * 0.99, mark: 1e-14 });
    await t.tick();
    const p = t.status().positions[0];
    expect(p.entryPrice).toBeCloseTo(1e-14 / 0.99, 22);
    expect(p.quoteReserve).toBe(2);
    await t.tick(); // the first mark: the pool's own price, so no fake gain and no take profit
    expect(t.status().positions[0].pnlPct!).toBeLessThan(0);
    expect(t.status().trades.filter((x) => x.side === 'sell')).toHaveLength(0);
  });

  it('a pool that can only take a dust-sized buy is skipped, with the size it could take', async () => {
    const t = run({ now: { price: 1e-14, quoteReserve: 0.000001, tokenReserve: 1e8 } });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().feed[0]).toMatchObject({ stage: 'buy', why: expect.stringMatching(new RegExp(`^the pool takes only .* within the impact cap, under ${MIN_BUY_SHARE * 100}% of the .* per trade$`)) });
  });

  it("a pool whose state can't be read now is skipped, never bought at GeckoTerminal's figures", async () => {
    const t = run({ now: new Error('one side of the pool is empty') });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().feed[0].why).toBe('could not read the pool now (one side of the pool is empty)');
  });
});
