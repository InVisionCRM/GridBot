/** Multi-chain: registry, RPC overrides, V2/V3 adapters, safety classifier + FOT policy, per-chain signers/queues/stop. */
import { describe, expect, it } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import { NETWORKS } from '../src/live/networks';
import { CHAINS, chainByKey, LEGACY_CHAIN_ID } from '../src/live/chains';
import { defaultMarkets, legacyMarkets, type MarketDef } from '../src/live/markets';
import { getAmountOut, NATIVE } from '../src/live/swapMath';
import { ADDRESS_THIS } from '../src/live/v3Math';
import { analyzeEconomics } from '../src/live/economics';
import { V3_ROUTER } from '../src/server/dex/abis';
import { V2Adapter } from '../src/server/dex/v2';
import { V3Adapter } from '../src/server/dex/v3';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { rpcUrlsFor } from '../src/server/chains/build';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub, type CustomFile } from '../src/server/chains/hub';
import { createSigners } from '../src/server/env';
import { MemoryStore } from '../src/server/bot/store';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain } from './helpers/mockChain';

const NET = NETWORKS.mainnet;
const ETH = chainByKey('ethereum')!;
const PLS = chainByKey('pulsechain')!;
const uni = ETH.dexes.find((d) => d.id === 'uniswap-v3')!;
const WETH: Tok = { address: ETH.wrappedNative.address, symbol: 'WETH', decimals: 18 };
const USDCs = ETH.stables.find((s) => s.symbol === 'USDC')!;
const USDC: Tok = { address: USDCs.address, symbol: 'USDC', decimals: 6 };
const ETH_DEF = defaultMarkets().find((m) => m.chainId === 1)!;
const ME = '0x1234567890123456789012345678901234567890';

function ethWorld() {
  const m = new MultiDexMock();
  [WETH, USDC].forEach((t) => m.addToken(t));
  m.addV3('uniswap-v3', { factory: uni.factory, quoter: uni.quoter! });
  m.v3Pool('uniswap-v3', WETH, 5_000, USDC, 15_000_000, 500, ETH_DEF.pool.address); // ETH ≈ $3000
  return m;
}

describe('Chain registry', () => {
  it('ids, keys and env slugs are unique; addresses checksummed; sources cited', () => {
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map((c) => c.key)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map((c) => c.envSlug)).size).toBe(CHAINS.length);
    for (const c of CHAINS) {
      expect(c.sources.length, c.key).toBeGreaterThan(0);
      expect(getAddress(c.wrappedNative.address)).toBe(c.wrappedNative.address);
      for (const s of c.stables) expect(getAddress(s.address)).toBe(s.address);
      for (const d of c.dexes) {
        expect(d.source, `${c.key}/${d.id}`).toMatch(/^https:\/\//);
        for (const a of [d.router, d.factory, d.quoter].filter(Boolean) as string[]) expect(getAddress(a)).toBe(a);
        if (d.kind === 'v3') { expect(d.quoter).toBeTruthy(); expect(d.feeTiers!.length).toBeGreaterThan(0); }
        else expect(d.feeBps).toBeGreaterThan(0);
      }
    }
    expect(CHAINS[0].id).toBe(LEGACY_CHAIN_ID);
  });
  it('covers exactly PulseChain, Robinhood Chain and Ethereum', () => {
    expect(CHAINS.map((c) => c.key)).toEqual(['pulsechain', 'robinhood', 'ethereum']);
    expect(defaultMarkets().map((m) => m.chainId).sort()).toEqual([1, 4663]);
  });
  it('a chain with trading disabled is not tradable', () => {
    const off = { ...ETH, trading: { enabled: false, reason: 'test: no DEX' }, dexes: [] };
    expect(new ChainRuntime(off, new MultiDexMock(), null).tradable).toBe(false);
  });
  it('RPC_URL_<SLUG> overrides come first, then the built-in fallbacks (deduped)', () => {
    const urls = rpcUrlsFor(ETH, { RPC_URL_ETHEREUM: 'https://my-eth.example, https://second.example', RPC_URL: 'https://ignored.example' });
    expect(urls.slice(0, 2)).toEqual(['https://my-eth.example', 'https://second.example']);
    expect(urls).not.toContain('https://ignored.example');
    expect(urls.slice(2)).toEqual(ETH.rpcs);
    expect(rpcUrlsFor(CHAINS[0], { RPC_URL: 'https://pls.example' })[0]).toBe('https://pls.example');
  });
});

