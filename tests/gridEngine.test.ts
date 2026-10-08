import { describe, expect, it, beforeEach } from 'vitest';
import {
  bootstrapOrders,
  calculateGridLevels,
  createOppositeOrder,
  estimateProfitPerCycle,
  gridSpacing,
  processTick,
  resetIdCounters,
  startBot,
  stopBot,
  validateConfig,
} from '../src/engine/gridEngine';
import type { GridConfig } from '../src/types/grid';

const baseConfig: GridConfig = {
  pair: 'PLS/USDC',
  baseToken: 'PLS',
  quoteToken: 'USDC',
  lowerPrice: 100,
  upperPrice: 110,
  gridCount: 10,
  totalCapital: 1000,
  profitPerGrid: 0.01,
  mode: 'paper',
};

describe('calculateGridLevels', () => {
  it('creates gridCount + 1 inclusive levels', () => {
    const levels = calculateGridLevels(100, 110, 10);
    expect(levels).toHaveLength(11);
    expect(levels[0].price).toBe(100);
    expect(levels[10].price).toBe(110);
    expect(levels[5].price).toBe(105);
  });

  it('rejects inverted ranges', () => {
    expect(() => calculateGridLevels(110, 100, 5)).toThrow(/upperPrice/);
  });

  it('rejects non-positive prices', () => {
    expect(() => calculateGridLevels(0, 10, 5)).toThrow(/positive/);
  });
});

describe('validateConfig', () => {
  it('accepts a sensible beginner config', () => {
    const result = validateConfig(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects bad ranges and tiny grids', () => {
    const result = validateConfig({
      ...baseConfig,
      lowerPrice: 50,
      upperPrice: 40,
      gridCount: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Upper price/.test(e))).toBe(true);
    expect(result.errors.some((e) => /at least 2 grids/i.test(e))).toBe(true);
  });
});

describe('gridSpacing & profit estimate', () => {
  it('computes arithmetic spacing', () => {
    expect(gridSpacing(baseConfig)).toBe(1);
  });

  it('estimates cycle profit from spacing * amount', () => {
    expect(estimateProfitPerCycle(baseConfig, 10)).toBe(10);
  });
});

describe('bootstrap and fill simulation', () => {
  beforeEach(() => {
    resetIdCounters();
  });

  it('places buys only below current price', () => {
    const levels = calculateGridLevels(100, 110, 10);
    const { orders } = bootstrapOrders(baseConfig, levels, 105);
    expect(orders.every((o) => o.side === 'buy')).toBe(true);
    expect(orders.every((o) => o.price < 105)).toBe(true);
    expect(orders.length).toBe(5); // levels 100,101,102,103,104
  });

  it('fills a buy when price drops to the level and places a sell above', () => {
    let state = startBot(baseConfig, 105, 'manual');
    expect(state.status).toBe('running');
    const buy = state.orders.find((o) => o.status === 'open' && o.price === 104);
    expect(buy).toBeTruthy();

    const tick = processTick(state, 104);
    state = tick.state;
    expect(tick.newFills).toHaveLength(1);
    expect(tick.newFills[0].side).toBe('buy');
    expect(state.portfolio.baseBalance).toBeGreaterThan(0);

    const sell = state.orders.find(
      (o) => o.status === 'open' && o.side === 'sell' && o.levelIndex === buy!.levelIndex + 1,
    );
    expect(sell).toBeTruthy();
    expect(sell!.price).toBe(105);
  });

  it('realizes positive PnL on a completed buy→sell cycle', () => {
    let state = startBot(baseConfig, 105, 'manual');
    // Fill buy at 104
    state = processTick(state, 104).state;
    const buyFill = state.fills[0];
    expect(buyFill.side).toBe('buy');

    // Fill sell at 105
    const beforeEquity = state.portfolio.equity;
    state = processTick(state, 105).state;
    const sellFill = state.fills.find((f) => f.side === 'sell');
    expect(sellFill).toBeTruthy();
    expect(sellFill!.realizedPnl).toBeGreaterThan(0);
    expect(state.portfolio.realizedPnl).toBeGreaterThan(0);
    // After round trip near start price, equity should be ~ initial + realized
    expect(state.portfolio.equity).toBeGreaterThan(beforeEquity - 1e-6);
  });

  it('createOppositeOrder maps buy→sell and sell→buy', () => {
    const levels = calculateGridLevels(100, 110, 10);
    const buyOrder = {
      id: 'x',
      levelIndex: 2,
      side: 'buy' as const,
      price: 102,
      amount: 1,
      quoteAmount: 102,
      status: 'filled' as const,
      createdAt: 1,
    };
    const sell = createOppositeOrder(buyOrder, levels, 1);
    expect(sell?.side).toBe('sell');
    expect(sell?.price).toBe(103);

    const buyBack = createOppositeOrder(sell!, levels, 1);
    expect(buyBack?.side).toBe('buy');
    expect(buyBack?.price).toBe(102);
  });

  it('stop cancels open orders', () => {
    const state = startBot(baseConfig, 105, 'manual');
    const stopped = stopBot(state);
    expect(stopped.status).toBe('stopped');
    expect(stopped.orders.every((o) => o.status !== 'open')).toBe(true);
  });
});
