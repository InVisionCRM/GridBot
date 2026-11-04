/**
 * The pool-share cap (10% of the pool's active liquidity) belongs to the smart trader's liquidity bots only (Kyle
 * 2026-11-04). A bot you start is the size you chose; the smart trader's bots opened before the cap became a per-bot
 * setting get it back when the trader loads.
 */
import { describe, expect, it } from 'vitest';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { NETWORKS } from '../src/live/networks';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState } from '../src/server/bot/autopilot';
import { DEFAULT_MAX_POOL_SHARE } from '../src/market/poolSize';
import { NET } from './helpers/mockChain';
import { MultiDexMock, type Tok } from './helpers/multiDex';

function world() {
  const CH = chainFromNetwork(NETWORKS.mainnet);
  const dex = CH.dexes.find((d) => d.id === '9mm-v3')!;
  const m = new MultiDexMock();
  const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
  const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
  [WPLS, DAI].forEach((t) => m.addToken(t));
  m.addV3('9mm-v3', { factory: dex.factory, quoter: dex.quoter! });
  const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
  const def: MarketDef = {
    key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
    base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
    pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
  };
  const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
  const bot = new MultiBot({ net: NET, reader: m, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
  return { bot, key: def.key };
}

describe('pool-share cap: smart trader bots only', () => {
  it('a bot you start has no cap; with one it is kept, and a cap outside 0–1 is refused', async () => {
    const { bot, key } = world();
    const mine = await bot.addLp({ mode: 'paper', market: key, bandPct: 0.1, capital: 1000 });
    expect(bot.lpMaxPoolShare(mine)).toBeUndefined();
    const capped = await bot.addLp({ mode: 'paper', market: key, bandPct: 0.1, capital: 1000, maxPoolShare: DEFAULT_MAX_POOL_SHARE });
    expect(bot.lpMaxPoolShare(capped)).toBe(0.1);
    await expect(bot.addLp({ mode: 'paper', market: key, bandPct: 0.1, capital: 1000, maxPoolShare: 0 })).rejects.toThrow(/between 0 and 1/);
  });

  it("the smart trader's liquidity bots saved without the cap get it back when it loads; a bot you started is left alone", async () => {
    const { bot, key } = world();
    const traders = await bot.addLp({ mode: 'paper', market: key, bandPct: 0.1, capital: 1000 });
    const mine = await bot.addLp({ mode: 'paper', market: key, bandPct: 0.1, capital: 1000 });
    const auto = {
      id: traders, kind: 'lp' as const, pool: `369:${key}:lp`, pair: 'PLS/DAI', label: 'PLS/DAI', market: key, spend: 'DAI', capital: 1000, reserve: 0,
      cost: 1000, openedAt: 1, expected: 0, feeBps: 25, retiring: null,
    };
    const saved: AutopilotState = {
      version: 2, on: true, mode: 'paper', options: { ...DEFAULT_OPTIONS }, budgets: [{ chainId: 369, coin: 'DAI', amount: 1000 }],
      accounts: [{ budget: { chainId: 369, coin: 'DAI', amount: 1000 }, coins: {}, gasNative: 0, bots: [auto], pending: [], startedAt: 1, halted: null, killed: null, withdrawn: 0 }],
      closeAll: false, reviewedAt: null, scanAt: null, log: [],
    };
    const store = new MemoryStore<AutopilotState>();
    store.save(saved);
    new Autopilot({ bot, store, emit: () => undefined, scan: async () => null });
    expect(bot.lpMaxPoolShare(traders)).toBe(DEFAULT_MAX_POOL_SHARE);
    expect(bot.lpMaxPoolShare(mine)).toBeUndefined();
  });
});
