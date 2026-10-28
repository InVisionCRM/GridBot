/** A liquidity bot is named like a grid: the pair alone. The chain has its own badge, and "ETH/USDG·HOOD" wrapped mid-word on a phone. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotRow } from '../src/ui/botRow';
import { lpName } from '../src/ui/model';
import { ShowUsdCtx } from '../src/ui/money';

const noop = () => {};
describe('liquidity bot name', () => {
  it('drops the chain suffix the server label carries', () => {
    expect(lpName({ label: 'ETH/USDG·HOOD' })).toBe('ETH/USDG');
    expect(lpName({ label: 'HEX/PLS·PLS' })).toBe('HEX/PLS');
    expect(lpName({ base: 'USDC', quote: 'ETH' })).toBe('USDC/ETH');
  });
  it('the row shows the pair, not the suffix', () => {
    const lp = { id: 'lp-1', kind: 'lp', mode: 'paper', status: 'running', chainId: 4663, label: 'ETH/USDG·HOOD', base: 'ETH', quote: 'USDG', usdPerQuote: 1, pnl: null, position: null };
    const s = { chains: [{ id: 4663, short: 'HOOD', name: 'Robinhood Chain', color: '#0f0' }], grids: [], trends: [], lps: [lp] };
    const html = renderToStaticMarkup(createElement(ShowUsdCtx.Provider, { value: { on: false, set: noop } }, createElement(BotRow, { s, b: lp, nav: noop, pause: noop, close: noop })));
    expect(html.replace(/\u200B/g, '')).toContain('ETH/USDG'); // the soft break after the slash is the only break in the name
    expect(html).not.toContain('·HOOD');
  });
});
