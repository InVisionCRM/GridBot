import { beforeEach, describe, expect, it } from 'vitest';
import { encodeV3Mint } from '../src/market/poolEvents';
import { gateToken, type GateInput } from '../src/market/tokenTrader';
import {
  BURN_ADDRESSES, clearV3LpLockCache, encodeIncreaseLiquidity, exposesLockSemantics, inspectV3LpLock,
  KNOWN_V3_LOCKERS, LOCKER_SELECTOR, MULTICALL3, unverifiedV3Lp, v3LockSatisfies, V3_LP_IFACE,
  type V3LockLog, type V3LockRpc, type V3LpReport,
} from '../src/market/v3LpLock';
import { DEFAULT_TRADER, TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { positionManagerFor, v3LockRpc } from '../src/server/market/v3LpLockRead';

const POOL = '0x' + 'ab'.repeat(20);
const NPM = '0x' + 'cd'.repeat(20);
const TOKEN0 = '0x' + '11'.repeat(20);
const TOKEN1 = '0x' + '22'.repeat(20);
const LOCKER = '0x' + '33'.repeat(20);
const EOA = '0x' + '44'.repeat(20);
const OTHER = '0x' + '55'.repeat(20);
const DEAD = BURN_ADDRESSES[1];
const FEE = 3000;
const NOW = 1_700_000_000;
const FUTURE = 1_800_000_000;
const PAST = 1_600_000_000;

const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 50_000, minLiquidityUsd: 5_000,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: false,
  holderConcentration: 0.1, recentLiqPull: false, liveAllowed: true, ...o,
});

function selector(data: string): string { return data.slice(0, 10).toLowerCase(); }
function word(data: string, i: number): bigint {
  const hex = data.slice(10 + i * 64, 10 + (i + 1) * 64);
  return hex ? BigInt('0x' + hex) : 0n;
}

interface Pos {
  tokenId: bigint;
  owner: string;
  liquidity: bigint;
  tickLower?: number;
  tickUpper?: number;
}

function lockerCode(): string {
  return '0x' + [LOCKER_SELECTOR.unlock, LOCKER_SELECTOR.lock, LOCKER_SELECTOR.unlockDate].join('00');
}

interface WorldOpts {
  pool?: string;
  liquidity: bigint;
  positions: Pos[];
  /** address → runtime code. Missing addresses are EOAs (`0x`). */
  code?: Record<string, string>;
  /** owner → unlockDate(uint256) → unix seconds, for the bytecode locker path */
  unlockAt?: Record<string, bigint>;
  /** Known-locker getLock rows, keyed by lock id. */
  uncx?: { len: number; eternal?: bigint; locks: Record<number, { nft: bigint; unlock: bigint; manager?: string }> };
  multicall?: boolean;
  head?: number;
  /** Throw from getLogs when the requested span is wider than this. */
  maxSpan?: number;
}

