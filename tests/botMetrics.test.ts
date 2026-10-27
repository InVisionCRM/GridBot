/**
 * One definition per bot, computed on the server (src/metrics/botMetrics.ts); every UI figure shows the same number.
 * Headline: units GENERATED per token, net of the costs charged in that token. Total P&L = Generated + Price change.
 */
import { describe, expect, it } from 'vitest';
import { botMetrics, DAY_MS, HEADLINE, type BotMetrics } from '../src/metrics/botMetrics';
import { feesToday, localDayStart } from '../src/metrics/feesToday';
import { botFacts } from '../src/ui/deskStats';
import { bucketItems, deskItems, emptyQuery } from '../src/ui/deskTableModel';
import { feesTodayOf, generatedParts, pnlParts, totalGeneratedUsd, totalPnlUsd } from '../src/ui/botRow';

const now = Date.UTC(2026, 9, 27, 20, 27); // Oct 27 2026, 4:27 PM EDT
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const attach = (b: B): B => ({ ...b, metrics: botMetrics(b, now) });

// ── Live ETH/USDC liquidity bot: on-chain numbers ───────────────────────────────────────────────────────────────
// Ethereum, Uniswap V3 USDC/WETH 0.05% 0x88e6…5640, owner 0x4168…309D. NFTs 1389275 → 1389340 → 1390220 → 1390287 →
// 1390514 (open). Read from the IncreaseLiquidity / DecreaseLiquidity / Collect / Swap events of the 14 bot txs and, for
// the open position, block 26286436 (tick 198723) with collect() simulated from the owner.
const ETH = 2344.17; // mid at block 26286436
const owed = { base: 0.007857928, quote: 19.215007 }; // collect() quote = tokensOwed + feeGrowth
const collected = { base: 0.020004029, quote: 45.433428 }; // Σ (Collect − DecreaseLiquidity) over the 4 exits
const gasEth = 0.000712; // 14 txs + 3 reverted ones
const swapFee = { base: 0.0023232936, quote: 2.2100189 }; // 0.05% of each rebalance swap's input coin
// Range-move loss per exit vs the coins put in, at the exit price, in the coin the next swap sold:
// 23.60 (ETH, fell out) · 1.14 (USDC, manual width change) · 19.52 (ETH, fell out) · 19.84 (USDC, rose out)
const moveLoss = { base: 23.6 / 2334.22 + 19.52 / 2307.77, quote: 1.14 + 19.84 };
const position = { base: 0.869807, quote: 5981.143321 };
const capital = 8000; // fixture: the bot's real start value is in data/state.json, not on-chain
const value = (position.base + owed.base) * ETH + position.quote + owed.quote;
// Quote-valued totals as the engine books them (each event at its own price): ≈ $92 collected, $1.67 gas,
// $7.61 swap fees, $64.10 range-move losses.
const totals = {
  fees: 91.97, gas: 1.67, swapCost: 7.61, moveLoss: 64.1, sent: 0, feeCoins: collected,
  gasCoins: { base: gasEth, quote: 0 }, swapCoins: swapFee, moveCoins: moveLoss,
};
function lpPnl(v: number, start: number, t: typeof totals) { // LpEngine.pnl()
  const equity = v + t.sent - t.gas;
  const fees = t.fees + owed.base * ETH + owed.quote;
  const net = fees - t.gas - t.swapCost - t.moveLoss;
  return { equity, fees, gas: t.gas, swapCost: t.swapCost, moveLoss: t.moveLoss, net, price: equity - start - net,
    feeCoins: { base: t.feeCoins.base + owed.base, quote: t.feeCoins.quote + owed.quote } };
}
const lpLive: B = {
  kind: 'lp', id: 'lp-eth', mode: 'live', status: 'running', label: 'ETH/USDC', base: 'ETH', quote: 'USDC', chainId: 1,
  startedAt: Date.UTC(2026, 9, 25, 4, 47), usdPerQuote: 1, price: ETH, value, startValue: capital, config: { capital },
  totals, owed, reranges: 4, inRange: true, position: { lower: 2307.72, upper: 2356.69 },
  pnl: lpPnl(value, capital, totals),
  feeHist: [[localDayStart(now) - 600_000, 100], [now - 3_600_000, 120]],
};
// Paper copy: half the size, $20 of fees sent out instead of re-deposited, state from before per-coin bookkeeping.
const paperTotals = { ...totals, sent: 20, gasCoins: undefined, swapCoins: undefined, moveCoins: undefined } as unknown as typeof totals;
const lpPaper: B = {
  ...lpLive, id: 'lp-paper', mode: 'paper', value: value / 2, startValue: 4000, config: { capital: 4000 },
  totals: paperTotals, pnl: lpPnl(value / 2, 4000, paperTotals), feeHist: [[localDayStart(now) - 60_000, 50]],
};
// HEX/PLS grid: spends PLS (quote), "stacks" HEX (base). Capital and profit are in PLS; PLS ≈ $0.0000051.
const PLS = 0.0000051;
const grid: B = {
  kind: 'grid', id: 'grid-hex', mode: 'live', status: 'running', stable: 'HEX', quoteSym: 'PLS', base: 'HEX', chainId: 369, usdPerQuote: PLS,
  startedAt: now - 10 * DAY_MS, price: 220, config: { totalCapitalQuote: 14_000_000, lowerPrice: 200, upperPrice: 240, gridCount: 10 },
  pnl: { realized: 140_000, unrealized: -35_000, plsHeld: 1, costQuote: 1 }, payout: { sent: 50_000 },
  stats: { roundTrips: 3, wins: 2, totalFees: 9_000, totalGas: 1_000 }, moveCount: 7, recenter: { count: 1 },
  trades: [
    { timestamp: now - 60_000, feeQuote: 1_000_000, roundTripNet: 150_000, stableAmount: 2_000_000, taxPct: 0.01 },
    { timestamp: now - 2 * DAY_MS, feeQuote: 5, roundTripNet: -10_000 },
  ],
};
const trend: B = {
  kind: 'trend', id: 'trend-pls', mode: 'paper', status: 'running', quote: 'DAI', chainId: 369, usdPerQuote: 1,
  startedAt: now - 1 * DAY_MS, capital: 500, cash: 260, pnl: { equity: 515, realized: 10, unrealized: 5, fees: 1.2, gas: 0.3, returnPct: 0.03 },
  moveCount: 4, trades: [{ timestamp: now - 3_600_000, feeQuote: 0.4 }],
};
const token: B = {
  kind: 'token', id: 'token-trader', on: true, options: { mode: 'paper' },
  trades: [
    { t: now - 3 * DAY_MS, side: 'buy', usd: 100, pnlUsd: null },
    { t: now - 2 * DAY_MS, side: 'buy', usd: 50, pnlUsd: null },
    { t: now - 1 * DAY_MS, side: 'sell', usd: 130, pnlUsd: 30 },
  ],
  positions: [{ id: 'p', spentUsd: 50, entryTokens: 10, tokens: 10, pnlUsd: -10 }],
};
const all = [lpLive, lpPaper, grid, trend, token].map(attach);
const m = (id: string) => all.find((b) => b.id === id)!.metrics as BotMetrics;

