import { describe, expect, it } from 'vitest';
import { applyBuy, applySell, emptyPosition, replay, totals, type LiveTrade } from '../src/live/ledger';

const t = (p: Partial<LiveTrade>): LiveTrade => ({
  id: Math.random().toString(), network: 'testnet', side: 'buy', intervalIndex: 0, stable: 'DAI',
  plsAmount: 0, stableAmount: 0, price: 0, gasPls: 0, gasUsd: 0, txHash: '0x', timestamp: Date.now(), realizedPnlUsd: 0, ...p,
});

describe('PnL including gas', () => {
  it('buy gas goes into cost basis; sell gas reduces realized', () => {
    let pos = applyBuy(emptyPosition(), 1_000_000, 10, 0.01); // $10 + $0.01 gas
    expect(pos.costUsd).toBeCloseTo(10.01);
    const { pos: after, realized } = applySell(pos, 1_000_000, 10.5, 0.01);
    expect(realized).toBeCloseTo(10.5 - 10.01 - 0.01);
    expect(after.plsHeld).toBe(0);
    pos = after;
    expect(pos.costUsd).toBeCloseTo(0);
  });
  it('a round trip that only covers fees shows a loss after gas', () => {
    const pos = applyBuy(emptyPosition(), 100, 1, 0.05);
    expect(applySell(pos, 100, 1.02, 0.05).realized).toBeLessThan(0);
  });
  it('partial sells use average cost', () => {
    const pos = applyBuy(applyBuy(emptyPosition(), 100, 1, 0), 100, 3, 0); // avg $0.02/PLS
    expect(applySell(pos, 100, 2.5, 0).realized).toBeCloseTo(0.5);
  });
  it('replay + totals skip failed trades but count their gas', () => {
    const trades = [
      t({ side: 'buy', plsAmount: 100, stableAmount: 1, gasUsd: 0.01 }),
      t({ side: 'sell', failed: true, gasUsd: 0.02, realizedPnlUsd: -0.02 }),
    ];
    expect(replay(trades).plsHeld).toBe(100);
    const tot = totals(trades, 0.02);
    expect(tot.gasUsd).toBeCloseTo(0.03);
    expect(tot.realized).toBeCloseTo(-0.02);
    expect(tot.unrealized).toBeCloseTo(100 * 0.02 - 1.01);
  });
});

describe('manual trades in the ledger', () => {
  it('are excluded from the grid position but their gas counts', () => {
    const trades = [t({ side: 'sell', manual: true, plsAmount: 100, stableAmount: 1, gasUsd: 0.01 })];
    expect(replay(trades).plsHeld).toBe(0);
    expect(totals(trades, 0.01).realized).toBeCloseTo(-0.01);
  });
});
