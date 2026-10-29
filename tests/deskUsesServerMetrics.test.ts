/**
 * a030: the desk shows the metrics status() attached to each bot (as of that bot's own last price), not a second
 * computation on the desk-wide spotsAt clock, which is 0 before the first poll and so blanks every age.
 */
import { describe, expect, it } from 'vitest';
import { deskFromStatus } from '../src/server/v2Desk';
import { gridMetrics } from '../src/metrics/botMetrics';

const T = 1_700_000_000_000;
const grid = {
  id: 'g1', kind: 'grid', mode: 'paper', status: 'running', chainId: 1, label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC', stable: 'USDC',
  usdPerQuote: 1, price: 12.5, priceAt: T, startedAt: T - 3_600_000,
  config: { lowerPrice: 10, upperPrice: 15, totalCapitalQuote: 1000, gridCount: 4 },
  pnl: { realized: 0, unrealized: 0 }, stats: { roundTrips: 0, totalFees: 0 }, trades: [], moveCount: 0,
};

describe('desk metrics', () => {
  it('uses the attached metrics, even before the first poll stamps spotsAt', () => {
    const attached = gridMetrics(grid, T);
    expect(attached.ageSec).toBe(3600);
    const desk = deskFromStatus({ spotsAt: 0, grids: [{ ...grid, metrics: attached }], lps: [], trends: [] });
    expect(desk.bots[0].metrics.ageSec).toBe(3600);
  });
  it('a bot without attached metrics is an error, not a recomputation', () => {
    expect(() => deskFromStatus({ spotsAt: T, grids: [grid], lps: [], trends: [] })).toThrow(/g1.*metrics/);
  });
});
