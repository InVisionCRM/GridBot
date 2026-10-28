/**
 * Kyle's rule: each figure appears once per screen. Renders the Bots list (collapsed, and with each bot opened; a
 * one-bot group and a two-bot group) and the LP page from sample paper data, reads the text a person would see on a
 * desktop and on a phone, and fails if any figure shows twice.
 *
 * A figure is an amount ($ or a coin), a percent, a run length or age (8.8h, 5.0d), or a price range (a – b). Two are the
 * same when they're in the same unit and agree to the shown precision: "−866 USDG" and "−$866.00" are the same figure
 * (USDG is worth $1 here). Not figures: zeros, dashes, labels (table headers, bot names, the notes about what the
 * estimates mean), buttons and inputs (the range-width choices), a trend's candle size ("1h candles"), the price chart
 * (its own scale and readout; it draws on a canvas), and counts.
 * "Seen on a desktop": the stat table's `in-row` cells are hidden (the row's columns show them). "Seen on a phone": the
 * row's value/% /age/APR/moves/fees columns are hidden (styles.css, max-width 860px) and the `in-row` cells show.
 * A closed <details> shows only its summary (a label); the LP page's net breakdown is checked closed and open.
 */
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeskTable } from '../src/ui/DeskTable';
import { GridDetail } from '../src/ui/GridDetail';
import { Home } from '../src/ui/Home';
import { LpDetail } from '../src/ui/LpDetail';
import { StatTable } from '../src/ui/StatTable';
import { TrendDetail } from '../src/ui/TrendDetail';
import { ShowUsdCtx } from '../src/ui/money';

// A rendered page shows a counting number at its end value (the static render would show where the count starts).
vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, AnimatedNumber: ({ value, format }: { value: number | null; format: (x: number) => string }) => h('span', null, value == null ? '—' : format(value)) };
});

const NOW = Date.UTC(2026, 9, 27, 23, 45);
const H = 3_600_000, D = 24 * H;
const PEGGED = ['USDG'];
const SYMS = ['USDG', 'SPY', 'NVDA', 'ETH'];

