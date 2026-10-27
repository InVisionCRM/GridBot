/**
 * Uniswap V4 on Robinhood Chain: hook flags, PoolKey id, Universal Router calldata, fee reading.
 * The fork against https://rpc.mainnet.chain.robinhood.com lives in v4Fork.test.ts.
 */
import { AbiCoder, getAddress, id } from 'ethers';
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/live/chains';
import { classify, hopFor } from '../src/server/dex/safety';
import type { ProbeResult } from '../src/server/dex/safety';
import { PERMIT2, V4_POOL_MANAGER, V4_QUOTER, V4_ROUTER, V4_STATE_VIEW } from '../src/server/dex/abis';
import { assessHook, decodeHookPermissions } from '../src/server/dex/v4Hooks';
import {
  DYNAMIC_FEE_FLAG, encodePermit2Approve, encodeUniversalRouterExecute, encodeV4ExactInputSingle,
  isDynamicFee, lpFeeBps, PERMIT2_MAX_TTL_SEC, permit2MaxExpiration, poolId, sortCurrencies, UINT160_MAX, V4_SWAP_ACTIONS, V4_SWAP_COMMAND,
} from '../src/server/dex/v4PoolKey';
import { V4Adapter, V4ScanError, V4_LOG_CHUNK, currencyPairs, v4PoolMatches } from '../src/server/dex/v4';
import { discoverPools } from '../src/server/dex/discovery';
import type { ChainRuntime } from '../src/server/chains/runtime';
import { TOPIC } from '../src/market/poolEvents';
import type { PoolRef } from '../src/live/markets';

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
/** Vanilla 1% ETH pool, hooks = 0. Pool id checked against PoolManager Initialize on chain 4663. */
const NATIVE_KEY = {
  currency0: ZERO,
  currency1: '0xc50C3c7a92E1b512Ec982770Abe91948F20356d0',
  fee: 10000,
  tickSpacing: 200,
  hooks: ZERO,
};
const NATIVE_POOL_ID = '0x892cfd4e384f62fc574cd1b46380b2f4028c887439b92329dfd7ca5fc706da99';
/** Doppler initializer. AFTER_SWAP_RETURNS_DELTA is set, so the empty allowlist rejects it. */
const DOPPLER = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';

const coder = AbiCoder.defaultAbiCoder();

describe('V4 hook flags', () => {
  it('address(0) is allowed and has no flags', () => {
    expect(decodeHookPermissions(ZERO).flags).toEqual([]);
    expect(assessHook(ZERO, []).allowed).toBe(true);
  });

  it('decodes the documented 0x2400 example as beforeInitialize + afterAddLiquidity', () => {
    const hooks = '0x0000000000000000000000000000000000002400';
    expect(decodeHookPermissions(hooks).flags).toEqual(['BEFORE_INITIALIZE', 'AFTER_ADD_LIQUIDITY']);
    const d = assessHook(hooks);
    expect(d.unsafe).toBe(false);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Unknown V4 hook/);
  });

  it('rejects the Doppler hook as unsafe, and accepts it only when allowlisted', () => {
    const d = assessHook(DOPPLER);
    expect(d.flags).toEqual([
      'BEFORE_INITIALIZE', 'AFTER_ADD_LIQUIDITY', 'AFTER_REMOVE_LIQUIDITY', 'AFTER_SWAP', 'AFTER_SWAP_RETURNS_DELTA',
    ]);
    expect(d.unsafe).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Unsafe V4 hook/);
    expect(assessHook(DOPPLER, [DOPPLER.toLowerCase()]).allowed).toBe(true);
  });

  it('rejects a non-zero hook with no delta flag as unknown', () => {
    const hooks = '0x0000000000000000000000000000000000000080';
    const d = assessHook(hooks);
    expect(d.flags).toEqual(['BEFORE_SWAP']);
    expect(d.unsafe).toBe(false);
    expect(d.unknown).toBe(true);
    expect(d.allowed).toBe(false);
  });

  it('a missing hook address is not tradable', () => {
    expect(assessHook(undefined).allowed).toBe(false);
    expect(assessHook('not-an-address').reason).toMatch(/missing its hook/);
  });
});

