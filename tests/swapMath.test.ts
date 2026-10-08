import { describe, expect, it } from 'vitest';
import {
  NATIVE, applySlippage, approvalNeeded, buildSwapCall, deadlineFromNow, fromUnits,
  getAmountOut, priceImpact, selectPath, toUnits, validateSlippageBps,
} from '../src/live/swapMath';

const WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27';
const DAI = '0xefD766cCb38EaF1dfd701853BFCe31359239F305';
const USDC = '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07';
const ME = '0x1111111111111111111111111111111111111111';

describe('min-out / slippage math', () => {
  it('1% slippage → 99% of quote', () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
  });
  it('rounds DOWN (never asks for more than the quote allows)', () => {
    expect(applySlippage(999n, 100)).toBe(989n); // 989.01 → 989
    expect(applySlippage(1n, 50)).toBe(0n);
  });
  it('works for 18-decimal amounts without precision loss', () => {
    const q = 123_456_789_012_345_678_901_234n;
    expect(applySlippage(q, 100)).toBe((q * 9900n) / 10000n);
  });
  it('rejects zero, negative, fractional and >5% slippage', () => {
    expect(() => applySlippage(1000n, 0)).toThrow();
    expect(() => applySlippage(1000n, -5)).toThrow();
    expect(() => applySlippage(1000n, 1.5)).toThrow();
    expect(() => applySlippage(1000n, 501)).toThrow(/5%/);
    expect(validateSlippageBps(500)).toBeNull();
  });
  it('rejects a non-positive quote', () => {
    expect(() => applySlippage(0n, 100)).toThrow();
  });
});

describe('getAmountOut (PulseX V2, 29 bps fee)', () => {
  it('matches the Uniswap V2 formula with 9971/10000', () => {
    const out = getAmountOut(1000n, 1_000_000n, 2_000_000n, 29);
    const inFee = 1000n * 9971n;
    expect(out).toBe((inFee * 2_000_000n) / (1_000_000n * 10000n + inFee));
  });
  it('matches a real mainnet observation (WPLS→DAI, 2026-10-05)', () => {
    // reserves + router.getAmountsOut result captured from rpc.pulsechain.com during development
    const rIn = 4206586860055299217515162348n; // WPLS
    const rOut = 41272574741491664103731n; // DAI
    expect(getAmountOut(10n ** 24n, rIn, rOut, 29)).toBeGreaterThan(0n);
  });
  it('throws on empty pools', () => {
    expect(() => getAmountOut(1n, 0n, 10n)).toThrow(/liquidity/);
  });
});

describe('price impact', () => {
  it('is ~0 for a tiny trade in a deep pool', () => {
    const rIn = 10n ** 30n, rOut = 10n ** 28n, a = 10n ** 18n;
    const out = getAmountOut(a, rIn, rOut);
    expect(priceImpact(a, out, [{ reserveIn: rIn, reserveOut: rOut }])).toBeLessThan(1e-6);
  });
  it('is ~ trade/reserve for a 1% sized trade', () => {
    const rIn = 1_000_000n * 10n ** 18n, rOut = 10_000n * 10n ** 18n, a = 10_000n * 10n ** 18n;
    const out = getAmountOut(a, rIn, rOut);
    const imp = priceImpact(a, out, [{ reserveIn: rIn, reserveOut: rOut }]);
    expect(imp).toBeGreaterThan(0.009);
    expect(imp).toBeLessThan(0.011);
  });
  it('flags a big trade in a thin pool above a 3% cap', () => {
    const rIn = 100n * 10n ** 18n, rOut = 100n * 10n ** 6n, a = 10n * 10n ** 18n;
    const out = getAmountOut(a, rIn, rOut);
    expect(priceImpact(a, out, [{ reserveIn: rIn, reserveOut: rOut }])).toBeGreaterThan(0.03);
  });
});

