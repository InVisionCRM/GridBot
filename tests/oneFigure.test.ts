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
 * No exemptions (Kyle, #73): the LP pace card has no "So far" line (that was Generated again), only the Est. rows.
 * Holdings is covered too: coin amounts per chain, no dollar figure and no total across coins.
 */
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeskTable } from '../src/ui/DeskTable';
import { GridDetail } from '../src/ui/GridDetail';
import { Holdings } from '../src/ui/Holdings';
import { Home } from '../src/ui/Home';
import { LpDetail } from '../src/ui/LpDetail';
import { StatTable } from '../src/ui/StatTable';
import { TrendDetail } from '../src/ui/TrendDetail';
import { ValueOverTime } from '../src/ui/ValueOverTime';
import { ShowUsdCtx } from '../src/ui/money';

// A rendered page shows a counting number at its end value (the static render would show where the count starts).
vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, AnimatedNumber: ({ value, format }: { value: number | null; format: (x: number) => string }) => h('span', null, value == null ? '—' : format(value)) };
});

// The value-over-time chart draws on a canvas: here it writes its series label, last value and drawdown pane as text, so a
// test can tell whether it rendered at all (Kyle, #73: a price-driven value only inside a collapsed Details).
vi.mock('../src/ui/Chart', async (orig) => {
  const m = await orig<typeof import('../src/ui/Chart')>();
  return {
    ...m,
    EquityChart: ({ series, drawdown = true }: { series: { name: string; data: [number, number][] }[]; drawdown?: boolean }) =>
      h('div', { className: 'eq-chart' }, series.map((x) => `${x.name} ${x.data[x.data.length - 1]?.[1] ?? ''}`).join(' '), drawdown ? ' drawdown' : ''),
  };
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

  it('one-bot groups show no totals; the two-bot group sums only the coins both bots count in', () => {
    const text = visibleText(desk(null, true), 'desktop');
    expect(text).toMatch(/Grid 1 U HOOD/); // straight to the row: no totals
    expect(text).toMatch(/Trend 1 N U HOOD/);
    // invested 34,000 + 5,000 USDG; generated in USDG (22.37 − 907.2) + (216.3 − 43.9); SPY and NVDA are each one bot's own
    expect(text).toMatch(/Liquidity 2 39,000 USDG −712\.4 USDG/);
  });
});

/** The figures (in the page's dollar unit: USDG is a dollar coin here) that equal `v` to the shown precision. */
const shown = (text: string, v: number) => figures(text).filter((f) => f.unit === '$' && Math.abs(f.v - v) <= f.tol + 1e-9);