// ---------------------------------------------------------------- sample data (paper, made up)
const s0 = {
  legacyChainId: 369,
  chains: [{ id: 4663, key: 'robinhood', name: 'Robinhood Chain', short: 'HOOD', color: '#ccff00', status: 'live' }],
  marketList: [], grids: [], trends: [], lps: [],
};
const stonkdStart = NOW - 8.8 * H;
const stonkd = {
  kind: 'lp', id: 'lp-stonkd', label: 'STONKD LP #2', mode: 'paper', status: 'running', chainId: 4663, market: 'robinhood:SPY/USDG',
  base: 'SPY', quote: 'USDG', usdPerQuote: 1, dexName: 'Uniswap V3', feeBps: 5, price: 771.33, priceAt: NOW, inRange: true,
  startedAt: stonkdStart, startValue: 34_000, config: { capital: 34_000, bandPct: 0.05, rerange: true }, profits: { mode: 'reinvest' },
  pnl: { feeCoins: { base: 0.0531, quote: 22.37 }, fees: 41.2, gas: 0.05, swapCost: 32.97, moveLoss: 874.18, net: -866, price: -12.4 },
  totals: { gas: 0.05, swapCost: 32.97, sent: 0 }, owed: { base: 0.0102, quote: 4.31 }, coins: { base: 21.3, quote: 16_950.2 },
  poolShare: 0.0563, timeInRange: 0.97, reranges: 0, lastRerangeAt: null, move: { block: null }, idle: { base: 0, quote: 0 },
  position: { id: 'paper-1', lower: 732.214, upper: 810.027, openedAt: stonkdStart },
  positionFees: { since: stonkdStart, coins: { base: 0.0531, quote: 22.37 } },
  equityHist: [[stonkdStart, 34_000], [NOW, 33_121.6]], equity: [],
};
const nvdaStart = NOW - 3.2 * D;
const nvdaLp = {
  ...stonkd, id: 'lp-nvda', label: 'NVDA LP', market: 'robinhood:NVDA/USDG', base: 'NVDA', price: 217.97, startedAt: nvdaStart, startValue: 5_000,
  config: { capital: 5_000, bandPct: 0.1, rerange: true },
  pnl: { feeCoins: { base: 1.1, quote: 216.3 }, fees: 455.9, gas: 0.6, swapCost: 1.43, moveLoss: 41.87, net: 412, price: 3.1 },
  totals: { gas: 0.6, swapCost: 1.43, sent: 0 }, owed: { base: 0.21, quote: 37.6 }, coins: { base: 10.93, quote: 2_612.77 }, poolShare: 0.0117,
  timeInRange: 0.88, reranges: 2, lastRerangeAt: NOW - 19 * H, position: { id: 'paper-2', lower: 196.2, upper: 240.12, openedAt: NOW - 19 * H },
  positionFees: { since: NOW - 19 * H, coins: { base: 0.41, quote: 88.2 } }, equityHist: [[nvdaStart, 5_000], [NOW, 5_415.1]],
};
const grid = {
  kind: 'grid', id: 'g-eth', mode: 'paper', status: 'running', chainId: 4663, stable: 'robinhood:ETH/USDG', quoteSym: 'USDG', base: 'ETH',
  usdPerQuote: 1, price: 2_348.87, startedAt: NOW - 0.5 * H, moveCount: 1, lastMoveAt: NOW - 12 * 60_000,
  config: { lowerPrice: 2_100, upperPrice: 2_600, gridCount: 10, totalCapitalUsd: 2_000 }, stats: { roundTrips: 0, wins: 0 },
  pnl: { realized: 0.0925, unrealized: -0.0177, fees: 0.31, gas: 0.02 }, intervals: [], trades: [], levels: [], equityHist: [[NOW - 0.5 * H, 2_000], [NOW, 2_000.0748]],
};
const trend = {
  kind: 'trend', id: 't-nvda', name: 'EMA NVDA/USDG-HOOD 1h', mode: 'paper', status: 'running', chainId: 4663, quote: 'robinhood:NVDA/USDG',
  quoteSym: 'USDG', base: 'NVDA', usdPerQuote: 1, tf: '1h', cfg: { strategy: 'ema', fast: 9, slow: 21, lines: [] }, capital: 1_000, startedAt: NOW - 5 * D,
  moveCount: 7, lastMoveAt: NOW - 2.3 * H, stats: { winRate: 0.5714 }, position: null, signals: [], trades: [],
  pnl: { realized: 61.5, unrealized: -4.2, returnPct: 0.0573, fees: 3.1, gas: 0.2 }, equityHist: [[NOW - 5 * D, 1_000], [NOW, 1_057.3]],
};
const s = { ...s0, grids: [grid], trends: [trend], lps: [stonkd, nvdaLp] };
const bots = [{ ...grid, kind: 'grid' }, { ...trend, kind: 'trend' }, stonkd, nvdaLp];

// ---------------------------------------------------------------- what a person sees
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'path', 'circle', 'rect', 'line', 'polyline', 'stop']);
const ALWAYS_HIDDEN = (tag: string, cls: string[]) => ['input', 'select', 'option', 'th', 'title', 'textarea'].includes(tag)
  || cls.some((c) => ['btn', 'stat-note', 'bot-title', 'chip-btn', 'chart-wrap', 'eq-chart'].includes(c)) || tag === 'h2' || tag === 'summary';
const PHONE_HIDDEN = ['desk-spark', 'desk-val', 'desk-pct', 'desk-age', 'desk-apr', 'desk-moves', 'desk-fees', 'desk-status'];
type View = 'desktop' | 'phone';

