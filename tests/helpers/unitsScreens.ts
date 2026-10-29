/**
 * Screens for the "crypto units only" check (tests/noDollars.test.tsx) and the phone screenshots: the real sanitized
 * status payload (tests/fixtures/real-status-2026-10-27.json, metrics recomputed with this checkout), plus what that
 * payload doesn't carry: one trend bot, the token trader, an analytics overview and journal built from the fixture's
 * own bots, market panels and a wallet snapshot. Amounts only; no addresses or keys.
 */
import { readFileSync } from 'node:fs';
import { gridMetrics, lpMetrics, trendMetrics, tokenMetrics, tokenSpendTotals } from '../../src/metrics/botMetrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const RAW = JSON.parse(readFileSync(new URL('../fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
export const AS_OF: number = RAW.grids[0].metrics.asOf;
const H = 3_600_000;

const trendRaw: Obj = {
  id: 't-units-1', kind: 'trend', name: 'Trend ETH/USDG', mode: 'paper', status: 'running', quote: 'robinhood:ETH/USDG', base: 'ETH', chainId: 4663,
  usdPerQuote: 1, tf: '1h', startedAt: AS_OF - 9 * 24 * H, capital: 500, cash: 260, price: 2341.18, priceAt: AS_OF - 60_000,
  cfg: { strategy: 'ema', fast: 9, slow: 21 }, nextCloseAt: AS_OF + 20 * 60_000, warm: null, lastNote: 'EMA9 above EMA21',
  pnl: { equity: 515.4, realized: 12.75, unrealized: 2.65, fees: 1.2, gas: 0.3, returnPct: 0.0308 },
  stats: { count: 3, winRate: 2 / 3, maxDrawdown: 0.021 }, blocked: 1, moveCount: 6, signals: [{ at: AS_OF - 2 * H, kind: 'buy', note: 'EMA cross up' }],
  position: { pls: 0.1025, entryPrice: 2315.4, bars: 2, unrealized: 2.65, unrealizedPct: 0.0112, risk: { stop: 2250, initialStop: 2250, entry: 2315.4, tp: 2480 } },
  trades: [
    { id: 'a', timestamp: AS_OF - 2 * H, side: 'buy', reason: 'EMA cross up', plsAmount: 0.1025, price: 2315.4, feeQuote: 0.4 },
    { id: 'b', timestamp: AS_OF - 30 * H, side: 'sell', reason: 'take profit', plsAmount: 0.1, price: 2390.1, realizedPnlQuote: 7.31, holdMs: 11 * H, feeQuote: 0.4 },
  ],
  equityHist: [[AS_OF - 48 * H, 500], [AS_OF - 24 * H, 507.3], [AS_OF, 515.4]],
};

export const S: Obj = {
  ...RAW,
  grids: RAW.grids.map((g: Obj) => ({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, AS_OF) })),
  lps: RAW.lps.map((l: Obj) => ({ ...l, metrics: lpMetrics(l, AS_OF) })),
  trends: [{ ...trendRaw, metrics: trendMetrics(trendRaw, AS_OF) }],
};
export const TREND_ID = trendRaw.id;

