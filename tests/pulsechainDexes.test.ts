/**
 * PulseChain multi-DEX: PulseX V1 + PulseX V2 + 9mm V2 + 9mm V3 in the registry, pool discovery, best-pool
 * selection (best quote at a realistic size), manual override, persistence, DEX tagging on fills.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork, PULSECHAIN_EXTRA_DEXES } from '../src/live/chains';
import { legacyMarkets } from '../src/live/markets';
import { DEFAULT_LIMITS } from '../src/live/limits';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, type CustomFile } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain } from './helpers/mockChain';

const NET = NETWORKS.mainnet;
const CH = chainFromNetwork(NET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAIq = NET.quotes.find((q) => q.symbol === 'DAI')!;
const DAI: Tok = { address: DAIq.address, symbol: 'DAI', decimals: 18 };
const MEME: Tok = { address: '0x00000000000000000000000000000000000b0b01', symbol: 'MEME', decimals: 9, name: 'Meme' };
const ME = '0x1234567890123456789012345678901234567890';

/** WPLS @ 0.00003 DAI on four DEXes with very different depth. */
function world(o: { v3Deep?: boolean } = {}) {
  const m = new MultiDexMock();
  [WPLS, DAI, MEME].forEach((t) => m.addToken(t));
  for (const id of ['pulsex-v1', 'pulsex-v2', '9mm-v2']) m.addV2(id, { router: dex(id).router, factory: dex(id).factory, feeBps: dex(id).feeBps!, wrapped: WPLS.address });
  m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
  const pools = {
    v1: m.v2Pair('pulsex-v1', WPLS, 1e9, DAI, 30_000),
    v2: m.v2Pair('pulsex-v2', WPLS, 1e8, DAI, 3_000),
    mm2: m.v2Pair('9mm-v2', WPLS, 1e6, DAI, 30),
    mm3: m.v3Pool('9mm-v3', WPLS, o.v3Deep ? 2e9 : 5e8, DAI, o.v3Deep ? 60_000 : 15_000, 2500),
    mm3thin: m.v3Pool('9mm-v3', WPLS, 1e5, DAI, 3, 10000),
    memeV1: m.v2Pair('pulsex-v1', MEME, 5e6, WPLS, 2e8),
    meme9: m.v3Pool('9mm-v3', MEME, 1e7, WPLS, 4e8, 2500),
  };
  const store = new MemoryStore<CustomFile>();
  const mk = (s = store) => new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: legacyMarkets(NET), legacyNet: NET, custom: s });
  return { m, pools, store, hub: mk(), mk };
}

describe('PulseChain DEX registry (verified addresses)', () => {
  it('mainnet has PulseX V2 first, then PulseX V1, 9mm V2 and 9mm V3; testnet keeps PulseX V2 only', () => {
    expect(CH.dexes.map((d) => d.id)).toEqual(['pulsex-v2', 'pulsex-v1', '9mm-v2', '9mm-v3']);
    expect(chainFromNetwork(NETWORKS.testnet).dexes.map((d) => d.id)).toEqual(['pulsex-v2']);
  });
  it('PulseX V1 is a separate router + factory from V2, 29 bps', () => {
    const v1 = dex('pulsex-v1'), v2 = dex('pulsex-v2');
    expect(v1.router).toBe('0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02');
    expect(v1.factory).toBe('0x1715a3E4A142d8b698131108995174F37aEBA10D');
    expect(v1.router).not.toBe(v2.router);
    expect(v1.factory).not.toBe(v2.factory);
    expect(v1.kind).toBe('v2');
    expect(v1.feeBps).toBe(29);
  });
  it('9mm V2 (25 bps) and 9mm V3 (SmartRouter + QuoterV2, tiers 100/500/2500/10000/20000) match the official deployments repo', () => {
    expect(dex('9mm-v2')).toMatchObject({ router: '0xcC73b59F8D7b7c532703bDfea2808a28a488cF47', factory: '0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b', feeBps: 25 });
    expect(dex('9mm-v3')).toMatchObject({
      kind: 'v3', factory: '0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68', router: '0xa9444246d80d6E3496C9242395213B4f22226a59',
      quoter: '0x500260dD7C27eCE20b89ea0808d05a13CF867279', feeTiers: [100, 500, 2500, 10000, 20000],
    });
    expect(dex('9mm-v3').feeTiers).not.toContain(3000);
  });
  it('every address is checksummed and every DEX cites a source', () => {
    for (const d of PULSECHAIN_EXTRA_DEXES) {
      for (const a of [d.router, d.factory, d.quoter].filter(Boolean) as string[]) expect(getAddress(a)).toBe(a);
      expect(d.source).toMatch(/^https:\/\/(github\.com\/9mm-exchange\/deployments|scan\.pulsechain\.com)/);
    }
  });
});