describe('LP page: headline Invested + Generated, the parts in Details (Kyle, #73)', () => {
  const p = stonkd.pnl;
  const genQuote = p.feeCoins.quote - (p.gas + p.swapCost + p.moveLoss); // −884.83 USDG
  const parts = { 'gas paid': -p.gas, 'swap costs paid': -p.swapCost, 'lost to range moves': -p.moveLoss };
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`headline: Invested and Generated in tokens, nothing else net-looking until Details is opened (${view})`, () => {
      const html = lpPage('lp-stonkd', true);
      const text = visibleText(html, view);
      expect(text).toMatch(/Invested i 34,000 USDG over 8\.8h Generated, net of costs i \+0\.0531 SPY −884\.83 USDG/);
      expect(text).toMatch(/\+0\.0531 SPY/);
      expect(shown(text, genQuote), 'generated USDG').toHaveLength(1);
      expect(shown(text, p.net), 'the engine net in one figure').toHaveLength(0);
      for (const [what, v] of Object.entries(parts)) expect(shown(text, v), what).toHaveLength(0);
    });
    it(`Details has the parts with plain labels and no price-move lines (${view})`, () => {
      const html = opened(lpPage('lp-stonkd', true));
      const text = visibleText(html, view);
      expect(shown(text, genQuote)).toHaveLength(1);
      for (const [what, v] of Object.entries(parts)) expect(shown(text, v), what).toHaveLength(1);
      for (const label of ['Fees earned', 'Costs paid: gas', 'Costs paid: swaps to the range&#x27;s mix (pool fee and price impact)', 'Lost to range moves (0 moves)', 'Generated as a share of what you put in']) {
        expect(html).toContain(`<th>${label}</th>`);
      }
      expect(html).not.toMatch(/Price move of|including that price move|coin price move/i);
      expect(shown(text, p.price), 'the price move').toHaveLength(0);
      expect(shown(text, p.net + p.price), 'net with the price move').toHaveLength(0);
      // Generated ÷ Invested: (0.0531 SPY × 771.33 − 884.83 USDG) ÷ 34,000, not the engine net −866 (−2.55%)
      expect(text).toMatch(/[−-]2\.48%/);
      expect(text).not.toMatch(/[−-]2\.55%/);
    });
  }
  it('the pace card has no "So far" line (Generated is the headline): only the Est. rows, never the position\'s gross fees', () => {
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      const html = opened(lpPage(id, true));
      expect(html, id).not.toMatch(/So far|pace-so-far/);
      expect(visibleText(html, 'desktop'), id).not.toMatch(/0\.41 NVDA|88\.2 USDG/); // positionFees: gross, this position only
    }
    expect(lpPage('lp-nvda', true)).toMatch(/This bot&#x27;s pace/);
  });
  it('the pace estimates are Generated ÷ days run × 1, 7, 365 (shared estimates), hidden under a day', () => {
    // STONKD has run 8.8h: no estimates, so no pace card at all
    expect(lpPage('lp-stonkd', true)).not.toMatch(/This bot&#x27;s pace|class="card pace"|Est\. a day/);
    // NVDA LP has run 3.2d: 1.1 NVDA and 172.4 USDG ÷ 3.2 × 1, 7, 365
    const text = visibleText(lpPage('lp-nvda', true), 'desktop');
    expect(text).toMatch(/Est\. a day 0\.34\d* NVDA \+ 53\.88 USDG Est\. 7 days 2\.406 NVDA \+ 377\.1 USDG Est\. 365 days 125\.5 NVDA \+ 19,660 USDG/);
  });
  it('the LP page has no Est. 24h / 7d / 365d table rows: the pace card is the one place for them', () => {
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      const html = opened(lpPage(id, true));
      expect(html, id).not.toMatch(/Est\. (24h|7d|365d)/);
      expect(html, id).not.toMatch(/Estimates \(24h, 7d, 365d\)|carried over 24h, 7d and 365d/); // nor the note about those rows
    }
  });
});

describe('crypto units only (Kyle, #73)', () => {
  it('a Bots-list row opened shows Value now and Invested in the coin', () => {
    const html = desk('lp-stonkd', true);
    expect(html).toMatch(/<th>Value now<\/th><td class="mono">33,122 USDG<\/td>/);
    expect(html).toMatch(/<th>Invested<\/th><td class="mono">34,000 USDG<\/td>/);
  });
  it('a coin not worth a dollar shows in that coin only', () => {
    const weth = { ...grid, id: 'g-weth', quoteSym: 'WETH', usdPerQuote: 2_500, config: { ...grid.config, totalCapitalUsd: 0.8 } };
    const html = renderToStaticMarkup(h(StatTable, { b: weth, s }));
    expect(html).toMatch(/<th>Invested<\/th><td class="mono">0\.8 WETH<\/td>/);
    expect(html).not.toContain('$');
  });
});

/**
 * Everything rendered, labels included: text nodes (also inside closed Details, table headers and summaries) and
 * title / aria-label attributes (tooltips). Kyle: no '$' and never the words Realized or Unrealized on these screens.
 */
