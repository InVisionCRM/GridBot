/**
 * Fixes found by reconciling against a real read-only pull (Oct 27 2026, 5:07 PM ET; actuals in the audit notes).
 * Fixture: tests/fixtures/real-2026-10-27.json — a sanitized subset (bot ids, amounts, prices, times; no addresses,
 * tx hashes, keys or env).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { upgradeLp, backfillMoveLoss, type LpState } from '../src/server/bot/lpEngine';
import { isCloseOut, legacyTradeNames, roundTripStats, totals, upgradeQuoteNames, type LiveTrade } from '../src/live/ledger';
import { gridMetrics, lpMetrics, botMetrics, bridgeCostsOf } from '../src/metrics/botMetrics';
import { liveAggregate } from '../src/server/bot/multi';
import { botFacts } from '../src/ui/deskStats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const FX = JSON.parse(readFileSync(new URL('./fixtures/real-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const NOW: number = FX.now;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Grid status the way engine.status() builds it (current names), from a saved state with the old names. */
function gridStatus(fx: Obj, saved: Obj = fx.state): Obj {
  const g = upgradeQuoteNames(clone(saved)) as Obj;
  const trades = (g.trades as LiveTrade[]).filter((t) => !!t.paper === (g.mode === 'paper'));
  const t = totals(trades, fx.status.price);
  const out = {
    ...fx.status, kind: 'grid', id: g.id, mode: g.mode, status: g.status, startedAt: g.startedAt, config: g.config,
    trades, stats: roundTripStats(trades),
    pnl: { realized: t.realized, unrealized: t.unrealized, gasQuote: t.gasQuote, plsHeld: t.pos.plsHeld, costQuote: t.pos.costQuote },
  };
  return { ...out, metrics: gridMetrics(out, NOW) };
}
function lpClosedStatus(state: LpState): Obj {
  const out = { ...FX.lpClosedLegacy.status, ...state, kind: 'lp', pnl: null, value: null };
  return { ...out, metrics: lpMetrics(out, NOW) };
}
/** The live LP as the server sends it now: the snapshot's pnl came from the old pnl() (net also took out the move loss). */
const lpLive = (): Obj => {
  const b = { ...clone(FX.lpLive) };
  const p = b.pnl, net = p.fees - p.gas - p.swapCost;
  b.pnl = { ...p, net, price: p.equity - b.startValue - net };
  return { ...b, metrics: lpMetrics(b, NOW) };
};

