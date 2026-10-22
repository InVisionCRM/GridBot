/**
 * Pair search (DexScreener) → pools on the app's DEXes, oriented like markets; picking one adds a market on exactly that
 * pool once its coin passes the safety check.
 */
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { PROBE_IFACE } from '../src/server/dex/safety';
import { PoolSearch } from '../src/server/market/poolSearch';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain } from './helpers/mockChain';

const NET = NETWORKS.mainnet;
const CH = chainFromNetwork(NET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
const MEME: Tok = { address: '0x00000000000000000000000000000000000b0b01', symbol: 'MEME', decimals: 9, name: 'Meme' };
const OTHER = '0x00000000000000000000000000000000000c0c01';

/** The safety probe's answer: stage 0 = buy, transfer and sell all went through at the quoted amounts; 4 = the sell reverts. */
const probeAnswer = (stage: number) => PROBE_IFACE.encodeFunctionResult('probe', [[10n ** 18n, 1000n, 1000n, 1000n, 1000n, 1000n, 900n, stage === 0 ? 900n : 0n, stage, '0x', 120_000n, 130_000n]]);

function world(probeStage = 0) {
  const m = new MultiDexMock();
  [WPLS, DAI, MEME].forEach((t) => m.addToken(t));
  for (const id of ['pulsex-v1', 'pulsex-v2']) m.addV2(id, { router: dex(id).router, factory: dex(id).factory, feeBps: dex(id).feeBps!, wrapped: WPLS.address });
  m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
  const pools = {
    v1: m.v2Pair('pulsex-v1', WPLS, 1e9, DAI, 30_000),
    memeV1: m.v2Pair('pulsex-v1', MEME, 5e6, WPLS, 2e8),
    meme9: m.v3Pool('9mm-v3', MEME, 1e7, WPLS, 4e8, 2500),
  };
  (m as unknown as { send: (method: string, params: unknown[]) => Promise<unknown> }).send = async () => probeAnswer(probeStage);
  const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: legacyMarkets(NET), legacyNet: NET });
  return { m, pools, hub };
}

const coin = (t: Tok) => ({ address: t.address, symbol: t.symbol, name: t.name ?? t.symbol });
/** A coin as the search returns it, for coins named as the app names them and copying no other coin's name */
const asFound = (t: Tok) => ({ ...coin(t), lookalike: null });
/** WPLS as markets name it: they trade it as the chain's own coin */
const asPls = { ...asFound(WPLS), symbol: 'PLS' };
const pair = (o: { chain?: string; dexId: string; label?: string; pool: string; base: { address: string; symbol: string; name: string }; quote: { address: string; symbol: string; name: string }; liq: number }) => ({
  chainId: o.chain ?? 'pulsechain', dexId: o.dexId, ...(o.label ? { labels: [o.label] } : {}), pairAddress: o.pool,
  baseToken: o.base, quoteToken: o.quote, liquidity: { usd: o.liq }, volume: { h24: o.liq / 2 },
});