function world(o: WorldOpts) {
  const poolAddr = (o.pool ?? POOL).toLowerCase();
  const head = o.head ?? 100;
  const calls: { to: string; data: string }[] = [];
  const sleeps: number[] = [];
  let failBlock = 0;
  const code = new Map<string, string>(Object.entries(o.code ?? {}).map(([a, c]) => [a.toLowerCase(), c]));
  if (o.multicall) code.set(MULTICALL3.toLowerCase(), '0x6001600d6000396000f3');
  const mints: V3LockLog[] = [];
  const receipts = new Map<string, { logs: V3LockLog[] }>();
  o.positions.forEach((p, i) => {
    const tx = '0x' + (i + 1).toString(16).padStart(64, '0');
    const mint = encodeV3Mint(p.liquidity, 1n, 1n);
    mints.push({ address: poolAddr, topics: mint.topics, data: mint.data, blockNumber: 40 + i, transactionHash: tx });
    const inc = encodeIncreaseLiquidity(p.tokenId, p.liquidity);
    receipts.set(tx, { logs: [{ address: NPM, topics: inc.topics, data: inc.data, blockNumber: 40 + i, transactionHash: tx }] });
  });

  const answer = (to: string, data: string): string => {
    const sel = selector(data);
    const who = to.toLowerCase();
    const pool = V3_LP_IFACE.pool;
    const npm = V3_LP_IFACE.npm;
    if (who === poolAddr) {
      if (sel === pool.getFunction('slot0')!.selector.toLowerCase()) return pool.encodeFunctionResult('slot0', [1n, 0]);
      if (sel === pool.getFunction('liquidity')!.selector.toLowerCase()) return pool.encodeFunctionResult('liquidity', [o.liquidity]);
      if (sel === pool.getFunction('token0')!.selector.toLowerCase()) return pool.encodeFunctionResult('token0', [TOKEN0]);
      if (sel === pool.getFunction('token1')!.selector.toLowerCase()) return pool.encodeFunctionResult('token1', [TOKEN1]);
      if (sel === pool.getFunction('fee')!.selector.toLowerCase()) return pool.encodeFunctionResult('fee', [FEE]);
    }
    if (who === NPM.toLowerCase()) {
      const id = word(data, 0);
      const pos = o.positions.find((p) => p.tokenId === id);
      if (sel === npm.getFunction('positions')!.selector.toLowerCase() && pos) {
        return npm.encodeFunctionResult('positions', [0, EOA, TOKEN0, TOKEN1, FEE, pos.tickLower ?? -60, pos.tickUpper ?? 60, pos.liquidity, 0, 0, 0, 0]);
      }
      if (sel === npm.getFunction('ownerOf')!.selector.toLowerCase() && pos) return npm.encodeFunctionResult('ownerOf', [pos.owner]);
    }
    const unlock = o.unlockAt?.[who];
    if (unlock != null && sel === V3_LP_IFACE.time.getFunction('unlockDate')!.selector.toLowerCase()) {
      return V3_LP_IFACE.time.encodeFunctionResult('unlockDate', [unlock]);
    }
    if (o.uncx && who === (o.positions.find((p) => KNOWN_V3_LOCKERS.some((k) => k.address.toLowerCase() === p.owner.toLowerCase()))?.owner.toLowerCase() ?? '')) {
      const uncx = V3_LP_IFACE.uncx;
      if (sel === uncx.getFunction('getLocksLength')!.selector.toLowerCase()) return uncx.encodeFunctionResult('getLocksLength', [BigInt(o.uncx.len)]);
      if (sel === uncx.getFunction('ETERNAL_LOCK')!.selector.toLowerCase()) return uncx.encodeFunctionResult('ETERNAL_LOCK', [o.uncx.eternal ?? (2n ** 256n - 1n)]);
      if (sel === uncx.getFunction('getLock')!.selector.toLowerCase()) {
        const row = o.uncx.locks[Number(word(data, 0))];
        if (!row) return '0x';
        return uncx.encodeFunctionResult('getLock', [word(data, 0), row.manager ?? NPM, poolAddr, row.nft, EOA, EOA, EOA, EOA, row.unlock, 1, 0]);
      }
    }
    if (who === MULTICALL3.toLowerCase() && sel === V3_LP_IFACE.multicall.getFunction('aggregate3')!.selector.toLowerCase()) {
      const decoded = V3_LP_IFACE.multicall.decodeFunctionData('aggregate3', data);
      const rows = [...decoded[0]] as { target?: string; callData?: string; 0?: string; 2?: string }[];
      const results = rows.map((row) => {
        const target = String(row.target ?? row[0]);
        const callData = String(row.callData ?? row[2]);
        const ret = answer(target, callData);
        return ret === '0x' ? [false, '0x'] : [true, ret];
      });
      return V3_LP_IFACE.multicall.encodeFunctionResult('aggregate3', [results]);
    }
    return '0x';
  };

  const rpc: V3LockRpc = {
    async call(to, data) {
      calls.push({ to, data });
      return answer(to, data);
    },
    async getCode(address) { return code.get(address.toLowerCase()) ?? '0x'; },
    async getLogs(f) {
      const span = f.toBlock - f.fromBlock + 1;
      if (o.maxSpan != null && span > o.maxSpan) throw new Error('block range too large');
      return mints.filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async getReceipt(hash) { return receipts.get(hash) ?? null; },
    async blockNumber() {
      if (failBlock > 0) { failBlock--; throw new Error('429 too many requests'); }
      return head;
    },
  };
  return {
    rpc, calls, sleeps, head,
    failBlockNumber(n: number) { failBlock = n; },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
}

const req = (over: Partial<Parameters<typeof inspectV3LpLock>[1]> = {}) => ({
  chainId: 4663, pool: POOL, positionManager: NPM, nowSec: NOW, gapMs: 0, chunkBlocks: 500, maxBlockSpan: 500, ...over,
});

async function run(w: ReturnType<typeof world>, over: Partial<Parameters<typeof inspectV3LpLock>[1]> = {}): Promise<V3LpReport> {
  return inspectV3LpLock(w.rpc, { ...req(over), sleep: w.sleep, clock: () => 0 });
}

beforeEach(() => clearV3LpLockCache());

describe('V3 position lock evidence', () => {
  it('classifies a locker contract and reads the unlock time', async () => {
    const w = world({
      liquidity: 1000n,
      positions: [{ tokenId: 7n, owner: LOCKER, liquidity: 1000n }],
      code: { [LOCKER]: lockerCode() },
      unlockAt: { [LOCKER]: BigInt(FUTURE) },
    });
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.shares).toEqual({ locker: 1, burn: 0, eoa: 0, other: 0 });
    expect(r.lockedOrBurnedShare).toBe(1);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ tokenId: '7', owner: LOCKER, class: 'locker', unlockAt: FUTURE, expired: false, permanent: false, inRange: true });
    expect(v3LockSatisfies(r)).toBe(true);
    expect(gateToken(clean({ lpUnlocked: true, v3Lp: r })).ok).toBe(true);
    expect(gateToken(clean({ risk: 'medium', lpUnlocked: true, v3Lp: r })).reason).toBeNull();
  });

  it('classifies a known UNCX locker from its lock table, including on Robinhood', async () => {
    const known = KNOWN_V3_LOCKERS.find((k) => k.chainId === 4663)!;
    const w = world({
      liquidity: 1000n,
      positions: [{ tokenId: 4n, owner: known.address, liquidity: 1000n }],
      code: { [known.address]: '0x363d3d373d3d3d363d73' },
      uncx: { len: 1, locks: { 1: { nft: 4n, unlock: BigInt(FUTURE), manager: NPM } } },
    });
    const r = await run(w, { chainId: 4663 });
    expect(r.status).toBe('verified');
    expect(r.positions[0].class).toBe('locker');
    expect(r.positions[0].unlockAt).toBe(FUTURE);
    expect(r.lockedOrBurnedShare).toBe(1);
  });

  it('treats an expired lock as a locker that does not satisfy the requirement', async () => {
    const w = world({
      liquidity: 1000n,
      positions: [{ tokenId: 7n, owner: LOCKER, liquidity: 1000n }],
      code: { [LOCKER]: lockerCode() },
      unlockAt: { [LOCKER]: BigInt(PAST) },
    });
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.positions[0]).toMatchObject({ class: 'locker', unlockAt: PAST, expired: true });
    expect(r.shares.locker).toBe(1);
    expect(r.lockedOrBurnedShare).toBe(0);
    expect(v3LockSatisfies(r)).toBe(false);
    expect(gateToken(clean({ lpUnlocked: true, v3Lp: r })).reason).toBe('liquidity is unlocked');
  });

  it('classifies a burn address as burned liquidity', async () => {
    const w = world({ liquidity: 1000n, positions: [{ tokenId: 3n, owner: DEAD, liquidity: 1000n }] });
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.shares.burn).toBe(1);
    expect(r.positions[0].class).toBe('burn');
    expect(r.positions[0].unlockAt).toBeNull();
    expect(v3LockSatisfies(r)).toBe(true);
    expect(gateToken(clean({ risk: 'medium', lpUnlocked: true, v3Lp: r })).ok).toBe(true);
  });

  it('classifies an EOA and does not treat it as locked', async () => {
    const w = world({ liquidity: 1000n, positions: [{ tokenId: 9n, owner: EOA, liquidity: 1000n }] });
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.shares).toEqual({ locker: 0, burn: 0, eoa: 1, other: 0 });
    expect(r.positions[0].class).toBe('eoa');
    expect(v3LockSatisfies(r)).toBe(false);
    expect(gateToken(clean({ lpUnlocked: true, v3Lp: r })).reason).toBe('liquidity is unlocked');
    const unknown = gateToken(clean({ lpUnlocked: null, v3Lp: r }));
    expect(unknown.ok).toBe(true);
    expect(unknown.v3Lp?.shares.eoa).toBe(1);
  });

  it('reports mixed locker, burn, EOA and other shares', async () => {
    const w = world({
      liquidity: 1000n,
      positions: [
        { tokenId: 1n, owner: LOCKER, liquidity: 500n },
        { tokenId: 2n, owner: DEAD, liquidity: 200n },
        { tokenId: 3n, owner: EOA, liquidity: 200n },
        { tokenId: 4n, owner: OTHER, liquidity: 100n },
      ],
      code: { [LOCKER]: lockerCode(), [OTHER]: '0x60006000' },
      unlockAt: { [LOCKER]: BigInt(FUTURE) },
    });
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.shares).toEqual({ locker: 0.5, burn: 0.2, eoa: 0.2, other: 0.1 });
    expect(r.lockedOrBurnedShare).toBe(0.7);
    expect(r.positions.map((p) => p.class)).toEqual(['locker', 'burn', 'eoa', 'other']);
    expect(r.positions[0].unlockAt).toBe(FUTURE);
    expect(v3LockSatisfies(r)).toBe(false);
    expect(gateToken(clean({ lpUnlocked: true, v3Lp: r })).reason).toBe('liquidity is unlocked');
  });

  it('fails closed when the RPC errors, and backs off on a rate limit', async () => {
    const down: V3LockRpc = {
      call: async () => { throw new Error('connection refused'); },
      getCode: async () => '0x',
      getLogs: async () => [],
      getReceipt: async () => null,
      blockNumber: async () => 1,
    };
    const sleeps: number[] = [];
    const refused = await inspectV3LpLock(down, { ...req(), sleep: async (ms) => { sleeps.push(ms); } });
    expect(refused.status).toBe('unverified');
    expect(refused.detail).toMatch(/connection refused/);
    expect(sleeps).toEqual([]);
    expect(v3LockSatisfies(refused)).toBe(false);
    expect(gateToken(clean({ lpUnlocked: null, v3Lp: refused })).reason).toBe('V3 liquidity lock unverified');
    expect(gateToken(clean({ lpUnlocked: false, v3Lp: refused })).reason).toBe('V3 liquidity lock unverified');

    clearV3LpLockCache();
    let left = 6;
    const limited: V3LockRpc = {
      call: async () => { throw new Error('429 rate limit'); },
      getCode: async () => { throw new Error('429 rate limit'); },
      getLogs: async () => [],
      getReceipt: async () => null,
      blockNumber: async () => { throw new Error('429 rate limit'); },
    };
    const waits: number[] = [];
    const rated = await inspectV3LpLock(limited, {
      ...req({ pool: '0x' + 'ee'.repeat(20) }),
      sleep: async (ms) => { waits.push(ms); left--; if (left < 0) throw new Error('too many retries'); },
    });
    expect(rated.status).toBe('unverified');
    expect(rated.detail).toMatch(/429/);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(gateToken(clean({ risk: 'safe', v3Lp: rated })).ok).toBe(false);
  });

  it('retries a rate limit and then accepts the pool', async () => {
    const w = world({
      liquidity: 1000n,
      positions: [{ tokenId: 1n, owner: DEAD, liquidity: 1000n }],
    });
    w.failBlockNumber(2);
    const r = await run(w);
    expect(r.status).toBe('verified');
    expect(r.shares.burn).toBe(1);
    expect(w.sleeps).toEqual([1000, 2000]);
  });

  it('shrinks a log range the RPC refuses, and caches a verified report', async () => {
    const pool = '0x' + 'd1'.repeat(20);
    const w = world({
      pool, liquidity: 800n,
      positions: [{ tokenId: 1n, owner: DEAD, liquidity: 800n }],
      head: 3_000,
      maxSpan: 1_500,
    });
    let now = 5_000;
    const r = await inspectV3LpLock(w.rpc, {
      ...req({ pool, chunkBlocks: 4_000, maxBlockSpan: 3_000, blockNumber: 3_000 }),
      sleep: w.sleep, clock: () => now,
    });
    expect(r.status).toBe('verified');
    expect(r.shares.burn).toBe(1);
    const after = w.calls.length;
    const again = await inspectV3LpLock(w.rpc, {
      ...req({ pool }), sleep: w.sleep, clock: () => now,
    });
    expect(again).toBe(r);
    expect(w.calls.length).toBe(after);
    now += 10 * 60_000 + 1;
    await inspectV3LpLock(w.rpc, { ...req({ pool }), sleep: w.sleep, clock: () => now });
    expect(w.calls.length).toBeGreaterThan(after);
  });

  it('batches eth_calls through Multicall3 when that contract has code', async () => {
    const w = world({
      pool: '0x' + 'd2'.repeat(20),
      liquidity: 1000n,
      positions: [{ tokenId: 1n, owner: DEAD, liquidity: 1000n }],
      multicall: true,
    });
    const r = await run(w, { pool: '0x' + 'd2'.repeat(20) });
    expect(r.status).toBe('verified');
    const agg = V3_LP_IFACE.multicall.getFunction('aggregate3')!.selector.toLowerCase();
    const slot0 = V3_LP_IFACE.pool.getFunction('slot0')!.selector.toLowerCase();
    expect(w.calls.some((c) => selector(c.data) === agg)).toBe(true);
    expect(w.calls.some((c) => selector(c.data) === slot0)).toBe(false);
  });

  it('fails closed when the positions do not cover the pool', async () => {
    const w = world({
      pool: '0x' + 'd3'.repeat(20),
      liquidity: 1000n,
      positions: [{ tokenId: 1n, owner: DEAD, liquidity: 100n }],
    });
    const r = await run(w, { pool: '0x' + 'd3'.repeat(20) });
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatch(/not fully accounted/);
    expect(v3LockSatisfies(r)).toBe(false);
  });
});

