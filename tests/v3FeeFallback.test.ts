/**
 * A dynamic-fee V3 DEX re-reads the pool's fee() for every quote. When that read fails (RPC error, a pool without
 * fee()), the quote's impact maths falls back to the pool's factory tier instead of throwing the whole quote away.
 */
import { describe, expect, it } from 'vitest';
import { V3_POOL, V3_QUOTER } from '../src/server/dex/abis';
import { V3Adapter } from '../src/server/dex/v3';
import type { DexConfig } from '../src/live/chains';

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(200), T = A(100), QUOTER = A(52);
const SEL_FEE = V3_POOL.getFunction('fee')!.selector;
const sqrt = 2n ** 96n; // price 1

const dexCfg = (dynamicFee: boolean): DexConfig => ({
  id: 'slip', name: 'Slip', kind: 'v3', factory: A(50), router: A(51), quoter: QUOTER, feeTiers: [3000], source: 'test',
  ...(dynamicFee ? { dynamicFee } : {}),
} as DexConfig);

/** A pool whose fee() always fails; everything else a quote needs answers normally. */
function chainWithoutFee() {
  let feeReads = 0;
  return {
    feeReads: () => feeReads,
    call: async (tx: { to: string; data: string }) => {
      const sel = tx.data.slice(0, 10);
      if (tx.to === QUOTER) return V3_QUOTER.encodeFunctionResult('quoteExactInputSingle', [990_000n, sqrt, 0, 100_000n]);
      if (sel === V3_POOL.getFunction('slot0')!.selector) return V3_POOL.encodeFunctionResult('slot0', [sqrt, 0]);
      if (sel === V3_POOL.getFunction('liquidity')!.selector) return V3_POOL.encodeFunctionResult('liquidity', [10n ** 24n]);
      if (sel === V3_POOL.getFunction('token0')!.selector) return V3_POOL.encodeFunctionResult('token0', [W]);
      if (sel === SEL_FEE) { feeReads++; throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); }
      throw new Error('unexpected ' + sel);
    },
  };
}

describe('feeBpsNow: a failed dynamic fee() read falls back to the tier', () => {
  it('returns the factory tier in bps instead of throwing', async () => {
    const c = chainWithoutFee();
    const ad = new V3Adapter(c, dexCfg(true), W);
    // feeBps 7 is a stale earlier read; the fallback is the factory tier 3000 = 30 bps
    await expect(ad.feeBpsNow({ dex: 'slip', kind: 'v3', address: A(1), feeBps: 7, feeTier: 3000 })).resolves.toBe(30);
    expect(c.feeReads()).toBe(1);
  });

  it('with no feeTier on the pool, falls back to its stored feeBps', async () => {
    const ad = new V3Adapter(chainWithoutFee(), dexCfg(true), W);
    await expect(ad.feeBpsNow({ dex: 'slip', kind: 'v3', address: A(1), feeBps: 30 })).resolves.toBe(30);
  });

  it('the quote still completes, with impact priced at the tier fee', async () => {
    const c = chainWithoutFee();
    const ad = new V3Adapter(c, dexCfg(true), W);
    const q = await ad.quote({ dex: 'slip', kind: 'v3', address: A(1), feeBps: 30, feeTier: 3000 }, W, T, 1_000_000n);
    expect(q.amountOut).toBe(990_000n);
    // out 990000 of 1e6 at price 1 is 1 % short; at the 0.3 % tier that is ~0.7 % impact
    expect(q.impact).toBeCloseTo(1 - 0.99 / 0.997, 6);
    expect(c.feeReads()).toBe(1);
  });

  it('a static DEX is unchanged: no fee() read, the pool fee is used as is', async () => {
    const c = chainWithoutFee();
    const ad = new V3Adapter(c, dexCfg(false), W);
    await expect(ad.feeBpsNow({ dex: 'slip', kind: 'v3', address: A(1), feeBps: 30, feeTier: 3000 })).resolves.toBe(30);
    expect(c.feeReads()).toBe(0);
  });
});