/** DexScreener's two answers for "MEME", in their real shape (labels as DexScreener writes them: '9mm' 'V3', 'pulsex' 'v1'). */
function screener(pools: ReturnType<typeof world>['pools']) {
  const answers: Record<string, unknown> = {
    'https://api.dexscreener.com/latest/dex/search?q=MEME': {
      pairs: [
        pair({ dexId: '9mm', label: 'V3', pool: pools.meme9, base: coin(MEME), quote: coin(WPLS), liq: 50_000 }),
        pair({ chain: 'ethereum', dexId: 'uniswap', label: 'v2', pool: '0x00000000000000000000000000000000000e7e01', base: coin(MEME), quote: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether' }, liq: 90_000 }),
        pair({ dexId: 'liberty-swap', pool: '0x00000000000000000000000000000000000d0d01', base: coin(MEME), quote: coin(WPLS), liq: 80_000 }),
      ],
    },
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${MEME.address}`]: [
      pair({ dexId: '9mm', label: 'V3', pool: pools.meme9, base: coin(MEME), quote: coin(WPLS), liq: 50_000 }),
      pair({ dexId: 'pulsex', label: 'v1', pool: pools.memeV1, base: coin(WPLS), quote: coin(MEME), liq: 20_000 }),
      pair({ dexId: 'pulsex', label: 'v2', pool: '0x00000000000000000000000000000000000f0f01', base: coin(MEME), quote: { address: OTHER, symbol: 'OTH', name: 'Other' }, liq: 70_000 }),
    ],
    'https://api.dexscreener.com/latest/dex/search?q=DAI': {
      pairs: [pair({ dexId: 'pulsex', label: 'v1', pool: pools.v1, base: coin(WPLS), quote: coin(DAI), liq: 900_000 })],
    },
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${DAI.address}`]: [],
  };
  const urls: string[] = [];
  const fetchJson = async (u: string) => {
    urls.push(u);
    if (!(u in answers)) throw new Error(`unexpected ${u}`);
    return answers[u];
  };
  return { urls, fetchJson };
}

describe('PoolSearch: DexScreener pools on the app\'s DEXes', () => {
  it('a coin\'s pools on this chain, deepest first, oriented like markets, V3 fee tier read on-chain', async () => {
    const { pools, hub } = world();
    const { urls, fetchJson } = screener(pools);
    const found = await new PoolSearch(hub, fetchJson).search('MEME', [369]);
    expect(urls).toEqual(['https://api.dexscreener.com/latest/dex/search?q=MEME', `https://api.dexscreener.com/token-pairs/v1/pulsechain/${MEME.address}`]);
    // Ethereum (not asked), liberty-swap (a DEX the app doesn't trade) and MEME/OTH (no coin that can be a quote) are left out
    expect(found).toEqual([
      { chainId: 369, dex: '9mm-v3', dexName: '9mm V3', kind: 'v3', pool: pools.meme9, base: asFound(MEME), quote: asPls, feeTier: 2500, feeBps: null, liquidityUsd: 50_000, volume24hUsd: 25_000, market: null, lpOk: true },
      // DexScreener had WPLS as the base: the market's way round is MEME/WPLS
      { chainId: 369, dex: 'pulsex-v1', dexName: 'PulseX V1', kind: 'v2', pool: pools.memeV1, base: asFound(MEME), quote: asPls, feeTier: null, feeBps: 29, liquidityUsd: 20_000, volume24hUsd: 10_000, market: null, lpOk: false },
    ]);
  });

  it('a pool a market already trades on carries its key (built-in V2 markets matched by DEX and coin pair)', async () => {
    const { pools, hub } = world();
    const { fetchJson } = screener(pools);
    const [p] = await new PoolSearch(hub, fetchJson).search('DAI', [369]);
    expect(p).toMatchObject({ dex: 'pulsex-v1', base: asFound(DAI), quote: asPls, market: 'DAI' });
    const added = await hub.addMarket({ chainId: 369, address: MEME.address, quote: WPLS.address, pool: pools.meme9 });
    const again = await new PoolSearch(hub, fetchJson).search('MEME', [369]);
    // MEME is now a coin of the app's markets, so the MEME/OTH pool can be quoted in it (OTH/MEME), as in Add custom token
    expect(again.map((x) => [x.base.symbol, x.quote.symbol, x.market])).toEqual([['OTH', 'MEME', null], ['MEME', 'PLS', added.key], ['MEME', 'PLS', null]]);
  });

  it('asks DexScreener once a minute per query; a 429 waits 1 s, then 2 s, then gives up', async () => {
    const { pools, hub } = world();
    const s = screener(pools);
    let t = 1_800_000_000_000, fail = 1;
    const waits: number[] = [];
    const fetchJson = async (u: string) => { if (fail-- > 0) throw new Error('HTTP 429 from api.dexscreener.com'); return s.fetchJson(u); };
    const ps = new PoolSearch(hub, fetchJson, { now: () => t, sleep: async (ms) => { waits.push(ms); } });
    await ps.search('MEME', [369]);
    expect(waits).toEqual([1000]);
    expect(s.urls).toHaveLength(2);
    await ps.search('MEME', [369]);
    expect(s.urls).toHaveLength(2);
    t += 60_001;
    fail = 3;
    await expect(ps.search('MEME', [369])).rejects.toThrow('HTTP 429');
    expect(waits).toEqual([1000, 1000, 2000]);
  });

  it('refuses one letter, and a chain DexScreener isn\'t asked about', async () => {
    const { pools, hub } = world();
    const ps = new PoolSearch(hub, screener(pools).fetchJson);
    await expect(ps.search(' M ', [369])).rejects.toThrow(/at least 2 letters/);
    const testnet = new Hub({ runtimes: [new ChainRuntime(chainFromNetwork(NETWORKS.testnet), new MultiDexMock(), null)], markets: [], legacyNet: NETWORKS.testnet });
    await expect(new PoolSearch(testnet, screener(pools).fetchJson).search('MEME', [NETWORKS.testnet.chainId])).rejects.toThrow(/covers PulseChain/);
  });
});

describe('PoolSearch: coins the app knows keep their names; a copy of a known name is flagged', () => {
  const HEX = NET.quotes.find((q) => q.symbol === 'HEX')!, EHEX = NET.quotes.find((q) => q.symbol === 'eHEX')!;
  const FAKE = '0x55C50875e890c7eE5621480baB02511C380E12C6'; // a real "HEX" copy on PulseX V2, seen 2026-10-22
  const FAKE_W = '0x00000000000000000000000000000000000a1a01';
  const P = { fakeW: '0x00000000000000000000000000000000000a1a02', real: '0x19BB45a7270177e303DEe6eAA6F5Ad700812bA98', fake: '0x9b82FeE4e54011fe7e5352317d6C7fDc5d2c1ACe', bridged: '0xF0eA3efE42C11c8819948Ec2D3179F4084863D3F' };
  const answers: Record<string, unknown> = {
    'https://api.dexscreener.com/latest/dex/search?q=HEX': {
      pairs: [
        pair({ dexId: 'pulsex', label: 'v2', pool: P.real, base: { address: HEX.address, symbol: 'HEX', name: 'HEX' }, quote: coin(WPLS), liq: 400_000 }),
        // DexScreener calls bridged HEX "HEX" too (its symbol() on-chain)
        pair({ dexId: 'pulsex', label: 'v2', pool: P.bridged, base: { address: EHEX.address, symbol: 'HEX', name: 'HEX' }, quote: coin(WPLS), liq: 50_000 }),
        pair({ dexId: 'pulsex', label: 'v2', pool: P.fake, base: { address: FAKE, symbol: 'HEX', name: 'HEX' }, quote: coin(WPLS), liq: 11_000 }),
      ],
    },
    // a coin calling itself WPLS: the wrapped coin's name, though markets show that one as PLS
    'https://api.dexscreener.com/latest/dex/search?q=WPLS': {
      pairs: [pair({ dexId: 'pulsex', label: 'v2', pool: P.fakeW, base: { address: FAKE_W, symbol: 'WPLS', name: 'Wrapped Pulse' }, quote: coin(DAI), liq: 5_000 })],
    },
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${HEX.address}`]: [],
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${EHEX.address}`]: [],
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${FAKE}`]: [],
    [`https://api.dexscreener.com/token-pairs/v1/pulsechain/${FAKE_W}`]: [],
  };
  it('each coin with its address; eHEX by its app name; the copy says whose name it uses', async () => {
    const { hub } = world();
    const found = await new PoolSearch(hub, async (u) => answers[u]).search('HEX', [369]);
    expect(found.map((p) => [p.pool, p.base.symbol, p.base.address, p.base.lookalike, p.market])).toEqual([
      [P.real, 'HEX', HEX.address, null, 'HEX'],
      [P.bridged, 'eHEX', EHEX.address, null, 'eHEX'],
      [P.fake, 'HEX', FAKE, 'HEX', null],
    ]);
    expect(found.every((p) => p.quote.symbol === 'PLS' && p.quote.lookalike === null)).toBe(true);
    const [w] = await new PoolSearch(hub, async (u) => answers[u]).search('WPLS', [369]);
    expect(w).toMatchObject({ pool: P.fakeW, base: { symbol: 'WPLS', address: FAKE_W, lookalike: 'WPLS' }, quote: { symbol: 'DAI' } });
  });
});

