/**
 * Token discovery priced every V3 pool at the DEX's first tier (0.01 %), so a 1 % pool's fee was understated 100×.
 * Pools now carry their own fee() (V2: the DEX's fee); dynamic-fee pools are read at quote time, never cached.
 */
import { describe, expect, it } from 'vitest';
import { AbiCoder } from 'ethers';
import { V3_FACTORY, V3_POOL, V3_QUOTER, V3_ROUTER } from '../src/server/dex/abis';
import { feeTierToBps, poolFeeBps, readV3FeeBps } from '../src/server/dex/poolFee';
import { V3Adapter } from '../src/server/dex/v3';
import { withPoolFees } from '../src/server/market/tokenFeed';
import { sizeBuy, type FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { DexConfig } from '../src/live/chains';
import type { GateInput } from '../src/market/tokenTrader';
import { feePct } from '../src/ui/TokenTrader';

const SEL_FEE = V3_POOL.getFunction('fee')!.selector;
const enc = (tier: number) => AbiCoder.defaultAbiCoder().encode(['uint24'], [tier]);
/** A chain whose pools answer fee() from a table (address → tier, or a function for a changing fee) */
function chain(fees: Record<string, number | (() => number)>) {
  const calls: string[] = [];
  return {
    calls,
    call: async (tx: { to: string; data: string }) => {
      calls.push(`${tx.to}:${tx.data.slice(0, 10)}`);
      const f = fees[tx.to.toLowerCase()];
      if (tx.data.startsWith(SEL_FEE) && f != null) return enc(typeof f === 'function' ? f() : f);
      throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
    },
  };
}
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');

describe('pool fee from the pool', () => {
  it('fee() tiers → bps: 0.01 %, 0.05 %, 0.3 %, 1 %', async () => {
    const c = chain({ [A(1)]: 100, [A(2)]: 500, [A(3)]: 3000, [A(4)]: 10000 });
    expect(await Promise.all([1, 2, 3, 4].map((i) => readV3FeeBps(c, A(i))))).toEqual([1, 5, 30, 100]);
    expect([100, 500, 3000, 10000].map(feeTierToBps)).toEqual([1, 5, 30, 100]);
    expect([1, 5, 30, 100].map(feePct)).toEqual(['0.01%', '0.05%', '0.3%', '1%']);
  });
  it('V2 uses the DEX fee; a pool without fee() is unknown (null), never a guessed tier', async () => {
    const c = chain({});
    expect(await poolFeeBps(c, A(9), { kind: 'v2', feeBps: 29 })).toBe(29);
    expect(await poolFeeBps(c, A(9), { kind: 'v3' })).toBeNull();
    expect(await poolFeeBps(c, A(9), { kind: 'v4' })).toBeNull();
  });
});

const fresh = (o: Partial<FreshPool>): FreshPool => ({
  chainId: 1, pool: A(1), dex: 'uniswap_v3', kind: 'v3', token: A(100), spend: A(200), tokenSymbol: 'T', spendSymbol: 'WETH',
  liquidityUsd: 100_000, volumeUsd: 10_000, createdAt: null, source: 'new', quoteReserve: 20, tokenReserve: 2_000_000, feeBps: 1, price: 0.00001, usdPerSpend: 2500, ...o,
});
const uni: Pick<DexConfig, 'kind' | 'feeBps' | 'dynamicFee'> = { kind: 'v3' };

describe('discovery: withPoolFees', () => {
  it('each V3 pool gets its own fee (not the DEX first tier); V2 the DEX fee; unreadable or unknown DEX pools are dropped', async () => {
    const c = chain({ [A(1)]: 100, [A(2)]: 500, [A(3)]: 3000, [A(4)]: 10000 });
    const pools = [1, 2, 3, 4].map((i) => fresh({ pool: A(i) }));
    pools.push(fresh({ pool: A(5), dex: 'uniswap_v2', kind: 'v3' }), fresh({ pool: A(6) }), fresh({ pool: A(7), dex: 'mystery' }), fresh({ pool: A(8), dex: 'uniswap-v4', kind: 'v4' }));
    const out = await withPoolFees(pools, () => c, (p) => (p.dex === 'mystery' ? null : p.dex === 'uniswap_v2' ? { kind: 'v2', feeBps: 30 } : p.dex === 'uniswap-v4' ? { kind: 'v4' } : uni));
    expect(out.map((p) => [p.pool, p.kind, p.feeBps])).toEqual([[A(1), 'v3', 1], [A(2), 'v3', 5], [A(3), 'v3', 30], [A(4), 'v3', 100], [A(5), 'v2', 30]]);
  });

  it('sizing a 1 % pool pays 100× the fee of a 0.01 % pool', () => {
    const base = { perTradeUsd: 100, totalUsd: 500, openUsd: 0, quoteReserve: 1e6, usdPerSpend: 1, price: 1, maxImpact: 0.03 };
    const lo = sizeBuy({ ...base, feeBps: 1 })!, hi = sizeBuy({ ...base, feeBps: 100 })!;
    const feeLo = 100 - lo.tokens, feeHi = 100 - hi.tokens; // at price 1 and deep liquidity, tokens ≈ spend − fee − impact
    expect(feeHi / feeLo).toBeGreaterThan(50);
    expect(hi.tokens).toBeLessThan(99.01); // (paper sizing charges the buy fee twice today; fixed in the effective-entry PR)
    expect(lo.tokens).toBeGreaterThan(99.96);
  });

  it('a dynamic-fee DEX marks its pools dynamic', async () => {
    const c = chain({ [A(1)]: 500 });
    const [p] = await withPoolFees([fresh({})], () => c, () => ({ kind: 'v3', dynamicFee: true }));
    expect(p).toMatchObject({ feeBps: 5, dynamicFee: true });
  });
});

describe('dynamic-fee pools: fee read at quote time', () => {
  const W = A(200), T = A(100);
  const dexCfg = (dynamicFee: boolean): DexConfig => ({ id: 'slip', name: 'Slip', kind: 'v3', factory: A(50), router: A(51), quoter: A(52), feeTiers: [100], source: 'test', ...(dynamicFee ? { dynamicFee } : {}) } as DexConfig);
  function quoterChain(feeSeq: number[]) {
    let feeReads = 0;
    const sqrt = 2n ** 96n; // price 1
    return {
      feeReads: () => feeReads,
      call: async (tx: { to: string; data: string }) => {
        const sel = tx.data.slice(0, 10);
        if (tx.to === A(52)) return V3_QUOTER.encodeFunctionResult('quoteExactInputSingle', [990_000n, sqrt, 0, 100_000n]);
        if (sel === V3_POOL.getFunction('slot0')!.selector) return V3_POOL.encodeFunctionResult('slot0', [sqrt, 0]);
        if (sel === V3_POOL.getFunction('liquidity')!.selector) return V3_POOL.encodeFunctionResult('liquidity', [10n ** 24n]);
        if (sel === V3_POOL.getFunction('token0')!.selector) return V3_POOL.encodeFunctionResult('token0', [W]);
        if (sel === SEL_FEE) { const f = feeSeq[Math.min(feeReads, feeSeq.length - 1)]; feeReads++; return enc(f); }
        throw new Error('unexpected ' + sel);
      },
    };
  }
  const pool = { dex: 'slip', kind: 'v3' as const, address: A(1), feeBps: 1, feeTier: 100 };

  it('the impact is computed with the fee read for that quote, and it changes between quotes', async () => {
    const c = quoterChain([30, 100].map((b) => b * 100));
    const ad = new V3Adapter(c, dexCfg(true), W);
    const q1 = await ad.quote(pool, W, T, 1_000_000n);
    const q2 = await ad.quote(pool, W, T, 1_000_000n);
    expect(c.feeReads()).toBe(2);
    // out 990000 of 1e6 at price 1: 1 % short. At a 0.3 % fee that's ~0.7 % impact; at 1 %, ~0.
    expect(q1.impact).toBeCloseTo(1 - 0.99 / 0.997, 6);
    expect(q2.impact).toBeCloseTo(0, 6);
    expect([await ad.feeBpsNow(pool), await ad.feeBpsNow(pool)]).toEqual([100, 100]);
  });

  it('a static V3 DEX never re-reads fee() at quote time', async () => {
    const c = quoterChain([3000]);
    const ad = new V3Adapter(c, dexCfg(false), W);
    await ad.quote({ ...pool, feeBps: 30, feeTier: 3000 }, W, T, 1_000_000n);
    expect(c.feeReads()).toBe(0);
  });

  it('token trader: a dynamic pool is sized at the fee read at buy time, and sells re-read it', async () => {
    const clean = (): GateInput => ({ mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0, liquidityUsd: 1e5, minLiquidityUsd: 0, canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null, holderConcentration: null, recentLiqPull: false, liveAllowed: true });
    const fees = [30, 100, 25];
    let wave = [fresh({ pool: A(11), dynamicFee: true, feeBps: 5, createdAt: 0 }), fresh({ pool: A(22), dynamicFee: true, feeBps: 5, createdAt: 0 })];
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => 1e12,
      discover: async () => { const w = wave; wave = []; return w; }, assess: async () => clean(),
      feeNow: async () => fees.shift()!,
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0 });
    t.turnOn();
    await t.tick();
    const [p1, p2] = t.status().positions;
    expect([p1.feeBps, p2.feeBps]).toEqual([30, 100]);
    expect(p2.tokens).toBeLessThan(p1.tokens); // the higher fee bought fewer tokens
    t.mark(p1.id, { price: p1.entryPrice * 0.7 });
    await t.tick(); // the hard stop sells p1 at the fee read now
    expect(t.status().positions.map((p) => p.pool)).toEqual([A(22)]);
    expect(fees).toEqual([]); // p1's sell (25) was read; p2's hold needed no fee
  });
});

