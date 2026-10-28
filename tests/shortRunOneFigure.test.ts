import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotRow } from '../src/ui/botRow';
import { ShowUsdCtx } from '../src/ui/money';
import { LpDetail } from '../src/ui/LpDetail';
import { deskItems, sortItems } from '../src/ui/deskTableModel';
import { aprShown, DAY_MS, rateOrSpan } from '../src/ui/runRate';

// PR #72 review (pr-72.md) findings 1-3: under a day, no figure is shown twice on one screen.

const H = 3_600_000;
const grid = (id: string, ageMs: number, realized: number) => ({
  kind: 'grid', id, label: id, mode: 'paper', status: 'running', startedAt: Date.now() - ageMs, usdPerQuote: 1,
  base: 'NVDA', quoteSym: 'USDG',
  config: { totalCapitalUsd: 100, lowerPrice: 10, upperPrice: 20, gridCount: 10 },
  pnl: { realized, unrealized: 0 },
  stats: { roundTrips: 1, wins: 1, totalFees: 0, totalGas: 0 },
  moveCount: 1, recenter: { count: 0 },
});
const noop = () => undefined;
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ShowUsdCtx.Provider, { value: { on: false, set: noop } }, el));
const cell = (html: string, c: string) => { const i = html.indexOf(`class="${c}"`); if (i < 0) return ''; const j = html.indexOf('<span class="desk-', i + 1); return html.slice(html.indexOf('>', i) + 1, j < 0 ? undefined : j); };
const text = (h: string) => h.replace(/<[^>]+>/g, '');

describe('aprShown / rateOrSpan', () => {
  it('no APR under a day, the yearly estimate from a day on', () => {
    expect(aprShown(8.8 * H, 0.5)).toBeNull();
    expect(aprShown(DAY_MS - 1, 0.5)).toBeNull();
    expect(aprShown(null, 0.5)).toBeNull();
    expect(aprShown(DAY_MS, 0.5)).toBe(0.5);
    expect(aprShown(3 * DAY_MS, null)).toBeNull();
  });
  it('under a day only the run length follows a headline net, never the net again', () => {
    const rate = (d: number) => `${d.toFixed(0)} USDG a day`;
    expect(rateOrSpan(-866, 8.8 * H, rate)).toBe('over 8.8h');
    expect(rateOrSpan(-866, 0, rate)).toBe('so far');
    expect(rateOrSpan(300, 3 * DAY_MS, rate)).toBe('100 USDG a day');
  });
});

describe('finding 1: Bots row APR cell does not repeat P&L %', () => {
  it('a short run shows only "—" and the run length in the APR cell', () => {
    const b = grid('short', 8.8 * H, 7);
    const html = render(createElement(BotRow, { s: { chains: [] }, b, nav: noop, pause: noop, close: noop, columns: true, metrics: true } as never));
    const pctCell = text(cell(html, 'desk-pct'));
    const apr = text(cell(html, 'desk-apr'));
    expect(pctCell).toMatch(/7\.0%/);
    expect(apr).toBe('—over 8.8h');
    expect(apr).not.toContain(pctCell);
  });
  it('a run of a day or more still shows the yearly estimate', () => {
    const html = render(createElement(BotRow, { s: { chains: [] }, b: grid('long', 2 * DAY_MS, 4), nav: noop, pause: noop, close: noop, columns: true, metrics: true } as never));
    expect(text(cell(html, 'desk-apr'))).toMatch(/730\.0%/);
  });
});

describe('finding 2: the APR sort uses the value the APR cell shows', () => {
  it('short runs (no APR shown) sort after every bot with an APR, in either direction', () => {
    const items = deskItems([grid('a-short-big', 2 * H, 50), grid('b-long', 2 * DAY_MS, 4), grid('c-long-small', 3 * DAY_MS, 1)], () => 'PulseChain');
    expect(sortItems(items, 'apr', 'desc').map((i) => i.name)).toEqual(['b-long', 'c-long-small', 'a-short-big']);
    expect(sortItems(items, 'apr', 'asc').map((i) => i.name)).toEqual(['c-long-small', 'b-long', 'a-short-big']);
  });
});

describe('finding 3: LP "Earned after costs" sub-line does not repeat the net', () => {
  const lp = (ageMs: number) => ({
    id: 'lp1', label: 'STONKD LP #2', kind: 'lp', mode: 'paper', status: 'running', chainId: 369, base: 'STONKD', quote: 'USDG',
    startedAt: Date.now() - ageMs, startValue: 5000, reranges: 0, usdPerQuote: 1, idle: { base: 0, quote: 0 }, config: { bandPct: 0.1 }, profits: { mode: 'keep' }, totals: { sent: 0 },
    pnl: { net: -866.12345, fees: 1, gas: 0, swapCost: 0, moveLoss: 0, feeCoins: { base: 0, quote: 1 } },
  });
  const sub = (ageMs: number) => {
    const html = render(createElement(LpDetail, { s: { lps: [lp(ageMs)], chains: [] }, id: 'lp1', events: [], ticks: [], nav: noop, act: noop, busy: false } as never));
    const i = html.indexOf('Earned after costs');
    const k = html.indexOf('<span class="sub">', i);
    return text(html.slice(k, html.indexOf('<div class="kpi">', k)));
  };
  it('under a day: % of what you put in and the run length only', () => {
    const s = sub(8.8 * H);
    expect(s).toMatch(/of what you put in · over 8\.8h/);
    expect(s).not.toMatch(/866/);
  });
  it('a day or more: the per-day rate', () => {
    expect(sub(2 * DAY_MS)).toMatch(/433.* a day/);
  });
});
