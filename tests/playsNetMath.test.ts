import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/market/tokenTrader';
import {
  feeBpsFromUniswapFee, feeFraction, netReturn, proceeds, resolveFeeFraction, roundTrip, roundTripFromTiers,
  stopTriggerPrice, takeProfitTriggerPrice, tokensBought, trailingTriggerPrice, triggerPrice,
  type LegCost,
} from '../src/plays/netMath';

const onePct = (over: Partial<LegCost> = {}): LegCost => ({ fee: 0.01, impact: 0, tax: 0, gasQuote: 0, ...over });

describe('fee tier', () => {
  it('converts a Uniswap fee() and never invents the 0.01% tier', () => {
    expect(feeBpsFromUniswapFee(10_000)).toBe(100);
    expect(feeBpsFromUniswapFee(100)).toBe(1);
    expect(feeFraction(100)).toBe(0.01);
    expect(feeFraction(1)).toBe(0.0001);
    expect(resolveFeeFraction(100)).toBe(0.01);
    expect(resolveFeeFraction('dynamic')).toBeNull();
    expect(resolveFeeFraction(Number.NaN)).toBeNull();

    const missing = roundTripFromTiers({
      size: 100, entryTier: 'dynamic', exitTier: 100,
      impactEntry: 0, impactExit: 0, taxEntry: 0, taxExit: 0, gasQuoteEntry: 0, gasQuoteExit: 0,
    });
    expect(missing).toEqual({ error: expect.stringMatching(/0\.01%/) });

    const src = readFileSync(new URL('../src/plays/netMath.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/feeTiers\[0\]/);
    expect(src).not.toMatch(/0\.0001/);
  });

  it('uses the entry tier and the exit tier it was given', () => {
    const mixed = roundTripFromTiers({
      size: 50, entryTier: 100, exitTier: 30,
      impactEntry: 0, impactExit: 0, taxEntry: 0, taxExit: 0, gasQuoteEntry: 0, gasQuoteExit: 0,
    });
    expect('error' in mixed).toBe(false);
    if ('error' in mixed) return;
    expect(mixed.k).toBeCloseTo(0.99 * 0.997, 12);
    const bothOnePct = roundTrip({ size: 50, entry: onePct(), exit: onePct() })!;
    expect(mixed.k).not.toBeCloseTo(bothOnePct.k, 8);
  });
});

describe('round trip and break-even', () => {
  const rt = roundTrip({ size: 100, entry: onePct(), exit: onePct() })!;

  it('charges a 1% fee each way as about 1.99% of size, and needs about +2.03% to net zero', () => {
    expect(rt.k).toBeCloseTo(0.99 * 0.99, 12);
    expect(rt.g).toBe(0);
    expect(rt.costFrac).toBeCloseTo(1 - 0.99 * 0.99, 12);
    expect(rt.costFrac * 100).toBeCloseTo(1.99, 2);
    expect(rt.breakEvenMove * 100).toBeCloseTo(2.030405, 4);
    const atFlat = netReturn({ size: 100, entry: onePct(), exit: onePct(), midEntry: 1, midNow: 1 })!;
    expect(atFlat).toBeCloseTo(-rt.costFrac, 12);
    const breakEven = triggerPrice(1, 0, rt)!;
    expect(netReturn({ size: 100, entry: onePct(), exit: onePct(), midEntry: 1, midNow: breakEven })).toBeCloseTo(0, 10);
  });

  it('puts impact, taxes and gas into the same cost', () => {
    const entry = onePct({ impact: 0.004, tax: 0.01, gasQuote: 0.4 });
    const exit = onePct({ impact: 0.005, tax: 0.02, gasQuote: 0.6 });
    const priced = roundTrip({ size: 80, entry, exit })!;
    expect(priced.g).toBeCloseTo(1 / 80, 12);
    expect(priced.costFrac).toBeCloseTo(1 - priced.k + priced.g, 12);
    expect(priced.costFrac).toBeGreaterThan(rt.costFrac);

    const mid0 = 2;
    const mid1 = 2.4;
    const tokens = tokensBought(80, mid0, entry)!;
    const quote = proceeds(tokens, mid1, exit)!;
    const fromFills = (quote - entry.gasQuote - exit.gasQuote) / 80 - 1;
    expect(netReturn({ size: 80, entry, exit, midEntry: mid0, midNow: mid1 })).toBeCloseTo(fromFills, 10);
    expect(fromFills).toBeCloseTo((mid1 / mid0) * priced.k - 1 - priced.g, 10);
  });

  it('refuses a size or a fee that cannot be priced', () => {
    expect(roundTrip({ size: 0, entry: onePct(), exit: onePct() })).toBeNull();
    expect(roundTrip({ size: 10, entry: onePct({ fee: 1 }), exit: onePct() })).toBeNull();
    expect(roundTrip({ size: 10, entry: onePct({ impact: -0.01 }), exit: onePct() })).toBeNull();
    expect(triggerPrice(1, 0, { k: 0, g: 0 })).toBeNull();
  });
});

describe('stop, take-profit and trailing prices', () => {
  const rt = roundTrip({ size: 100, entry: onePct(), exit: onePct() })!;
  const gross = (net: number) => (triggerPrice(1, net, rt)! - 1) * 100;

  it('fires a net stop and net targets at the published gross moves for a 1% pool', () => {
    expect(gross(-0.25)).toBeCloseTo(-23.48, 2);
    expect(gross(0.5)).toBeCloseTo(53.05, 2);
    expect(gross(1)).toBeCloseTo(104.06, 2);
    expect(gross(EXIT.trailArm)).toBeCloseTo(32.64, 2);

    const stop = stopTriggerPrice(4, 25, rt)!;
    expect(netReturn({ size: 100, entry: onePct(), exit: onePct(), midEntry: 4, midNow: stop })).toBeCloseTo(-0.25, 8);
    const tp = takeProfitTriggerPrice(4, 50, rt)!;
    expect(netReturn({ size: 100, entry: onePct(), exit: onePct(), midEntry: 4, midNow: tp })).toBeCloseTo(0.5, 8);
  });

  it('arms the trailing stop on net return and prices the give-back from the peak', () => {
    expect(trailingTriggerPrice(1, EXIT.trailArm - 0.001, EXIT.trailArm, EXIT.trailGap, rt)).toBeNull();
    const exitNet = (1 + 0.5) * (1 - EXIT.trailGap) - 1;
    const price = trailingTriggerPrice(1, 0.5, EXIT.trailArm, EXIT.trailGap, rt)!;
    expect(price).toBeCloseTo(triggerPrice(1, exitNet, rt)!, 12);
    expect(netReturn({ size: 100, entry: onePct(), exit: onePct(), midEntry: 1, midNow: price })).toBeCloseTo(exitNet, 8);
  });
});
