/**
 * Audit a019: a Details row whose figure is shown elsewhere is not deleted when it is the Total P&L: it reads "same as
 * <that row>" with its % of capital in. "Made at event prices" is left out while Generated is 0.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoneyDetails } from '../src/ui/MoneyDetails';

const metrics = {
  kind: 'grid', generated: { USDC: 0 }, totalPnlPct: -0.0124, capitalCoins: { USDC: 1000 }, calc: 'how', breakdownByCoin: null,
  quote: { symbol: 'USDC', made: 0, totalPnl: -12.42, priceChange: -12.42, unrealized: -12.42, currentValue: 987.58, capitalIn: 1000 },
};

describe('grid Details while nothing is generated yet and coins are held', () => {
  it('keeps Total P&L as "same as Open positions" with its %, and drops Made at event prices', () => {
    const html = renderToStaticMarkup(createElement(MoneyDetails, { b: { kind: 'grid', metrics }, hide: ['Open positions'] }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/Total P&amp;L = Price change same as Open positions · −1\.24% of capital in/);
    expect(text).not.toContain('Made at event prices');
    expect(text).not.toContain('12.42'); // the figure itself is shown elsewhere on the page
  });
});
