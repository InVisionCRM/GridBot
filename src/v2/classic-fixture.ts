/**
 * Frozen demo payload for the current Pro Desk, so before-screenshots do not
 * need a wallet, a key, or .env. DEMO DATA.
 */
const NOW = Date.now();

function hist(base: number, n = 40): [number, number][] {
  const out: [number, number][] = [];
  for (let i = n; i >= 0; i--) {
    out.push([NOW - i * 3_600_000, base * (1 + Math.sin(i / 4) * 0.01) + (n - i) * base * 0.0006]);
  }
  return out;
}

function intervals(lower: number, upper: number, count: number, price: number) {
  const levels: number[] = [];
  for (let i = 0; i <= count; i++) levels.push(lower + ((upper - lower) * i) / count);
  return levels.slice(0, -1).map((buy, index) => {
    const sell = levels[index + 1];
    const holding = sell < price;
    return {
      index, buyPrice: buy, sellPrice: sell, status: holding ? 'holding' : 'waitingBuy',
      plsAmount: holding ? 0.04 : 0, buyAmount: 80, needsRearm: false,
    };
  });
}

function candles(price: number) {
  const step = 3600;
  const now = Math.floor(NOW / 1000 / step) * step;
  const out = [];
  let prev = price * 0.98;
  for (let i = 80; i >= 0; i--) {
    const c = price * (0.98 + 0.02 * ((80 - i) / 80)) + Math.sin(i / 6) * price * 0.004;
    out.push({ t: now - i * step, o: prev, h: Math.max(prev, c) * 1.002, l: Math.min(prev, c) * 0.998, c, v: 12 });
    prev = c;
  }
  return out;
}

const grid = {
  id: 'demo-eth', kind: 'grid', mode: 'paper', status: 'running', chainId: 1, chainShort: 'ETH',
  base: 'ETH', quoteSym: 'USDC', stable: 'USDC', label: 'ETH/USDC', name: 'ETH/USDC',
  dexName: 'Uniswap V3', feeBps: 5, feeTier: 500, flipped: false, price: 3248.2, priceAt: NOW,
  usdPerQuote: 1, startedAt: NOW - 18 * 86_400_000, lastError: null, inFlight: null, closing: false,
  available: true, queue: [], archivedAt: null, spacingWarn: null, halt: null,
  config: { lowerPrice: 3100, upperPrice: 3500, gridCount: 8, totalCapitalUsd: 2500 },
  intervals: intervals(3100, 3500, 8, 3248.2),
  pnl: { realized: 86.4, unrealized: 24.1, gasUsd: 6.2, plsHeld: 0.42, costUsd: 1360 },
  stats: { roundTrips: 14, wins: 9, avgNet: 6.17, totalFees: 18.4, totalGas: 6.2, count: 14, winRate: 9 / 14 },
  trades: [
    { id: 't1', timestamp: NOW - 20 * 60_000, side: 'sell', plsAmount: 0.04, stableAmount: 130, price: 3260, execPrice: 3258, failed: false, txHash: 'paper-demo-1', feeQuote: 0.42, roundTripNet: 4.8, intervalIndex: 4 },
    { id: 't2', timestamp: NOW - 55 * 60_000, side: 'buy', plsAmount: 0.04, stableAmount: 128, price: 3210, execPrice: 3212, failed: false, txHash: 'paper-demo-2', feeQuote: 0.38, intervalIndex: 3 },
    { id: 't3', timestamp: NOW - 3 * 3_600_000, side: 'sell', plsAmount: 0.05, stableAmount: 160, price: 3302, execPrice: 3300, failed: false, txHash: 'paper-demo-3', feeQuote: 0.5, roundTripNet: 6.1, intervalIndex: 5 },
  ],
  equityHist: hist(2500),
  recenter: { enabled: true, aboveSince: null, lastAt: NOW - 86_400_000, count: 2 },
  profits: { mode: 'reinvest' },
  limits: { maxPriceImpact: 0.03, slippageBps: 100, deadlineMinutes: 10 },
  moveCount: 16, lastMoveAt: NOW - 20 * 60_000,
};

const trend = {
  id: 'demo-trend', kind: 'trend', mode: 'paper', status: 'running', chainId: 369, chainShort: 'PLS',
  base: 'HEX', quoteSym: 'PLS', quote: 'HEX', stable: 'HEX', name: 'HEX/PLS', label: 'HEX/PLS',
  dexName: 'PulseX V2', feeBps: 29, price: 1420, priceAt: NOW, usdPerQuote: 0.000034,
  startedAt: NOW - 5 * 86_400_000, lastError: null, inFlight: null, closing: false, available: true,
  archivedAt: null, halt: null, capital: 800, blocked: 2, tf: '1h', nextCloseAt: NOW + 600_000,
  cfg: { strategy: 'ema', fast: 9, slow: 21, stopAtr: 2, tpR: 2, trailAtr: 0, minEdgePct: 0.0025, lines: [] },
  pnl: { realized: 12.4, unrealized: 3.1, returnPct: 0.019, equity: 815.5, fees: 1.2, gas: 0.4 },
  stats: { count: 4, winRate: 0.75, maxDrawdown: 0.04 },
  position: null, signals: [], trades: [], lastNote: 'Demo data. Waiting for a signal.',
  equityHist: hist(800), moveCount: 4, lastMoveAt: NOW - 86_400_000, priceAtNote: NOW,
};

