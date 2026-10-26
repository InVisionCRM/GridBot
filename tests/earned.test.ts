/** Home's "Earned by live trading": per coin a bot spends, no dollar conversion. */
import { describe, expect, it } from 'vitest';
import { earnedByCoin } from '../src/ui/model';

const grid = { kind: 'grid', quoteSym: 'DAI', pnl: { realized: 12.5 }, stats: { roundTrips: 5, wins: 4 } };
const trend = { kind: 'trend', quoteSym: 'DAI', pnl: { realized: -2 }, stats: { count: 4, winRate: 0.5 } };
// fees 30, gas 4, swaps 1, lost to moves 5: earned after costs 20
const lp = { kind: 'lp', quoteSym: 'USDG', pnl: { fees: 30, gas: 4, swapCost: 1, moveLoss: 5, net: 20, price: -80 } };

describe('earnedByCoin', () => {
  it('a liquidity bot adds its earnings after costs (fees − gas − swaps − lost to moves), never the price part', () => {
    const e = earnedByCoin([grid, trend, lp]);
    expect(e.find((x) => x.symbol === 'USDG')).toMatchObject({ amount: 20, fees: 30, trades: 0 });
    expect(e.find((x) => x.symbol === 'DAI')).toMatchObject({ amount: 10.5, trades: 9, wins: 6, losses: 3 });
  });
  it('a liquidity bot that has not measured its position yet adds nothing', () => {
    expect(earnedByCoin([{ ...lp, pnl: null }])).toEqual([]);
  });
});
