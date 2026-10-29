import { describe, expect, it } from 'vitest';
import { adaptStatus } from '../src/v2/adapt-status';
import { deskOf } from './helpers/deskOf';
import { gridMetrics, lpMetrics, trendMetrics } from '../src/metrics/botMetrics';
import { deskStatusPill, formatAmt, formatClockEt, formatPx, formatTokenLine, formatWhen, showsNoFills } from '../src/v2/format';
import { HEADLINE_FLOOR_PX, headlinePx } from '../src/v2/tokens';
import { sanitizedActivity, sanitizedStatus } from '../src/v2/sanitized-fixture';

function units(generated: Record<string, number> | null) {
  return Object.entries(generated ?? {})
    .filter(([, amount]) => amount !== 0)
    .map(([symbol, amount]) => ({ symbol, amount }));
}

const AS_OF = sanitizedStatus.spotsAt;

describe('adaptStatus', () => {
  const desk = adaptStatus(sanitizedStatus, sanitizedActivity, AS_OF, 'fixture');

  it('copies grid generated from botMetrics', () => {
    const grid = desk.bots.find((b) => b.metrics.botId === 'grid-paper');
    const server = gridMetrics(sanitizedStatus.grids[0], AS_OF);
    expect(grid?.metrics.generated.map((t) => ({ symbol: t.symbol, amount: t.amount }))).toEqual(units(server.generated));
    expect(grid?.metrics.generatedUsd).toBe(server.generatedUsd);
    expect(grid?.metrics.feesCollectedUsd).toBe(server.feesCollectedUsd);
    expect(grid?.metrics.swapCostUsd).toBe(server.swapCostUsd);
    expect(grid?.metrics.tokenTaxesUsd).toBe(server.tokenTaxesUsd);
    expect(grid?.metrics.aprPct).toBe(server.aprPct);
    expect(grid?.metrics.invested).toEqual([{ symbol: 'USDC', amount: 1000, usd: null }]);
    expect(grid?.metrics.grossFees).toEqual([]);
    expect(grid?.metrics.feesPaid).toEqual([]);
  });

  it('copies LP generated from botMetrics', () => {
    const lp = desk.bots.find((b) => b.metrics.botId === 'lp-live');
    const server = lpMetrics(sanitizedStatus.lps[0], AS_OF);
    expect(lp?.metrics.generated.map((t) => ({ symbol: t.symbol, amount: t.amount }))).toEqual(units(server.generated));
    expect(lp?.metrics.generatedUsd).toBe(server.generatedUsd);
    expect(lp?.metrics.aprPct).toBe(server.aprPct);
    expect(lp?.metrics.tokenTaxesUsd).toBe(server.tokenTaxesUsd);
    expect(lp?.metrics.realizedRebalanceLossUsd).toBe(server.realizedRebalanceLossUsd);
    expect(lp?.metrics.est.d1?.map((t) => t.amount)).toEqual(units(server.generatedRate.d1).map((t) => t.amount));
    expect(lp?.metrics.est.d7?.map((t) => t.amount)).toEqual(units(server.generatedRate.d7).map((t) => t.amount));
    expect(lp?.metrics.est.d365?.map((t) => t.amount)).toEqual(units(server.generatedRate.d365).map((t) => t.amount));
    expect(server.generatedRate.d1).not.toBeNull();
    expect(server.generatedRate.d7).not.toBeNull();
    expect(server.generatedRate.d365).not.toBeNull();
    expect(lp?.metrics.grossFees).toEqual([]);
    expect(lp?.metrics.feesPaid).toEqual([]);
    expect(lp?.metrics.moveLoss).toEqual([]);
    expect(formatTokenLine([
      { symbol: 'USDC', amount: 63.23957 },
      { symbol: 'ETH', amount: 0.00173066 },
    ])).toBe('+63.24 USDC + 0.001731 ETH');
    const qa = {
      id: 'qa-lp', mode: 'live' as const, status: 'running', base: 'USDC', quote: 'ETH',
      usdPerQuote: 2000, price: 1 / 2342, startedAt: AS_OF - 3 * 86_400_000,
      startValue: 3.5,
      pnl: {
        feeCoins: { base: 63.23957, quote: 0.00173066 },
        fees: 1, gas: 0, swapCost: 0, moveLoss: 0, net: 1, price: 0, equity: 1,
      },
      totals: { gas: 0, swapCost: 0, moveLoss: 0 },
    };
    const qaDesk = deskOf({ spotsAt: AS_OF, lps: [qa] }, [], AS_OF);
    const qaServer = lpMetrics(qa, AS_OF);
    expect(qaDesk.bots[0].metrics.generated.map((t) => t.amount)).toEqual(units(qaServer.generated).map((t) => t.amount));
    expect(formatTokenLine(qaDesk.bots[0].metrics.generated)).toBe('+63.24 USDC + 0.001731 ETH');
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
    const live = lpMetrics(sanitizedStatus.lps[0], AS_OF);
    expect(desk.portfolio.generatedUsd).toBe(live.generatedUsd);
    expect(desk.portfolio.generatedPerDayUsd).toBe(live.est.d1);
    expect(desk.portfolio.generatedPerDay?.find((t) => t.symbol === 'USDC')?.amount).toBe(live.generatedRate.d1?.USDC);
    expect(desk.bots.find((b) => b.metrics.botId === 'lp-live')?.pair).toBe('ETH/USDC');
    expect(desk.portfolio.paperGeneratedUsd).toBeCloseTo(15.5);
    expect(desk.portfolio.tokens.map((t) => t.symbol).sort()).toEqual(['ETH', 'USDC']);
    expect(desk.portfolio.feesTodayLiveUsd).toBeNull();
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
    const young = deskOf({
      spotsAt: now,
      grids: [{
        id: 'young', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 20 * 60_000,
        config: { totalCapitalQuote: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 1, totalFees: 0.1 },
      }],
    }, [], now);
    const youngServer = gridMetrics(young.bots[0] ? {
      id: 'young', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - 20 * 60_000,
      config: { totalCapitalQuote: 100 },
      pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: 1, totalFees: 0.1 },
    } : {}, now);
    const m = young.bots[0].metrics;
    expect(m.est.d1).toBe(youngServer.generatedRate.d1 == null ? null : expect.anything());
    expect(youngServer.generatedRate.d1).toBeNull();
    expect(m.est.d7).toBeNull();
    expect(m.est.d365).toBeNull();

    const day = deskOf({
      spotsAt: now,
      grids: [{
        id: 'day', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 4 * 3600_000,
        config: { totalCapitalQuote: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 1, totalFees: 0.1 },
      }],
    }, [], now);
    const dayRaw = {
      id: 'day', mode: 'live' as const, status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - 4 * 3600_000,
      config: { totalCapitalQuote: 100 },
      pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: 1, totalFees: 0.1 },
    };
    const dayServer = gridMetrics(dayRaw, now);
    const d = day.bots[0].metrics;
    expect(dayServer.generatedRate.d1).toBeNull();
    expect(dayServer.generatedRate.d7).toBeNull();
    expect(dayServer.generatedRate.d365).toBeNull();
    expect(d.est.d1).toBeNull();
    expect(d.est.d7).toBeNull();
    expect(d.est.d365).toBeNull();
    expect(d.aprPct).toBeNull();

    const week = deskOf({
      spotsAt: now,
      grids: [{
        id: 'week', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 8 * 86_400_000,
        config: { totalCapitalQuote: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 2, totalFees: 0 },
      }],
    }, [], now);
    expect(week.bots[0].metrics.est.d1?.[0].amount).toBeCloseTo(3 / 8);
    expect(week.bots[0].metrics.est.d7?.[0].amount).toBeCloseTo(3 * 7 / 8);
    expect(week.bots[0].metrics.est.d365?.[0].amount).toBeCloseTo(3 * 365 / 8);

    const month = deskOf({
      spotsAt: now,
      grids: [{
        id: 'month', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 30 * 86_400_000,
        config: { totalCapitalQuote: 100 },
        pnl: { realized: 3, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 2, totalFees: 0 },
      }],
    }, [], now);
    expect(month.bots[0].metrics.est.d365?.[0].amount).toBeCloseTo(3 * 365 / 30);
  });

  it('sums botMetrics generated dollars with no second rounding', () => {
    const now = 1_700_000_000_000;
    const row = (id: string, realized: number) => ({
      id, mode: 'live', status: 'running', label: `${id}/USDC`, base: id, quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - 86_400_000,
      config: { totalCapitalQuote: 10 },
      pnl: { realized, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: 2, totalFees: 0 },
    });
    const mixed = deskOf({ spotsAt: now, grids: [row('AAA', 1.006), row('BBB', 1.006)] }, [], now);
    const cards = mixed.bots.map((b) => b.metrics.generatedUsd);
    const sum = (cards[0] ?? 0) + (cards[1] ?? 0);
    expect(cards).toEqual([
      gridMetrics(row('AAA', 1.006), now).generatedUsd,
      gridMetrics(row('BBB', 1.006), now).generatedUsd,
    ]);
    expect(mixed.portfolio.generatedUsd).toBe(sum);
  });

  it('copies botMetrics estimates: none under a day, all three from one day', () => {
    const now = 1_700_000_000_000;
    const bot = (id: string, ageMs: number, trips: number) => ({
      id, mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: now - ageMs,
      config: { totalCapitalQuote: 10 },
      pnl: { realized: 1, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: trips, totalFees: 0 },
      trades: [{ side: 'sell', failed: false, timestamp: now - 30_000, realizedPnlUsd: 1 }],
    });
    const minute = deskOf({ spotsAt: now, grids: [bot('baby', 60_000, 1)] }, [], now);
    expect(minute.bots[0].metrics.ageSec).toBeCloseTo(60);
    expect(minute.bots[0].metrics.aprPct).toBeNull();
    expect(minute.bots[0].metrics.est.d1).toBeNull();
    expect(minute.portfolio.generatedPerDayUsd).toBeNull();

    const oneRaw = bot('one', 2 * 86_400_000, 1);
    const oneFill = deskOf({ spotsAt: now, grids: [oneRaw] }, [], now);
    const oneServer = gridMetrics(oneRaw, now);
    expect(oneFill.bots[0].metrics.aprPct).toBe(oneServer.aprPct);
    expect(oneFill.bots[0].metrics.aprPct).not.toBeNull();
    expect(oneFill.bots[0].metrics.est.d1?.[0].amount).toBe(oneServer.generatedRate.d1?.USDC);
    expect(oneFill.bots[0].metrics.est.d7?.[0].amount).toBe(oneServer.generatedRate.d7?.USDC);
    expect(oneFill.bots[0].metrics.est.d365?.[0].amount).toBe(oneServer.generatedRate.d365?.USDC);

    const readyRaw = bot('two', 8 * 86_400_000, 2);
    const ready = deskOf({ spotsAt: now, grids: [readyRaw] }, [], now);
    expect(ready.bots[0].metrics.aprPct).toBe(gridMetrics(readyRaw, now).aprPct);
    expect(ready.bots[0].metrics.aprPct).not.toBeNull();
  });

  it('flips a stable base under one dollar and leaves PLS/DAI alone', () => {
    const eth = desk.prices.find((p) => p.symbol.startsWith('ETH/USDC'));
    expect(eth?.symbol).toBe('ETH/USDC');
    expect(eth?.chain).toBe('ETH');
    expect(eth?.price).toBeCloseTo(2000);
    const now = 1_700_000_000_000;
    const pls = deskOf({
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
    expect(row?.fee).toBeNull();
  });

  it('shows the range in the tape orientation so it brackets the displayed price', () => {
    const lp = desk.bots.find((b) => b.metrics.botId === 'lp-live');
    const range = lp?.metrics.range;
    const tape = desk.prices.find((p) => p.symbol === 'ETH/USDC');
    expect(range?.inRange).toBe(true);
    expect(range!.lower).toBeLessThanOrEqual(range!.current);
    expect(range!.current).toBeLessThanOrEqual(range!.upper);
    expect(range!.current).toBeCloseTo(tape!.price!);
    expect(range!.current).toBeCloseTo(2000);
    expect(range!.lower).toBeCloseTo(1 / 0.0006);
    expect(range!.upper).toBeCloseTo(1 / 0.0004);
    expect(lp?.metrics.calc).toContain('per coin');
    expect(lp?.metrics.calc).not.toMatch(/\bAPR\b/);
    const grid = desk.bots.find((b) => b.metrics.botId === 'grid-paper');
    expect(grid?.metrics.range?.lower).toBe(10);
    expect(grid?.metrics.range?.current).toBeCloseTo(12.5);
    expect(grid?.metrics.range?.upper).toBe(15);
    expect(grid!.metrics.range!.lower).toBeLessThanOrEqual(grid!.metrics.range!.current);
    expect(grid!.metrics.range!.current).toBeLessThanOrEqual(grid!.metrics.range!.upper);
  });

  it('maps a trend bot from botMetrics and names the chain', () => {
    const now = 1_700_000_000_000;
    const desk = deskOf({
      spotsAt: now,
      chains: [{ id: 1, short: 'ETH', name: 'Ethereum', color: '#000' }],
      trends: [{
        id: 'trend-paper', mode: 'paper', status: 'running', label: 'ETH/USDC',
        base: 'ETH', quoteSym: 'USDC', chainId: 1, dexName: 'Uniswap V3',
        usdPerQuote: 1, price: 2300, startedAt: now - 3 * 86_400_000,
        capital: 100,
        pnl: { realized: 4.5, unrealized: 1, equity: 105.5, gas: 0.2, fees: 0.1 },
        stats: { count: 2 },
        moveCount: 2,
      }],
    }, [], now);
    const bot = desk.bots.find((b) => b.metrics.kind === 'trend');
    expect(bot?.pair).toBe('ETH/USDC');
    expect(bot?.chainName).toBe('Ethereum');
    expect(bot?.dex).toBe('Uniswap V3');
    expect(bot?.metrics.mode).toBe('paper');
    const server = trendMetrics({
      id: 'trend-paper', mode: 'paper', status: 'running', label: 'ETH/USDC',
      base: 'ETH', quoteSym: 'USDC', chainId: 1, dexName: 'Uniswap V3',
      usdPerQuote: 1, price: 2300, startedAt: now - 3 * 86_400_000,
      capital: 100,
      pnl: { realized: 4.5, unrealized: 1, equity: 105.5, gas: 0.2, fees: 0.1 },
      stats: { count: 2 },
      moveCount: 2,
    }, now);
    expect(bot?.metrics.generated.map((t) => ({ symbol: t.symbol, amount: t.amount }))).toEqual(units(server.generated));
    expect(bot?.metrics.est.d1?.[0].amount).toBeCloseTo(4.5 / 3);
    expect(bot?.metrics.invested).toEqual([{ symbol: 'USDC', amount: 100, usd: null }]);
  });

  it('keeps one price per pool and labels a second fee tier', () => {
    const now = 1_700_000_000_000;
    const grid = (id: string, extra: Record<string, unknown>) => ({
      id, mode: 'paper', status: 'running', label: 'ETH/USDC', base: 'ETH', quoteSym: 'USDC',
      chainId: 1, dexName: 'Uniswap V3', usdPerQuote: 1, startedAt: now - 86_400_000,
      config: { totalCapitalUsd: 1 },
      pnl: { realized: 0, unrealized: 0 },
      stats: { roundTrips: 0 },
      ...extra,
    });
    const two = deskOf({
      spotsAt: now,
      chains: [{ id: 1, short: 'ETH', color: '#000' }],
      grids: [
        grid('stale', { price: 2300, feeBps: 5, priceAt: 1, status: 'stopped' }),
        grid('live', { price: 2342.18, feeBps: 5, priceAt: 2, status: 'running', mode: 'live' }),
        grid('wide', { price: 2400, feeBps: 30, priceAt: 3, status: 'running' }),
      ],
    }, [], now);
    const rows = two.prices.filter((p) => p.symbol === 'ETH/USDC');
    expect(rows.map((p) => p.fee).sort()).toEqual(['0.05%', '0.3%']);
    expect(rows.find((p) => p.fee === '0.05%')?.price).toBeCloseTo(2342.18);
    expect(rows.find((p) => p.fee === '0.3%')?.price).toBeCloseTo(2400);
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
    expect(formatAmt(0.001730655)).toBe('+0.001731');
    expect(formatAmt(0.015310296)).toBe('+0.01531');
    expect(formatAmt(0.062282897)).toBe('+0.06228');
    expect(formatAmt(-0.000004966)).toBe('−0.000005');
    expect(formatAmt(66290.99388961491)).toBe('+66.3k');
    expect(formatAmt(9260.24)).toBe('+9,260.24');
    expect(formatAmt(9503.41)).toBe('+9,503.41');
    expect(formatTokenLine([
      { symbol: 'USDC', amount: 9260.24 },
      { symbol: 'USDG', amount: 9503.41 },
    ])).toBe('+9,260.24 USDC + 9,503.41 USDG');
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
    expect(formatClockEt(t)).toBe('5:05 PM ET');
  });

  it('uses one status pill that follows the source', () => {
    const t = Date.UTC(2026, 9, 27, 21, 5, 9);
    expect(deskStatusPill('live', t, false)).toEqual({ text: 'Live', tone: 'live' });
    expect(deskStatusPill('live', t, true)).toEqual({ text: 'Stale', tone: 'stale' });
    expect(deskStatusPill('snapshot', t, false)).toEqual({ text: 'Snapshot · 5:05 PM ET', tone: 'snap' });
    expect(deskStatusPill('fixture', t, false).tone).toBe('snap');
  });

  it('shrinks a headline to the largest size that fits', () => {
    const widthAt = (px: number) => px * 14;
    expect(HEADLINE_FLOOR_PX).toBe(22);
    expect(headlinePx(28, widthAt, 400)).toBe(28);
    expect(headlinePx(28, widthAt, 328)).toBe(23);
    expect(headlinePx(28, widthAt, 200)).toBe(null);
    expect(headlinePx(16, (px) => px * 15, 226)).toBe(15);
    expect(headlinePx(16, widthAt, 180)).toBe(null);
    expect(headlinePx(34, widthAt, 0)).toBe(34);
  });
  it('counts the live bots the hero sums, not paper ones', () => {
    const now = 1_700_000_000_000;
    const grid = (id: string, mode: 'live' | 'paper', status: string) => ({
      id, mode, status, chainId: 1, label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC', usdPerQuote: 1, price: 2,
      startedAt: now - 86_400_000, config: { totalCapitalQuote: 100, lowerPrice: 1, upperPrice: 3 },
      pnl: { realized: 0, unrealized: 0, gasUsd: 0 }, stats: { roundTrips: 0, totalFees: 0 },
    });
    const desk = deskOf({ spotsAt: now, grids: [grid('a', 'live', 'running'), grid('b', 'live', 'paused'), grid('c', 'paper', 'running'), grid('d', 'paper', 'running')] }, [], now);
    expect(desk.portfolio.botsRunning).toBe(1);
    expect(desk.portfolio.botsTotal).toBe(2);
  });
});
