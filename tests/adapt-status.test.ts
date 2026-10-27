import { describe, expect, it } from 'vitest';
import { adaptStatus } from '../src/v2/adapt-status';
import { formatPx, formatTokenLine, formatUsd, formatWhen, showsNoFills } from '../src/v2/format';
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
    expect(lp?.metrics.aprPct).toBeCloseTo(40 / 2000);
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
    expect(desk.portfolio.generatedPerDayUsd).toBeCloseTo(20);
    expect(desk.portfolio.generatedPerDay?.find((t) => t.symbol === 'USDC')?.amount).toBeCloseTo(10);
    expect(desk.bots.find((b) => b.metrics.botId === 'lp-live')?.pair).toBe('ETH/USDC');
    expect(desk.portfolio.paperGeneratedUsd).toBeCloseTo(15.5);
    expect(desk.portfolio.tokens.map((t) => t.symbol).sort()).toEqual(['ETH', 'USDC']);
    expect(desk.portfolio.feesTodayLiveUsd).toBeNull();
    expect(desk.portfolio.madeSeries).toEqual([]);
  });

  it('drops activity that is not a fill, fee, or range move, and strips hex', () => {
    expect(desk.activity).toHaveLength(2);
    expect(desk.activity.find((a) => a.botId === 'grid-paper')?.pair).toBe('AAA/USDC');
    const lpLine = desk.activity.find((a) => a.botId === 'lp-live');
    expect(lpLine?.pair).toBe('ETH/USDC');
    expect(lpLine?.chain).toBe('ETH');
    expect(lpLine?.text).toBe('Liquidity USDC/ETH: price is outside the range; moving the range to the price');
    expect(lpLine?.text).not.toContain('·');
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
    expect(d.aprPct).toBeNull();

    const week = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'week', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 8 * 86_400_000,
        config: { totalCapitalUsd: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 2, totalFees: 0 },
      }],
    }, [], now);
    expect(week.bots[0].metrics.est.d7).not.toBeNull();
    expect(week.bots[0].metrics.est.d365).toBeNull();

    const month = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'month', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 30 * 86_400_000,
        config: { totalCapitalUsd: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 2, totalFees: 0 },
      }],
    }, [], now);
    expect(month.bots[0].metrics.est.d365?.[0].amount).toBeCloseTo(3 * 365 / 30);
  });

  it('rounds each live bot to cents before the home total', () => {
    const now = 1_700_000_000_000;
    const row = (id: string, realized: number) => ({
      id, mode: 'live', status: 'running', label: `${id}/USDC`, base: id, quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - 86_400_000,
      config: { totalCapitalUsd: 10 },
      pnl: { realized, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: 2, totalFees: 0 },
    });
    const mixed = adaptStatus({ spotsAt: now, grids: [row('AAA', 1.006), row('BBB', 1.006)] }, [], now);
    const cards = mixed.bots.map((b) => b.metrics.generatedUsd);
    const sum = (cards[0] ?? 0) + (cards[1] ?? 0);
    expect(cards).toEqual([1.01, 1.01]);
    expect(mixed.portfolio.generatedUsd).toBeCloseTo(sum, 10);
    expect(formatUsd(mixed.portfolio.generatedUsd, true)).toBe(formatUsd(sum, true));
    expect(formatUsd(mixed.portfolio.generatedUsd, true)).toBe('+$2.02');
  });

  it('dashes APR on a one-minute bot with one fill, and on an older bot with one fill', () => {
    const now = 1_700_000_000_000;
    const bot = (id: string, ageMs: number, trips: number) => ({
      id, mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - ageMs,
      config: { totalCapitalUsd: 10 },
      pnl: { realized: 1, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: trips, totalFees: 0 },
      trades: [{ side: 'sell', failed: false, timestamp: now - 30_000, realizedPnlUsd: 1 }],
    });
    const minute = adaptStatus({ spotsAt: now, grids: [bot('baby', 60_000, 1)] }, [], now);
    expect(minute.bots[0].metrics.ageSec).toBeCloseTo(60);
    expect(minute.bots[0].metrics.aprPct).toBeNull();
    expect(minute.bots[0].metrics.est.d1).toBeNull();
    expect(minute.portfolio.generatedPerDayUsd).toBeNull();

    const oneFill = adaptStatus({ spotsAt: now, grids: [bot('one', 2 * 86_400_000, 1)] }, [], now);
    expect(oneFill.bots[0].metrics.aprPct).toBeNull();

    const ready = adaptStatus({ spotsAt: now, grids: [bot('two', 2 * 86_400_000, 2)] }, [], now);
    expect(ready.bots[0].metrics.aprPct).toBeCloseTo(1 / 10);
  });

  it('flips a stable base under one dollar and leaves PLS/DAI alone', () => {
    const eth = desk.prices.find((p) => p.symbol.startsWith('ETH/USDC'));
    expect(eth?.symbol).toBe('ETH/USDC');
    expect(eth?.chain).toBe('ETH');
    expect(eth?.price).toBeCloseTo(2000);
    const now = 1_700_000_000_000;
    const pls = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'pls', mode: 'paper', status: 'stopped', label: 'PLS/DAI', base: 'PLS', quoteSym: 'DAI',
        usdPerQuote: 1, price: 5.093e-6, startedAt: now - 86_400_000,
        config: { totalCapitalUsd: 1 },
        pnl: { realized: 0, unrealized: 0 },
        stats: { roundTrips: 0 },
      }],
    }, [], now);
    const row = pls.prices[0];
    expect(row?.symbol).toBe('PLS/DAI');
    expect(row?.chain).not.toContain('·');
    expect(row?.price).toBeCloseTo(5.093e-6);
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

  it('treats a zero book with no fills as empty, and a real zero with fills as a number', () => {
    expect(showsNoFills({ generated: [], generatedUsd: 0, fillCount: 0 })).toBe(true);
    expect(showsNoFills({ generated: [], generatedUsd: null, fillCount: 0 })).toBe(false);
    expect(showsNoFills({ generated: [{ amount: 1 }], generatedUsd: 0, fillCount: 2 })).toBe(false);
  });

  it('shows activity clocks in Detroit, not UTC', () => {
    const t = Date.UTC(2026, 9, 27, 21, 5, 9);
    const detroit = formatWhen(t);
    const utc = new Date(t).toISOString().slice(11, 19);
    expect(detroit).not.toContain(utc);
    expect(detroit).toMatch(/5:05:09/);
  });
});