describe('generated: units per token, net of the costs charged in that token', () => {
  it('liquidity (on-chain): fees collected + owed per coin − gas (ETH) − swap fees − range-move losses', () => {
    const x = m('lp-eth');
    expect(x.headline).toBe('generated');
    expect(HEADLINE).toBe('generated');
    expect(x.generated!.ETH).toBeCloseTo(0.027861957 - 0.000712 - 0.0023232936 - moveLoss.base, 9);
    expect(moveLoss.base).toBeCloseTo(0.018566, 5); // receipts: 0.0185661 ETH
    expect(x.generated!.ETH).toBeCloseTo(0.00626, 5);
    expect(x.generated!.USDC).toBeCloseTo(64.648435 - 2.2100189 - 20.98, 6);
    expect(x.generated!.USDC).toBeCloseTo(41.46, 2); // receipts: 41.455 USDC (exit losses here are rounded to cents)
    expect(x.generatedUsd).toBeCloseTo(x.generated!.ETH * ETH + x.generated!.USDC, 9);
    expect(x.generatedUsd).toBeCloseTo(56.13, 2);
    // the event-priced dollars agree within the ETH price drift between events and now
    expect(x.dollarsMadeUsd).toBeCloseTo(129.6 - 1.67 - 7.61 - 64.1, 1);
    expect(Math.abs(x.dollarsMadeUsd! - x.generatedUsd!)).toBeLessThan(0.5);
    expect(x.feesUncollectedUsd).toBeCloseTo(37.62, 1);
    expect(x.feesEarnedUsd).toBeCloseTo(129.6, 1);
    expect(x.realizedRebalanceLossUsd).toBeCloseTo(64.1, 6);
    expect(x.tokenTaxesUsd).toBeNull();
    expect(x.moveCount).toBe(4);
    expect(x.range).toEqual({ lower: 2307.72, upper: 2356.69, current: ETH, inRange: true });
  });
  it('liquidity state from before per-coin bookkeeping charges the costs to the quote coin', () => {
    const x = m('lp-paper');
    expect(x.generated!.ETH).toBeCloseTo(0.027861957, 9);
    expect(x.generated!.USDC).toBeCloseTo(64.648435 - 1.67 - 7.61 - 64.1, 6);
  });
  it('grid: round-trip profit in the coin it spends (PLS), not the one it stacks', () => {
    const x = m('grid-hex');
    expect(Object.keys(x.generated!)).toEqual(['PLS']);
    expect(x.generated!.PLS).toBe(140_000);
    expect(x.generatedUsd).toBeCloseTo(140_000 * PLS, 12);
    expect(x.unrealizedUsd).toBeCloseTo(-35_000 * PLS, 12);
    expect(x.realizedRebalanceLossUsd).toBeCloseTo(10_000 * PLS, 12); // the losing round trip, already inside realized
    expect(x.tokenTaxesUsd).toBeCloseTo(20_000 * PLS, 12);
    expect(x.moveCount).toBe(8); // 7 fills + 1 re-center
    expect(x.fillCount).toBe(7);
    expect(x.aprPct).toBeCloseTo((140_000 / 14_000_000) * 36.5, 9); // generated, not total P&L
  });
  it('trend and token trader: closed trades only', () => {
    expect(m('trend-pls').generated).toEqual({ DAI: 10 });
    expect(m('token-trader').generated).toEqual({ USD: 30 });
    expect(m('token-trader').unrealizedUsd).toBe(-10);
  });
});

