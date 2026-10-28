import { beforeEach, describe, expect, it } from 'vitest';
import { encodeV3Mint } from '../src/market/poolEvents';
import {
  BURN_ADDRESSES, clearV3LpLockCache, encodeIncreaseLiquidity, inspectV3LpLock, MULTICALL3, v3LockSatisfies, V3_LP_IFACE,
  V3_LP_LOCK_CACHE_TTL_MS, type V3LockLog, type V3LockRpc, type V3LpReport,
} from '../src/market/v3LpLock';
import { DEFAULT_TRADER, TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';

const POOL = '0x' + 'ab'.repeat(20);
const NPM = '0x' + 'cd'.repeat(20);
const TOKEN0 = '0x' + '11'.repeat(20);
const TOKEN1 = '0x' + '22'.repeat(20);
const EOA = '0x' + '44'.repeat(20);
const DEAD = BURN_ADDRESSES[1];
const HEAD = 100;

type Trace = { method: string; to?: string; data?: string; fromBlock?: number; toBlock?: number };

function selector(data: string): string { return data.slice(0, 10).toLowerCase(); }

function world() {
  const trace: Trace[] = [];
  const tx = '0x' + '1'.padStart(64, '0');
  const mint = encodeV3Mint(1000n, 1n, 1n);
  const inc = encodeIncreaseLiquidity(1n, 1000n);
  const mints: V3LockLog[] = [{ address: POOL, topics: mint.topics, data: mint.data, blockNumber: 40, transactionHash: tx }];
  const receipt = { logs: [{ address: NPM, topics: inc.topics, data: inc.data, blockNumber: 40, transactionHash: tx }] };
  const answer = (to: string, data: string): string => {
    const sel = selector(data);
    const who = to.toLowerCase();
    const pool = V3_LP_IFACE.pool;
    const npm = V3_LP_IFACE.npm;
    if (who === POOL) {
      if (sel === pool.getFunction('slot0')!.selector.toLowerCase()) return pool.encodeFunctionResult('slot0', [1n, 0]);
      if (sel === pool.getFunction('liquidity')!.selector.toLowerCase()) return pool.encodeFunctionResult('liquidity', [1000n]);
      if (sel === pool.getFunction('token0')!.selector.toLowerCase()) return pool.encodeFunctionResult('token0', [TOKEN0]);
      if (sel === pool.getFunction('token1')!.selector.toLowerCase()) return pool.encodeFunctionResult('token1', [TOKEN1]);
      if (sel === pool.getFunction('fee')!.selector.toLowerCase()) return pool.encodeFunctionResult('fee', [3000]);
    }
    if (who === NPM.toLowerCase()) {
      if (sel === npm.getFunction('positions')!.selector.toLowerCase()) {
        return npm.encodeFunctionResult('positions', [0, EOA, TOKEN0, TOKEN1, 3000, -60, 60, 1000n, 0, 0, 0, 0]);
      }
      if (sel === npm.getFunction('ownerOf')!.selector.toLowerCase()) return npm.encodeFunctionResult('ownerOf', [DEAD]);
    }
    if (who === MULTICALL3.toLowerCase() && sel === V3_LP_IFACE.multicall.getFunction('aggregate3')!.selector.toLowerCase()) {
      const decoded = V3_LP_IFACE.multicall.decodeFunctionData('aggregate3', data);
      const rows = [...decoded[0]] as { target?: string; callData?: string; 0?: string; 2?: string }[];
      const results = rows.map((row) => {
        const ret = answer(String(row.target ?? row[0]), String(row.callData ?? row[2]));
        return ret === '0x' ? [false, '0x'] : [true, ret];
      });
      return V3_LP_IFACE.multicall.encodeFunctionResult('aggregate3', [results]);
    }
    return '0x';
  };
  const rpc: V3LockRpc = {
    async call(to, data) { trace.push({ method: 'call', to, data }); return answer(to, data); },
    async getCode(address) { trace.push({ method: 'getCode', to: address }); return '0x'; },
    async getLogs(f) { trace.push({ method: 'getLogs', to: f.address, fromBlock: f.fromBlock, toBlock: f.toBlock }); return mints.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock); },
    async getReceipt(hash) { trace.push({ method: 'getReceipt', data: hash }); return hash === tx ? receipt : null; },
    async blockNumber() { trace.push({ method: 'blockNumber' }); return HEAD; },
  };
  return { rpc, trace };
}

const base = (over: Partial<Parameters<typeof inspectV3LpLock>[1]> = {}) => ({
  chainId: 4663, pool: POOL, positionManager: NPM, nowSec: 1_700_000_000,
  gapMs: 0, chunkBlocks: 500, maxBlockSpan: 500, blockNumber: HEAD,
  sleep: async () => undefined, ...over,
});

beforeEach(() => clearV3LpLockCache());