/** Visible text: a tag is a word break; a hidden element and everything in it is dropped. */
export function visibleText(html: string, view: View): string {
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let out = '', skip = 0; const stack: boolean[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] != null) { if (!skip) out += m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'"); continue; }
    const [, close, tag0, attrs, self] = m; const tag = tag0.toLowerCase();
    if (close) { const hid = stack.pop(); if (hid) skip--; out += ' '; continue; }
    const cls = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/);
    const shut = tag === 'details' && !/\sopen(?:[\s=>]|$)/.test(attrs); // a closed <details>: only its summary shows
    const hidden = ALWAYS_HIDDEN(tag, cls) || shut || (view === 'desktop' && cls.includes('in-row')) || (view === 'phone' && cls.some((c) => PHONE_HIDDEN.includes(c)));
    if (self || VOID.has(tag)) { out += ' '; continue; }
    stack.push(hidden); if (hidden) skip++; out += ' ';
  }
  return out.replace(/\s+/g, ' ');
}

interface Fig { unit: string; v: number; tol: number; text: string }
const decs = (t: string) => (t.includes('.') ? t.split('.')[1].length : 0);
const parseNum = (t: string) => Number(t.replace(/,/g, ''));
const neg = (sg: string) => (sg === '-' || sg === '−' ? -1 : 1);

/** Every figure in the text, in a common unit: dollars (and dollar coins), each other coin, %, hours, ranges. */
export function figures(text: string): Fig[] {
  const out: Fig[] = [];
  const N = '(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)';
  const add = (unit: string, v: number, tol: number, t: string) => { if (v !== 0 && Number.isFinite(v)) out.push({ unit, v, tol, text: t.trim() }); };
  let rest = text.replace(/\b\d+[mhd] candles\b/g, ' ');
  // ranges first, then blank them so their ends aren't read again
  rest = rest.replace(new RegExp(`${N}\\s?–\\s?${N}`, 'g'), (t, a, b) => { add('range', parseNum(a) * 1e6 + parseNum(b), 0, t); return ' '; });
  rest = rest.replace(new RegExp(`([+\\-−]?)\\s?\\$\\s?${N}`, 'g'), (t, sg, n) => { add('$', neg(sg) * parseNum(n), 0.5 * 10 ** -decs(n), t); return ' '; });
  rest = rest.replace(new RegExp(`([+\\-−]?)${N}\\s(${SYMS.join('|')})(?![/\\w-])`, 'g'), (t, sg, n, sym) => {
    add(PEGGED.includes(sym) ? '$' : sym, neg(sg) * parseNum(n), 0.5 * 10 ** -decs(n), t); return ' ';
  });
  rest = rest.replace(new RegExp(`([+\\-−±]?)${N}\\s?%`, 'g'), (t, sg, n) => { add(sg === '±' ? '±%' : '%', neg(sg) * parseNum(n), 0.5 * 10 ** -decs(n), t); return ' '; });
  rest.replace(new RegExp(`(?<![\\w.$])${N}(m|h|d)(?!\\w)`, 'g'), (t, n, u) => {
    const k = u === 'm' ? 1 / 60 : u === 'h' ? 1 : 24; add('h', parseNum(n) * k, 0.5 * 10 ** -decs(n) * k, t); return ' ';
  });
  return out;
}

/** Figures shown twice: same unit and equal to the shown precision. */
export function repeats(figs: Fig[]): string[] {
  const dup: string[] = [];
  for (let i = 0; i < figs.length; i++) for (let j = i + 1; j < figs.length; j++) {
    const a = figs[i], b = figs[j];
    if (a.unit === b.unit && Math.abs(a.v - b.v) <= Math.max(a.tol, b.tol) + 1e-9) dup.push(`"${a.text}" and "${b.text}"`);
  }
  return dup;
}