describe('Total P&L = Generated + Price change (both sides recomputed from raw inputs)', () => {
  it('liquidity', () => {
    const x = m('lp-eth');
    // independent: value now − gas paid from the wallet − capital in
    const totalRaw = (position.base + owed.base) * ETH + position.quote + owed.quote - 1.67 - capital;
    // independent: the generated coins valued now, from the event amounts
    const ethUnits = collected.base + owed.base - gasEth - swapFee.base - moveLoss.base;
    const usdcUnits = collected.quote + owed.quote - swapFee.quote - moveLoss.quote;
    const genRaw = ethUnits * ETH + usdcUnits;
    expect(x.totalPnlUsd).toBeCloseTo(totalRaw, 6);
    expect(x.generatedUsd).toBeCloseTo(genRaw, 6);
    expect(x.priceChangeUsd).toBeCloseTo(totalRaw - genRaw, 6);
    expect(x.generatedUsd! + x.priceChangeUsd!).toBeCloseTo(x.currentValueUsd! + x.paidOutUsd! - x.gasUsd! - x.capitalInUsd!, 6);
  });
  it('grid, trend, token, paper liquidity', () => {
    // grid: generated = realized, price change = open lots; payouts stay in the P&L
    expect(m('grid-hex').priceChangeUsd).toBeCloseTo(-35_000 * PLS, 12);
    expect(m('grid-hex').generatedUsd! + m('grid-hex').priceChangeUsd!).toBeCloseTo((14_000_000 + 105_000 - 50_000 + 50_000 - 14_000_000) * PLS, 12);
    expect(m('trend-pls').priceChangeUsd).toBeCloseTo(5, 12);
    expect(m('trend-pls').generatedUsd! + m('trend-pls').priceChangeUsd!).toBeCloseTo(515 - 500, 12);
    expect(m('token-trader').generatedUsd! + m('token-trader').priceChangeUsd!).toBeCloseTo(40 + 130 - 150, 12);
    const p = m('lp-paper');
    expect(p.generatedUsd! + p.priceChangeUsd!).toBeCloseTo(value / 2 + 20 - 1.67 - 4000, 6);
  });
});

