import { describe, expect, it } from 'vitest';
import { adaptStatus } from '../src/v2/adapt-status';
import { formatPx, formatTokenLine, formatWhen } from '../src/v2/format';
import { sanitizedActivity, sanitizedStatus } from '../src/v2/sanitized-fixture';

const AS_OF = sanitizedStatus.spotsAt;

describe('adaptStatus', () => {
  const desk = adaptStatus(sanitizedStatus, sanitizedActivity, AS_OF, 'fixture');

  it('keeps grid generated equal to realized, without subtracting fees again', () => {
    const grid = desk.bots.find((b) => b.metrics.botId === 'grid-paper');
    expect(grid?.metrics.generated).toEqual([{ symbol: 'USDC', amount: 15.5, usd: 15.5 }]);
    expect(grid?.metrics.generatedUsd).toBe(15.5);
    expect(grid?.metrics.feesCollectedUsd).toBe(0.8);
    expect(grid?.metrics.tokenTaxesUsd).toBeNull();
    expect(grid?.metrics.swapCostUsd).toBeNull();
    expect(grid?.metrics.aprPct).toBeCloseTo(15.5 / 1000);
  });

  it('nets LP costs out of the quote leg and uses engine net for dollars', () => {
    const lp = desk.bots.find((b) => b.metrics.botId === 'lp-live');
    const usdc = lp?.metrics.generated.find((t) => t.symbol === 'USDC');
    const eth = lp?.metrics.generated.find((t) => t.symbol === 'ETH');
    expect(usdc?.amount).toBe(20);
    // quote fees 0.004 − gas 0.001 − swap 0.002 − rebalance 0.003
    expect(eth?.amount).toBeCloseTo(-0.002);
    expect(lp?.metrics.generatedUsd).toBeCloseTo(0.02 * 2000);
    expect(lp?.metrics.tokenTaxesUsd).toBeNull();
    expect(lp?.metrics.realizedRebalanceLossUsd).toBeCloseTo(0.003 * 2000);
  });

  it('leaves a closed bot without a pnl reading as unknown', () => {
    const closed = desk.bots.find((b) => b.metrics.botId === 'lp-closed');
    expect(closed?.metrics.generated).toEqual([]);
    expect(closed?.metrics.generatedUsd).toBeNull();
    expect(closed?.metrics.est.d1).toBeNull();
    expect(closed?.metrics.priceChangeUsd).toBeNull();
    expect(closed?.metrics.capitalInUsd).toBeCloseTo(100 * 0.00001);
  });

  it('sums live dollars and does not fold paper into the headline', () => {
    expect(desk.portfolio.generatedUsd).toBeCloseTo(40);
    expect(desk.portfolio.paperGeneratedUsd).toBeCloseTo(15.5);
    expect(desk.portfolio.tokens.map((t) => t.symbol).sort()).toEqual(['ETH', 'USDC']);
    expect(desk.portfolio.feesTodayLiveUsd).toBeNull();
    expect(desk.portfolio.madeSeries).toEqual([]);
  });

  it('drops activity that is not a fill, fee, or range move, and strips hex', () => {
    expect(desk.activity).toHaveLength(2);
    expect(desk.activity.some((a) => /0x/i.test(a.text))).toBe(false);
    expect(JSON.stringify(desk)).not.toMatch(/0x[0-9a-fA-F]{8,}/);
  });

  it('dashes estimates until each window has enough history', () => {
    const now = 1_700_000_000_000;
    const young = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'young', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 20 * 60_000,
        config: { totalCapitalUsd: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 1, totalFees: 0.1 },
      }],
    }, [], now);
    const m = young.bots[0].metrics;
    expect(m.est.d1).toBeNull();
    expect(m.est.d7).toBeNull();
    expect(m.est.d365).toBeNull();

    const day = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'day', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 4 * 3600_000,
        config: { totalCapitalUsd: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 1, totalFees: 0.1 },
      }],
    }, [], now);
    const d = day.bots[0].metrics;
    expect(d.est.d1?.[0].amount).toBeCloseTo(3 * 86_400 / (4 * 3600));
    expect(d.est.d7?.[0].amount).toBeCloseTo(3 * 7 * 86_400 / (4 * 3600));
    expect(d.est.d365).toBeNull();
    expect(d.est.usd.d365).toBeNull();
  });
});

describe('format', () => {
  it('does not round a sub-cent PLS price to $0.00', () => {
    const text = formatPx(5.0938348336569646e-6);
    expect(text.startsWith('$0.0')).toBe(true);
    expect(text).not.toBe('$0.00');
    expect(text).toContain('₅');
  });

  it('formats generated units the way the hero reads', () => {
    expect(formatTokenLine([
      { symbol: 'USDC', amount: 15.62 },
      { symbol: 'WETH', amount: 0.00236 },
    ])).toBe('+15.62 USDC + 0.00236 WETH');
    expect(formatTokenLine([{ symbol: 'PLS', amount: 98300 }])).toBe('+98.3k PLS');
  });

  it('shows activity clocks in Detroit, not UTC', () => {
    const t = Date.UTC(2026, 9, 27, 21, 5, 9);
    const detroit = formatWhen(t);
    const utc = new Date(t).toISOString().slice(11, 19);
    expect(detroit).not.toContain(utc);
    expect(detroit).toMatch(/5:05:09/);
  });
});