describe('DEX adapters', () => {
  it('V2 uses the per-DEX fee (9mm V2 = 25 bps)', async () => {
    const nine = PLS.dexes.find((d) => d.id === '9mm-v2')!;
    const m = new MultiDexMock();
    const dai = PLS.stables.find((x) => x.symbol === 'DAI')!;
    const W: Tok = { address: PLS.wrappedNative.address, symbol: 'WPLS', decimals: 18 }, T: Tok = { address: dai.address, symbol: 'DAI', decimals: 18 };
    m.addV2('9mm-v2', { router: nine.router, factory: nine.factory, feeBps: 25, wrapped: W.address });
    m.v2Pair('9mm-v2', W, 1_000_000, T, 10);
    const ad = new V2Adapter(m, nine, W.address);
    const [pool] = await ad.findPools(W.address, T.address);
    expect(pool).toMatchObject({ dex: '9mm-v2', kind: 'v2', feeBps: 25 });
    const q = await ad.quote(pool, W.address, T.address, 10n ** 18n);
    const st = await ad.state(pool, W.address, T.address);
    const wIs0 = st.token0.toLowerCase() === W.address.toLowerCase();
    expect(q.amountOut).toBe(getAmountOut(10n ** 18n, wIs0 ? st.reserve0 : st.reserve1, wIs0 ? st.reserve1 : st.reserve0, 25));
  });

  it('V3 finds pools on every tier; QuoterV2 quotes; native-in/out swaps go through multicall', async () => {
    const m = ethWorld();
    m.v3Pool('uniswap-v3', WETH, 10, USDC, 30_000, 3000);
    const ad = new V3Adapter(m, uni, WETH.address);
    const pools = await ad.findPools(WETH.address, USDC.address);
    expect(pools.map((p) => p.feeTier).sort()).toEqual([3000, 500]);
    const p500 = pools.find((p) => p.feeTier === 500)!;
    expect(p500.feeBps).toBe(5);
    const q = await ad.quote(p500, WETH.address, USDC.address, 10n ** 18n);
    expect(Number(q.amountOut) / 1e6).toBeGreaterThan(2980);
    expect(Number(q.amountOut) / 1e6).toBeLessThan(3000);
    const buy = ad.buildSwap({ pool: p500, tokenIn: USDC.address, tokenOut: NATIVE, amountIn: 1000n, amountOutMin: 1n, recipient: ME, deadline: 99n });
    const [, inner] = buy.args as [bigint, string[]];
    expect(inner).toHaveLength(2);
    const single = V3_ROUTER.decodeFunctionData('exactInputSingle', inner[0])[0];
    expect(single.recipient).toBe(ADDRESS_THIS);
    expect(single.fee).toBe(500n);
    expect(V3_ROUTER.decodeFunctionData('unwrapWETH9', inner[1])[1]).toBe(ME);
    const sell = ad.buildSwap({ pool: p500, tokenIn: NATIVE, tokenOut: USDC.address, amountIn: 5n, amountOutMin: 1n, recipient: ME, deadline: 99n });
    expect(sell.value).toBe(5n);
    expect((sell.args as [bigint, string[]])[1]).toHaveLength(1);
  });
});