describe('every surface shows the server figure', () => {
  it('desk row, desk table, stat table, and Home agree with metrics for every kind', () => {
    const items = deskItems(all, () => 'X', now);
    for (const b of all) {
      const x = b.metrics as BotMetrics;
      expect(generatedParts(b).usd).toBe(x.generatedUsd);
      expect(generatedParts(b).units).toBe(x.generated);
      expect(pnlParts(b).usd).toBe(x.totalPnlUsd);
      const f = botFacts(b, now);
      expect(f.generatedUsd).toBe(x.generatedUsd);
      expect(f.pnlUsd).toBe(x.totalPnlUsd);
      expect(f.investedUsd).toBe(x.capitalInUsd);
      expect(f.valueUsd).toBe(x.currentValueUsd);
      expect(f.priceChangeUsd).toBe(x.priceChangeUsd);
      expect(f.aprPct).toBe(x.aprPct);
      expect(f.est.h24?.amount ?? null).toBe(x.est.d1);
      expect(f.calc).toBe(x.calc);
      const row = items.find((i) => i.b.id === b.id);
      if (row) expect(row.facts.generatedUsd).toBe(x.generatedUsd);
    }
    expect(totalGeneratedUsd(all)).toBeCloseTo(all.reduce((s, b) => s + (b.metrics.generatedUsd ?? 0), 0), 9);
    expect(totalPnlUsd(all)).toBeCloseTo(all.reduce((s, b) => s + (b.metrics.totalPnlUsd ?? 0), 0), 9);
  });
  it('the desk table sorts by generated dollars', () => {
    const items = deskItems(all, () => 'X', now);
    const rows = bucketItems(items, { ...emptyQuery(), sort: 'generated', dir: 'desc' }).flatMap((g) => g.rows);
    const byBucket = rows.map((r) => r.facts.generatedUsd ?? -Infinity);
    expect(rows.length).toBeGreaterThan(0);
    for (const g of bucketItems(items, { ...emptyQuery(), sort: 'generated', dir: 'desc' })) {
      const v = g.rows.map((r) => r.facts.generatedUsd ?? -Infinity);
      expect(v).toEqual([...v].sort((a, b) => b - a));
    }
    expect(byBucket.length).toBe(rows.length);
  });
  it('a bot without server metrics shows dashes, never a client-side guess', () => {
    const { metrics, ...raw } = all.find((b) => b.id === 'grid-hex')!; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(pnlParts(raw).usd).toBeNull();
    expect(generatedParts(raw).text).toBe('—');
    expect(botFacts(raw, now).pnlUsd).toBeNull();
  });
});

describe('rates: linear, capped at 365/7 × the history', () => {
  it('a 2.65-day-old bot gets per-day and per-week units but a dash and a hint for the year and APR', () => {
    const x = m('lp-eth');
    const days = (now - lpLive.startedAt) / DAY_MS;
    expect(x.generatedRate.d1!.ETH).toBeCloseTo(x.generated!.ETH / days, 12);
    expect(x.generatedRate.d7!.USDC).toBeCloseTo((x.generated!.USDC / days) * 7, 9);
    expect(x.generatedRate.d365).toBeNull();
    expect(x.est.d365).toBeNull();
    expect(x.aprPct).toBeNull();
    expect(x.est.needs).toEqual({ d1: null, d7: null, d30: null, d365: 'needs 7d of history' });
  });
});

describe('fees today', () => {
  const ft = feesToday(all, now);
  it('headline counts live liquidity fees earned since midnight; paper and fees paid stay separate', () => {
    expect(ft.liveEarnedUsd).toBeCloseTo(lpLive.pnl.fees - 100, 6);
    expect(ft.paperEarnedUsd).toBeCloseTo(lpPaper.pnl.fees - 50, 6);
    expect(ft.livePaidUsd).toBeCloseTo(1_000_000 * PLS, 9);
    expect(ft.paperPaidUsd).toBeCloseTo(0.4, 9);
  });
  it('Home reads it, limited to the bots on screen', () => {
    expect(feesTodayOf({ feesToday: ft }, all).liveEarnedUsd).toBeCloseTo(ft.liveEarnedUsd, 9);
    const onlyPaper = feesTodayOf({ feesToday: ft }, all.filter((b) => b.mode === 'paper'));
    expect(onlyPaper.liveEarnedUsd).toBe(0);
    expect(onlyPaper.paperEarnedUsd).toBeCloseTo(ft.paperEarnedUsd, 9);
  });
});

describe('status payload', async () => {
  const { MultiBot } = await import('../src/server/bot/multi');
  const { Logger } = await import('../src/server/bot/logger');
  const { MemoryStore } = await import('../src/server/bot/store');
  const { NET, MockChain } = await import('./helpers/mockChain');
  it('every bot in /api/bot/status carries metrics, and metricsFor(id) returns the same figures', async () => {
    const P0 = 0.00001;
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 });
    const st = bot.status();
    const g = st.grids.find((x) => x.id === id)!;
    expect(g.metrics).toMatchObject({ botId: id, kind: 'grid', mode: 'paper', headline: 'generated' });
    expect(g.metrics.quote.capitalIn).toBe(30);
    expect(st.feesToday).toMatchObject({ liveEarnedUsd: 0 });
    expect(bot.metricsFor(id)).toMatchObject({ botId: id, totalPnlUsd: g.metrics.totalPnlUsd, generatedUsd: g.metrics.generatedUsd });
    expect(bot.metricsFor('nope')).toBeNull();
  });
});
