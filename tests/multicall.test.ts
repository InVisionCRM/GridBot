/**
 * Multicall3 read batching: reads started together go out as one aggregate3 eth_call, with the same answers (and the
 * same errors) as direct reads; a chain without Multicall3, or a batch that fails, reads direct. Measured: RPC
 * requests per poll before and after.
 */
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { CHAINS, chainByKey } from '../src/live/chains';
import { defaultMarkets, legacyMarkets, type MarketDef } from '../src/live/markets';
import { ERC20, PAIR, V3_POOL } from '../src/server/dex/abis';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, type CustomFile } from '../src/server/chains/hub';
import { withMulticall, type MulticallReader } from '../src/server/chains/multicall';
import type { RuntimeReader } from '../src/server/chains/runtime';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain } from './helpers/mockChain';
import { mc3Node } from './helpers/mc3Node';

const NET = NETWORKS.mainnet;
const ETH = chainByKey('ethereum')!;
const uni = ETH.dexes.find((d) => d.id === 'uniswap-v3')!;
const WETH: Tok = { address: ETH.wrappedNative.address, symbol: 'WETH', decimals: 18 };
const USDCs = ETH.stables.find((s) => s.symbol === 'USDC')!;
const USDC: Tok = { address: USDCs.address, symbol: 'USDC', decimals: 6 };
const ETH_DEF = defaultMarkets().find((m) => m.chainId === 1)!;
const ME = '0x1234567890123456789012345678901234567890';
const flush = () => new Promise((r) => setTimeout(r, 5));

function world(o: { batch: boolean; deployed?: boolean; failAggregate?: () => boolean; n?: number }) {
  let t = 1_800_000_000_000;
  const eth = new MultiDexMock();
  [WETH, USDC].forEach((x) => eth.addToken(x));
  eth.addV3('uniswap-v3', { factory: uni.factory, quoter: uni.quoter! });
  eth.v3Pool('uniswap-v3', WETH, 5_000, USDC, 15_000_000, 500, ETH_DEF.pool.address);
  const defs: MarketDef[] = [];
  for (let i = 0; i < (o.n ?? 5); i++) {
    const tok: Tok = { address: `0x00000000000000000000000000000000000c0d${(i + 16).toString(16)}`, symbol: `T${i}`, decimals: 18 };
    eth.addToken(tok);
    const pool = eth.v3Pool('uniswap-v3', tok, 1e6, WETH, 100 + i * 10, 3000);
    defs.push({ key: `ethereum:T${i}/ETH`, chainId: 1, base: { address: tok.address, symbol: tok.symbol, decimals: 18 }, quote: { address: WETH.address, symbol: 'ETH', decimals: 18, native: true },
      pool: { dex: 'uniswap-v3', kind: 'v3', address: pool, feeBps: 30, feeTier: 3000 }, probe: 1, quoteKind: 'wrapped', candlePool: pool });
  }
  eth.native = 10n ** 20n;
  eth.gasPrice = 10n ** 7n;
  for (const x of [WETH, USDC]) eth.wallet.set(`${ME.toLowerCase()}:${x.address.toLowerCase()}`, 10n ** 20n);
  const node = mc3Node(eth, { deployed: o.deployed, failAggregate: o.failAggregate });
  const trusted = new Set([WETH.address, USDC.address, ...defs.map((d) => d.base.address)].map((a) => a.toLowerCase()));
  const offs: string[] = [];
  const reader: RuntimeReader = o.batch ? withMulticall(node, { trusted, onOff: (w) => offs.push(w) }) : node;
  const mc = (reader as MulticallReader<RuntimeReader>).multicall;
  const noSend = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('test: must not send'); } };
  const pls = new MockChain(0.00001);
  const hub = new Hub({ runtimes: [new ChainRuntime(CHAINS[0], pls, null), new ChainRuntime(ETH, reader, noSend)], markets: [...legacyMarkets(NET), ETH_DEF, ...defs], legacyNet: NET, custom: new MemoryStore<CustomFile>(), now: () => t });
  const bot = new MultiBot({ net: NET, reader: pls, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub, now: () => t });
  return { eth, node, reader, mc, hub, bot, defs, offs, later: (ms: number) => { t += ms; } };
}

