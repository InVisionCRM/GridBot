/**
 * Audits a009 and a010: the token trader's age and fill count come from its own all-time records, not from the trade
 * log (trimmed to the newest 200 rows, and without a mode until now). Trade rows record paper or live.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { tokenMetrics } from '../src/metrics/botMetrics';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
const POOL: FreshPool = {
  chainId: 369, pool: '0x' + 'e'.repeat(40), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '33'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003,
};
const make = (store = new MemoryStore<TraderState>()) => new TokenTrader({
  store, now: () => NOW, emit: () => {},
  sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
  discover: async () => [POOL], assess: async () => clean(), resolve: async () => null, mark: async () => null,
});

describe('token trader: all-time age and fills', () => {
  it('a buy records its mode on the trade row, starts the mode\'s clock, and counts one fill', async () => {
    const t = make();
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe' });
    t.turnOn();
    await t.tick();
    const s = t.status();
    expect(s.trades[0]).toMatchObject({ side: 'buy', mode: 'paper' });
    expect(s.startedAt).toEqual({ paper: NOW });
    expect(s.generated.find((g) => g.mode === 'paper')!.fills).toBe(1);
  });

  it('metrics: age from the saved start and fills from the ledger, whatever the trimmed log still holds', () => {
    const coin = { chainId: 369, address: '0x22', symbol: 'WPLS', native: true };
    const m = tokenMetrics({
      on: true, options: { mode: 'live' }, startedAt: { live: NOW - 30 * 86_400_000 },
      generated: [{ mode: 'live', coin, amount: 5, proceeds: 105, cost: 100, fees: 0, taxes: 0, gasNative: 0, gasInAmount: true, closed: 300, fills: 640, basis: 'closed' }],
      trades: [{ t: NOW - 3_600_000, mode: 'live', side: 'sell', label: 'NEW/WPLS', amount: 1, usd: 1, pnl: 0.1 }], positions: [],
    }, NOW);
    expect(m.ageSec).toBeCloseTo(30 * 86_400, 0);
    expect(m.fillCount).toBe(640);
  });

  it('an older file: start and fills are set once from what the log showed, then kept', () => {
    const store = new MemoryStore<TraderState>();
    store.data = {
      version: 1, on: false, options: { mode: 'paper' }, positions: [], feed: [], cursors: {}, snipesAt: [], plays: [],
      trades: [{ t: NOW - 5000, side: 'sell', chainId: 369, pool: '0x1', label: 'A/WPLS', usd: 1, price: 1, why: '', pnlUsd: 0, spendSym: 'WPLS' },
        { t: NOW - 9000, side: 'buy', chainId: 369, pool: '0x1', label: 'A/WPLS', usd: 1, price: 1, why: '', pnlUsd: null, spendSym: 'WPLS' }],
      generated: { 'paper:369:0x22': { mode: 'paper', chainId: 369, coin: '0x22', symbol: 'WPLS', proceeds: 1, cost: 1, fees: 0, taxes: 0, gasNative: 0, closed: 1 } },
    } as unknown as TraderState;
    const t = make(store);
    expect(t.status().startedAt).toEqual({ paper: NOW - 9000 });
    expect(store.data!.generated!['paper:369:0x22'].fills).toBe(2);
  });
});