describe('Picking a found pool: a market on exactly that pool, once it passes the safety check', () => {
  const bot = (hub: Hub) => new MultiBot({ net: NET, reader: new MockChain(0.00003), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });

  it('added on the pool picked (not the deepest), a second pick returns the same market', async () => {
    const { pools, hub } = world(0);
    const b = bot(hub);
    const key = await b.addPoolMarket({ chainId: 369, pool: pools.memeV1, base: MEME.address, quote: WPLS.address });
    expect(hub.def(key)).toMatchObject({ custom: true, pool: { dex: 'pulsex-v1', address: pools.memeV1 }, safety: { liveAllowed: true } });
    expect(await b.addPoolMarket({ chainId: 369, pool: pools.memeV1, base: MEME.address, quote: WPLS.address })).toBe(key);
    expect(hub.byChain(369).filter((d) => d.custom)).toHaveLength(1);
  });

  it('a coin that fails it (a honeypot: the sell reverts) is not added, and says why', async () => {
    const { pools, hub } = world(4);
    await expect(bot(hub).addPoolMarket({ chainId: 369, pool: pools.meme9, base: MEME.address, quote: WPLS.address }))
      .rejects.toThrow(/^Not added: MEME failed the safety check \(blocked risk\)\. .*SELL reverts/);
    expect(hub.byChain(369).filter((d) => d.custom)).toHaveLength(0);
  });
});