function rendered(html: string): string {
  const attrs = [...html.matchAll(/\s(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]);
  return `${html.replace(/<[^>]*>/g, ' ')} ${attrs.join(' ')}`.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}
const BANNED = /\$|\bUnrealized\b|\bRealized\b/i;
const hits = (html: string) => rendered(html).split(/(?<=[.!?])\s+|\s{2,}/).filter((x) => BANNED.test(x)).map((x) => x.trim()).slice(0, 5);

describe("no '$', no Realized/Unrealized labels, on every covered screen and state (Kyle, #73)", () => {
  for (const usdOn of [false, true]) {
    const tag = `dollars ${usdOn ? 'on' : 'off'}`;
    it(`Bots list, collapsed and each bot open (${tag})`, () => {
      expect(hits(desk(null, usdOn))).toEqual([]);
      for (const b of bots) expect(hits(desk(b.id, usdOn)), b.id).toEqual([]);
    });
    it(`Home (${tag})`, () => {
      expect(hits(renderToStaticMarkup(wrap(h(Home, { s, nav: noop, holdings: null, act: noop }), usdOn)))).toEqual([]);
    });
    it(`Grid page (${tag})`, () => { expect(hits(opened(gridPage(usdOn)))).toEqual([]); });
    it(`Trend page (${tag})`, () => { expect(hits(opened(trendPage(usdOn)))).toEqual([]); });
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      it(`LP page ${id}, Details closed and opened (${tag})`, () => {
        expect(hits(lpPage(id, usdOn))).toEqual([]);
        expect(hits(opened(lpPage(id, usdOn)))).toEqual([]);
      });
    }
  }
  it('the check itself catches a dollar sign and both labels', () => {
    expect(hits('<td>≈ $12.00</td>')).toHaveLength(1);
    expect(hits('<th>Realized</th>')).toHaveLength(1);
    expect(hits('<span title="Unrealized change">x</span>')).toHaveLength(1);
    expect(hits('<td>34,000 USDG</td>')).toHaveLength(0);
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

describe("token and smart trader screens: no '$', no Realized/Unrealized (source check; they load their data on mount)", () => {
  it('neither file renders a dollar sign or the labels', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['TokenTrader.tsx', 'SmartTrader.tsx']) {
      const src = readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '') // comments
        .replace(/\$\{/g, '{'); // template-literal holes are not dollar signs
      expect(src, f).not.toMatch(/\$/);
      expect(src, f).not.toMatch(/\bUnrealized\b|\bRealized\b/);
      expect(src, f).not.toMatch(/\busd\(|<Usd\b|formatUsd/);
    }
  });
});

describe('Est. APR comes from Generated, never from a value change that includes the price (Kyle, #73)', () => {
  it('the trend row: realized ÷ capital ÷ 5 days × 365, not its returnPct (which includes the open trade)', () => {
    const html = desk(null, true);
    const m = /EMA NVDA\/USDG-HOOD 1h<\/span>[\s\S]*?<span class="desk-apr"[^>]*>([\s\S]*?)<\/span>/.exec(html);
    expect(m?.[1]).toBe('+449.0%'); // 61.5 / 1,000 / 5 × 365 = 4.4895
    expect(html).not.toMatch(/\bAPY\b/);
  });
  it('the NVDA LP row: Generated (1.1 NVDA at the pool price + 172.4 USDG) ÷ put in, carried over a year', () => {
    const html = desk(null, true);
    const m = /NVDA LP<\/span>[\s\S]*?<span class="desk-apr"[^>]*>([\s\S]*?)<\/span>/.exec(html);
    const gen = 1.1 * 217.97 + (216.3 - (0.6 + 1.43 + 41.87));
    expect(m?.[1]).toBe(`+${((gen / 5_000 / 3.2) * 365 * 100).toFixed(1)}%`);
  });
});

/**
 * One Generated figure per bot, everywhere (gate finding on #73's stills, desktop-lp-3.2d and desktop-bots): for the same
 * fixture the pace card's "So far", the LP headline Generated and the Bots list's Generated column are the same tokens,
 * and Gen. % and Est. APR are worked out from those tokens (an LP's base part at the pool price), never from the engine's
 * separate pnl.net or the open position's gross positionFees.
 */
describe('So far == Generated column == LP headline; Gen. % and Est. APR from the same Generated (gate finding, #73)', () => {
  // the NVDA LP still: tiny fee coins, so ~−1.4 USDG generated, while pnl.net (+412) and positionFees (1.1 NVDA + 230 USDG) say otherwise
  const still = {
    ...nvdaLp, id: 'lp-nvda-still', label: 'NVDA LP still', price: 217.82, startedAt: NOW - 3.2 * D,
    pnl: { feeCoins: { base: 0.00016568, quote: 0.0748 }, fees: 455, gas: 0.08, swapCost: 1.4, moveLoss: 0, net: 412, price: -4.2 },
    position: { id: 'paper-3', lower: 196.2, upper: 240.12, openedAt: NOW - 3.2 * D },
    positionFees: { since: NOW - 3.2 * D, coins: { base: 1.1, quote: 230 } }, lastRerangeAt: null, reranges: 0,
  };
  const cases = [stonkd, nvdaLp, still];
  type Amt = { v: number; tol: number };
  /** Coin amounts in a piece of visible text, by coin: "+0.0531 SPY", "− 884.83 USDG", "0.00016568 NVDA". */
  const coins = (text: string): Map<string, Amt> => {
    const m = new Map<string, Amt>();
    for (const x of text.matchAll(new RegExp(`([+\\-−]?)\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s(${SYMS.join('|')})(?![/\\w-])`, 'g'))) {
      const d = x[2].includes('.') ? x[2].split('.')[1].length : 0;
      m.set(x[3], { v: neg(x[1]) * parseNum(x[2]), tol: 0.5 * 10 ** -d });
    }
    return m;
  };
  const between = (text: string, a: RegExp, b: RegExp) => {
    const i = text.search(a); expect(i, `${a}`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(i).replace(a, ''); const j = rest.search(b);
    return j < 0 ? rest : rest.slice(0, j);
  };
  const sOf = (b: typeof stonkd) => ({ ...s0, lps: [b] });
  const page = (b: typeof stonkd) => visibleText(renderToStaticMarkup(wrap(h(LpDetail, { s: sOf(b), id: b.id, events: [], ticks: null, nav: noop, act: noop, busy: false }), false)), 'desktop');
  const row = (b: typeof stonkd) => {
    const html = renderToStaticMarkup(wrap(h(DeskTable, { s: sOf(b), bots: [b], nav: noop, pause: noop, close: noop, initialOpen: null }), false));
    const cell = (c: string) => new RegExp(`<span class="${c}"[^>]*>([\\s\\S]*?)</span>(?=<span class="desk-|<span class="desk-|$)`).exec(html.slice(html.indexOf(`>${b.label}<`)))?.[1] ?? '';
    return { pnl: visibleText(cell('desk-pnl'), 'desktop'), pct: visibleText(cell('desk-pct'), 'desktop'), apr: visibleText(cell('desk-apr'), 'desktop') };
  };
  const pctOf = (t: string) => { const x = /([+\-−]?)(\d[\d,]*(?:\.\d+)?)%/.exec(t); expect(x, t).not.toBeNull(); return { v: neg(x![1]) * parseNum(x![2]) / 100, tol: 0.5 * 10 ** -(decs(x![2]) + 2) }; };
  /** Generated as the engine fields define it (#48): base fee coins, quote fee coins − gas − swap cost − range-move loss. */
  const truth = (b: typeof stonkd) => new Map([[b.base, b.pnl.feeCoins.base], ['USDG', b.pnl.feeCoins.quote - (b.pnl.gas + b.pnl.swapCost + b.pnl.moveLoss)]]);
  const same = (got: Map<string, Amt>, want: Map<string, number>, what: string) => {
    expect([...got.keys()].sort(), what).toEqual([...want.keys()].sort());
    for (const [k, v] of want) expect(Math.abs(got.get(k)!.v - v), `${what} ${k}: ${got.get(k)!.v} vs ${v}`).toBeLessThanOrEqual(got.get(k)!.tol + 1e-12);
  };

  for (const b of cases) {
    it(`${b.label}: LP headline Generated == the Bots list's Generated column, and no pace "So far" repeating it`, () => {
      const text = page(b);
      expect(text).not.toMatch(/So far/);
      const headline = coins(between(text, /Generated, net of costs i/, /Liquidity provided/));
      const column = coins(row(b).pnl);
      const want = truth(b);
      same(headline, want, 'headline');
      same(column, want, 'Generated column');
    });
    it(`${b.label}: Gen. % == the Generated column ÷ Invested (base part at the pool price), and Est. APR from it`, () => {
      const r = row(b);
      const column = coins(r.pnl);
      const valued = [...column].reduce((a, [k, x]) => a + (k === 'USDG' ? x.v : x.v * b.price), 0);
      const tolV = [...column].reduce((a, [k, x]) => a + (k === 'USDG' ? x.tol : x.tol * b.price), 0);
      const inv = b.startValue;
      // rounds to 0.0%: Gen. % reads "—" (Kyle, #73)
      if (Math.abs(valued / inv) < 0.0005 - tolV / inv) { expect(r.pct.trim()).toBe('—'); return; }
      const shown = pctOf(r.pct);
      expect(Math.abs(shown.v - valued / inv), `${r.pct} vs ${valued}/${inv}`).toBeLessThanOrEqual(shown.tol + tolV / inv + 1e-12);
      // and never the engine net when that disagrees
      if (Math.abs(b.pnl.net - valued) / inv > 0.001) expect(Math.abs(shown.v - b.pnl.net / inv)).toBeGreaterThan(shown.tol);
      const days = (NOW - b.startedAt) / D;
      if (days >= 1) {
        const apr = pctOf(r.apr);
        expect(Math.abs(apr.v - (valued / inv / days) * 365), `${r.apr}`).toBeLessThanOrEqual(apr.tol + (tolV / inv / days) * 365 + 1e-12);
      } else expect(r.apr.trim()).toBe('—');
    });
  }
  it('Home names the best bot from the same Generated: the trend (+61.5 USDG), not the NVDA LP still (−1.4 USDG, engine net +412)', () => {
    const html = renderToStaticMarkup(wrap(h(Home, { s: { ...s0, trends: [trend], lps: [still] }, nav: noop, holdings: null, act: noop }), false));
    expect(visibleText(html, 'desktop')).toMatch(/Best bot EMA NVDA\/USDG-HOOD 1h/);
  });
  it('the NVDA LP still: Gen. % rounds to 0.0% so reads "—", a small negative Est. APR, not +8.2% and +939.9%', () => {
    const r = row(still);
    expect(r.pct.trim()).toBe('—');
    expect(r.apr.trim()).toMatch(/^[−-]3\.\d%$/);
    expect(page(still)).toMatch(/Generated, net of costs i \+0\.00016568 NVDA −1\.4052 USDG/);
    expect(page(still)).not.toMatch(/So far/);
  });
  it('Gen. % that rounds to 0.0% shows nowhere: Bots row (desktop and phone), the row opened, the LP Details, grid and trend pages', () => {
    const tiny = { ...still, id: 'lp-tiny', label: 'Tiny LP' };
    const flatGrid = { ...grid, id: 'g-flat', pnl: { ...grid.pnl, realized: 0.0004, gas: 0 } }; // 0.0004 ÷ 2,000 ≈ 0.00002%
    const flatTrend = { ...trend, id: 't-flat', pnl: { ...trend.pnl, realized: 0.2, gas: 0 } }; // 0.2 ÷ 1,000 = 0.02%
    const sx = { ...s0, grids: [flatGrid], trends: [flatTrend], lps: [tiny] };
    const zero = /(?<![±\d.])[+\-−]?0\.0+%/; // a Gen. % of 0.0% (not a range width like ±10.00%)
    for (const open of [null, tiny.id, flatGrid.id, flatTrend.id]) {
      const html = renderToStaticMarkup(wrap(h(DeskTable, { s: sx, bots: [{ ...flatGrid, kind: 'grid' }, { ...flatTrend, kind: 'trend' }, tiny], nav: noop, pause: noop, close: noop, initialOpen: open }), false));
      for (const view of ['desktop', 'phone'] as View[]) expect(visibleText(html, view), `${open} ${view}`).not.toMatch(zero);
      expect(html).toMatch(/<span class="desk-pct"[^>]*><span class="">—<\/span><\/span>/);
    }
    const lp = opened(renderToStaticMarkup(wrap(h(LpDetail, { s: sx, id: tiny.id, events: [], ticks: null, nav: noop, act: noop, busy: false }), false)));
    expect(lp).toMatch(/<th>Generated as a share of what you put in<\/th><td class="mono">—<\/td>/);
    expect(visibleText(lp, 'desktop')).not.toMatch(zero);
    for (const el of [h(GridDetail, { s: sx, id: flatGrid.id, events: [], ticks: null, nav: noop, act: noop, busy: false }), h(TrendDetail, { s: sx, id: flatTrend.id, events: [], ticks: null, nav: noop, act: noop, busy: false })]) {
      const html = opened(renderToStaticMarkup(wrap(el, false)));
      expect(html).toMatch(/Generated/);
      expect(visibleText(html, 'desktop')).not.toMatch(zero);
      expect(html).not.toMatch(/of what was put in/);
    }
  });
});

// ---------------------------------------------------------------- Holdings (Kyle, #73): coin amounts only
const coin = (chainId: number, symbol: string, amount: number, usdEach: number | null, address: string | null = `0x${symbol}`) =>
  ({ chainId, address, symbol, decimals: 18, amount, usdEach, usd: usdEach == null ? null : amount * usdEach });
const ref = (id: string, kind: 'grid' | 'lp', name: string) => ({ id, kind, name, status: 'running', mode: 'live' as const });
const holdingsSnap = {
  address: '0x1234567890abcdef1234567890abcdef12345678', at: NOW - 60_000, hasSigner: true,
  netWorthUsd: 61_234.5, netWorthExDustUsd: 61_200, unpriced: 0, walletUsd: 40_000, freeUsd: 38_000, botsUsd: 2_000, lpUsd: 21_000, feesUsd: 34.5,
  overdrawn: false,
  chains: [{ chainId: 4663, name: 'Robinhood Chain', short: 'HOOD', color: '#ccff00', address: null, usd: 61_000, walletUsd: 40_000, botsUsd: 2_000, lpUsd: 21_000, feesUsd: 34.5 }],
  wallet: [
    { coin: coin(4663, 'USDG', 34_000, 1), dust: false, bots: [{ bot: ref('g-eth', 'grid', 'ETH grid'), amount: 1_200 }] },
    { coin: coin(4663, 'ETH', 2.5, 2_348.87, null), dust: false, bots: [] },
    { coin: coin(4663, 'SPY', 0.75, 771.33), dust: false, bots: [] },
    { coin: coin(369, 'PLS', 1_234_567, 0.00003, null), dust: false, bots: [] },
    { coin: coin(4663, 'NVDA', 0.00001, 217.97), dust: true, bots: [] },
  ],
  positions: [{
    chainId: 4663, kind: 'v3', dexName: 'Uniswap V3', pool: '0xpool', feeLabel: '0.05%', tokenId: '77', range: 'in',
    token0: coin(4663, 'SPY', 21.3, 771.33), token1: coin(4663, 'USDG', 16_950.2, 1), usd: 33_379.33, partial: false, dust: false,
    bot: ref('lp-stonkd', 'lp', 'STONKD LP #2'), stranded: false, idleNote: null,
  }],
  fees: [{
    chainId: 4663, dexName: 'Uniswap V3', pool: '0xpool', feeLabel: '0.05%', tokenId: '77', token0: coin(4663, 'SPY', 0.0102, 771.33),
    token1: coin(4663, 'USDG', 4.31, 1), usd: 12.18, partial: false, dust: false, bot: null, stranded: false, leftover: false,
  }],
  bots: [{ bot: ref('g-eth', 'grid', 'ETH grid'), chainId: 4663, coins: [coin(4663, 'USDG', 1_200, 1), coin(4663, 'ETH', 0.4, 2_348.87, null)], usd: 2_139.5, dust: false }],
  errors: [], how: ['How it is counted.'],
};
const sH = { ...s0, chains: [...s0.chains, { id: 369, key: 'pulse', name: 'PulseChain', short: 'PLS', color: '#f0f', status: 'live' }] };
const holdingsPage = (snap: unknown = holdingsSnap) =>
  opened(renderToStaticMarkup(h(Holdings, { s: sH, snap: snap as never, loading: false, error: null, reload: noop, nav: noop })));

describe("Holdings: coin amounts per chain, no '$', no cross-coin total, each figure once (Kyle, #73)", () => {
  it('shows each coin in its own units, stablecoins as "34,000 USDG"', () => {
    const text = visibleText(holdingsPage(), 'desktop');
    for (const want of ['34,000 USDG', '2.5 ETH', '0.75 SPY', '1,234,570 PLS', '21.3 SPY · 16,950.2 USDG', '0.0102 SPY · 4.31 USDG', '1,200 USDG · 0.4 ETH']) expect(text).toContain(want);
    expect(text).toMatch(/Robinhood Chain[\s\S]*PulseChain|PulseChain[\s\S]*Robinhood Chain/);
  });
  it("no '$' anywhere (text, tooltips, labels), and no dollar total: not the net worth, a chain's, the fees' or the grids'", () => {
    for (const html of [holdingsPage(), renderToStaticMarkup(h(Holdings, { s: sH, snap: holdingsSnap as never, loading: false, error: null, reload: noop, nav: noop }))]) {
      expect(hits(html)).toEqual([]);
      const text = visibleText(html, 'desktop');
      for (const usd of ['61,234', '61,200', '61,000', '40,000', '33,379', '2,139', '12.18', '34.5']) expect(text, usd).not.toContain(usd);
      expect(text).not.toMatch(/\b\d+(\.\d+)?K\b/); // full amounts, not "34K"
    }
  });
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`each figure once (${view}), folds opened`, () => {
      expect(repeats(figures(visibleText(holdingsPage(), view)))).toEqual([]);
    });
  }
  it("the header's dollar net-worth chip is off on Holdings, as on the other crypto-only views", async () => {
    const { CRYPTO_ONLY } = await import('../src/ui/Header');
    expect(CRYPTO_ONLY.has('holdings')).toBe(true);
  });
  it('paper mode (no wallet): still no dollar figure', () => {
    const paper = { ...holdingsSnap, hasSigner: false, address: null, wallet: [], positions: [], fees: [], bots: [], chains: [] };
    expect(hits(holdingsPage(paper))).toEqual([]);
    expect(visibleText(holdingsPage(paper), 'desktop')).toMatch(/Paper mode/);
  });
});

describe('Value over time (value line + drawdown) is collapsed and closed by default (Kyle, #73)', () => {
  const closedSection = /<details class="card net-details value-details"><summary>Details: value over time/;
  const pages: [string, () => string][] = [
    ['LP page lp-stonkd', () => lpPage('lp-stonkd', false)], ['LP page lp-nvda', () => lpPage('lp-nvda', false)],
    ['Grid page', () => gridPage(false)], ['Trend page', () => trendPage(false)],
  ];
  for (const [name, page] of pages) {
    it(`${name}: the section is there, closed, and neither the chart, its value label nor the drawdown is rendered`, () => {
      const html = page();
      expect(html).toMatch(closedSection);
      expect(html).not.toMatch(/class="eq-chart"|empty-eq/);
      expect(html).not.toMatch(/value USDG|drawdown|Value now/);
      // and no value figure from the chart's data on the page (e.g. the NVDA LP's last value, 5,415.1 USDG)
      for (const view of ['desktop', 'phone'] as View[]) expect(visibleText(html, view)).not.toMatch(/5,415\.1|33,121\.6|2,000\.0748|1,057\.3/);
    });
  }
  it('opened, it renders the chart with its value label and drawdown, from the same data', () => {
    const html = renderToStaticMarkup(h(ValueOverTime, { q: 'USDG', note: 'after gas', data: nvdaLp.equityHist as [number, number][], initialOpen: true }));
    expect(html).toMatch(/<details class="card net-details value-details" open="">/);
    expect(html).toMatch(/<div class="eq-chart">value USDG 5415\.1 drawdown<\/div>/);
    // the pages pass their Value now row in: shown only when opened
    const withNow = (open: boolean) => renderToStaticMarkup(h(ValueOverTime, { q: 'USDG', data: [], initialOpen: open }, h(StatTable, { b: nvdaLp, s, only: ['value'] })));
    expect(withNow(true)).toMatch(/<th>Value now<\/th><td class="mono">5,415\.1 USDG<\/td>/);
    expect(withNow(false)).not.toMatch(/Value now|5,415/);
    // closed (the default), the same component renders only its summary
    const shut = renderToStaticMarkup(h(ValueOverTime, { q: 'USDG', data: nvdaLp.equityHist as [number, number][] }));
    expect(shut).not.toMatch(/eq-chart|value USDG|drawdown/);
    expect(shut).toMatch(/Details: value over time/);
  });
});
