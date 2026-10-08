import { describe, expect, it } from 'vitest';
import { checkTrade, DEFAULT_LIMITS, DEFAULT_LIVE_NETWORK, HARD_CAPS, validateLimits, type TradeCheckInput } from '../src/live/limits';

const ok: TradeCheckInput = { side: 'buy', tradeUsd: 5, priceImpact: 0.001, killSwitch: false, walletOnCorrectChain: true, priceIsOnChain: true };

describe('limits', () => {
  it('defaults: 3% impact cap, 1% slippage, 10 min deadline, mainnet; no dollar limits', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxPriceImpact: 0.03, slippageBps: 100, deadlineMinutes: 10 });
    expect(DEFAULT_LIVE_NETWORK).toBe('mainnet');
    expect(HARD_CAPS).toEqual({ maxPriceImpact: 0.05, slippageBps: 500, deadlineMinutes: 60 });
    expect(validateLimits(DEFAULT_LIMITS)).toEqual([]);
  });
  it('rejects out-of-range values', () => {
    expect(validateLimits({ ...DEFAULT_LIMITS, maxPriceImpact: 0 })).not.toEqual([]);
    expect(validateLimits({ ...DEFAULT_LIMITS, maxPriceImpact: 0.051 })).not.toEqual([]);
    expect(validateLimits({ ...DEFAULT_LIMITS, slippageBps: 0 })).not.toEqual([]);
    expect(validateLimits({ ...DEFAULT_LIMITS, slippageBps: 501 })).not.toEqual([]);
    expect(validateLimits({ ...DEFAULT_LIMITS, deadlineMinutes: 61 })).not.toEqual([]);
  });
  it('any trade size passes; impact cap, kill switch, chain and price checks block', () => {
    expect(checkTrade({ ...ok, tradeUsd: 1_000_000 }, DEFAULT_LIMITS).ok).toBe(true);
    expect(checkTrade({ ...ok, priceImpact: 0.031 }, DEFAULT_LIMITS).ok).toBe(false);
    expect(checkTrade({ ...ok, killSwitch: true }, DEFAULT_LIMITS).ok).toBe(false);
    expect(checkTrade({ ...ok, walletOnCorrectChain: false }, DEFAULT_LIMITS).ok).toBe(false);
    expect(checkTrade({ ...ok, priceIsOnChain: false }, DEFAULT_LIMITS).ok).toBe(false);
  });
  it('grid sells never exceed PLS bought by the bot (manual trades exempt)', () => {
    expect(checkTrade({ ...ok, side: 'sell', plsToSell: 200, plsHeldByBot: 100 }, DEFAULT_LIMITS).ok).toBe(false);
    expect(checkTrade({ ...ok, side: 'sell', plsToSell: 100, plsHeldByBot: 100 }, DEFAULT_LIMITS).ok).toBe(true);
    expect(checkTrade({ ...ok, side: 'sell', manual: true, plsToSell: 200, plsHeldByBot: 0 }, DEFAULT_LIMITS).ok).toBe(true);
  });
});