const lp = {
  id: 'demo-hex', kind: 'lp', mode: 'paper', status: 'running', chainId: 369, chainShort: 'PLS',
  base: 'HEX', quote: 'DAI', quoteSym: 'DAI', label: 'HEX/DAI', market: 'DAI',
  dexName: '9mm V3', feeBps: 25, feeTier: 2500, price: 0.00482, priceAt: NOW, usdPerQuote: 1,
  startedAt: NOW - 11 * 86_400_000, lastError: null, closing: false, available: true, archivedAt: null,
  halt: null, inRange: true, reranges: 3, lastRerangeAt: NOW - 2 * 86_400_000,
  config: { capital: 4000, bandPct: 0.08, rerange: true },
  position: { lower: 0.0044, upper: 0.0052, id: 'paper', openedAt: NOW - 2 * 86_400_000 },
  pnl: { net: 96, fees: 128, gas: 9, swapCost: 7, price: -22, moveLoss: 14, feeCoins: { base: 1200, quote: 18 } },
  coins: { base: 400000, quote: 1800 }, owed: { base: 80, quote: 1.2 }, idle: { base: 0, quote: 0 },
  poolShare: 0.002, startValue: 4000, totals: { gas: 9, swapCost: 7, sent: 0 },
  equity: hist(4000), equityHist: hist(4000), moveCount: 3, step: null,
};

const chains = [
  { id: 369, key: 'pulsechain', name: 'PulseChain', short: 'PLS', color: '#e040fb', status: 'live', tradable: true, reason: null, nativeSymbol: 'PLS', explorer: 'https://example.invalid', hasSigner: false, address: null, gasNative: null, lowGas: false, lowGasNative: 50000, nativeUsd: null, walletError: null, txBusy: false, rpc: null, bots: 2, dexes: [{ id: 'pulsex-v2', name: 'PulseX V2', kind: 'v2' }] },
  { id: 1, key: 'ethereum', name: 'Ethereum', short: 'ETH', color: '#8c9eff', status: 'live', tradable: true, reason: null, nativeSymbol: 'ETH', explorer: 'https://example.invalid', hasSigner: false, address: null, gasNative: null, lowGas: false, lowGasNative: 0.01, nativeUsd: null, walletError: null, txBusy: false, rpc: null, bots: 1, dexes: [{ id: 'uni-v3', name: 'Uniswap V3', kind: 'v3' }] },
];

const market = {
  key: 'USDC', label: 'ETH/USDC', chainId: 1, base: 'ETH', quote: 'USDC', quoteKind: 'stable', dex: 'uni-v3', kind: 'v3',
  feeBps: 5, feeTier: 500, pool: null, legacy: false, custom: false, risk: null, liveAllowed: true, tradable: true,
  spot: 3248.2, usdPerQuote: 1, dexName: 'Uniswap V3', flipped: false, pairKey: 'USDC', spends: 'USDC', stacks: 'ETH', quoteNative: false,
};

export function classicStatus() {
  return {
    aggregate: { realized: 86.4, unrealized: 24.1 },
    grids: [grid],
    trends: [trend],
    lps: [lp],
    chains,
    marketList: [market],
    legacyChainId: 1,
    address: null,
    copy: null,
    explorer: 'https://example.invalid',
    quotes: ['USDC', 'DAI'],
    allocations: { ok: true, rows: [], note: 'Demo data' },
  };
}

export function classicCandles() {
  return { candles: candles(3248.2), meta: { source: 'demo', updatedAt: Math.floor(NOW / 1000) } };
}

export function classicHoldings() {
  return {
    address: null, at: NOW, hasSigner: false, netWorthUsd: null, netWorthExDustUsd: null, unpriced: 0,
    walletUsd: 0, freeUsd: 0, botsUsd: 0, lpUsd: 0, feesUsd: 0, overdrawn: false,
    chains: [], wallet: [], positions: [], fees: [], bots: [], errors: [], how: [],
  };
}

export function classicAuto() {
  return { on: false, mode: 'paper', budgets: [], accounts: [], options: { grid: true, lp: true, newTokens: false, risk: 'safe', slots: 3, stopLossPct: 0.2 }, reviewedAt: null, log: [] };
}

export function classicTrader() {
  return { on: false, openUsd: 0, positions: [], trades: [], feed: [], options: { mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 3600, maxPoolShare: 0.02, maxImpact: 0.03, risk: 'safe', sniper: { on: false, minLiquidityUsd: 10000, delayBlocks: 1, delaySec: 3, maxPerHour: 4 } } };
}

export function classicOpps() {
  return { running: false, testUsd: 1000, chains: [] };
}
