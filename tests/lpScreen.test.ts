import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShowUsdCtx } from '../src/ui/money';
import { botMetrics } from '../src/metrics/botMetrics';

vi.mock('../src/ui/Chart', () => ({ Chart: () => null, EquityChart: () => null }));

import { LpDetail } from '../src/ui/LpDetail';

const bot = {
  id: 'lp1', kind: 'lp', label: 'PLS/DAI', base: 'PLS', quote: 'DAI', market: 'pulsechain:PLS/DAI#9mm',
  status: 'running', mode: 'paper', chainId: 369, dexName: '9mm V3', feeBps: 25, feeTier: 2500,
  price: 0.00003, priceAt: 1, inRange: true, reranges: 2, lastRerangeAt: 1, usdPerQuote: 1,
  config: { bandPct: 0.1, rerange: true, capital: 1000 },
  profits: { mode: 'reinvest' },
  position: { lower: 0.000027, upper: 0.000033, openedAt: 1, id: 'paper' },
  owed: { base: 1.25, quote: 3.5 },
  coins: { base: 100, quote: 40 },
  idle: { base: 0, quote: 0 },
  totals: { sent: 0, gas: 0.1, swapCost: 0.2 },
  pnl: { feeCoins: { base: 2, quote: 4 }, fees: 4.1, gas: 0.1, swapCost: 0.2, moveLoss: 0.4, net: 3.4 },
  equity: [],
};

describe('LP screen figures', () => {
  it('shows fees waiting and moves once, in token units, without Realized or Unrealized', () => {
    const html = renderToStaticMarkup(
      createElement(ShowUsdCtx.Provider, { value: { on: true, set: () => undefined } },
        createElement(LpDetail, {
          s: { lps: [{ ...bot, metrics: botMetrics(bot, 1) }], chains: [] }, id: 'lp1', events: [], ticks: null, nav: () => undefined, act: () => undefined, busy: false,
        })),
    );
    expect(html.match(/Fees waiting/g)).toHaveLength(1);
    expect(html).toContain('1.25 PLS');
    expect(html).toContain('3.5 DAI');
    expect(html.match(/2 range moves/g)).toHaveLength(1);
    expect(html).not.toMatch(/Realized|Unrealized/);
    const waiting = html.slice(html.indexOf('Fees waiting'), html.indexOf('Compound at'));
    // #43: the range-move loss and its count are in Details' breakdown (gas · swaps · range moves), not a KPI of their own
    expect(html).toContain('gas · swaps · range moves');
    const moves = html.slice(html.indexOf('gas · swaps · range moves'), html.indexOf('= Generated'));
    expect(waiting).not.toContain('$');
    expect(moves).not.toContain('$');
  });
});