const wrap = (el: ReactElement, usdOn: boolean) => h(ShowUsdCtx.Provider, { value: { on: usdOn, set: () => undefined } }, el);
const noop = () => undefined;
const desk = (open: string | null, usdOn: boolean) => renderToStaticMarkup(wrap(h(DeskTable, { s, bots, nav: noop, pause: noop, close: noop, initialOpen: open }), usdOn));
const lpPage = (id: string, usdOn: boolean) => renderToStaticMarkup(wrap(h(LpDetail, { s, id, events: [], ticks: null, nav: noop, act: noop, busy: false }), usdOn));
/** The same page with its collapsed Details opened. */
const opened = (html: string) => html.replace(/<details(?![^>]*\sopen)/g, '<details open=""');
const gridPage = (usdOn: boolean) => renderToStaticMarkup(wrap(h(GridDetail, { s, id: grid.id, events: [], ticks: null, nav: noop, act: noop, busy: false }), usdOn));
const trendPage = (usdOn: boolean) => renderToStaticMarkup(wrap(h(TrendDetail, { s, id: trend.id, events: [], ticks: null, nav: noop, act: noop, busy: false }), usdOn));

beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

describe('figure finder (self-check)', () => {
  it('reads −866 USDG and −$866.00 as the same figure, and tells different ones apart', () => {
    expect(repeats(figures('−866 USDG then −$866.00'))).toHaveLength(1);
    expect(repeats(figures('−2.5% and −2.55%'))).toHaveLength(1);
    expect(repeats(figures('8.8h and 9h ago'))).toHaveLength(1);
    expect(repeats(figures('−866 USDG and +866 USDG, 732.2 – 810.0 USDG/SPY, $0.00, 0%'))).toHaveLength(0);
    expect(repeats(figures('21.3 SPY and $21.30'))).toHaveLength(0);
  });
  it('a page that repeats a figure fails', () => {
    const html = '<div><b>−866 USDG</b><table><tr><th>Net 8.8h</th><td>−$866.00</td></tr></table></div>';
    expect(repeats(figures(visibleText(html, 'desktop')))).toHaveLength(1);
  });
});

describe('each figure once per screen', () => {
  for (const usdOn of [false, true]) {
    for (const view of ['desktop', 'phone'] as View[]) {
      const tag = `${view}, dollars ${usdOn ? 'on' : 'off'}`;
      it(`Bots list, collapsed (${tag})`, () => {
        expect(repeats(figures(visibleText(desk(null, usdOn), view)))).toEqual([]);
      });
      for (const b of bots) {
        it(`Bots list, ${b.id} open (${tag})`, () => {
          const text = visibleText(desk(b.id, usdOn), view);
          expect(text).toMatch(/Spacing|Moves|Chain/); // it really is open
          expect(repeats(figures(text))).toEqual([]);
        });
      }
      it(`Grid page, a run under a day (${tag})`, () => {
        expect(repeats(figures(visibleText(gridPage(usdOn), view)))).toEqual([]);
      });
      it(`Home (${tag})`, () => {
        const html = renderToStaticMarkup(wrap(h(Home, { s, nav: noop, holdings: null, act: noop }), usdOn));
        expect(repeats(figures(visibleText(html, view)))).toEqual([]);
      });
      it(`Trend page (${tag})`, () => {
        expect(repeats(figures(visibleText(trendPage(usdOn), view)))).toEqual([]);
      });
      for (const id of ['lp-stonkd', 'lp-nvda']) {
        it(`LP page ${id} (${tag})`, () => {
          const text = visibleText(lpPage(id, usdOn), view);
          expect(text).toMatch(/Generated, net of costs/);
          expect(repeats(figures(text))).toEqual([]);
        });
        it(`LP page ${id}, Details opened (${tag})`, () => {
          const html = opened(lpPage(id, usdOn));
          expect(html).toMatch(/Costs paid/);
          const text = visibleText(html, view);
          expect(repeats(figures(text))).toEqual([]);
        });
      }
    }
  }

  it('one-bot groups show no totals; the two-bot group leads with coins', () => {
    const text = visibleText(desk(null, true), 'desktop');
    expect(text).toMatch(/Grid 1 \$ HOOD/); // straight to the row: no totals
    expect(text).toMatch(/Trend 1 N \$ HOOD/);
    expect(text).toMatch(/Liquidity 2 +38,537 USDG +−463\.3 USDG/);
  });
});

/** The figures (in the page's dollar unit: USDG is a dollar coin here) that equal `v` to the shown precision. */
const shown = (text: string, v: number) => figures(text).filter((f) => f.unit === '$' && Math.abs(f.v - v) <= f.tol + 1e-9);

