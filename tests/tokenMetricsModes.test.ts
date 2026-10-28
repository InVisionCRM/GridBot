/**
 * Token trader metrics are one mode at a time (the trader's current mode) and come from the trader's own per-mode
 * ledger, not from the trade log, which keeps only its newest 200 rows: paper never leaks into the live headline, the
 * figures do not drift once the log is full, and gas on a native spend coin is a cost.
 */
import { describe, expect, it } from 'vitest';
import { tokenMetrics } from '../src/metrics/botMetrics';

const AS_OF = 1_700_000_000_000;
const coin = { chainId: 1, address: null, symbol: 'WETH', native: true };
const ledger = [
  { mode: 'paper', coin, amount: 5, proceeds: 15, cost: 10, gasNative: 0, gasInAmount: true, closed: 3, basis: 'closed' },
  { mode: 'live', coin, amount: 0.9, proceeds: 3, cost: 2, gasNative: 0.1, gasInAmount: true, closed: 2, basis: 'closed' },
];
const positions = [
  { mode: 'live', spendSym: 'WETH', label: 'PEPE/WETH', spent: 1, tokens: 50, entryTokens: 100, pnl: 0.2, usdPerSpend: 2000 },
  { mode: 'paper', spendSym: 'WETH', label: 'DOGE/WETH', spent: 4, tokens: 100, entryTokens: 100, pnl: 1, usdPerSpend: 2000 },
];
// a full log: 200 live sells of 0.001 each (0.2 in all) — the ledger says 0.9, because older rows fell off the log
const trades = Array.from({ length: 200 }, (_, i) => ({ t: AS_OF - (200 - i) * 60_000, mode: 'live', side: 'sell', spendSym: 'WETH', label: 'PEPE/WETH', amount: 0.015, usd: 30, pnl: 0.001, pnlUsd: 2 }));
const status = (mode: 'live' | 'paper') => ({ id: 'token-trader', on: true, options: { mode }, generated: ledger, positions, trades });

describe('token trader metrics: one mode, from the ledger', () => {
  it('live: Generated is the live ledger, gas is a cost, and Total P&L = Generated + open result', () => {
    const m = tokenMetrics(status('live'), AS_OF);
    expect(m.mode).toBe('live');
    expect(m.generated).toEqual({ WETH: 0.9 });
    expect(m.quote.symbol).toBe('WETH');
    expect(m.quote.capitalIn).toBeCloseTo(2.5, 12); // 2 paid for what was sold + 0.5 still in the open position
    expect(m.quote.currentValue).toBeCloseTo(0.7, 12);
    expect(m.quote.unrealized).toBeCloseTo(0.2, 12);
    expect(m.quote.totalPnl).toBeCloseTo(1.1, 12);
    expect(m.quote.gas).toBeCloseTo(0.1, 12);
    expect(m.capitalCoins).toEqual({ WETH: 2.5 });
  });
  it('paper: the paper ledger and the paper position only', () => {
    const m = tokenMetrics(status('paper'), AS_OF);
    expect(m.mode).toBe('paper');
    expect(m.generated).toEqual({ WETH: 5 });
    expect(m.quote.capitalIn).toBeCloseTo(14, 12);
    expect(m.quote.unrealized).toBeCloseTo(1, 12);
    expect(m.quote.totalPnl).toBeCloseTo(6, 12);
    expect(m.fillCount).toBe(0); // no paper rows left in the log
  });
  it('an older file with no ledger keeps its dollar figures', () => {
    const m = tokenMetrics({ id: 'tt', on: false, options: { mode: 'paper' }, positions: [], trades: [{ t: 1, mode: 'paper', side: 'sell', usd: 10, pnlUsd: 2 }] }, AS_OF);
    expect(m.quote.symbol).toBe('USD');
    expect(m.generated).toEqual({ USD: 2 });
  });
});
