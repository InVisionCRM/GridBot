import { beforeEach, describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { applyLpUnlock, cachedTokenLp, clearLpUnlockCache, clearTokenLpCache, lpUnlockFromV3, readV2LpUnlock, unverifiedLpUnlock, type LpUnlockRpc } from '../src/market/lpUnlock';
import { encodeV3Mint } from '../src/market/poolEvents';
import { gateToken, type FreshPool, type GateInput } from '../src/market/tokenTrader';
import {
  BURN_ADDRESSES, clearV3LpLockCache, encodeIncreaseLiquidity, inspectV3LpLock, MULTICALL3, unverifiedV3Lp,
  V3_LP_IFACE, type V3LockLog, type V3LockRpc,
} from '../src/market/v3LpLock';
import { DEFAULT_TRADER, TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';

const PAIR = '0x' + 'aa'.repeat(20);
const TOKEN = '0x' + 'bb'.repeat(20);
const OWNER = '0x' + 'cc'.repeat(20);
const V3_POOL = '0x' + 'd4'.repeat(20);
const NPM = '0x' + 'cd'.repeat(20);
const TOKEN0 = '0x' + '11'.repeat(20);
const TOKEN1 = '0x' + '22'.repeat(20);
const EOA = '0x' + '44'.repeat(20);
const DEAD = BURN_ADDRESSES[1];
const BACKOFF = [1000, 2000, 4000, 8000, 16000];

const ERC = new Interface([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);

const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 50_000, minLiquidityUsd: 5_000,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: 0.1, recentLiqPull: false, liveAllowed: true, ...o,
});

function selector(data: string): string { return data.slice(0, 10).toLowerCase(); }

function v2rpc(o: { total: bigint; burned: bigint; owner: string | null; ownerBalance: bigint; multicall: boolean; fail?: 'refused' | '429' }) {
  const calls: { to: string; data: string }[] = [];
  const sleeps: number[] = [];
  const supply = ERC.getFunction('totalSupply')!.selector.toLowerCase();
  const balance = ERC.getFunction('balanceOf')!.selector.toLowerCase();
  const owner = ERC.getFunction('owner')!.selector.toLowerCase();
  const answer = (to: string, data: string): string => {
    const sel = selector(data);
    const who = to.toLowerCase();
    if (who === MULTICALL3.toLowerCase() && sel === V3_LP_IFACE.multicall.getFunction('aggregate3')!.selector.toLowerCase()) {
      const decoded = V3_LP_IFACE.multicall.decodeFunctionData('aggregate3', data);
      const rows = [...decoded[0]] as { target?: string; callData?: string; 0?: string; 2?: string }[];
      const results = rows.map((row) => {
        const ret = answer(String(row.target ?? row[0]), String(row.callData ?? row[2]));
        return ret === '0x' ? [false, '0x'] : [true, ret];
      });
      return V3_LP_IFACE.multicall.encodeFunctionResult('aggregate3', [results]);
    }
    if (who === PAIR && sel === supply) return ERC.encodeFunctionResult('totalSupply', [o.total]);
    if (who === PAIR && sel === balance) {
      const [holder] = ERC.decodeFunctionData('balanceOf', data);
      const h = String(holder).toLowerCase();
      const amount = h === DEAD ? o.burned : (o.owner && h === o.owner.toLowerCase() ? o.ownerBalance : 0n);
      return ERC.encodeFunctionResult('balanceOf', [amount]);
    }
    if (who === TOKEN && sel === owner) return o.owner ? ERC.encodeFunctionResult('owner', [o.owner]) : '0x';
    return '0x';
  };
  const rpc: LpUnlockRpc = {
    async call(to, data) {
      if (o.fail === 'refused') throw new Error('connection refused');
      if (o.fail === '429') throw new Error('429 Too Many Requests');
      calls.push({ to, data });
      return answer(to, data);
    },
    async getCode() {
      if (o.fail === 'refused') throw new Error('connection refused');
      if (o.fail === '429') throw new Error('429 Too Many Requests');
      return o.multicall ? '0x6001600d6000396000f3' : '0x';
    },
  };
  return { rpc, calls, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

async function readV2(o: Parameters<typeof v2rpc>[0]) {
  const w = v2rpc(o);
  const evidence = await readV2LpUnlock(w.rpc, {
    chainId: 4663, pool: PAIR, token: TOKEN, gapMs: 0, sleep: w.sleep, clock: () => 0,
  });
  return { evidence, ...w };
}

function v3rpc(o: { liquidity: bigint; owner: string; fail?: boolean }) {
  const head = 100;
  const tx = '0x' + '1'.padStart(64, '0');
  const mint = encodeV3Mint(o.liquidity, 1n, 1n);
  const inc = encodeIncreaseLiquidity(1n, o.liquidity);
  const mints: V3LockLog[] = [{ address: V3_POOL, topics: mint.topics, data: mint.data, blockNumber: 40, transactionHash: tx }];
  const receipt = { logs: [{ address: NPM, topics: inc.topics, data: inc.data, blockNumber: 40, transactionHash: tx }] };
  const answer = (to: string, data: string): string => {
    const sel = selector(data);
    const who = to.toLowerCase();
    const pool = V3_LP_IFACE.pool;
    const npm = V3_LP_IFACE.npm;
    if (who === V3_POOL) {
      if (sel === pool.getFunction('slot0')!.selector.toLowerCase()) return pool.encodeFunctionResult('slot0', [1n, 0]);
      if (sel === pool.getFunction('liquidity')!.selector.toLowerCase()) return pool.encodeFunctionResult('liquidity', [o.liquidity]);
      if (sel === pool.getFunction('token0')!.selector.toLowerCase()) return pool.encodeFunctionResult('token0', [TOKEN0]);
      if (sel === pool.getFunction('token1')!.selector.toLowerCase()) return pool.encodeFunctionResult('token1', [TOKEN1]);
      if (sel === pool.getFunction('fee')!.selector.toLowerCase()) return pool.encodeFunctionResult('fee', [3000]);
    }
    if (who === NPM.toLowerCase()) {
      if (sel === npm.getFunction('positions')!.selector.toLowerCase()) {
        return npm.encodeFunctionResult('positions', [0, EOA, TOKEN0, TOKEN1, 3000, -60, 60, o.liquidity, 0, 0, 0, 0]);
      }
      if (sel === npm.getFunction('ownerOf')!.selector.toLowerCase()) return npm.encodeFunctionResult('ownerOf', [o.owner]);
    }
    return '0x';
  };
  const rpc: V3LockRpc = {
    async call(to, data) {
      if (o.fail) throw new Error('connection refused');
      return answer(to, data);
    },
    async getCode() { return '0x'; },
    async getLogs(f) {
      if (o.fail) throw new Error('connection refused');
      return mints.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async getReceipt() { return receipt; },
    async blockNumber() {
      if (o.fail) throw new Error('connection refused');
      return head;
    },
  };
  return rpc;
}

async function v3Evidence(o: { liquidity: bigint; owner: string; fail?: boolean }) {
  const report = await inspectV3LpLock(v3rpc(o), {
    chainId: 4663, pool: V3_POOL, positionManager: NPM, nowSec: 1_700_000_000,
    gapMs: 0, chunkBlocks: 500, maxBlockSpan: 500, clock: () => 0, sleep: async () => undefined,
  });
  return { report, evidence: lpUnlockFromV3(report) };
}

beforeEach(() => { clearLpUnlockCache(); clearTokenLpCache(); clearV3LpLockCache(); });

describe('live lpUnlocked', () => {
  it('does not trust the token contract when the pair is not burned', async () => {
    const { evidence, calls } = await readV2({ total: 1000n, burned: 100n, owner: OWNER, ownerBalance: 600n, multicall: true });
    expect(evidence).toMatchObject({ kind: 'v2', status: 'unverified', lpUnlocked: null });
    expect(calls.every((c) => c.to.toLowerCase() !== TOKEN)).toBe(true);
    const agg = V3_LP_IFACE.multicall.getFunction('aggregate3')!.selector.toLowerCase();
    expect(calls.some((c) => selector(c.data) === agg)).toBe(true);
    const result = gateToken(applyLpUnlock(clean({ mode: 'live', risk: 'safe' }), true, evidence));
    expect(result.ok).toBe(false);
    expect(result.liveOk).toBe(false);
    expect(result.reason).toBe('liquidity lock unverified');
    expect(gateToken(applyLpUnlock(clean({ mode: 'live', risk: 'medium' }), true, evidence)).reason).toBe('liquidity lock unverified');
  });

  it('maps a V2 pair that is at least 90% burned to lpUnlocked false', async () => {
    const { evidence, calls } = await readV2({ total: 1000n, burned: 950n, owner: OWNER, ownerBalance: 10n, multicall: false });
    expect(evidence).toMatchObject({ kind: 'v2', status: 'verified', lpUnlocked: false });
    expect(calls.every((c) => c.to.toLowerCase() !== TOKEN)).toBe(true);
    const result = gateToken(applyLpUnlock(clean({ mode: 'live' }), true, evidence));
    expect(result.reason).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.liveOk).toBe(true);
  });

  it('maps a burned V3 position NFT to lpUnlocked false', async () => {
    const { report, evidence } = await v3Evidence({ liquidity: 1000n, owner: DEAD });
    expect(report.status).toBe('verified');
    expect(report.shares.burn).toBe(1);
    expect(evidence).toMatchObject({ kind: 'v3', status: 'verified', lpUnlocked: false });
    const result = gateToken(applyLpUnlock(clean({ mode: 'live' }), true, evidence));
    expect(result.reason).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('maps an EOA-held V3 position to lpUnlocked true and blocks a live buy', async () => {
    const { report, evidence } = await v3Evidence({ liquidity: 1000n, owner: EOA });
    expect(report.status).toBe('verified');
    expect(report.shares.eoa).toBe(1);
    expect(evidence).toMatchObject({ kind: 'v3', status: 'verified', lpUnlocked: true });
    const result = gateToken(applyLpUnlock(clean({ mode: 'live' }), true, evidence));
    expect(result.reason).toBe('liquidity is unlocked');
    expect(result.ok).toBe(false);
    expect(result.liveOk).toBe(false);
  });

  it('fails closed when the V2 read or the V3 position read cannot be verified', async () => {
    const refused = await readV2({ total: 1000n, burned: 950n, owner: OWNER, ownerBalance: 0n, multicall: false, fail: 'refused' });
    expect(refused.evidence.status).toBe('unverified');
    expect(refused.evidence.detail).toMatch(/connection refused/);
    expect(refused.sleeps).toEqual([]);
    const blocked = gateToken(applyLpUnlock(clean({ mode: 'live', lpUnlocked: false }), true, refused.evidence));
    expect(blocked.reason).toBe('liquidity lock unverified');
    expect(blocked.ok).toBe(false);

    clearLpUnlockCache();
    const limited = await readV2({ total: 1000n, burned: 950n, owner: OWNER, ownerBalance: 0n, multicall: true, fail: '429' });
    expect(limited.evidence.status).toBe('unverified');
    expect(limited.evidence.detail).toMatch(/429/);
    expect(limited.sleeps).toEqual(BACKOFF);

    const v3 = await v3Evidence({ liquidity: 1000n, owner: DEAD, fail: true });
    expect(v3.report.status).toBe('unverified');
    expect(v3.evidence).toMatchObject({ kind: 'v3', status: 'unverified', lpUnlocked: null });
    expect(gateToken(applyLpUnlock(clean({ mode: 'live' }), true, v3.evidence)).reason).toBe('V3 liquidity lock unverified');
    expect(gateToken(applyLpUnlock(clean({ risk: 'any', lpUnlocked: true }), true, v3.evidence)).ok).toBe(true);
  });

  it('leaves the gate unchanged when the flag is off', async () => {
    const { evidence } = await readV2({ total: 1000n, burned: 100n, owner: OWNER, ownerBalance: 600n, multicall: true });
    const gate = clean();
    applyLpUnlock(gate, false, evidence);
    expect(gate.lpUnlocked).toBeNull();
    expect(gate.lpUnlock).toBeUndefined();

    const cases: GateInput[] = [
      clean({ lpUnlocked: false }),
      clean({ lpUnlocked: true, risk: 'medium' }),
      clean(),
      clean({ lpUnlocked: false, risk: 'safe' }),
      clean({ risk: 'any', lpUnlocked: true, proxy: true, canPause: true }),
      clean({ mode: 'live', risk: 'any', liveAllowed: false }),
    ];
    const reasons = [null, 'liquidity is unlocked', null, null, null, 'safety check does not allow live trading'];
    cases.forEach((g, i) => {
      const r = gateToken(g);
      expect(r.reason, `case ${i}`).toBe(reasons[i]);
      expect(Object.keys(r).sort()).toEqual(['liveOk', 'ok', 'reason']);
    });

    const onlyV3 = gateToken(clean({ v3Lp: unverifiedV3Lp(V3_POOL, NPM, 'down') }));
    expect(onlyV3.reason).toBe('V3 liquidity lock unverified');
    expect(Object.keys(onlyV3).sort()).toEqual(['liveOk', 'ok', 'reason', 'v3Lp']);

    const fresh = new TokenTrader({ store: new MemoryStore() });
    expect(fresh.status().options.lpUnlockCheck).toBe(false);
    expect(DEFAULT_TRADER.lpUnlockCheck).toBe(false);
    fresh.configure({ lpUnlockCheck: true });
    expect(fresh.status().options.lpUnlockCheck).toBe(true);
    fresh.configure({ perTradeUsd: 80 });
    expect(fresh.status().options.lpUnlockCheck).toBe(true);
    fresh.configure({ v3LpLockCheck: true });
    expect(fresh.status().options.lpUnlockCheck).toBe(true);
    fresh.configure({ lpUnlockCheck: false });
    expect(fresh.status().options.lpUnlockCheck).toBe(false);
    expect(fresh.status().options.v3LpLockCheck).toBe(true);

    const options = { ...DEFAULT_TRADER };
    delete (options as { lpUnlockCheck?: boolean }).lpUnlockCheck;
    const store = new MemoryStore<TraderState>();
    store.data = { version: 1, on: false, options, positions: [], trades: [], feed: [], cursors: {}, snipesAt: [] };
    expect(new TokenTrader({ store }).status().options.lpUnlockCheck).toBe(false);
  });

  it('a slow LP check does not delay the hard stop', async () => {
    const now = 1_700_000_000_000;
    const bought: FreshPool = {
      chainId: 4663, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3',
      token: TOKEN, spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WETH',
      liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: now - 48 * 3600_000, source: 'new',
      quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
    };
    let hang = false;
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const t = new TokenTrader({
      store: new MemoryStore(),
      now: () => now,
      discover: async () => [bought],
      assess: async () => { if (hang) await gate; return clean({ liquidityUsd: 80_000, minLiquidityUsd: 0 }); },
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, risk: 'safe', lpUnlockCheck: true });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(1);
    hang = true;
    const slowBuy = t.tick();
    await new Promise((r) => setImmediate(r));
    const open = t.status().positions[0];
    t.mark(open.id, { price: open.entryPrice * 0.7 });
    const started = Date.now();
    await t.tick();
    expect(Date.now() - started).toBeLessThan(500);
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().trades[0].why).toMatch(/hard stop/);
    release();
    await slowBuy;
  });

  it('times out a slow per-token read and then uses the cached result', async () => {
    let calls = 0;
    const key = '4663:0x' + 'ab'.repeat(20);
    const first = await cachedTokenLp(key, () => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => resolve({ lp: { kind: 'v2', status: 'verified', lpUnlocked: false, detail: 'burned' } }), 40);
    }), { timeoutMs: 10, clock: () => 0, fallback: () => ({ lp: unverifiedLpUnlock('v2', 'lp check timed out') }) });
    expect(first.lp?.status).toBe('unverified');
    expect(first.lp?.detail).toMatch(/timed out/);
    await new Promise((r) => setTimeout(r, 50));
    const second = await cachedTokenLp(key, () => { calls += 1; return Promise.resolve({ lp: unverifiedLpUnlock('v2', 'should not run') }); }, {
      timeoutMs: 10, clock: () => 0, fallback: () => ({ lp: unverifiedLpUnlock('v2', 'lp check timed out') }),
    });
    expect(calls).toBe(1);
    expect(second.lp).toMatchObject({ status: 'verified', lpUnlocked: false });
  });
});
