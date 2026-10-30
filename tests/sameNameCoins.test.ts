/**
 * Two coins with one name on a chain (Kyle, 2026-10-30: "smart trader stuck"). On PulseChain the fork copy of DAI
 * (0x6B17…, about $0.001) and the bridged DAI (0xefD7…, $1) both answer symbol() "DAI". A paper Smart trader grid on the
 * fork copy closed with 4,034,744 of it, booked as "DAI": priced as $4M of the bridged one and swapped back through the
 * bridged DAI's pool ("would move the price 92%"), every few minutes, for good.
 */
import { describe, expect, it } from 'vitest';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { NETWORKS } from '../src/live/networks';
import { MemoryStore } from '../src/server/bot/store';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, type CustomFile } from '../src/server/chains/hub';
import { MockChain } from './helpers/mockChain';

const NET = NETWORKS.mainnet;
const FORK_DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const BRIDGED_DAI = NET.quotes.find((q) => q.symbol === 'DAI')!.address;
const hub = (custom?: MemoryStore<CustomFile>) =>
  new Hub({ runtimes: [new ChainRuntime(chainFromNetwork(NET), new MockChain(1) as never, null)], markets: legacyMarkets(NET), legacyNet: NET, custom });

describe('a coin whose name another coin on the chain already has', () => {
  it('keeps its own name when it is the same coin; a different one gets the name and the start of its address', () => {
    const h = hub();
    expect(h.nameFor(369, BRIDGED_DAI, 'DAI')).toBe('DAI');
    expect(h.nameFor(369, FORK_DAI, 'DAI')).toBe('DAI·6B17');
    expect(h.nameFor(369, FORK_DAI, 'FRESH')).toBe('FRESH');
    expect(h.nameFor(369, '0x' + '12'.repeat(20), 'PLS')).toBe('PLS·1212'); // a token calling itself the chain's own coin
  });

  it('a market saved with the clashing name is loaded under the distinct one; the app\'s own DAI keeps "DAI"', () => {
    const saved = new MemoryStore<CustomFile>();
    const fork: MarketDef = {
      key: 'pulsechain:DAI/PLS', chainId: 369, base: { address: FORK_DAI, symbol: 'DAI', decimals: 18 },
      quote: { address: NET.pulsex.wpls, symbol: 'PLS', decimals: 18, native: true },
      pool: { dex: 'pulsex-v2', kind: 'v2', address: '0x' + 'ae'.repeat(20), feeBps: 29 }, quoteKind: 'native', probe: 1, custom: true,
    } as unknown as MarketDef;
    saved.save({ version: 1, tokens: [], markets: [fork], pools: {} });
    const h = hub(saved);
    expect(h.def('pulsechain:DAI/PLS').base.symbol).toBe('DAI·6B17');
    expect(h.byChain(369).filter((m) => [m.base, m.quote].some((t) => t.symbol === 'DAI')).every((m) => [m.base, m.quote].some((t) => t.address.toLowerCase() === BRIDGED_DAI.toLowerCase()))).toBe(true);
  });
});

describe('paper books that hold a coin which cannot be swapped back can be reset', async () => {
  const { MultiBot } = await import('../src/server/bot/multi');
  const { Logger } = await import('../src/server/bot/logger');
  const { Autopilot, DEFAULT_OPTIONS } = await import('../src/server/bot/autopilot');
  const { NET: MNET, MockChain: MC } = await import('./helpers/mockChain');
  type S = import('../src/server/bot/autopilot').AutopilotState;
  const make = (mode: 'paper' | 'live') => {
    const chain = new MC(1);
    const store = new MemoryStore<S>();
    store.save({
      version: 2, on: false, mode, options: DEFAULT_OPTIONS, budgets: [{ chainId: MNET.chainId, coin: 'PLS', amount: 14e6 }], closeAll: false, reviewedAt: null, scanAt: null, log: [],
      accounts: [{ budget: { chainId: MNET.chainId, coin: 'PLS', amount: 14e6 }, coins: { PLS: 1e6, DAI: 4_025_463 }, gasNative: 0, pending: [], startedAt: 0, halted: null, withdrawn: 0, bots: [] }],
    } as unknown as S);
    const bot = new MultiBot({ net: MNET, reader: chain as never, signer: null, store: new MemoryStore(), log: new Logger(true) });
    return new Autopilot({ bot, store, emit: () => undefined, scan: async () => null });
  };
  it('paper, no bots and no swap open: the budget can be set again (the coins were only its books)', () => {
    const ap = make('paper');
    ap.configure({ mode: 'paper', options: {}, budgets: [{ chainId: MNET.chainId, coin: 'PLS', amount: 14e6 }] });
    expect(ap.state.accounts).toEqual([]);
  });
  it('live, the same coins are in the wallet: still refused until they are settled', () => {
    const ap = make('live');
    expect(() => ap.configure({ mode: 'live', options: {}, budgets: [{ chainId: MNET.chainId, coin: 'PLS', amount: 14e6 }] })).toThrow(/coins other than PLS to settle/);
  });
});