describe('V4 PoolKey and router calldata', () => {
  it('sorts currencies by uint160 and matches the on-chain pool id', () => {
    expect(sortCurrencies(NATIVE_KEY.currency1, NATIVE_KEY.currency0)).toEqual([NATIVE_KEY.currency0, NATIVE_KEY.currency1]);
    expect(poolId(NATIVE_KEY)).toBe(NATIVE_POOL_ID);
  });

  it('reads a dynamic fee flag and converts lpFee to bps the way V3 tiers do', () => {
    expect(isDynamicFee(DYNAMIC_FEE_FLAG)).toBe(true);
    expect(isDynamicFee(10000)).toBe(false);
    expect(DYNAMIC_FEE_FLAG).toBe(0x800000);
    expect(lpFeeBps(10000)).toBe(100);
    expect(lpFeeBps(3000)).toBe(30);
  });

  it('encodes V4_SWAP with minHopPriceX36 = 0, command 0x10 and actions 0x060c0f', () => {
    expect(V4_ROUTER.getFunction('execute')!.selector).toBe(id('execute(bytes,bytes[],uint256)').slice(0, 10));
    expect(V4_QUOTER.getFunction('quoteExactInputSingle')!.selector)
      .toBe(id('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))').slice(0, 10));
    expect(V4_POOL_MANAGER.getEvent('Initialize')!.topicHash).toBe(TOPIC.v4Init);
    const deadline = 1_800_000_000n;
    const input = encodeV4ExactInputSingle({ key: NATIVE_KEY, zeroForOne: true, amountIn: 10n ** 15n, amountOutMin: 1n });
    const data = encodeUniversalRouterExecute(input, deadline);
    const decoded = V4_ROUTER.decodeFunctionData('execute', data);
    expect(decoded[0]).toBe(V4_SWAP_COMMAND);
    expect(decoded[2]).toBe(deadline);
    const [actions, params] = coder.decode(['bytes', 'bytes[]'], decoded[1][0] as string);
    expect(actions).toBe(V4_SWAP_ACTIONS);
    const p0 = coder.decode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'uint256', 'bytes'],
      params[0] as string,
    );
    expect(p0[2]).toBe(10n ** 15n);
    expect(p0[3]).toBe(1n);
    expect(p0[4]).toBe(0n); // minHopPriceX36 — omitting this word reverts on both Robinhood routers
    const settle = coder.decode(['address', 'uint256'], params[1] as string);
    const take = coder.decode(['address', 'uint256'], params[2] as string);
    expect(settle[0]).toBe(ZERO);
    expect(settle[1]).toBe(10n ** 15n);
    expect(take[0]).toBe(getAddress(NATIVE_KEY.currency1));
    expect(take[1]).toBe(1n);
  });

  it('refuses amounts that do not fit in uint128, and encodes a Permit2 approve inside uint160/uint48', () => {
    expect(() => encodeV4ExactInputSingle({ key: NATIVE_KEY, zeroForOne: true, amountIn: 1n << 128n, amountOutMin: 1n })).toThrow(/uint128/);
    const data = encodePermit2Approve(WETH, '0x204FAca1764B154221e35c0d20aBb3c525710498', UINT160_MAX, 1_800_000_000n);
    const decoded = PERMIT2.decodeFunctionData('approve', data);
    expect(decoded[0]).toBe(WETH);
    expect(decoded[2]).toBe(UINT160_MAX);
    expect(decoded[3]).toBe(1_800_000_000n);
    const now = 1_700_000_000;
    expect(permit2MaxExpiration(now)).toBe(BigInt(now + PERMIT2_MAX_TTL_SEC));
    expect(PERMIT2_MAX_TTL_SEC).toBe(30 * 24 * 60 * 60);
  });
});