describe('findPools: feeTier stays the factory tier', () => {
  const W = A(200), T = A(100), FACTORY = A(50), QUOTER = A(52), ROUTER = A(51), POOL = A(1);
  const ZERO = '0x' + '0'.repeat(40);
  const SEL_GET = V3_FACTORY.getFunction('getPool')!.selector;
  const sqrt = 2n ** 96n;
  /** Factory tier 100 has a pool whose fee() is not 100. Other tiers have no pool. */
  function splitChain(dynamicFee: boolean, feeNow: () => number) {
    let feeReads = 0;
    const quotedFees: bigint[] = [];
    const cfg: DexConfig = {
      id: 'slip', name: 'Slip', kind: 'v3', factory: FACTORY, router: ROUTER, quoter: QUOTER,
      feeTiers: [100, 500, 3000, 10000], source: 'test', ...(dynamicFee ? { dynamicFee: true } : {}),
    };
    const call = async (tx: { to: string; data: string }) => {
      const sel = tx.data.slice(0, 10);
      const to = tx.to.toLowerCase();
      if (to === FACTORY.toLowerCase() && sel === SEL_GET) {
        const fee = Number(V3_FACTORY.decodeFunctionData('getPool', tx.data)[2]);
        return V3_FACTORY.encodeFunctionResult('getPool', [fee === 100 ? POOL : ZERO]);
      }
      if (to === POOL.toLowerCase() && sel === SEL_FEE) { feeReads++; return enc(feeNow()); }
      if (to === QUOTER.toLowerCase()) {
        const q = V3_QUOTER.decodeFunctionData('quoteExactInputSingle', tx.data)[0] as { fee: bigint };
        quotedFees.push(q.fee);
        return V3_QUOTER.encodeFunctionResult('quoteExactInputSingle', [990_000n, sqrt, 0, 100_000n]);
      }
      if (to === POOL.toLowerCase() && sel === V3_POOL.getFunction('slot0')!.selector) return V3_POOL.encodeFunctionResult('slot0', [sqrt, 0]);
      if (to === POOL.toLowerCase() && sel === V3_POOL.getFunction('liquidity')!.selector) return V3_POOL.encodeFunctionResult('liquidity', [10n ** 24n]);
      if (to === POOL.toLowerCase() && sel === V3_POOL.getFunction('token0')!.selector) return V3_POOL.encodeFunctionResult('token0', [W]);
      throw new Error('unexpected ' + to + ' ' + sel);
    };
    return { cfg, call, feeReads: () => feeReads, quotedFees };
  }

  it('a static pool takes feeBps from the factory tier and still quotes and swaps on that tier', async () => {
    const c = splitChain(false, () => 10000);
    const ad = new V3Adapter(c, c.cfg, W);
    const [pool] = await ad.findPools(W, T);
    expect(pool.address.toLowerCase()).toBe(POOL);
    expect(pool).toMatchObject({ kind: 'v3', feeTier: 100, feeBps: 1 });
    expect(c.feeReads()).toBe(0);
    const q = await ad.quote(pool, W, T, 1_000_000n);
    expect(c.feeReads()).toBe(0);
    expect(c.quotedFees).toEqual([100n]);
    // The quoter mock returns a 1% shortfall. Impact is priced at the 0.01% tier, not at that shortfall.
    expect(q.impact).toBeCloseTo(1 - 990_000 / (1_000_000 * (1 - 1 / 10_000)), 6);
    const built = ad.buildSwap({ pool, tokenIn: W, tokenOut: T, amountIn: 1_000_000n, amountOutMin: 1n, recipient: A(9), deadline: 99n });
    const single = V3_ROUTER.decodeFunctionData('exactInputSingle', (built.args as [bigint, string[]])[1][0])[0] as { fee: bigint };
    expect(single.fee).toBe(100n);
    expect(pool.feeTier).toBe(100);
  });

  it('a dynamic-fee pool keeps the factory tier while each quote re-reads fee()', async () => {
    const fees = [10000, 3000, 500];
    const c = splitChain(true, () => fees.shift()!);
    const ad = new V3Adapter(c, c.cfg, W);
    const [pool] = await ad.findPools(W, T);
    expect(pool).toMatchObject({ feeTier: 100, feeBps: 100 });
    const q1 = await ad.quote(pool, W, T, 1_000_000n);
    const q2 = await ad.quote(pool, W, T, 1_000_000n);
    expect(c.quotedFees).toEqual([100n, 100n]);
    expect(pool.feeTier).toBe(100);
    expect(q1.impact).toBeCloseTo(1 - 0.99 / 0.997, 6);
    expect(q2.impact).toBeCloseTo(1 - 0.99 / 0.9995, 6);
    expect(c.feeReads()).toBe(3);
    expect(fees).toEqual([]);
  });

  it('a failed fee() read keeps the pool with feeBps equal to the factory tier', async () => {
    const c = splitChain(true, () => { throw new Error('no fee()'); });
    const ad = new V3Adapter(c, c.cfg, W);
    const [pool] = await ad.findPools(W, T);
    expect(pool.address.toLowerCase()).toBe(POOL);
    expect(pool).toMatchObject({ kind: 'v3', feeTier: 100, feeBps: 1 });
    expect(c.feeReads()).toBe(1);
  });

  it('a non-dynamic DEX makes no fee() call in findPools', async () => {
    const c = splitChain(false, () => 10000);
    const ad = new V3Adapter(c, c.cfg, W);
    const pools = await ad.findPools(W, T);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ feeTier: 100, feeBps: 1 });
    expect(c.feeReads()).toBe(0);
  });
});
