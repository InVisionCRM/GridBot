/**
 * Small stand-in with the same shape as /api/bot/status.
 * Fake coins and no addresses. The owner snapshot stays outside the repo.
 */
export const sanitizedStatus = {
  spotsAt: 1_700_000_000_000,
  chains: [
    { id: 1, short: 'ETH', color: '#8c9eff' },
    { id: 369, short: 'PLS', color: '#e040fb' },
  ],
  grids: [
    {
      id: 'grid-paper', mode: 'paper', status: 'running', chainId: 1, label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC', stable: 'USDC',
      dexName: 'Example', usdPerQuote: 1, price: 12.5, startedAt: 1_700_000_000_000 - 8 * 86_400_000,
      config: { lowerPrice: 10, upperPrice: 15, totalCapitalQuote: 1000, totalCapitalUsd: 1000, gridCount: 4 },
      pnl: { realized: 15.5, unrealized: 2, gasUsd: 0.4, plsHeld: 1, costUsd: 40 },
      stats: { roundTrips: 2, totalFees: 0.8, totalGas: 0.4, totalNet: 15.5, wins: 2 },
      moveCount: 2,
      trades: [
        { side: 'sell', failed: false, timestamp: 1_700_000_000_000 - 86_400_000, realizedPnlUsd: 15.5, feeQuote: 0.8 },
      ],
    },
  ],
  lps: [
    {
      id: 'lp-live', mode: 'live', status: 'running', chainId: 1, label: 'USDC/ETH', base: 'USDC', quote: 'ETH',
      dexName: 'Example', usdPerQuote: 2000, price: 0.0005, startedAt: 1_700_000_000_000 - 2 * 86_400_000,
      inRange: true, startValue: 1, value: 1.02, reranges: 1,
      config: { capital: 1 },
      position: { lower: 0.0004, upper: 0.0006 },
      owed: { base: 10, quote: 0.002 },
      totals: { fees: 0.01, gas: 0.001, feeCoins: { base: 4, quote: 0.001 }, swapCost: 0.002, moveLoss: 0.003 },
      pnl: {
        net: 0.02, price: -0.004, fees: 0.026, gas: 0.0011, swapCost: 0.002, moveLoss: 0.0029, equity: 1.016,
        feeCoins: { base: 20, quote: 0.004 },
      },
    },
    {
      id: 'lp-closed', mode: 'live', status: 'closed', chainId: 369, label: 'BBB/PLS', base: 'BBB', quote: 'PLS',
      dexName: 'Example', usdPerQuote: 0.00001, price: null, startedAt: 1_700_000_000_000 - 86_400_000,
      pnl: null, config: { capital: 100 },
    },
  ],
};

export const sanitizedActivity = [
  { t: 1_700_000_000_000 - 60_000, type: 'filled', kind: 'grid', level: 'success', botId: 'grid-paper', msg: 'Grid AAA/USDC: SOLD 4 AAA — RT net +1.2 USDC' },
  { t: 1_700_000_000_000 - 3_600_000, type: 'range', kind: 'lp', level: 'warn', botId: 'lp-live', msg: 'Liquidity USDC/ETH·ETH: price is outside the range; moving the range to the price' },
  { t: 1_700_000_000_000 - 3_000_000, type: 'error', kind: 'lp', level: 'error', botId: 'lp-live', msg: 'skip me 0xabcdeffedcba0123456789abcdef0123456789ab' },
];