describe('path selection', () => {
  it('native in → [WPLS, token]', () => {
    expect(selectPath(NATIVE, DAI, WPLS)).toEqual([WPLS, DAI]);
  });
  it('token → native → [token, WPLS]', () => {
    expect(selectPath(USDC, NATIVE, WPLS)).toEqual([USDC, WPLS]);
  });
  it('token → token direct when a pair exists, via WPLS otherwise', () => {
    expect(selectPath(USDC, DAI, WPLS, true)).toEqual([USDC, DAI]);
    expect(selectPath(USDC, DAI, WPLS, false)).toEqual([USDC, WPLS, DAI]);
  });
  it('rejects same-token swaps (incl. native vs WPLS)', () => {
    expect(() => selectPath(NATIVE, WPLS, WPLS)).toThrow();
  });
});

describe('buildSwapCall', () => {
  const deadline = 1_900_000_000n;
  it('sell PLS → swapExactETHForTokens with value = amountIn', () => {
    const c = buildSwapCall({ tokenIn: NATIVE, tokenOut: DAI, amountIn: 10n ** 21n, quotedOut: 10n ** 19n, slippageBps: 100, recipient: ME, wpls: WPLS, deadline });
    expect(c.method).toBe('swapExactETHForTokens');
    expect(c.value).toBe(10n ** 21n);
    expect(c.args).toEqual([(10n ** 19n * 9900n) / 10000n, [WPLS, DAI], ME, deadline]);
  });
  it('buy PLS with stable → swapExactTokensForETH, no value', () => {
    const c = buildSwapCall({ tokenIn: USDC, tokenOut: NATIVE, amountIn: 5_000_000n, quotedOut: 10n ** 24n, slippageBps: 100, recipient: ME, wpls: WPLS, deadline });
    expect(c.method).toBe('swapExactTokensForETH');
    expect(c.value).toBe(0n);
    expect(c.args[0]).toBe(5_000_000n);
    expect(c.args[2]).toEqual([USDC, WPLS]);
  });
  it('token → token → swapExactTokensForTokens', () => {
    const c = buildSwapCall({ tokenIn: USDC, tokenOut: DAI, amountIn: 1n, quotedOut: 1000n, slippageBps: 100, recipient: ME, wpls: WPLS, deadline, hasDirectPair: false });
    expect(c.method).toBe('swapExactTokensForTokens');
    expect(c.path).toEqual([USDC, WPLS, DAI]);
  });
  it('rejects a bad recipient and zero amounts', () => {
    expect(() => buildSwapCall({ tokenIn: NATIVE, tokenOut: DAI, amountIn: 1n, quotedOut: 1n, slippageBps: 100, recipient: 'nope', wpls: WPLS, deadline })).toThrow();
    expect(() => buildSwapCall({ tokenIn: NATIVE, tokenOut: DAI, amountIn: 0n, quotedOut: 1n, slippageBps: 100, recipient: ME, wpls: WPLS, deadline })).toThrow();
  });
});

describe('deadline + approvals + units', () => {
  it('deadline is now + minutes, bounded 1..60', () => {
    expect(deadlineFromNow(10, 1000)).toBe(1600n);
    expect(() => deadlineFromNow(0)).toThrow();
    expect(() => deadlineFromNow(61)).toThrow();
  });
  it('approves EXACT amount, never unlimited; none for native or enough allowance', () => {
    expect(approvalNeeded(USDC, 0n, 5_000_000n)).toBe(5_000_000n);
    expect(approvalNeeded(USDC, 5_000_000n, 5_000_000n)).toBeNull();
    expect(approvalNeeded(NATIVE, 0n, 10n)).toBeNull();
    expect(approvalNeeded(USDC, 0n, 5n)).not.toBe(2n ** 256n - 1n);
  });
  it('toUnits / fromUnits round-trip', () => {
    expect(toUnits('1.5', 6)).toBe(1_500_000n);
    expect(toUnits('0.000001', 6)).toBe(1n);
    expect(toUnits(2, 18)).toBe(2n * 10n ** 18n);
    expect(fromUnits(1_500_000n, 6)).toBeCloseTo(1.5);
    expect(() => toUnits('-1', 6)).toThrow();
    expect(() => toUnits('abc', 6)).toThrow();
  });
});
