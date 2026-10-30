/**
 * The token trader's funnel: every coin the scan finds is counted, and each one that leaves is counted at the stage
 * that turned it away (rules, safety checks, the buy itself) or as bought. Counts start again each local day.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const T0 = new Date(2026, 9, 30, 10, 0).getTime();
const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + (n++).toString(16).padStart(40, 'b'), dex: 'uni-v3', kind: 'v3',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: T0 - 48 * 3600_000, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000, ...o,
});

describe('token trader funnel', () => {
  it('counts what the scan found, and where each coin left or got bought', async () => {
    let now = T0;
    const young = pool({ createdAt: T0 - 60_000 }); // under the minimum age: a rule
    const v4 = pool({ kind: 'v4' }); // a rule
    const honeypot = pool(); // the safety check says no
    const good = pool(); // bought
    const batches = [[young, v4, honeypot, good]];
    const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper;
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => now, sniper,
      discover: async () => batches.shift() ?? [],
      assess: async (p) => (p === honeypot ? clean({ honeypot: true }) : clean()),
      resolve: async () => null,
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, risk: 'safe' });
    t.turnOn();
    await t.tick();
    const s = t.status();
    expect(s.funnel).toMatchObject({ scouted: 4, rules: 2, checks: 1, buy: 0, bought: 1 });
    // each feed row says where it left
    const stageOf = (p: FreshPool) => s.feed.find((f) => f.pool === p.pool)?.stage;
    expect([stageOf(young), stageOf(v4), stageOf(honeypot), stageOf(good)]).toEqual(['rules', 'rules', 'checks', 'buy']);
    expect(s.feed.find((f) => f.pool === good.pool)?.verdict).toBe('bought');
    // a new local day starts the counts again
    now = T0 + 24 * 3600_000;
    batches.push([pool({ createdAt: now - 60_000 })]);
    await t.tick();
    expect(t.status().funnel).toMatchObject({ scouted: 1, rules: 1, checks: 0, bought: 0 });
  });
});