describe('real snapshot: LP Generated is units earned; range-move losses are reported beside it, not taken out', () => {
  it('Fees paid = gas + swaps, so fees earned − fees paid = what it made', () => {
    const b = lpLive(), k = b.usdPerQuote, t = b.totals;
    const f = botFacts(b, NOW);
    expect(f.feesPaidUsd!).toBeCloseTo((t.gas + t.swapCost) * k, 6);
    expect(f.feesPaidUsd! / k).toBeCloseTo(0.002633, 5); // gas + swaps (actuals)
    expect(f.feesEarnedUsd! - f.feesPaidUsd!).toBeCloseTo(b.metrics.dollarsMadeUsd, 6);
    expect(b.metrics.dollarsMadeUsd / k).toBeCloseTo(0.028842 + 0.022473, 5); // fees − gas − swaps, ETH
    expect(b.metrics.realizedRebalanceLossUsd / k).toBeCloseTo(0.022473, 5); // the 3 moves, reported on their own
  });
  it('generated per coin = fees − gas − swaps', () => {
    const b = lpLive(), m = b.metrics;
    const gen = m.generated!;
    expect(gen.USDC).toBeCloseTo(b.pnl.feeCoins.base, 6);
    expect(gen.ETH).toBeCloseTo(b.pnl.feeCoins.quote - b.totals.gas - b.totals.swapCost, 9);
  });
  it('the LP page has no "Lost to range moves" tile; the loss is a Details info row, not a cost line', () => {
    const src = readFileSync(new URL('../src/ui/LpDetail.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('>Lost to range moves<');
    expect(src).toMatch(/metrics\.breakdownByCoin/);
    const md = readFileSync(new URL('../src/ui/MoneyDetails.tsx', import.meta.url), 'utf8');
    expect(md).toContain("'Range moves (in Price change)'");
    expect(md).not.toMatch(/rangeMoveLoss/);
  });
});

describe('real snapshot: closed Robinhood ETH/USDG LP move loss is rebuilt at load (#2)', () => {
  const saved = FX.lpClosedLegacy.state as LpState;
  it('the saved state shows 12 moves and no loss (zeroed by the v5 upgrade)', () => {
    expect(saved.reranges).toBe(12);
    expect(saved.totals.moveLoss).toBe(0);
    // what the app showed (+89.51 = fees − gas, no move loss) …
    expect(saved.totals.fees - saved.totals.gas).toBeCloseTo(89.51, 2);
    // … which is Generated again under the units rule; the rebuilt move loss is reported beside it even when no server rebuilt it
    const m = lpClosedStatus(clone(saved)).metrics;
    expect(m.generated.USDG).toBeCloseTo(89.51, 2);
    expect(m.realizedRebalanceLossUsd).toBeCloseTo(105.82, 2);
  });
  it('load rebuilds ≈105.8 USDG lost to moves, reported beside its +89.51 USDG Generated (fees − gas)', () => {
    const before = clone(saved);
    const up = upgradeLp(clone(saved));
    expect(saved).toEqual(before); // never edits the saved object
    expect(up.version).toBe(7);
    expect(up.totals.moveLoss).toBeCloseTo(105.82, 2);
    expect(up.totals.moveLossBackfill).toMatchObject({ price: saved.lastPrice });
    const m = lpClosedStatus(up).metrics;
    expect(m.generated!.USDG).toBeCloseTo(89.51, 2);
    expect(m.generated!.ETH).toBe(0);
    expect(m.realizedRebalanceLossUsd!).toBeCloseTo(105.82, 2);
    expect(m.dollarsMadeUsd!).toBeCloseTo(89.51, 2);
    // Total P&L = idle coins at the exit price − gas − start ≈ −53.2 USDG; price change = the rest. (The actuals' −141.51
    // price effect was taken against the app's uncorrected +89.51 net: −141.51 + 105.82 ≈ −35.7, the gap being the exit
    // price vs the last value point.)
    expect(m.totalPnlUsd!).toBeCloseTo(0.8717608375797146 * 2332.745368296711 + 117.28207 - 0.8165948 - 2203.2534147, 3);
    expect(m.priceChangeUsd!).toBeCloseTo(-36.88 - 105.82, 1); // the move loss now sits in Price change
    expect(m.generatedUsd! + m.priceChangeUsd!).toBeCloseTo(m.totalPnlUsd!, 9);
  });
  it('is idempotent and leaves bots it cannot rebuild exactly alone', () => {
    const once = upgradeLp(clone(saved));
    expect(upgradeLp(clone(once))).toEqual(once);
    expect(backfillMoveLoss(once)).toBe(once);
    const running = { ...clone(saved), status: 'running' as const };
    expect(backfillMoveLoss(running)).toBe(running);
    const sent = { ...clone(saved), totals: { ...clone(saved).totals, sent: 5 } };
    expect(backfillMoveLoss(sent)).toBe(sent);
    const counted = { ...clone(saved), totals: { ...clone(saved).totals, moveLoss: 3 } };
    expect(backfillMoveLoss(counted)).toBe(counted);
  });
});

describe('real snapshot: aggregate (Total profit moved alert) is live-only and includes LPs (#3)', () => {
  it('sums live grids and LPs from their metrics and leaves paper out', () => {
    const lpClosed = lpClosedStatus(upgradeLp(clone(FX.lpClosedLegacy.state)));
    const live = [lpLive(), lpClosed];
    const hex = gridStatus(FX.gridHexLegacy); // live
    const paper = [gridStatus(FX.gridSchiffyStopped), gridStatus(FX.gridEthUsdgStopped)];
    expect(hex.mode).toBe('live');
    expect(paper.every((g) => g.mode === 'paper')).toBe(true);
    const a = liveAggregate([hex, ...paper], [], live);
    expect(a.mode).toBe('live');
    expect(a.bots).toBe(3);
    const sum = (f: (m: Obj) => number) => [hex, ...live].reduce((x, b) => x + f(b.metrics), 0);
    expect(a.realized).toBeCloseTo(sum((m) => m.realizedUsd), 9);
    expect(a.unrealized).toBeCloseTo(sum((m) => m.unrealizedUsd ?? 0), 9);
    expect(a.realized + a.unrealized).toBeCloseTo(sum((m) => m.totalPnlUsd), 6);
    expect(a.roundTrips).toBe(0); // the live grid has no completed round trip
    expect(a.lpFeesEarnedUsd).toBeGreaterThan(0);
    // the paper grids' +$15 / round trips are not in it
    expect(liveAggregate(paper, [], []).bots).toBe(0);
    expect(liveAggregate(paper, [], []).realized).toBe(0);
  });
});

describe('real snapshot: grid *Usd fields are quote coin, renamed *Quote (#4)', () => {
  const saved = FX.gridHexLegacy.state;
  it('old names on load → *Quote names, same values, idempotent', () => {
    expect(saved.config.totalCapitalUsd).toBe(14_000_000);
    const g = upgradeQuoteNames(clone(saved)) as Obj;
    expect(g.config).toMatchObject({ totalCapitalQuote: 14_000_000 });
    expect('totalCapitalUsd' in g.config).toBe(false);
    expect(g.quotePerBuy).toBe(saved.usdPerBuy);
    expect('usdPerBuy' in g).toBe(false);
    expect(g.trades.every((t: Obj) => 'gasQuote' in t && 'realizedPnlQuote' in t && !('gasUsd' in t) && !('realizedPnlUsd' in t))).toBe(true);
    expect(g.trades.map((t: Obj) => t.gasQuote)).toEqual(saved.trades.map((t: Obj) => t.gasUsd));
    expect(upgradeQuoteNames(clone(g))).toEqual(g);
  });
  it('dollars are converted: the HEX grid\'s 14M PLS capital is ≈ $71, its 82 PLS gas ≈ $0.0004', () => {
    const b = gridStatus(FX.gridHexLegacy), m = b.metrics, k = b.usdPerQuote;
    expect(b.quoteSym).toBe('PLS');
    expect(m.capitalInUsd!).toBeCloseTo(14_000_000 * k, 6);
    expect(m.capitalInUsd!).toBeLessThan(100);
    expect(m.gasUsd! / k).toBeCloseTo(82.16, 1);
    expect(m.generated).toEqual({ PLS: 0 });
  });
  it('API readers of the old names still get them (quote coin) next to the new ones', () => {
    const t = legacyTradeNames(upgradeQuoteNames(clone(saved)).trades[0] as LiveTrade);
    expect(t.gasUsd).toBe(t.gasQuote);
    expect(t.realizedPnlUsd).toBe(t.realizedPnlQuote);
  });
});

describe('real snapshot: a stopped grid\'s cash-out sale is not a round trip (#5)', () => {
  it('SCHIFFY: the sale of the free coins at stop is a close-out; Generated 0, the loss is price change', () => {
    const b = gridStatus(FX.gridSchiffyStopped), m = b.metrics;
    const sell = b.trades.find((t: LiveTrade) => t.side === 'sell');
    expect(sell.intervalIndex).toBe(-1);
    expect(isCloseOut(sell)).toBe(true);
    expect(b.stats.roundTrips).toBe(0);
    expect(b.stats.wins).toBe(0);
    expect(b.stats.closeOuts).toBe(1);
    expect(b.stats.closeOutNet).toBeCloseTo(-0.004326, 6);
    expect(m.generated).toEqual({ ETH: 0 });
    expect(m.realizedRebalanceLossUsd).toBe(0);
    expect(m.quote.realized).toBeCloseTo(-0.004326, 6); // still in realized cash / Total P&L
    expect(m.priceChangeUsd!).toBeCloseTo(m.totalPnlUsd!, 9);
  });
  it('a grid with only real round trips is unchanged (ETH/USDG: +15.33 USDG over 10 round trips)', () => {
    const b = gridStatus(FX.gridEthUsdgStopped);
    expect(b.stats.roundTrips).toBe(10);
    expect(b.metrics.generated.USDG).toBeCloseTo(15.33, 2);
  });
});

describe('bridge cost hook (design only, no bridging)', () => {
  it('per-event costs in the bot\'s coin come off Generated; none → null', () => {
    const b = lpLive();
    expect(b.metrics.bridgeCosts).toBeNull();
    expect(b.metrics.inTransitUsd).toBeNull();
    const costs = [
      { at: NOW, kind: 'bridgeFee', coin: 'ETH', units: 0.0004, usdAtEvent: 0.94 },
      { at: NOW, kind: 'gasDestination', coin: 'ETH', units: 0.0001, usdAtEvent: 0.23 },
    ];
    const withBridge = { ...b, bridge: { costs } };
    expect(bridgeCostsOf(withBridge)).toEqual({ events: 2, units: { ETH: 0.0005 }, usdAtEvents: 0.94 + 0.23 });
    const m = botMetrics(withBridge, NOW)!;
    expect(m.generated!.ETH).toBeCloseTo(b.metrics.generated.ETH - 0.0005, 12);
    expect(m.generated!.USDC).toBe(b.metrics.generated.USDC);
    expect(m.generatedUsd! + m.priceChangeUsd!).toBeCloseTo(m.totalPnlUsd!, 9);
  });
});

