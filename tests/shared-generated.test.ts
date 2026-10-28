import { describe, expect, it } from 'vitest';
import { estimates, ESTIMATE_MIN_AGE_SEC, generatedTokens, lpParts, lpQuoteCosts } from '../src/shared/generated';

const DAY = ESTIMATE_MIN_AGE_SEC;

describe('generatedTokens', () => {
  it('keeps an LP base fee and subtracts quote-coin costs from the quote fee', () => {
    const bot = {
      kind: 'lp' as const,
      base: 'USDC',
      quote: 'ETH',
      feeCoins: { base: 63.239573, quote: 0.02683694099017285 },
      gas: 0.0006807057687194715,
      swapCost: 0.001952698134734282,
      moveLoss: 0.022472881717407633,
      netQuote: 0.028842093923664137,
    };
    const parts = lpParts(bot);
    const costs = lpQuoteCosts(bot);
    expect(parts.generated.find((t) => t.symbol === 'USDC')?.amount).toBeCloseTo(63.239573);
    expect(parts.generated.find((t) => t.symbol === 'ETH')?.amount).toBeCloseTo(0.02683694099017285 - costs);
    expect(parts.feesPaid[0].amount).toBeCloseTo(bot.gas + bot.swapCost);
    expect(parts.moveLoss[0].amount).toBeCloseTo(bot.moveLoss);
    for (const symbol of ['USDC', 'ETH']) {
      const gross = parts.gross.find((t) => t.symbol === symbol)?.amount ?? 0;
      const paid = parts.feesPaid.find((t) => t.symbol === symbol)?.amount ?? 0;
      const move = parts.moveLoss.find((t) => t.symbol === symbol)?.amount ?? 0;
      const made = parts.generated.find((t) => t.symbol === symbol)?.amount ?? 0;
      expect(gross - paid - move).toBeCloseTo(made);
    }
  });

  it('uses pnl.net in the quote coin only when an LP has no fee coins', () => {
    const made = generatedTokens({ kind: 'lp', base: 'USDC', quote: 'ETH', feeCoins: null, netQuote: 0.02 });
    expect(made).toEqual([{ symbol: 'ETH', amount: 0.02 }]);
  });

  it('uses grid and trend pnl.realized in the quote coin, and nothing for a token trader', () => {
    expect(generatedTokens({ kind: 'grid', quote: 'USDC', realized: 15.5 })).toEqual([{ symbol: 'USDC', amount: 15.5 }]);
    expect(generatedTokens({ kind: 'trend', quote: 'DAI', realized: -1.25 })).toEqual([{ symbol: 'DAI', amount: -1.25 }]);
    expect(generatedTokens({ kind: 'trader', quote: 'USDC', realized: 4 })).toEqual([]);
    expect(generatedTokens({ kind: 'sniper' })).toEqual([]);
    expect(generatedTokens({ kind: 'token' })).toEqual([]);
  });
});

describe('estimates', () => {
  const made = [
    { symbol: 'ETH', amount: 0.02029 },
    { symbol: 'USDC', amount: 63.24 },
  ];
  const age = 2.6 * DAY;

  it('scales each token by Generated / age × 1, 7 and 365', () => {
    const est = estimates(made, age);
    for (const token of made) {
      const day = token.amount / 2.6;
      expect(est.perDay?.find((t) => t.symbol === token.symbol)?.amount).toBeCloseTo(day);
      expect(est.h24?.find((t) => t.symbol === token.symbol)?.amount).toBeCloseTo(day);
      expect(est.d7?.find((t) => t.symbol === token.symbol)?.amount).toBeCloseTo(day * 7);
      expect(est.d365?.find((t) => t.symbol === token.symbol)?.amount).toBeCloseTo(day * 365);
    }
  });

  it('hides every window when the bot is under one day old', () => {
    expect(estimates(made, DAY - 1)).toEqual({ perDay: null, h24: null, d7: null, d365: null });
    expect(estimates(made, 4 * 3600)).toEqual({ perDay: null, h24: null, d7: null, d365: null });
    expect(estimates(made, null).h24).toBeNull();
  });
});
