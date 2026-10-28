/**
 * Fees waiting appears once on the LP page. With a position open, the figure is in the range health panel and Details'
 * "of which waiting in the position" row only points there. Once closed there is no panel, so Details shows the figure.
 */
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { botMetrics } from '../src/metrics/botMetrics';

vi.mock('../src/ui/Chart', () => ({ Chart: () => null, EquityChart: () => null }));

import { LpDetail } from '../src/ui/LpDetail';

const base = {
  id: 'lp1', kind: 'lp', label: 'PLS/DAI', base: 'PLS', quote: 'DAI', market: 'pulsechain:PLS/DAI#9mm',
  mode: 'paper', chainId: 369, dexName: '9mm V3', feeBps: 25, feeTier: 2500,
  price: 0.00003, priceAt: 1, reranges: 2, lastRerangeAt: 1, usdPerQuote: 1,
  config: { bandPct: 0.1, rerange: true, capital: 1000 },
  profits: { mode: 'reinvest' },
  owed: { base: 1.2345, quote: 3.4567 },
  idle: { base: 0, quote: 0 },
  totals: { sent: 0, gas: 0.1, swapCost: 0.2 },
  pnl: { feeCoins: { base: 2, quote: 4 }, fees: 4.1, gas: 0.1, swapCost: 0.2, moveLoss: 0.4, net: 3.4 },
  equity: [],
};
const OPEN = { ...base, status: 'running', inRange: true, position: { lower: 0.000027, upper: 0.000033, openedAt: 1, id: 'paper' }, coins: { base: 100, quote: 40 } };
const CLOSED = { ...base, status: 'closed', inRange: null, position: null, coins: null };

const render = (b: Record<string, unknown>) => renderToStaticMarkup(createElement(LpDetail, {
  s: { lps: [{ ...b, metrics: botMetrics(b, 1) }], chains: [] }, id: 'lp1', events: [], ticks: null, nav: () => undefined, act: () => undefined, busy: false,
}));
/** Count a figure as text (not inside an attribute such as a tooltip). */
const count = (html: string, re: RegExp) => (html.replace(/<[^>]*>/g, '\n').match(re) ?? []).length;
const between = (html: string, a: string, b: string) => { const i = html.indexOf(a); return i < 0 ? '' : html.slice(i, html.indexOf(b, i)); };

describe('LP Fees waiting is shown once', () => {
  it('open position: the range health panel has the figure; Details only points to it', () => {
    const html = render(OPEN);
    expect(html).toContain('class="lp-health"');
    expect(count(html, /Fees waiting/g)).toBe(1);
    expect(count(html, /1\.2345/g)).toBe(1);
    expect(count(html, /3\.4567/g)).toBe(1);
    const panel = between(html, 'Fees waiting', 'Compound at');
    expect(panel).toContain('1.2345 PLS');
    expect(panel).toContain('3.4567 DAI');
    const row = between(html, 'of which waiting in the position', '</tr>');
    expect(row).toContain('shown in the position card');
    expect(row).not.toMatch(/\d/);
  });
  it('closed position: no panel; Details has the (non-zero) figure', () => {
    const html = render(CLOSED);
    expect(html).not.toContain('Fees waiting');
    expect(html).not.toContain('class="lp-health"'); // no range health panel once closed
    expect(count(html, /1\.2345/g)).toBe(1);
    expect(count(html, /3\.4567/g)).toBe(1);
    const row = between(html, 'of which waiting in the position', '</tr>');
    expect(row).toContain('1.2345 PLS');
    expect(row).toContain('3.4567 DAI');
    expect(row).not.toContain('shown in the position card');
  });
});