describe('LP page: one headline net (gate findings on #72 and #73)', () => {
  const p = stonkd.pnl;
  const parts = {
    'gas paid': -p.gas, 'swap costs paid': -p.swapCost, 'lost to range moves': -p.moveLoss, 'net with the price move': p.net + p.price, 'the price move': p.price,
  };
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`shows the net once and nothing else net-looking until Details is opened (${view})`, () => {
      const text = visibleText(lpPage('lp-stonkd', true), view);
      expect(text).not.toMatch(/Earned after costs/); // #72 gate: it repeated the headline net
      expect(shown(text, p.net)).toHaveLength(1);
      for (const [what, v] of Object.entries(parts)) expect(shown(text, v), what).toHaveLength(0);
      expect(figures(text).filter((f) => f.unit === '%' && Math.abs(f.v - (p.net / stonkd.startValue) * 100) <= f.tol + 1e-9), 'net %').toHaveLength(0);
    });
    it(`moves the rest into Details, with plain labels, not removing it (${view})`, () => {
      const html = opened(lpPage('lp-stonkd', true));
      const text = visibleText(html, view);
      expect(shown(text, p.net)).toHaveLength(1);
      for (const [what, v] of Object.entries(parts)) expect(shown(text, v), what).toHaveLength(1);
      // plain labels saying what each one is (labels are <th>, not figures, so read from the markup)
      for (const label of ['Fees earned', 'Costs paid: gas', 'Costs paid: swaps to the range&#x27;s mix (pool fee and price impact)', 'Lost to range moves (0 moves)', 'Net as a share of what you put in', 'Price move of the SPY and USDG held (not in the net)', 'Net including that price move']) {
        expect(html).toContain(`<th>${label}</th>`);
      }
      expect(text).toMatch(/[−-]2\.55%/);
    });
  }
});

describe('amounts lead with the coin, dollars small', () => {
  it('a Bots-list row opened on a phone shows Value and Invested in the coin, not dollars first', () => {
    const html = desk('lp-stonkd', true);
    expect(html).toMatch(/<th>Value<\/th><td class="mono">33,122 USDG<\/td>/);
    expect(html).toMatch(/<th>Invested<\/th><td class="mono">34,000 USDG<\/td>/);
    expect(visibleText(html, 'phone')).not.toMatch(/\$3[34],/);
  });
  it('a coin not worth a dollar: the coin first, the dollars after it in small print', () => {
    const weth = { ...grid, id: 'g-weth', quoteSym: 'WETH', usdPerQuote: 2_500, config: { ...grid.config, totalCapitalUsd: 0.8 } };
    const html = renderToStaticMarkup(h(StatTable, { b: weth, s }));
    expect(html).toMatch(/<th>Invested<\/th><td class="mono">0\.8 WETH<small class="usd"> \$2,000<\/small>/);
  });
});

describe('APR under a day (gate finding on #72)', () => {
  it('shows "—", not the P&L % again, for every bot under a day', () => {
    const html = desk(null, true);
    // each row: its name, then its APR cell. Grid (30m) and STONKD (8.8h) are under a day; the trend (5d) and NVDA LP (3.2d) are not.
    const rows = [...html.matchAll(/<span class="bot-title">([^<]*)<\/span>[\s\S]*?<span class="desk-apr"[^>]*>([\s\S]*?)<\/span><span class="desk-moves">/g)]
      .map((m) => [m[1], m[2]] as const);
    expect(rows.map(([n]) => n).sort()).toEqual(['EMA NVDA/USDG-HOOD 1h', 'NVDA LP', 'STONKD LP #2', 'PLS/robinhood:ETH/USDG'].sort());
    for (const [n, apr] of rows) {
      if (n === 'STONKD LP #2' || n === 'PLS/robinhood:ETH/USDG') expect(apr, n).toBe('—');
      else expect(apr, n).toMatch(/^[+−-]?[\d.,]+%$/);
    }
  });
});