describe('V4 adapter', () => {
  const hood = CHAINS.find((c) => c.id === 4663)!;
  const cfg = hood.dexes.find((d) => d.id === 'uniswap-v4')!;

  function ref(over: Partial<NonNullable<PoolRef['v4']>> = {}): PoolRef {
    const v4 = { ...NATIVE_KEY, poolId: NATIVE_POOL_ID, dynamicFee: false, ...over };
    return { dex: 'uniswap-v4', kind: 'v4', address: v4.poolId, feeBps: isDynamicFee(v4.fee) ? 0 : lpFeeBps(v4.fee), v4 };
  }

  it('searches the currencies it was given, and a reader with no logs yields nothing', async () => {
    const wethPair = currencyPairs(WETH, NATIVE_KEY.currency1, WETH).flat();
    expect(wethPair).not.toContain(ZERO);
    expect(currencyPairs(ZERO, NATIVE_KEY.currency1, WETH).flat()).toContain(ZERO);
    const ad = new V4Adapter({ call: async () => '0x' }, cfg, WETH);
    expect(await ad.findPools(WETH, NATIVE_KEY.currency1)).toEqual([]);
  });

  it('scans Initialize logs in chunks under the 10_000_000-block cap and then only the tail', async () => {
    expect(V4_LOG_CHUNK).toBeLessThan(10_000_000);
    const ev = V4_POOL_MANAGER.encodeEventLog('Initialize', [
      NATIVE_POOL_ID, NATIVE_KEY.currency0, NATIVE_KEY.currency1, NATIVE_KEY.fee, NATIVE_KEY.tickSpacing, NATIVE_KEY.hooks,
      1n, 0,
    ]);
    const ranges: [number, number][] = [];
    let head = 9070 + V4_LOG_CHUNK + 25;
    const ad = new V4Adapter({
      call: async () => '0x',
      getBlockNumber: async () => head,
      getLogs: async (f) => {
        ranges.push([f.fromBlock, f.toBlock]);
        expect(f.toBlock - f.fromBlock + 1).toBeLessThanOrEqual(V4_LOG_CHUNK);
        expect(f.topics[0]).toBe(TOPIC.v4Init);
        expect(f.address).toBe(cfg.factory);
        const first = f.fromBlock === 9070;
        return first ? [{ topics: ev.topics, data: ev.data }] : [];
      },
    }, cfg, WETH);
    const found = await ad.findPools(ZERO, NATIVE_KEY.currency1);
    const native = found.find((p) => p.address === NATIVE_POOL_ID);
    expect(native?.v4).toMatchObject({ fee: 10000, tickSpacing: 200, hooks: ZERO, dynamicFee: false });
    expect(native?.feeBps).toBe(100);
    expect(ranges.some(([from]) => from === 9070)).toBe(true);
    const calls = ranges.length;
    head += 10;
    await ad.findPools(ZERO, NATIVE_KEY.currency1);
    const tail = ranges.slice(calls);
    expect(tail.length).toBeGreaterThan(0);
    expect(Math.min(...tail.map(([from]) => from))).toBeGreaterThan(9070 + V4_LOG_CHUNK);
  });

  it('reads the LP fee from getSlot0 at quote time and refuses to build a rejected hook', async () => {
    const sqrt = 1908495653441889301188931688731428n;
    const ad = new V4Adapter({
      call: async (tx) => {
        const sel = tx.data.slice(0, 10);
        if (sel === V4_STATE_VIEW.getFunction('getSlot0')!.selector) return V4_STATE_VIEW.encodeFunctionResult('getSlot0', [sqrt, 201799n, 4097000n, 10000n]);
        if (sel === V4_STATE_VIEW.getFunction('getLiquidity')!.selector) return V4_STATE_VIEW.encodeFunctionResult('getLiquidity', [32156000099526845215062n]);
        if (sel === V4_QUOTER.getFunction('quoteExactInputSingle')!.selector) return V4_QUOTER.encodeFunctionResult('quoteExactInputSingle', [573458801863169377441980n, 41928n]);
        throw new Error(`unexpected ${sel}`);
      },
    }, cfg, WETH);
    const q = await ad.quote(ref(), 'native', NATIVE_KEY.currency1, 10n ** 15n);
    expect(q.lpFee).toBe(10000);
    expect(q.dynamicFee).toBe(false);
    expect(q.amountOut).toBe(573458801863169377441980n);
    expect(q.hook?.allowed).toBe(true);
    const st = await ad.state(ref(), WETH, NATIVE_KEY.currency1);
    expect(st.token0).toBe(WETH); // address(0) is faced as the wrapped native
    expect(st.pool.feeBps).toBe(100);
    const built = ad.buildSwap({
      pool: ref(), tokenIn: 'native', tokenOut: NATIVE_KEY.currency1, amountIn: 10n ** 15n, amountOutMin: 1n,
      recipient: '0x000000000000000000000000000000000000bEEF', deadline: 1_800_000_000n,
    });
    expect(built.to).toBe(cfg.router);
    expect(built.value).toBe(10n ** 15n);
    expect(built.method).toBe('execute');
    expect(V4_ROUTER.decodeFunctionData('execute', built.data)[0]).toBe('0x10');

    const bad = ref({ hooks: DOPPLER });
    await expect(ad.quote(ref(), WETH, NATIVE_KEY.currency1, 10n ** 15n)).rejects.toThrow(/not in this V4 pool/);
    expect(() => ad.buildSwap({
      pool: ref(), tokenIn: WETH, tokenOut: NATIVE_KEY.currency1, amountIn: 1n, amountOutMin: 1n,
      recipient: '0x000000000000000000000000000000000000bEEF', deadline: 1n,
    })).toThrow(/not in this V4 pool/);
    const quoted = await ad.quote(bad, 'native', NATIVE_KEY.currency1, 10n ** 15n);
    expect(quoted.hook?.allowed).toBe(false);
    expect(quoted.lpFee).toBe(10000);
    expect(() => ad.buildSwap({
      pool: bad, tokenIn: 'native', tokenOut: NATIVE_KEY.currency1, amountIn: 1n, amountOutMin: 1n,
      recipient: '0x000000000000000000000000000000000000bEEF', deadline: 1n,
    })).toThrow(/Unsafe V4 hook/);
  });

  it('drops an address(0) pool from a WETH search, and surfaces a getLogs failure', async () => {
    const ev = V4_POOL_MANAGER.encodeEventLog('Initialize', [
      NATIVE_POOL_ID, NATIVE_KEY.currency0, NATIVE_KEY.currency1, NATIVE_KEY.fee, NATIVE_KEY.tickSpacing, NATIVE_KEY.hooks,
      1n, 0,
    ]);
    const ad = new V4Adapter({
      call: async () => '0x',
      getBlockNumber: async () => 10_000,
      getLogs: async () => [{ topics: ev.topics, data: ev.data }],
    }, cfg, WETH);
    expect(await ad.findPools(WETH, NATIVE_KEY.currency1)).toEqual([]);
    const failing = new V4Adapter({
      call: async () => '0x',
      getBlockNumber: async () => 20_000,
      getLogs: async () => { throw new Error('rpc down'); },
    }, cfg, WETH);
    await expect(failing.findPools(ZERO, NATIVE_KEY.currency1)).rejects.toBeInstanceOf(V4ScanError);
  });

  it('discovery leaves a mismatched V4 pool unquoted, so auto-pick and hand-pick cannot take it', async () => {
    const sqrt = 1908495653441889301188931688731428n;
    const ad = new V4Adapter({
      call: async (tx) => {
        const sel = tx.data.slice(0, 10);
        if (sel === V4_STATE_VIEW.getFunction('getSlot0')!.selector) return V4_STATE_VIEW.encodeFunctionResult('getSlot0', [sqrt, 201799n, 0n, 10000n]);
        if (sel === V4_STATE_VIEW.getFunction('getLiquidity')!.selector) return V4_STATE_VIEW.encodeFunctionResult('getLiquidity', [10n ** 22n]);
        if (sel === V4_QUOTER.getFunction('quoteExactInputSingle')!.selector) return V4_QUOTER.encodeFunctionResult('quoteExactInputSingle', [5n * 10n ** 23n, 40_000n]);
        throw new Error(`unexpected ${sel}`);
      },
    }, cfg, WETH);
    const native = ref();
    const wethId = '0x' + 'ab'.repeat(32);
    const wethPool: PoolRef = {
      dex: 'uniswap-v4', kind: 'v4', address: wethId, feeBps: 30,
      v4: { currency0: WETH, currency1: NATIVE_KEY.currency1, fee: 3000, tickSpacing: 60, hooks: ZERO, poolId: wethId, dynamicFee: false },
    };
    ad.findPools = async () => [native, wethPool];
    const rt = { adapters: new Map([[cfg.id, ad]]) } as unknown as ChainRuntime;
    const base = { address: NATIVE_KEY.currency1, symbol: 'TOK', decimals: 18 };
    const wethQuote = { address: WETH, symbol: 'WETH', decimals: 18 };
    const nativeQuote = { address: WETH, symbol: 'ETH', decimals: 18, native: true as const };
    expect(v4PoolMatches(native, base, wethQuote)).toBe(false);
    expect(v4PoolMatches(native, base, nativeQuote)).toBe(true);
    expect(v4PoolMatches(wethPool, base, wethQuote)).toBe(true);
    expect(v4PoolMatches(wethPool, base, nativeQuote)).toBe(false);
    const forWeth = await discoverPools(rt, base, wethQuote, { refQuote: 0.001, quoteUsd: null });
    expect(forWeth.find((p) => p.address === NATIVE_POOL_ID)?.refOut ?? null).toBeNull();
    expect(forWeth.find((p) => p.address === NATIVE_POOL_ID)?.error).toMatch(/does not match/);
    expect(forWeth.find((p) => p.address === wethId)?.refOut).toBeGreaterThan(0);
    const forNative = await discoverPools(rt, base, nativeQuote, { refQuote: 0.001, quoteUsd: null });
    expect(forNative.find((p) => p.address === wethId)?.refOut ?? null).toBeNull();
    expect(forNative.find((p) => p.address === wethId)?.error).toMatch(/does not match/);
    expect(forNative.find((p) => p.address === NATIVE_POOL_ID)?.refOut).toBeGreaterThan(0);
  });
});