describe('withMulticall: same answers as direct reads', () => {
  it('reads started together go out as one aggregate3; results equal direct reads', async () => {
    const d = world({ batch: false }), b = world({ batch: true });
    const reads = (w: typeof d) => Promise.all([
      ...w.defs.map((m) => w.reader.call({ to: m.pool.address!, data: V3_POOL.encodeFunctionData('slot0') })),
      w.reader.call({ to: WETH.address, data: ERC20.encodeFunctionData('balanceOf', [ME]) }),
      w.reader.getBalance(ME).then(String),
    ]);
    const want = await reads(d);
    const before = b.node.counts.requests;
    expect(await reads(b)).toEqual(want);
    // 1 code check + 1 aggregate3 for 7 reads
    expect(b.node.counts.requests - before).toBe(2);
    expect(b.mc).toMatchObject({ state: 'on', batched: 7 });
    const again = b.node.counts.requests;
    expect(await reads(b)).toEqual(want);
    expect(b.node.counts.requests - again).toBe(1);
  });

  it('a call that fails inside the batch is re-run alone and fails exactly as a direct call does', async () => {
    const d = world({ batch: false }), b = world({ batch: true });
    const bad = { to: '0x000000000000000000000000000000000000beef', data: PAIR.encodeFunctionData('getReserves') };
    const direct = await d.reader.call(bad).then(() => 'ok', (e: Error) => e.message);
    const [r, ok] = await Promise.allSettled([b.reader.call(bad), b.reader.call({ to: b.defs[0].pool.address!, data: V3_POOL.encodeFunctionData('liquidity') })]);
    expect(r.status === 'rejected' ? (r.reason as Error).message : 'ok').toBe(direct);
    expect(ok.status).toBe('fulfilled');
    expect(b.mc.direct).toBe(1);
  });

  it('not batched: calls with from, unknown selectors, balanceOf on a token outside the trusted list', async () => {
    const b = world({ batch: true });
    const custom = '0x00000000000000000000000000000000000ba5e1';
    await Promise.all([
      b.reader.call({ to: b.defs[0].pool.address!, data: V3_POOL.encodeFunctionData('slot0'), from: ME }),
      b.reader.call({ to: WETH.address, data: ERC20.encodeFunctionData('symbol') }),
      b.reader.call({ to: custom, data: ERC20.encodeFunctionData('balanceOf', [ME]) }).catch(() => null),
    ]);
    expect(b.mc).toMatchObject({ batched: 0, direct: 3 });
    expect(b.node.counts.byMethod.eth_getCode ?? 0).toBe(0);
  });

  it('no Multicall3 on the chain: reads direct for good, said once', async () => {
    const d = world({ batch: false }), b = world({ batch: true, deployed: false });
    const keys = b.defs.map((m) => m.key);
    expect(await b.bot.prices(keys)).toEqual(await d.bot.prices(keys));
    expect(b.mc.state).toBe('off');
    expect(b.offs).toEqual(['no Multicall3 contract on this chain']);
    const n = b.node.counts.requests, m = d.node.counts.requests;
    await b.bot.prices(keys);
    await d.bot.prices(keys);
    expect(b.node.counts.requests - n).toBe(d.node.counts.requests - m); // exactly the direct reads, no code check again
    expect(b.mc.batched).toBe(0);
  });

  it('a batch that fails as a whole runs its calls direct (same prices); 3 in a row re-check the contract', async () => {
    let fail = true;
    const d = world({ batch: false }), b = world({ batch: true, failAggregate: () => fail });
    const keys = b.defs.map((m) => m.key);
    const want = await d.bot.prices(keys);
    expect(await b.bot.prices(keys)).toEqual(want);
    expect(b.mc.fallbacks).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await b.bot.prices(keys);
    const codeChecks = b.node.counts.byMethod.eth_getCode;
    expect(codeChecks).toBeGreaterThan(1);
    fail = false;
    expect(await b.bot.prices(keys)).toEqual(want);
    expect(b.mc.state).toBe('on');
  });
});

describe('RPC requests per poll, before and after', () => {
  it('prices for 6 V3 markets, and a full poll with 3 paper grids: fewer requests, identical prices and grid state', async () => {
    const d = world({ batch: false }), b = world({ batch: true });
    const keys = [ETH_DEF.key, ...d.defs.map((m) => m.key)];
    const p0 = await d.bot.prices(keys);
    await b.bot.prices(keys); // warm-up: decimals, pool lookups, the code check
    const n0 = d.node.counts.requests, m0 = b.node.counts.requests;
    expect(await d.bot.prices(keys)).toEqual(p0);
    expect(await b.bot.prices(keys)).toEqual(p0);
    const pricesBefore = d.node.counts.requests - n0, pricesAfter = b.node.counts.requests - m0;

    const grids = async (w: typeof d) => {
      const ids: string[] = [];
      for (const m of w.defs.slice(0, 3)) {
        const spot = await w.bot.hub.quoter(m.key).getPrice();
        ids.push(await w.bot.add({ mode: 'paper', stable: m.key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 0.05 }));
      }
      return ids;
    };
    const di = await grids(d), bi = await grids(b);
    const poll = async (w: typeof d) => { const n = w.node.counts.requests; await w.bot.tickAll(); await flush(); return w.node.counts.requests - n; };
    await poll(d); await poll(b);
    const tickBefore: number[] = [], tickAfter: number[] = [];
    for (let i = 0; i < 4; i++) {
      // the same price move in both worlds: a grid trades
      for (const w of [d, b]) { for (const m of w.defs.slice(0, 3)) w.eth.movePrice(m.pool.address!, i % 2 ? 1.08 : 0.92); w.later(15_000); }
      tickBefore.push(await poll(d));
      tickAfter.push(await poll(b));
    }
    const strip = (w: typeof d, ids: string[]) => w.bot.status().grids.filter((g) => ids.includes(g.id)).map((g) => ({ trades: (g.trades ?? []).map(({ id: _id, txHash: _h, ...t }: { id: string; txHash: string }) => t), pnl: g.pnl, price: g.price, stats: g.stats, queue: g.queue }));
    expect(strip(b, bi)).toEqual(strip(d, di));
    expect(b.bot.spots).toEqual(d.bot.spots);
    expect(strip(d, di).some((g) => (g.trades?.length ?? 0) > 0)).toBe(true);
    console.info(`RPC requests — prices(6 markets): ${pricesBefore} → ${pricesAfter}; poll with 3 paper grids: [${tickBefore}] → [${tickAfter}]; by method after: ${JSON.stringify(b.node.counts.byMethod)} before: ${JSON.stringify(d.node.counts.byMethod)}`);
    expect(pricesAfter).toBeLessThan(pricesBefore / 3);
    expect(tickAfter.reduce((a, x) => a + x, 0)).toBeLessThan(tickBefore.reduce((a, x) => a + x, 0) / 2);
  });
});