describe('gate with the check disabled', () => {
  it('keeps the previous decisions and does not add a v3Lp field', () => {
    expect(exposesLockSemantics('0x')).toBe(false);
    expect(exposesLockSemantics(lockerCode())).toBe(true);
    expect(v3LockSatisfies(undefined)).toBe(false);
    expect(v3LockSatisfies(unverifiedV3Lp(POOL, NPM, 'rpc failed'))).toBe(false);

    const cases: GateInput[] = [
      clean(),
      clean({ lpUnlocked: true, risk: 'medium' }),
      clean({ lpUnlocked: null, canPause: null }),
      clean({ lpUnlocked: false, risk: 'safe' }),
      clean({ risk: 'any', lpUnlocked: true, proxy: true, canPause: true }),
      clean({ mode: 'live', risk: 'any', liveAllowed: false }),
    ];
    const reasons = [
      null,
      'liquidity is unlocked',
      null,
      null,
      null,
      'safety check does not allow live trading',
    ];
    cases.forEach((g, i) => {
      const r = gateToken(g);
      expect(r.reason, `case ${i}`).toBe(reasons[i]);
      expect(Object.keys(r).sort()).toEqual(['liveOk', 'ok', 'reason']);
    });
    expect(gateToken(clean({ lpUnlocked: true, v3Lp: unverifiedV3Lp(POOL, NPM, 'down'), risk: 'any' })).ok).toBe(true);
  });

  it('defaults the trader option off and leaves it off when older state has no field', () => {
    const fresh = new TokenTrader({ store: new MemoryStore() });
    expect(fresh.status().options.v3LpLockCheck).toBe(false);
    fresh.configure({ v3LpLockCheck: true });
    expect(fresh.status().options.v3LpLockCheck).toBe(true);
    fresh.configure({ perTradeUsd: 80 });
    expect(fresh.status().options.v3LpLockCheck).toBe(true);
    fresh.configure({ v3LpLockCheck: false });
    expect(fresh.status().options.v3LpLockCheck).toBe(false);

    const options = { ...DEFAULT_TRADER };
    delete (options as { v3LpLockCheck?: boolean }).v3LpLockCheck;
    const store = new MemoryStore<TraderState>();
    store.data = { version: 1, on: false, options, positions: [], trades: [], feed: [], cursors: {}, snipesAt: [] };
    const loaded = new TokenTrader({ store });
    expect(loaded.status().options.v3LpLockCheck).toBe(false);
  });
});

describe('reader adapter', () => {
  it('turns a contract revert into empty return data and lets a rate limit throw', async () => {
    const revert = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', reason: 'no such function' });
    const rpc = v3LockRpc({ call: async () => { throw revert; } });
    expect(await rpc.call(POOL, '0x')).toBe('0x');

    const limited = Object.assign(new Error('429 Too Many Requests'), { code: 'SERVER_ERROR' });
    const rpc2 = v3LockRpc({ call: async () => { throw limited; } });
    await expect(rpc2.call(POOL, '0x')).rejects.toThrow(/429/);
  });

  it('finds a V3 position manager by gecko id and ignores a V2 dex', () => {
    const dexes = [
      { id: 'uniswap-v2', kind: 'v2' as const, gecko: 'uniswap-v2-robinhood' },
      { id: 'uniswap-v3', kind: 'v3' as const, gecko: 'uniswap-v3-robinhood', positionManager: NPM },
    ];
    expect(positionManagerFor(dexes as never, 'uniswap-v3-robinhood')).toBe(NPM);
    expect(positionManagerFor(dexes as never, 'uniswap-v2-robinhood')).toBeNull();
  });
});