describe('Pool discovery + best-pool selection across PulseX V1 / V2 / 9mm', () => {
  it('discovers PLS/DAI on all four DEXes (both 9mm V3 tiers) with DEX names', async () => {
    const { hub, pools } = world();
    const c = await hub.poolOptions('DAI');
    const got = c.pools.map((p) => `${p.dex}:${p.feeTier ?? p.feeBps}`).sort();
    expect(got).toEqual(['9mm-v2:25', '9mm-v3:10000', '9mm-v3:2500', 'pulsex-v1:29', 'pulsex-v2:29'].sort());
    expect(c.pools.find((p) => p.dex === 'pulsex-v1')!.dexName).toBe('PulseX V1');
    expect(c.best!.address).toBe(pools.v1); // deepest → best output for ≈$250
    expect(c.mode).toBe('default');
    expect(c.current.dex).toBe('pulsex-v2'); // legacy default unchanged until the user switches
  });

  it('ranking = best output at the reference size; a deeper 9mm V3 pool wins over PulseX', async () => {
    const { hub, pools } = world({ v3Deep: true });
    const c = await hub.poolOptions('DAI');
    expect(c.best!.address).toBe(pools.mm3);
    const outs = c.pools.filter((p) => p.refOut != null).map((p) => p.refOut!);
    expect(outs).toEqual([...outs].sort((a, b) => b - a));
  });

  it('auto → PulseX V1; quotes and swaps then go through the V1 router', async () => {
    const { hub, m, pools } = world();
    const { def } = await hub.setPool('DAI', { auto: true });
    expect(def.pool).toMatchObject({ dex: 'pulsex-v1', kind: 'v2', address: pools.v1, feeBps: 29 });
    expect(def.poolMode).toBe('auto');
    const q = hub.quoter('DAI');
    m.calls = [];
    const price = await q.getPrice();
    expect(price).toBeGreaterThan(0.0000295);
    expect(price).toBeLessThan(0.00003);
    expect(m.calls).toContain(dex('pulsex-v1').router.toLowerCase());
    expect(m.calls).not.toContain(dex('pulsex-v2').router.toLowerCase());
    const buy = await q.quote('buy', 5, DEFAULT_LIMITS, ME, 0n);
    expect(buy.call.to).toBe(dex('pulsex-v1').router);
    expect(buy.spender).toBe(dex('pulsex-v1').router);
    expect(buy.call.method).toBe('swapExactTokensForETH');
  });

  it('manual override to 9mm V3 builds a SmartRouter multicall; reset returns to PulseX V2', async () => {
    const { hub, pools } = world();
    const q = hub.quoter('DAI'); // same Quoter object must follow the switch
    const { def } = await hub.setPool('DAI', { pool: pools.mm3 });
    expect(def.pool).toMatchObject({ dex: '9mm-v3', kind: 'v3', feeTier: 2500, feeBps: 25 });
    expect(def.poolMode).toBe('manual');
    const sell = await q.quote('sell', 100_000, DEFAULT_LIMITS, ME, null);
    expect(sell.call.to).toBe(dex('9mm-v3').router);
    expect(sell.call.method).toBe('multicall');
    expect(sell.call.value).toBe(10n ** 23n);
    const buy = await q.quote('buy', 5, DEFAULT_LIMITS, ME, 0n);
    expect(buy.spender).toBe(dex('9mm-v3').router);
    // candles stay on the original PulseX V2 pair (no mixed series)
    expect(hub.candleSource('DAI')).toMatchObject({ pool: DAIq.pool, kind: 'v2' });
    await hub.setPool('DAI', { reset: true });
    expect(hub.def('DAI').pool).toMatchObject({ dex: 'pulsex-v2', kind: 'v2' });
    expect(hub.def('DAI').poolMode).toBe('default');
  });

  it('rejects pools that are not this pair, and unquotable pools', async () => {
    const { hub, pools } = world();
    await expect(hub.setPool('DAI', { pool: pools.memeV1 })).rejects.toThrow(/not a PLS\/DAI pool/);
    await expect(hub.setPool('DAI', { pool: '0x000000000000000000000000000000000000dEaD' })).rejects.toThrow(/not a PLS\/DAI pool/);
  });

  it('the override persists in data/custom.json and is restored on restart', async () => {
    const { hub, store, mk, pools } = world();
    await hub.setPool('DAI', { pool: pools.mm3 });
    expect(store.load()!.pools!.DAI.pool.dex).toBe('9mm-v3');
    const again = mk(store);
    expect(again.def('DAI').pool).toMatchObject({ dex: '9mm-v3', address: pools.mm3, feeTier: 2500 });
    expect(again.def('DAI').poolMode).toBe('manual');
    expect(again.candleSource('DAI').kind).toBe('v2');
    // other legacy markets untouched
    expect(again.def('USDC').pool.dex).toBe('pulsex-v2');
  });

  it('custom token discovery searches PulseX V1 and 9mm V3 too and defaults to the deepest pool', async () => {
    const { hub, pools } = world();
    const r = await hub.inspect({ chainId: 369, address: MEME.address, quote: WPLS.address });
    expect(r.pools.map((p) => p.dex).sort()).toEqual(['9mm-v3', 'pulsex-v1']);
    expect(r.chosen!.address).toBe(pools.meme9); // 1e7 MEME / 4e8 WPLS beats 5e6 / 2e8
    const manual = await hub.inspect({ chainId: 369, address: MEME.address, quote: WPLS.address, pool: pools.memeV1 });
    expect(manual.chosen!.dex).toBe('pulsex-v1');
    expect(manual.draft!.pool).toMatchObject({ dex: 'pulsex-v1', kind: 'v2', feeBps: 29 });
  });
});

