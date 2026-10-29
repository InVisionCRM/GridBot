/**
 * metrics.breakdownByCoin: per coin, in token units, earned − gasSwap − rangeMoveLoss − taxes − bridge = generated,
 * exactly (float epsilon), and each line's generated is the headline's Generated for that coin. Checked on every bot of
 * the real 2026-10-27 status pull, the live LP's ETH numbers, a grid with no fills, and the Details render (collapsed).
 * Also the Invested fallback: a grid saved before the *Usd→*Quote rename (only config.totalCapitalUsd, quote units).
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { botMetrics, gridMetrics, lpMetrics, tokenMetrics, trendMetrics, type BotMetrics } from '../src/metrics/botMetrics';
import { roundTripCosts, roundTripStats, type LiveTrade } from '../src/live/ledger';
import { coinBreakdownRows, MoneyDetails } from '../src/ui/MoneyDetails';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const R = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const AS_OF = R.grids[0].metrics.asOf as number;
const EPS = (x: number) => 1e-12 * Math.max(1, Math.abs(x));

function identity(m: BotMetrics) {
  expect(m.breakdownByCoin, m.botId).not.toBeNull();
  for (const [sym, c] of Object.entries(m.breakdownByCoin!)) {
    const sum = c.earned - c.gasSwap - c.rangeMoveLoss - c.taxes - c.bridge;
    expect(Math.abs(sum - c.generated), `${m.botId} ${sym}`).toBeLessThanOrEqual(EPS(c.generated));
    expect(c.generated, `${m.botId} ${sym} = headline`).toBe(m.generated![sym] ?? 0);
    for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true);
  }
  for (const sym of Object.keys(m.generated!)) expect(m.breakdownByCoin![sym], `${m.botId} ${sym}`).toBeDefined();
  expect(Object.keys(m.breakdownByCoin!)).not.toContain('USD');
}

describe('identity on every bot of the real status pull, per coin', () => {
  const bots: Obj[] = [...R.grids.map((g: Obj) => ({ ...g, kind: 'grid' })), ...R.lps.map((l: Obj) => ({ ...l, kind: 'lp' })), ...R.trends.map((t: Obj) => ({ ...t, kind: 'trend' }))];
  it(`covers ${bots.length} bots`, () => expect(bots.length).toBe(18));
  for (const b of bots) it(`${b.kind} ${b.id}`, () => identity(botMetrics(b, AS_OF)!));
});

describe('the live LP lp-mvnm73sx-hghe, ETH', () => {
  const l = R.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
  const m = lpMetrics(l, AS_OF);
  it('0.026837 fees − 0.002633 gas + swap fees − 0.022473 range moves = 0.001731 ETH', () => {
    const e = m.breakdownByCoin!.ETH;
    expect(e.earned).toBeCloseTo(0.026837, 6);
    expect(e.gasSwap).toBeCloseTo(0.002633, 6);
    expect(e.rangeMoveLoss).toBeCloseTo(0.022473, 6);
    expect(e.taxes).toBe(0);
    expect(e.bridge).toBe(0);
    expect(e.generated).toBeCloseTo(0.001731, 6);
    // the inputs: fees collected + owed, gas + swap cost and the move loss the engine booked (quote-valued totals)
    expect(e.earned).toBe(l.pnl.feeCoins.quote);
    expect(e.gasSwap).toBe(l.totals.gas + l.totals.swapCost);
    expect(e.rangeMoveLoss).toBe(l.totals.moveLoss);
    expect(m.breakdownByCoin!.USDC).toEqual({ earned: l.pnl.feeCoins.base, gasSwap: 0, rangeMoveLoss: 0, taxes: 0, bridge: 0, generated: l.pnl.feeCoins.base });
    expect(m.breakdownBasis).toMatchObject({ earned: 'lpFees', itemized: true });
  });
  it('per-coin costs (gasCoins / swapCoins / moveCoins) land on the coin charged', () => {
    const mm = lpMetrics({ ...l, totals: { ...l.totals, gasCoins: { base: 0.5, quote: 0.0001 }, swapCoins: { base: 1, quote: 0 }, moveCoins: { base: 0, quote: 0.02 } } }, AS_OF);
    expect(mm.breakdownByCoin!.USDC).toMatchObject({ gasSwap: 1.5, rangeMoveLoss: 0 });
    expect(mm.breakdownByCoin!.ETH).toMatchObject({ gasSwap: 0.0001, rangeMoveLoss: 0.02 });
    identity(mm);
  });
  it('bridge costs are a line of their own and still add up', () => {
    const mm = lpMetrics({ ...l, bridge: { costs: [{ at: 1, kind: 'bridgeFee', coin: 'ETH', units: 0.0001, usdAtEvent: 0.3 }] } }, AS_OF);
    expect(mm.breakdownByCoin!.ETH.bridge).toBe(0.0001);
    expect(mm.breakdownByCoin!.ETH.generated).toBeCloseTo(0.0016306553693, 12);
    identity(mm);
  });
});

describe('grid / trend: trade profit before costs', () => {
  const buy = { side: 'buy', intervalIndex: 3, timestamp: 1, stableAmount: 100, gasQuote: 1, feeQuote: 0.3, lotCost: 101, realizedPnlQuote: 0 };
  const sell = { side: 'sell', intervalIndex: 3, timestamp: 2, stableAmount: 110, gasQuote: 1, feeQuote: 0.33, lotCost: 101, roundTripNet: 8, realizedPnlQuote: 8 };
  it('a grid with no fills: 0 in every part', () => {
    const m = gridMetrics({ id: 'g0', kind: 'grid', status: 'running', quoteSym: 'DAI', stable: 'DAI', config: { totalCapitalQuote: 100 }, pnl: { realized: 0, unrealized: 0 }, stats: roundTripStats([]), trades: [] }, AS_OF);
    expect(m.breakdownByCoin).toEqual({ DAI: { earned: 0, gasSwap: 0, rangeMoveLoss: 0, taxes: 0, bridge: 0, generated: 0 } });
    const hex = gridMetrics({ ...R.grids.find((g: Obj) => g.id === 'g-mvowdsys-i5iq'), kind: 'grid' }, AS_OF); // two buys, no sell yet
    expect(hex.breakdownByCoin).toEqual({ PLS: { earned: 0, gasSwap: 0, rangeMoveLoss: 0, taxes: 0, bridge: 0, generated: 0 } });
  });
  it('one round trip: profit before costs = sold − spent + pool fees; gas is both legs', () => {
    const c = roundTripCosts([sell, buy] as never);
    expect(c).toEqual({ gas: 2, poolFees: 0.63, taxes: 0, lostGas: 0, roundTrips: 1, unmatched: 0 });
    const m = gridMetrics({ id: 'g1', kind: 'grid', status: 'running', quoteSym: 'DAI', config: { totalCapitalQuote: 200 }, pnl: { realized: 8, unrealized: 0 }, stats: roundTripStats([buy, sell] as never as LiveTrade[]), trades: [sell, buy] }, AS_OF);
    expect(m.breakdownByCoin!.DAI.earned).toBeCloseTo(110 - 100 + 0.63, 12);
    expect(m.breakdownByCoin!.DAI).toMatchObject({ gasSwap: 2.63, rangeMoveLoss: 0, taxes: 0, generated: 8 });
    expect(m.breakdownBasis).toMatchObject({ earned: 'tradeProfit', itemized: true });
    identity(m);
  });
  it('gas lost on a failed trade and token tax are costs too; a close-out sale is not a round trip', () => {
    const failed = { side: 'buy', intervalIndex: 4, timestamp: 3, stableAmount: 0, gasQuote: 0.5, failed: true, realizedPnlQuote: -0.5 };
    const taxed = { ...sell, taxPct: 0.01 };
    const out = { side: 'sell', intervalIndex: -1, timestamp: 4, stableAmount: 50, gasQuote: 0.2, feeQuote: 0.1, realizedPnlQuote: -1 };
    const c = roundTripCosts([buy, taxed, failed, out] as never);
    expect(c.gas).toBeCloseTo(2.5, 12);
    expect(c.lostGas).toBe(0.5);
    expect(c.taxes).toBeCloseTo(1.1, 12);
    expect(c.roundTrips).toBe(1);
  });
  it('grid: the gas spent sending profits out is a cost of Generated and of Total P&L', () => {
    const g = {
      id: 'gp', kind: 'grid', status: 'running', quoteSym: 'USDC', config: { totalCapitalQuote: 100 }, pnl: { realized: 10, unrealized: 0 },
      stats: { generated: 10, roundTrips: 2, totalGas: 1, totalFees: 0.5, rtCosts: { gas: 1, poolFees: 0.5, taxes: 0, lostGas: 0, roundTrips: 2, unmatched: 0 } },
      payout: { sent: 8, gasQuote: 0.3 }, trades: [], startedAt: 1,
    };
    const m = gridMetrics(g, AS_OF);
    expect(m.generated!.USDC).toBeCloseTo(9.7, 12);
    expect(m.quote.totalPnl).toBeCloseTo(9.7, 12); // value now 102 + paid out 8 − gas 0.3 − capital 100
    expect(m.quote.gas).toBeCloseTo(1.3, 12);
    expect(m.breakdownByCoin!.USDC.gasSwap).toBeCloseTo(1.8, 12);
    identity(m);
    const kept = gridMetrics({ ...g, payout: { sent: 0, gasQuote: 0 } }, AS_OF);
    expect(kept.generated!.USDC).toBe(10);
    expect(kept.quote.totalPnl).toBeCloseTo(10, 12);
  });
  it('what was put in, per coin: a liquidity bot funded with both coins lists both', () => {
    const lp = { id: 'l2', kind: 'lp', status: 'running', base: 'ETH', quote: 'USDG', quoteSym: 'USDG', usdPerQuote: 1, startValue: 1468.5, startPrice: 2342.5, startedAt: 1, config: { capital: 1000, baseAmount: 0.2, bandPct: 0.1 }, pnl: { net: 0, price: 0, fees: 0, gas: 0, swapCost: 0, moveLoss: 0, equity: 1468.5, feeCoins: { base: 0, quote: 0 } }, totals: { gas: 0, swapCost: 0, moveLoss: 0 }, value: 1468.5 };
    expect(lpMetrics(lp, AS_OF).capitalCoins).toEqual({ USDG: 1000, ETH: 0.2 });
    expect(lpMetrics({ ...lp, config: { ...lp.config, baseAmount: 0 } }, AS_OF).capitalCoins).toEqual({ USDG: 1000 });
    expect(gridMetrics({ id: 'g3', kind: 'grid', status: 'running', quoteSym: 'DAI', config: { totalCapitalQuote: 200 }, pnl: { realized: 0 }, stats: {}, trades: [] }, AS_OF).capitalCoins).toEqual({ DAI: 200 });
  });
  it('a sell whose buy is not in the log: not itemized, still adds up', () => {
    const m = gridMetrics({ id: 'g2', kind: 'grid', status: 'running', quoteSym: 'DAI', config: { totalCapitalQuote: 200 }, pnl: { realized: 8 }, stats: { generated: 8 }, trades: [sell] }, AS_OF);
    expect(m.breakdownBasis!.itemized).toBe(false);
    identity(m);
  });
  it('trend: every filled sell counts, from the status rtCosts or its trades', () => {
    const t = { id: 't1', kind: 'trend', status: 'running', quoteSym: 'USDC', quote: 'ethereum:ETH/USDC', capital: 100, pnl: { realized: 8, unrealized: 0 }, trades: [sell, buy], startedAt: 1 };
    const m = trendMetrics(t, AS_OF);
    expect(m.breakdownByCoin!.USDC).toMatchObject({ gasSwap: 2.63, generated: 8 });
    identity(m);
    expect(trendMetrics({ ...t, rtCosts: { gas: 1, poolFees: 0, taxes: 0, lostGas: 0, roundTrips: 1, unmatched: 0 } }, AS_OF).breakdownByCoin!.USDC.earned).toBe(9);
  });
  it('token trader: itemized from its ledger (pool fees + gas, taxes), adding up to Generated (a014); an old dollar log has no lines', () => {
    // the trader's own ledger is the source (one mode at a time); fees and taxes are already inside proceeds / cost
    const weth = { chainId: 1, address: null, symbol: 'WETH', native: true };
    const tt = tokenMetrics({ on: true, options: { mode: 'paper' }, generated: [{ mode: 'paper', coin: weth, amount: 0.095, proceeds: 1.1, cost: 1, fees: 0.02, taxes: 0.01, gasNative: 0.005, gasInAmount: true, closed: 1, fills: 2, basis: 'closed' }], trades: [{ t: 1, mode: 'paper', side: 'buy', label: 'PEPE/WETH', amount: 1, usd: 3000 }, { t: 2, mode: 'paper', side: 'sell', label: 'PEPE/WETH', amount: 1.1, usd: 3300, pnl: 0.1 }], positions: [] }, AS_OF);
    const b = tt.breakdownByCoin!.WETH;
    expect(b.generated).toBeCloseTo(0.095, 12);
    expect(b.gasSwap).toBeCloseTo(0.025, 12); // pool fees 0.02 + gas 0.005
    expect(b.taxes).toBeCloseTo(0.01, 12);
    expect(b.earned - b.gasSwap - b.taxes).toBeCloseTo(b.generated, 12);
    expect(tt.breakdownBasis!.itemized).toBe(true);
    const old = tokenMetrics({ on: true, trades: [{ t: 1, side: 'sell', usd: 30, pnlUsd: 2 }], positions: [] }, AS_OF);
    expect(old.breakdownByCoin).toBeNull();
  });
});

describe('Details render: collapsed, per coin, adds up', () => {
  const l = R.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
  const b = { ...l, kind: 'lp', metrics: lpMetrics(l, AS_OF) };
  it('the lines are inside a closed <details> and print the ETH parts', () => {
    const html = renderToStaticMarkup(createElement(MoneyDetails, { b }));
    expect(html).toMatch(/^<details class="more money-details" data-testid="money-details"><summary>/); // no `open`
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).toContain('Fees earned, ETH');
    expect(text).toContain('+0.0268369 ETH');
    expect(text).toContain('− Gas + swap fees, ETH');
    expect(text).toContain('−0.0026334 ETH');
    expect(text).toContain('− Range moves, ETH');
    expect(text).toContain('−0.0224729 ETH');
    expect(text).toContain('= Generated, ETH');
    expect(text).toMatch(/Fees earned, USDC\s+all of it is Generated/);
    expect(text).not.toMatch(/\$|\bUSD\b/);
  });
  it('the rows follow breakdownByCoin exactly (earned, each non-zero cost, = Generated)', () => {
    const rows = coinBreakdownRows(b.metrics).map(([k]) => k);
    expect(rows).toEqual(['Fees earned, USDC', 'Fees earned, ETH', '− Gas + swap fees, ETH', '− Range moves, ETH', '= Generated, ETH']);
  });
});

describe('Invested fallback: legacy grid config.totalCapitalUsd (quote-coin units)', () => {
  const g = { ...R.grids.find((x: Obj) => x.id === 'g-mvowdsys-i5iq'), kind: 'grid' };
  it('only totalCapitalUsd: capitalInQuote from it, source legacy-config', () => {
    const { totalCapitalQuote: _q, ...cfg } = g.config;
    const m = gridMetrics({ ...g, config: cfg }, AS_OF);
    expect(m.capitalInQuote).toBe(14_000_000); // PLS: the HEX~ grid spent 700,000 + 6,300,000 PLS on its buys
    expect(m.capitalInSource).toBe('legacy-config');
    expect(m.quote.capitalIn).toBe(14_000_000);
  });
  it('totalCapitalQuote wins when present (source config); neither: null', () => {
    expect(gridMetrics(g, AS_OF)).toMatchObject({ capitalInQuote: 14_000_000, capitalInSource: 'config' });
    const m = gridMetrics({ ...g, config: { lowerPrice: 1, upperPrice: 2, gridCount: 3 } }, AS_OF);
    expect(m).toMatchObject({ capitalInQuote: null, capitalInSource: null });
  });
});

describe('#43 regression: the closed Robinhood ETH/USDG LP is −16.31 USDG, never +89.51', () => {
  const F = JSON.parse(readFileSync(new URL('./fixtures/real-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
  const saved = F.lpClosedLegacy.state as Obj; // saved state: 12 moves, totals.moveLoss 0 (zeroed by the v5 upgrade)
  const fromOldServer = { ...F.lpClosedLegacy.status, ...saved, kind: 'lp', pnl: null, value: null }; // no load-time rebuild
  it('a payload that never had the rebuild: botMetrics rebuilds the move loss (same math as the engine)', () => {
    const m = lpMetrics(fromOldServer, F.now);
    expect(m.generated!.USDG).toBeCloseTo(-16.31, 2);
    expect(m.breakdownByCoin!.USDG.rangeMoveLoss).toBeCloseTo(105.82, 2);
    identity(m);
  });
  it('a payload the server already rebuilt is not charged twice', () => {
    const l = R.lps.find((x: Obj) => x.id === 'lp-mvfv3g7g-to6l');
    expect(l.totals.moveLossBackfill).toBeDefined();
    expect(lpMetrics(l, AS_OF).generated!.USDG).toBeCloseTo(-16.311152863527596, 9);
  });
});

describe('no fills: 0, not null', () => {
  it('a grid with no stats, no realized and no trades', () => {
    expect(gridMetrics({ id: 'g', kind: 'grid', status: 'running', quoteSym: 'DAI', config: { totalCapitalQuote: 10 } }, AS_OF).generated).toEqual({ DAI: 0 });
  });
  it('a trend with no pnl and no trades', () => {
    expect(trendMetrics({ id: 't', kind: 'trend', status: 'running', quoteSym: 'USDC', capital: 10 }, AS_OF).generated).toEqual({ USDC: 0 });
  });
  it('but a bot with fills and no figure stays unknown (null)', () => {
    expect(gridMetrics({ id: 'g', kind: 'grid', status: 'running', quoteSym: 'DAI', moveCount: 3 }, AS_OF).generated).toBeNull();
  });
});