describe('Safety classifier + FOT policy (V2 support / V3 proven / cap / honeypot)', () => {
  const probe = (p: Partial<ProbeResult>): ProbeResult => ({
    stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 1000n, transferGot: 1000n, sellIn: 1000n,
    expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 120_000n, gasSell: 130_000n, ...p,
  });
  const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];
  it('clean token → low risk, live allowed', () => {
    const r = classify({ probe: probe({}), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' });
    expect(r).toMatchObject({ risk: 'low', liveAllowed: true, honeypot: false, taxMode: 'none' });
  });
  it('≤10% tax on V2 → live allowed (v2-fot), risk medium/high', () => {
    for (const [p, mode] of [[{ gotBuy: 950n }, 'v2-fot'], [{ transferGot: 990n }, 'v2-fot'], [{ gotSell: 850n }, 'v2-fot']] as const) {
      const r = classify({ probe: probe(p), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' });
      expect(r.liveAllowed).toBe(true);
      expect(r.taxMode).toBe(mode);
      expect(r.reasons.join(' ')).toMatch(/Fee-on-transfer|SupportingFeeOnTransferTokens/);
    }
  });
  it('tax on V3 that completed the probe → live allowed as v3-proven', () => {
    const r = classify({ probe: probe({ gotBuy: 950n, gotSell: 855n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3' });
    expect(r).toMatchObject({ liveAllowed: true, taxMode: 'v3-proven', risk: 'high' });
  });
  it('tax above the live cap → blocked', () => {
    const r = classify({ probe: probe({ gotBuy: 800n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2', maxTax: 0.10 });
    expect(r).toMatchObject({ liveAllowed: false, risk: 'blocked', taxMode: 'blocked' });
    expect(r.reasons.join(' ')).toMatch(/above the 10% live cap/);
  });
  it('sell revert = honeypot; failed buy reports no fake 100% tax', () => {
    expect(classify({ probe: probe({ stage: 4, gotSell: 0n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' })).toMatchObject({ risk: 'blocked', honeypot: true, liveAllowed: false });
    const b = classify({ probe: probe({ stage: 2, gotBuy: 0n, err: 'TRANSFER_FAILED' }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' });
    expect(b.buyTaxPct).toBeNull();
    expect(b.risk).toBe('blocked');
  });
  it('paused / blacklist / maxTx surface on the report; no simulation → unknown', () => {
    expect(classify({ probe: null, simError: 'override rejected', proxy: null, depth, liquidityUsd: 1e6 })).toMatchObject({ risk: 'unknown', liveAllowed: false });
    expect(classify({ probe: probe({}), proxy: { kind: 'EIP-1967' }, depth, liquidityUsd: 1e6 }).risk).toBe('medium');
    expect(classify({ probe: probe({}), proxy: null, depth, liquidityUsd: 5_000 }).risk).toBe('high');
    expect(classify({ probe: probe({}), proxy: null, depth: [{ usd: 100, buyImpactPct: 0.05, sellImpactPct: 0.01 }], liquidityUsd: 1e6 }).risk).toBe('high');
    const paused = classify({ probe: probe({}), proxy: null, depth, liquidityUsd: 1e6, flags: { maxTx: null, maxWallet: null, blacklist: null, paused: true, pausedBy: 'paused()' } });
    expect(paused).toMatchObject({ liveAllowed: false, risk: 'blocked' });
    const limits = classify({ probe: probe({}), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2', decimals: 18, flags: { maxTx: (10n ** 18n).toString(), maxWallet: (100n * 10n ** 18n).toString(), blacklist: 'isBlacklisted(address)', paused: null, pausedBy: null } });
    expect(limits.maxTxTokens).toBe(1);
    expect(limits.maxWalletTokens).toBe(100);
    expect(limits.blacklist).toBe('isBlacklisted(address)');
    expect(limits.liveAllowed).toBe(true);
    expect(limits.risk).toBe('medium');
  });
});

describe('Economics use the market fee', () => {
  it('a 5-bps V3 pool clears a grid a 100-bps pool cannot', () => {
    const i = { lowerPrice: 2700, upperPrice: 3300, gridCount: 12, capital: 2000, spot: 3000, pool: { quoteReserve: 15e6, plsReserve: 5000 }, gasPricePls: 1e-9 * 0.01, approval: 'max' as const, gasUnits: { approve: 50_000, swap: 150_000 } };
    expect(analyzeEconomics({ ...i, feeBps: 5 }).ok).toBe(true);
    expect(analyzeEconomics({ ...i, feeBps: 100 }).ok).toBe(false);
  });
});

describe('Multi-chain operation', () => {
  it('PRIVATE_KEY + PRIVATE_KEY_ETHEREUM: per-chain override, shared elsewhere, env scrubbed', () => {
    const a = Wallet.createRandom(), b = Wallet.createRandom();
    process.env.PRIVATE_KEY = a.privateKey;
    process.env.PRIVATE_KEY_ETHEREUM = b.privateKey;
    const s = createSigners([{ id: 369, envSlug: 'PULSECHAIN', provider: null as never }, { id: 1, envSlug: 'ETHEREUM', provider: null as never }]);
    expect(s.get(369)!.address).toBe(a.address);
    expect(s.get(1)!.address).toBe(b.address);
    expect(process.env.PRIVATE_KEY).toBeUndefined();
    expect(process.env.PRIVATE_KEY_ETHEREUM).toBeUndefined();
  });

  function twoChains(ethSigner = false) {
    const pls = new MockChain(0.00001);
    const eth = ethWorld();
    const noSend = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('test: must not send'); } };
    const rtP = new ChainRuntime(CHAINS[0], pls, null), rtE = new ChainRuntime(ETH, eth, ethSigner ? noSend : null);
    const hub = new Hub({ runtimes: [rtP, rtE], markets: [...legacyMarkets(NET), ETH_DEF], legacyNet: NET, custom: new MemoryStore<CustomFile>() });
    const bot = new MultiBot({ net: NET, reader: pls, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
    return { pls, eth, rtP, rtE, hub, bot };
  }

  it('legacy markets stay chain 369 with unchanged labels; each chain has its own tx gate + nonce queue', () => {
    const { hub, rtP, rtE } = twoChains();
    expect(hub.def('DAI').chainId).toBe(369);
    expect(hub.label('DAI')).toBe('PLS/DAI');
    expect(hub.label(ETH_DEF.key)).toBe('ETH/USDC·ETH');
    expect(rtP.gate).not.toBe(rtE.gate);
    expect(rtP.nonce).not.toBe(rtE.nonce);
  });

  it('an Ethereum paper grid prices through Uniswap V3; STOP Ethereum leaves PulseChain running', async () => {
    const { bot, hub, eth } = twoChains();
    eth.gasPrice = 10n ** 7n; // 0.01 gwei keeps the mock grid clear of the gas gate
    const px = await hub.quoter(ETH_DEF.key).getPrice();
    expect(px).toBeGreaterThan(2900);
    expect(px).toBeLessThan(3000);
    const pg = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.000009, upperPrice: 0.000011, gridCount: 10, totalCapitalUsd: 30 });
    const bg = await bot.add({ mode: 'paper', stable: ETH_DEF.key, lowerPrice: px * 0.95, upperPrice: px * 1.05, gridCount: 8, totalCapitalUsd: 400 });
    const st = bot.status();
    expect(st.grids.find((g) => g.id === bg)).toMatchObject({ chainId: 1, dex: 'uniswap-v3', dexName: 'Uniswap V3', feeTier: 500 });
    expect(bot.stopChain(1)).toBe(1);
    const after = bot.status().grids;
    expect(after.find((g) => g.id === bg)!.status).toBe('stopped');
    expect(after.find((g) => g.id === pg)!.status).toBe('running');
  });

  it('live trading on a custom market without a passing simulation is refused (paper allowed)', async () => {
    const { bot, eth } = twoChains(true);
    eth.gasPrice = 10n ** 7n;
    const MEME: Tok = { address: '0x00000000000000000000000000000000000b0b02', symbol: 'MEME', decimals: 18 };
    eth.addToken(MEME);
    eth.v3Pool('uniswap-v3', MEME, 1e6, WETH, 100, 3000);
    for (const t of [MEME, WETH]) eth.wallet.set(`${ME.toLowerCase()}:${t.address.toLowerCase()}`, 10n ** 24n);
    const d: MarketDef = await bot.addMarket({ chainId: 1, address: MEME.address, quote: WETH.address });
    expect(d.safety!.risk).toBe('unknown'); // mock reader has no eth_call state override
    expect(d.safety!.liveAllowed).toBe(false);
    const spot = await bot.hub.quoter(d.key).getPrice();
    const p = { stable: d.key, lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 0.01, allowTightSpacing: true };
    await expect(bot.add({ mode: 'live', ...p })).rejects.toThrow(/safety|paper only|blocked|simulation/i);
    await expect(bot.add({ mode: 'paper', ...p })).resolves.toBeTruthy();
  });
});