describe('V4 safety classification', () => {
  const probe = (gotBuy: bigint, gotSell: bigint): ProbeResult => ({
    stage: 0, quoteIn: 1000n, expectedBuy: 1000n, gotBuy, transferSent: 100n, transferGot: 100n,
    sellIn: 900n, expectedSell: 900n, gotSell, err: '', gasBuy: 1n, gasSell: 1n,
  });

  it('a taxed V4 round trip that passed is v4-proven, and one over the cap stays blocked', () => {
    const proven = classify({ probe: probe(950n, 855n), proxy: null, depth: [], liquidityUsd: 100_000, poolKind: 'v4', now: 1 });
    expect(proven.taxMode).toBe('v4-proven');
    expect(proven.poolKind).toBe('v4');
    expect(proven.liveAllowed).toBe(true);
    const v3 = classify({ probe: probe(950n, 855n), proxy: null, depth: [], liquidityUsd: 100_000, poolKind: 'v3', now: 1 });
    expect(v3.taxMode).toBe('v3-proven');
    const over = classify({ probe: probe(500n, 900n), proxy: null, depth: [], liquidityUsd: 100_000, poolKind: 'v4', now: 1 });
    expect(over.taxMode).toBe('blocked');
    expect(over.liveAllowed).toBe(false);
  });

  it('hopFor will not send a V4 pool through the V2/V3 probe', () => {
    const hood = CHAINS.find((c) => c.id === 4663)!;
    const cfg = hood.dexes.find((d) => d.id === 'uniswap-v4')!;
    const ad = new V4Adapter({ call: async () => '0x' }, cfg, WETH);
    expect(() => hopFor(ad, { dex: 'uniswap-v4', kind: 'v4', address: NATIVE_POOL_ID, feeBps: 100 }, WETH, NATIVE_KEY.currency1)).toThrow(/SafetyProbeV4/);
  });
});