describe('DEX/version on fills, grids and pool switches (MultiBot)', () => {
  const P0 = 0.00001;
  const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 };

  it('every fill records dex + fee; grid status carries dexName', async () => {
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.dexName).toBe('PulseX V2');
    expect(g.trades.length).toBeGreaterThan(0);
    for (const t of g.trades) expect(t).toMatchObject({ dex: 'pulsex-v2', feeBps: 29 });
    expect(bot.marketList().find((m) => m.key === 'DAI')).toMatchObject({ dexName: 'PulseX V2', poolMode: 'default', poolChoices: 4 });
  });

  it('setMarketPool switches, logs the change, and is refused while a tx is in flight', async () => {
    const { m, pools } = world();
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: legacyMarkets(NET), legacyNet: NET });
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
    const d = await bot.setMarketPool('DAI', { pool: pools.v1 });
    expect(d.pool.dex).toBe('pulsex-v1');
    expect(bot.activity.recent(5, 0).some((e) => /PulseX V2 0\.29% → PulseX V1 0\.29% \(manual\)/.test(e.msg))).toBe(true);
    // simulate an in-flight tx on a DAI grid
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.000027, upperPrice: 0.000033, gridCount: 10, totalCapitalUsd: 30 });
    const st = (bot as unknown as { engines: Map<string, { state: { inFlight: unknown } }> }).engines.get(id)!.state;
    st.inFlight = { nonce: 0, hash: '0x1' };
    await expect(bot.setMarketPool('DAI', { auto: true })).rejects.toThrow(/in flight/);
    st.inFlight = null;
    await bot.setMarketPool('DAI', { pool: pools.mm3 });
    expect(bot.status().grids.find((g) => g.id === id)).toMatchObject({ dex: '9mm-v3', dexName: '9mm V3', feeTier: 2500 });
  });
});