/** The token trader, as /api/token-trader returns it (new log lines carry the coin they spend). */
export const TRADER: Obj = (() => {
  const t: Obj = {
    id: 'token-trader', kind: 'token', on: true, openUsd: 120, lastError: null, entriesHalt: null, exitsManaged: 1,
    options: { mode: 'paper', perTradeUsd: 60, totalUsd: 300, minPoolAgeSec: 7200, maxPoolShare: 0.02, maxImpact: 0.02, sizeImpactCap: 0.01, risk: 'safe', sniper: { on: false, minLiquidityUsd: 20000, delayBlocks: 2, delaySec: 0, maxPerHour: 3, chains: {} } },
    trades: [
      { t: AS_OF - 3 * H, side: 'sell', chainId: 1, pool: 'p1', label: 'PEPE/WETH', usd: 70.23, price: 1e-5, why: 'take profit +50%', pnlUsd: 10.23, spendSym: 'WETH', amount: 0.03, pnl: 0.00437 },
      { t: AS_OF - 20 * H, side: 'buy', chainId: 1, pool: 'p1', label: 'PEPE/WETH', usd: 60, price: 1e-5, why: 'buy depth ok', pnlUsd: null, spendSym: 'WETH', amount: 0.02563, pnl: null },
      { t: AS_OF - 30 * H, side: 'buy', chainId: 1, pool: 'p2', label: 'MOG/WETH', usd: 60, price: 2e-6, why: 'buy depth ok', pnlUsd: null, spendSym: 'WETH', amount: 0.02563, pnl: null },
    ],
    positions: [{ id: 'tt-1', chainId: 1, pool: 'p2', label: 'MOG/WETH', source: 'scan', spend: '0xspend', spent: 0.02563, spentUsd: 60, usdPerSpend: 2341.0064, entryTokens: 3e7, tokens: 3e7, entryPrice: 8.5e-10, price: 8.9e-10, feeBps: 30, pnlUsd: 2.8, pnl: 2.8 / 2341.0064, spendSym: 'WETH', exitPlan: 'hold' }],
    // the trader's own per-mode ledger: metrics read Generated from it (the log keeps only its newest rows)
    generated: [{ mode: 'paper', coin: { chainId: 1, address: null, symbol: 'WETH', native: true }, amount: 0.00437, proceeds: 0.03, cost: 0.02563, fees: null, taxes: null, gasNative: 0, gasSymbol: 'ETH', gasInAmount: true, closed: 1, basis: 'closed' }],
    feed: [{ t: AS_OF - 3600_000, chainId: 1, pool: 'p3', label: 'WOJ/WETH', verdict: 'skipped', why: "liquidity under the sniper's minimum" }],
  };
  return { ...t, metrics: tokenMetrics(t, AS_OF), spendTotals: tokenSpendTotals(t) };
})();

/** /api/analytics/overview for the live fixture bots (the server's shape; dollars kept, as the API does). */
export function overview(mode: 'live' | 'paper' = 'live'): Obj {
  const bots = [...S.grids, ...S.lps, ...S.trends].filter((b: Obj) => (b.mode === 'live') === (mode === 'live')).map((b: Obj) => {
    const q = b.metrics.quote, k = q.usdPerQuote ?? 0;
    return {
      id: b.id, kind: b.kind ?? (b.position !== undefined ? 'lp' : 'grid'), name: b.name ?? b.id, chainId: b.chainId, mode: b.mode, status: b.status, usdPerQuote: k,
      capital: q.capitalIn ?? 0, equity: q.currentValue ?? 0, realized: q.realized ?? 0, unrealized: q.unrealized ?? 0, fees: 0.1, gas: q.gas ?? 0,
      equityUsd: (q.currentValue ?? 0) * k, capitalUsd: (q.capitalIn ?? 0) * k, realizedUsd: (q.realized ?? 0) * k, unrealizedUsd: (q.unrealized ?? 0) * k, feesUsd: 0.1 * k, gasUsd: (q.gas ?? 0) * k,
      returnPct: b.metrics.totalPnlPct ?? 0, metrics: b.metrics,
      stats: { count: 4, winRate: 0.75, profitFactor: 2.1, avg: 0.4, maxDrawdown: 0.03, streak: 2, maxWinStreak: 3, maxLossStreak: 1, timeInMarket: 0.6, best: 1.2, worst: -0.3 },
    };
  });
  const sum = (k: string) => bots.reduce((a: number, b: Obj) => a + b[k], 0);
  const eq = sum('equityUsd');
  return {
    totals: { equityUsd: eq, capitalUsd: sum('capitalUsd'), realizedUsd: sum('realizedUsd'), unrealizedUsd: sum('unrealizedUsd'), feesUsd: sum('feesUsd'), gasUsd: sum('gasUsd') },
    periods: { today: { realized: 3.2, equityChange: 5.1, partial: false }, d7: { realized: 20.4, equityChange: 31.9, partial: true }, all: { realized: sum('realizedUsd'), equityChange: eq - sum('capitalUsd'), partial: false } },
    bots,
    allocation: [{ asset: 'ETH', chainId: 4663, usd: eq * 0.6, amount: (eq * 0.6) / 2341.179 }, { asset: 'USDG', chainId: 4663, usd: eq * 0.4, amount: eq * 0.4 }],
    chains: S.chains.map((c: Obj) => ({ chainId: c.id, name: c.name, short: c.short, color: c.color, bots: bots.filter((b: Obj) => b.chainId === c.id).length, running: 1, gasNative: 0.05, nativeSymbol: c.nativeSymbol, gasNativeUsd: 117, lowGas: false })),
    portfolio: [[AS_OF - 48 * H, eq * 0.97], [AS_OF - 24 * H, eq * 0.99], [AS_OF, eq]],
    portfolioDrawdown: 0.02, notes: ['Curve at today\'s capital.'],
  };
}

