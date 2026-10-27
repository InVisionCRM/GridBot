import { describe, expect, it } from 'vitest';
import { MultiBot, STOPPED_LP_EVERY, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const LNET = NETWORKS.mainnet;
const CH = chainFromNetwork(LNET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: LNET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: LNET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 };

function counted() {
  const chain = new MockChain(P0);
  let n = 0;
  const call = chain.call.bind(chain);
  chain.call = async (tx) => { n++; return call(tx); };
  const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
  return { chain, bot, calls: () => n, reset: () => { n = 0; } };
}

describe('poll RPC volume', () => {
  it('grids on one market reuse the poll\'s price: three grids cost what one does', async () => {
    const one = counted();
    await one.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await one.bot.tickAll(); // seed buy
    await one.bot.tickAll();
    one.reset();
    await one.bot.tickAll();
    const perPoll1 = one.calls();

    const three = counted();
    for (let i = 0; i < 3; i++) await three.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await three.bot.tickAll();
    await three.bot.tickAll();
    three.reset();
    await three.bot.tickAll();
    expect(three.calls()).toBe(perPoll1);
    expect(perPoll1).toBeGreaterThan(0);
  });

  it('a grid ticked on its own still reads its price', async () => {
    const s = counted();
    const id = await s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    s.reset();
    const g = (s.bot as unknown as { engines: Map<string, { tick: () => Promise<void> }> }).engines.get(id)!;
    await g.tick();
    expect(s.calls()).toBeGreaterThan(0);
  });

  it('stopped grids are not ticked', async () => {
    const s = counted();
    const id = await s.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    s.bot.stop(id);
    const g = (s.bot as unknown as { engines: Map<string, { tick: () => Promise<void> }> }).engines.get(id)!;
    let ticks = 0;
    const orig = g.tick.bind(g);
    g.tick = async () => { ticks++; return orig(); };
    await s.bot.tickAll();
    await s.bot.tickAll();
    expect(ticks).toBe(0);
  });

  it('a stopped liquidity bot is ticked only every STOPPED_LP_EVERY polls (and always to settle a sent tx)', async () => {
    const m = new MultiDexMock();
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(LNET), def], legacyNet: LNET });
    const bot = new MultiBot({ net: LNET, reader: new MockChain(P0), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
    const id = await bot.addLp({ mode: 'paper', market: def.key, bandPct: 0.1, capital: 1000 });
    await bot.tickAll();
    bot.stopLp(id);
    const e = (bot as unknown as { lpEngines: Map<string, { tick: () => Promise<void>; state: { step: unknown } }> }).lpEngines.get(id)!;
    let ticks = 0;
    const orig = e.tick.bind(e);
    e.tick = async () => { ticks++; return orig(); };
    for (let i = 0; i < STOPPED_LP_EVERY; i++) await bot.tickAll();
    expect(ticks).toBe(1);
    e.state.step = { action: 'rerange', stage: 'exit', tries: 0, hash: '0xabc' };
    ticks = 0;
    await bot.tickAll();
    expect(ticks).toBe(1);
  });
});