describe('V3 LP lock RPC bounds', () => {
  it('serves a cache hit inside the TTL with no further RPC calls', async () => {
    const w = world();
    let now = 0;
    const first = await inspectV3LpLock(w.rpc, { ...base(), cacheEnabled: true, clock: () => now });
    expect(first.status).toBe('verified');
    expect(v3LockSatisfies(first)).toBe(true);
    const used = w.trace.length;
    expect(used).toBeGreaterThan(0);
    now = V3_LP_LOCK_CACHE_TTL_MS - 1;
    const second = await inspectV3LpLock(w.rpc, { ...base(), cacheEnabled: true, clock: () => now });
    expect(w.trace.length).toBe(used);
    expect(second).toEqual(first);
  });

  it('misses the cache after the TTL and on a different block range', async () => {
    const w = world();
    let now = 0;
    await inspectV3LpLock(w.rpc, { ...base(), cacheEnabled: true, cacheTtlMs: 1_000, clock: () => now });
    const used = w.trace.length;
    now = 1_000;
    await inspectV3LpLock(w.rpc, { ...base(), cacheEnabled: true, cacheTtlMs: 1_000, clock: () => now });
    expect(w.trace.length).toBeGreaterThan(used);
    const afterTtl = w.trace.length;
    await inspectV3LpLock(w.rpc, { ...base({ blockNumber: HEAD + 50 }), cacheEnabled: true, cacheTtlMs: 1_000, clock: () => now });
    expect(w.trace.length).toBeGreaterThan(afterTtl);
  });

  it('fails closed when the call budget is exceeded and does not pass on a partial read', async () => {
    const w = world();
    const open = await inspectV3LpLock(w.rpc, base());
    expect(open.status).toBe('verified');
    expect(v3LockSatisfies(open)).toBe(true);
    clearV3LpLockCache();
    const limited = world();
    const closed = await inspectV3LpLock(limited.rpc, { ...base(), callBudget: 2 });
    expect(closed.status).toBe('unverified');
    expect(closed.detail).toBe('LP lock unverified: call budget exceeded (2 calls)');
    expect(v3LockSatisfies(closed)).toBe(false);
    expect(limited.trace.length).toBe(2);
  });

  it('matches the unbounded result when the run stays inside the budget', async () => {
    const openWorld = world();
    const open = await inspectV3LpLock(openWorld.rpc, base());
    clearV3LpLockCache();
    const cappedWorld = world();
    const capped = await inspectV3LpLock(cappedWorld.rpc, { ...base(), callBudget: 10_000 });
    expect(capped).toEqual(open);
    expect(cappedWorld.trace).toEqual(openWorld.trace);
  });

  it('keeps the call sequence and the result when the cache and the budget are off', async () => {
    const plain = world();
    const plainReport = await inspectV3LpLock(plain.rpc, base());
    clearV3LpLockCache();
    const off = world();
    const offReport = await inspectV3LpLock(off.rpc, { ...base(), cacheEnabled: false, callBudget: 0 });
    expect(off.trace).toEqual(plain.trace);
    expect(offReport).toEqual(plainReport);
  });

  it('defaults the cache off and the budget unlimited', () => {
    const fresh = new TokenTrader({ store: new MemoryStore() });
    expect(fresh.status().options.v3LpLockCacheEnabled).toBe(false);
    expect(fresh.status().options.v3LpLockCallBudget).toBe(0);
    expect(fresh.status().options.v3LpLockCacheTtlMs).toBe(V3_LP_LOCK_CACHE_TTL_MS);
    expect(DEFAULT_TRADER.v3LpLockCacheEnabled).toBe(false);
    expect(DEFAULT_TRADER.v3LpLockCallBudget).toBe(0);
    fresh.configure({ v3LpLockCacheEnabled: true, v3LpLockCallBudget: 40, v3LpLockCacheTtlMs: 5_000 });
    expect(fresh.status().options.v3LpLockCacheEnabled).toBe(true);
    expect(fresh.status().options.v3LpLockCallBudget).toBe(40);
    expect(fresh.status().options.v3LpLockCacheTtlMs).toBe(5_000);
    fresh.configure({ perTradeUsd: 80 });
    expect(fresh.status().options.v3LpLockCacheEnabled).toBe(true);
    fresh.configure({ v3LpLockCacheEnabled: false, v3LpLockCallBudget: 0 });
    expect(fresh.status().options.v3LpLockCacheEnabled).toBe(false);
    expect(fresh.status().options.v3LpLockCallBudget).toBe(0);
    const options = { ...DEFAULT_TRADER };
    delete (options as { v3LpLockCacheEnabled?: boolean }).v3LpLockCacheEnabled;
    delete (options as { v3LpLockCallBudget?: number }).v3LpLockCallBudget;
    const store = new MemoryStore<TraderState>();
    store.data = { version: 1, on: false, options, positions: [], trades: [], feed: [], cursors: {}, snipesAt: [], plays: [] };
    const loaded = new TokenTrader({ store });
    expect(loaded.status().options.v3LpLockCacheEnabled).toBe(false);
    expect(loaded.status().options.v3LpLockCallBudget).toBe(0);
  });
});