export const JOURNAL = { total: 1, rows: [{ t: AS_OF - H, kind: 'grid', bot: 'Grid ETH/USDG', pair: 'robinhood:ETH/USDG', side: 'sell', reason: 'level', pls: 0.01, quote: 23.6, price: 2360, fee: 0.07, gas: 0.01, pnl: 0.21, pnlUsd: 0.21, tx: 'paper-1' }] };

export const PANELS = [{
  pair: 'robinhood:ETH/USDG', base: 'ETH', quote: 'USDG', chainShort: 'RH', chainColor: '#d6ff3f', spot: 2341.18, spark: [1, 2, 3], regime: { kind: 'trend', hint: 'Trending up' },
  change24h: 0.012, change7d: 0.04, liquidityUsd: 4_200_000, volume24hUsd: 9_800_000, atrPct: 0.006, trend: 'up', er: 0.42, dexName: 'Uniswap V3', feeBps: 5, feeTier: 500,
  depth: [{ usd: 100, buyImpactPct: 0.0001, sellImpactPct: 0.0001 }, { usd: 500, buyImpactPct: 0.0003, sellImpactPct: 0.0003 }, { usd: 1000, buyImpactPct: 0.0006, sellImpactPct: 0.0006 }],
}];

/** /api/holdings with a wallet (amounts from the fixture's chains; dollars inside as the API keeps them). */
export const HOLDINGS: Obj = (() => {
  const coin = (chainId: number, symbol: string, amount: number, usdEach: number) => ({ chainId, address: null, symbol, decimals: 18, amount, usdEach, usd: amount * usdEach });
  const wallet = [
    { coin: coin(4663, 'ETH', 1.25, 2341.179), dust: false, bots: [] },
    { coin: coin(4663, 'USDG', 840.5, 1), dust: false, bots: [] },
    { coin: coin(369, 'PLS', 14_000_000, 0.0000050938), dust: false, bots: [] },
    { coin: coin(1, 'ETH', 0.4, 2341.0064), dust: false, bots: [] },
  ];
  const by = (id: number) => wallet.filter((w) => w.coin.chainId === id).reduce((a, w) => a + w.coin.usd, 0);
  const chains = S.chains.map((c: Obj) => ({ chainId: c.id, name: c.name, short: c.short, color: c.color, address: null, usd: by(c.id), walletUsd: by(c.id), freeUsd: by(c.id), botsUsd: 0, lpUsd: 0, feesUsd: 0 }));
  const net = wallet.reduce((a, w) => a + w.coin.usd, 0);
  return { address: null, at: AS_OF, hasSigner: true, netWorthUsd: net, netWorthExDustUsd: net, walletUsd: net, chains, wallet, positions: [], fees: [], bots: [], errors: [] };
})();
