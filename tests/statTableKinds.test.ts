/** The expanded row lists the stats a bot kind has. A dash means "not yet"; a stat the kind cannot have is not listed. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { gridMetrics, lpMetrics, trendMetrics } from '../src/metrics/botMetrics';
import { StatTable } from '../src/ui/StatTable';

const AS_OF = 1_700_000_000_000;
const DAY = 86_400_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (b: any) => renderToStaticMarkup(createElement(StatTable, { b, s: { chains: [] } }));
const labels = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

describe('the stat table lists only the stats a bot kind has', () => {
  it('a trend bot: no spacing, range or fees earned; nobody has a "Time in range" (no engine reports one)', () => {
    const t = { id: 't1', kind: 'trend', status: 'running', quoteSym: 'USDC', quote: 'ethereum:ETH/USDC', capital: 100, pnl: { realized: 8, unrealized: 0 }, stats: { count: 2, winRate: 0.5 }, trades: [], startedAt: AS_OF - DAY };
    const r = labels(render({ ...t, metrics: trendMetrics(t, AS_OF) }));
    expect(r).toContain('Win rate');
    for (const gone of ['Spacing', 'Range', 'Fees earned', 'Time in range']) expect(r, gone).not.toContain(gone);
  });
  it('a grid: no fees earned; a liquidity bot: no win rate or moves', () => {
    const g = { id: 'g1', kind: 'grid', status: 'running', quoteSym: 'DAI', config: { totalCapitalQuote: 200, lowerPrice: 1, upperPrice: 2, gridCount: 10 }, pnl: { realized: 0 }, stats: {}, trades: [], startedAt: AS_OF - DAY };
    const gr = labels(render({ ...g, metrics: gridMetrics(g, AS_OF) }));
    expect(gr).toContain('Spacing');
    expect(gr).not.toContain('Fees earned');
    expect(gr).not.toContain('Time in range');
    const l = {
      id: 'l1', kind: 'lp', mode: 'paper', status: 'running', base: 'ETH', quote: 'USDG', quoteSym: 'USDG', usdPerQuote: 1, startValue: 1000,
      config: { capital: 1000, bandPct: 0.1 }, position: { lower: 1, upper: 2 }, inRange: true, startedAt: AS_OF - DAY,
      pnl: { net: 0, price: 0, fees: 0, gas: 0, swapCost: 0, moveLoss: 0, equity: 1000, feeCoins: { base: 0, quote: 0 } }, totals: { gas: 0, swapCost: 0, moveLoss: 0 },
    };
    const lr = labels(render({ ...l, metrics: lpMetrics(l, AS_OF) }));
    expect(lr).toContain('Fees earned');
    expect(lr).not.toContain('Win rate');
    expect(lr).not.toContain('Moves');
  });
});
