/**
 * Audit a017: the grid page gets the newest 100 trades. Its Fees tile and Fills count must not be sums over that list:
 * the tile is pool fees + gas over every fill (the metrics' Fees paid) and the heading gives the all-time count.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridDetail } from '../src/ui/GridDetail';
import { gridMetrics } from '../src/metrics/botMetrics';
import { botFacts } from '../src/ui/deskStats';
import { qty } from '../src/ui/fmt';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const noop = () => {};

describe('grid page over more than 100 fills', () => {
  it('Fees + gas and the Fills count cover every fill, not the 100 sent', () => {
    const g0 = RAW.grids[0];
    const row = g0.trades[0];
    const trades = Array.from({ length: 100 }, (_, i) => ({ ...row, id: `t${i}`, feeQuote: 0.01, failed: false }));
    const g = { ...g0, trades, tradeCount: 250, stats: { ...g0.stats, totalFees: 2.5 } };
    const m = gridMetrics({ ...g, kind: 'grid' }, g0.metrics.asOf);
    const s = { ...RAW, grids: [{ ...g, metrics: m }, ...RAW.grids.slice(1)] };
    const html = renderToStaticMarkup(createElement(GridDetail, { s, events: [], ticks: { prices: {} }, nav: noop, act: noop, busy: false, id: g.id } as never));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const q = m.quote.symbol!;
    const paid = botFacts({ ...g, metrics: m }).feesPaid!;
    expect(paid).toBeGreaterThanOrEqual(2.5); // all-time pool fees, plus gas
    expect(text).toContain(`Fees + gas i ${qty(paid, q, 4, false)} all fills`); // "i": the tooltip mark
    expect(text).not.toContain(`${qty(1, q, 4, false)} all fills`); // not the 100-row sum (100 × 0.01)
    expect(text).toMatch(/Fills 250 · newest 100 shown/);
  });
});
