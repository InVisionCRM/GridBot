/**
 * Kyle's rule: each figure appears once per screen, no exemptions (ported from #73 onto main's botMetrics screens:
 * every figure comes from the server's metrics, nothing from the old generated.ts). Renders Home, the Bots list
 * (collapsed, and each bot's row opened), Holdings, and the grid, trend and LP pages (a 3.2-day LP and an 8.8-hour LP,
 * Details closed and opened) from #73's sample paper data with metrics computed by botMetrics, reads the text a person
 * would see on a desktop and on a phone, and fails if any figure shows twice. Then the display rules themselves:
 * the LP pace card, "—" for a percent that rounds to 0.0%, Holdings in coin amounts, the collapsed Value over time,
 * the grid's stop sale in Details, and the live LP fixture's Generated.
 *
 * A figure is a coin amount, a percent, a run length or age (8.8h, 5.0d), or a price range (a – b). Two are the same
 * when they're in the same unit and agree to the shown precision. Not figures: zeros, dashes, labels (table headers,
 * bot names, the notes about what the estimates mean), buttons and inputs, a trend's candle size ("1h candles"), the
 * charts (they draw on a canvas), and counts. "Seen on a desktop": the stat table's `in-row` cells are hidden (the
 * row's columns show them). "Seen on a phone": the row's value/% /age/APR/moves/fees columns are hidden (styles.css,
 * max-width 860px) and the `in-row` cells show. A closed <details> shows only its summary (a label).
 */
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A rendered page shows a counting number at its end value (the static render would show where the count starts).
vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, AnimatedNumber: ({ value, format }: { value: number | null | undefined; format: (x: number) => string }) => h('span', { className: 'num' }, value == null ? '—' : format(value)), useCount: (v: number | null) => v };
});
// The value-over-time chart draws on a canvas: here it writes its series label and last value as text, so a test can
// tell whether it rendered at all (Kyle, #73: a price-driven value only inside a collapsed Details).
vi.mock('../src/ui/Chart', async (orig) => {
  const m = await orig<typeof import('../src/ui/Chart')>();
  return {
    ...m,
    EquityChart: ({ series, drawdown = true }: { series: { name: string; data: [number, number][] }[]; drawdown?: boolean }) =>
      h('div', { className: 'eq-chart' }, series.map((x) => `${x.name} ${x.data[x.data.length - 1]?.[1] ?? ''}`).join(' '), drawdown ? ' drawdown' : ''),
  };
});
import { gridMetrics, lpMetrics, trendMetrics } from '../src/metrics/botMetrics';
import { BotRow } from '../src/ui/botRow';
import { DeskTable } from '../src/ui/DeskTable';
import { deskItems, sortItems } from '../src/ui/deskTableModel';
import { pctShown, qty, qtyFixed, sameShown, usd as fmtUsd } from '../src/ui/fmt';
import { walletModel } from '../src/ui/walletModel';
import { readFileSync } from 'node:fs';
import { Bots } from '../src/ui/Bots';
import { GridDetail } from '../src/ui/GridDetail';
import { HIDE_WORTH_ON } from '../src/ui/Header';
import { Holdings } from '../src/ui/Holdings';
import { Desk } from '../src/ui/Desk';
import { LpDetail } from '../src/ui/LpDetail';
import { ShowUsdCtx } from '../src/ui/money';
import { StatTable } from '../src/ui/StatTable';
import { TrendDetail } from '../src/ui/TrendDetail';
import { ValueOverTime } from '../src/ui/ValueOverTime';
import { HOLDINGS as REAL_HOLDINGS, S as REAL } from './helpers/unitsScreens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const NOW = Date.UTC(2026, 9, 27, 23, 45);
const H = 3_600_000, D = 24 * H;
const PEGGED: string[] = []; // crypto units only: each coin is its own unit
// any coin symbol (BUN, HEX, pDAI…), not only the sample's: a capitalised word after a number, but not a clock's AM/PM
const SYM = '(?!(?:AM|PM)\\b)([a-z]?[A-Z][A-Z0-9]{1,10})';

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
  equityHist: [[stonkdStart, 34_000], [NOW, 33_121.6]], equity: [], value: 33_121.6,
};
const nvdaStart = NOW - 3.2 * D;
const nvdaLp = {
  ...stonkd, id: 'lp-nvda', label: 'NVDA LP', market: 'robinhood:NVDA/USDG', base: 'NVDA', price: 217.97, startedAt: nvdaStart, startValue: 5_000,
  config: { capital: 5_000, bandPct: 0.1, rerange: true },
  pnl: { feeCoins: { base: 1.1, quote: 216.3 }, fees: 455.9, gas: 0.6, swapCost: 1.43, moveLoss: 41.87, net: 412, price: 3.1 },
  totals: { gas: 0.6, swapCost: 1.43, sent: 0 }, owed: { base: 0.21, quote: 37.6 }, coins: { base: 10.93, quote: 2_612.77 }, poolShare: 0.0117,
  timeInRange: 0.88, reranges: 2, lastRerangeAt: NOW - 19 * H, position: { id: 'paper-2', lower: 196.2, upper: 240.12, openedAt: NOW - 19 * H },
  positionFees: { since: NOW - 19 * H, coins: { base: 0.41, quote: 88.2 } }, equityHist: [[nvdaStart, 5_000], [NOW, 5_415.1]], value: 5_415.1,
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
/** The same bots with the server's metrics (botMetrics at NOW), as /api/status sends them. */
const withM = (b: Obj): Obj => ({ ...b, metrics: b.kind === 'lp' ? lpMetrics(b as never, NOW) : b.kind === 'grid' ? gridMetrics(b as never, NOW) : trendMetrics(b as never, NOW) });
const s: Obj = { ...s0, grids: [withM(grid)], trends: [withM(trend)], lps: [withM(stonkd), withM(nvdaLp)] };
const bots: Obj[] = [{ ...s.grids[0], kind: 'grid' }, { ...s.trends[0], kind: 'trend' }, s.lps[0], s.lps[1]];

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'path', 'circle', 'rect', 'line', 'polyline', 'stop']);
const ALWAYS_HIDDEN = (tag: string, cls: string[]) => ['input', 'select', 'option', 'th', 'title', 'textarea'].includes(tag)
  || cls.some((c) => ['btn', 'stat-note', 'bot-title', 'chip-btn', 'chart-wrap', 'eq-chart'].includes(c)) || tag === 'h2' || tag === 'summary';
const PHONE_HIDDEN = ['desk-spark', 'desk-val', 'desk-pct', 'desk-age', 'desk-apr', 'desk-moves', 'desk-fees', 'desk-status'];
type View = 'desktop' | 'phone';

/** Visible text: a tag is a word break; a hidden element and everything in it is dropped. */
export function visibleText(html: string, view: View, rowClass?: string): string {
  const rows: boolean[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let out = '', skip = 0; const stack: boolean[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] != null) { if (!skip) out += m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'"); continue; }
    const [, close, tag0, attrs, self] = m; const tag = tag0.toLowerCase();
    if (close && VOID.has(tag)) { out += ' '; continue; } // an svg <rect></rect>: opened as void, so its close is no element
    if (close) { const hid = stack.pop(); if (hid) skip--; out += rows.pop() ? ' ⟦/ROW⟧ ' : ' '; continue; }
    const cls = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/);
    const shut = tag === 'details' && !/\sopen(?:[\s=>]|$)/.test(attrs); // a closed <details>: only its summary shows
    const hidden = ALWAYS_HIDDEN(tag, cls) || shut || (view === 'desktop' && cls.includes('in-row')) || (view === 'phone' && cls.some((c) => PHONE_HIDDEN.includes(c)));
    if (self || VOID.has(tag)) { out += ' '; continue; }
    const isRow = !!rowClass && cls.includes(rowClass) && !skip && !hidden;
    rows.push(isRow); stack.push(hidden); if (hidden) skip++; out += isRow ? ' ⟦ROW⟧ ' : ' ';
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
  rest = rest.replace(new RegExp(`([+\\-−]?)${N}\\s${SYM}(?![/\\w-])`, 'g'), (t, sg, n, sym) => {
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

/**
 * A list screen (Bots, Home): each bot row is checked on its own and against everything outside the rows (headlines,
 * group headers), so a total that repeats a row fails. Two different bots that happen to share an amount (both put in
 * 1 ETH) are two figures, not one repeated.
 */
export function listRepeats(html: string, view: View, rowClass = 'bot-block'): string[] {
  const text = visibleText(html, view, rowClass);
  const outside: string[] = [], rowsTxt: string[] = [];
  let depth = 0, cur = '';
  for (const part of text.split(/(⟦\/?ROW⟧)/)) {
    if (part === '⟦ROW⟧') { if (depth++ === 0) { outside.push(cur); cur = ''; } continue; }
    if (part === '⟦/ROW⟧') { if (--depth === 0) { rowsTxt.push(cur); cur = ''; } continue; }
    cur += part;
  }
  outside.push(cur);
  const out = figures(outside.join(' '));
  const dup = new Set(repeats(out));
  for (const r of rowsTxt) for (const d of repeats([...out, ...figures(r)])) dup.add(d);
  return [...dup];
}

const wrap = (el: ReactElement) => h(ShowUsdCtx.Provider, { value: { on: false, set: () => undefined } }, el);
const render = (el: ReactElement) => renderToStaticMarkup(wrap(el));
const noop = () => undefined;
/** The same page with every collapsed Details opened. */
const opened = (html: string) => html.replace(/<details(?![^>]*\sopen)/g, '<details open=""');
const desk = (sx: Obj = s, bs: Obj[] = bots) => render(h(DeskTable, { s: sx, bots: bs, nav: noop, pause: noop, close: noop }));
const row = (b: Obj, sx: Obj = s) => render(h(BotRow, { s: sx, b, nav: noop, pause: noop, close: noop, columns: true, metrics: true, expandable: true, open: true, onToggle: noop }));
const pageProps = (sx: Obj, id: string) => ({ s: sx, id, events: [], ticks: null, nav: noop, act: noop, busy: false });
const lpPage = (id: string, sx: Obj = s) => render(h(LpDetail, pageProps(sx, id)));
const gridPage = (id = grid.id, sx: Obj = s) => render(h(GridDetail, pageProps(sx, id)));
const trendPage = (id = trend.id, sx: Obj = s) => render(h(TrendDetail, pageProps(sx, id)));
/**
 * The home: each card is a row. Next payday is set aside: Kyle chose it beside Money flow (2026-10-30), and it lists the
 * same open trades by how close they are to paying, so those figures appear in both by design.
 */
const deskHtml = (sx: Obj = s, holdings: Obj | null = null) => render(h(Desk, { s: sx, nav: noop, act: noop, busy: false, holdings: holdings as never, events: [] }));
const withoutPayday = (html: string) => html.replace(/<section class="dk-card"><h3>Next payday[\s\S]*?<\/section>/, '');
export const deskRepeats = (html: string, view: View) => listRepeats(withoutPayday(html), view, 'dk-cardi');
const home = () => deskHtml();

beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

describe('figure finder (self-check)', () => {
  it('reads the same figure twice and tells different ones apart', () => {
    expect(repeats(figures('−0.004326 ETH then −0.0043261 ETH'))).toHaveLength(1);
    expect(repeats(figures('−2.5% and −2.55%'))).toHaveLength(1);
    expect(repeats(figures('8.8h and 9h ago'))).toHaveLength(1);
    expect(repeats(figures('−866 USDG and +866 USDG, 732.2 – 810.0 USDG/SPY, 0 ETH, 0%'))).toHaveLength(0);
    expect(repeats(figures('21.3 SPY and 21.3 USDG'))).toHaveLength(0);
    expect(repeats(figures('19,099.79 BUN and 19,100 BUN; 03:23 PM and 04:23 PM'))).toHaveLength(1); // any coin, not clocks
  });
  it('a list: a total that repeats a row fails; two rows that share an amount do not', () => {
    const rowOf = (x: string) => `<div class="bot-block"><span>${x}</span></div>`;
    expect(listRepeats(`<div>${rowOf('1.0000 ETH invested +0.5 ETH')}${rowOf('1.0000 ETH invested +0.7 ETH')}</div>`, 'desktop')).toEqual([]);
    expect(listRepeats(`<div><b>+0.5 ETH</b>${rowOf('1.0000 ETH +0.5 ETH')}${rowOf('2 ETH +0.7 ETH')}</div>`, 'desktop')).toHaveLength(1);
    expect(listRepeats(`<div>${rowOf('+0.5 ETH and +0.50 ETH')}</div>`, 'desktop')).toHaveLength(1);
  });
  it('a page that repeats a figure fails; a closed Details hides its figures until opened', () => {
    const html = '<div><b>−866 USDG</b><details><summary>Details</summary><table><tr><th>Net 8.8h</th><td>−866.00 USDG</td></tr></table></details></div>';
    expect(repeats(figures(visibleText(html, 'desktop')))).toHaveLength(0);
    expect(repeats(figures(visibleText(opened(html), 'desktop')))).toHaveLength(1);
  });
});

describe('each figure once per screen (Kyle, no exemptions)', () => {
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`Bots list, collapsed (${view})`, () => { expect(listRepeats(desk(), view)).toEqual([]); });
    for (const b of bots) {
      it(`Bots list, ${b.id} opened (${view})`, () => {
        const html = row(b);
        expect(html).toMatch(/<th>Chain<\/th>/); // it really is open
        const text = visibleText(html, view);
        expect(repeats(figures(text))).toEqual([]);
      });
    }
    it(`Home (${view})`, () => {
      const html = home();
      expect(html).toContain('Next payday'); // the panel set aside is really there
      expect(deskRepeats(html, view)).toEqual([]);
    });
    it(`Grid page, a run under a day, Details closed and opened (${view})`, () => {
      expect(repeats(figures(visibleText(gridPage(), view)))).toEqual([]);
      expect(repeats(figures(visibleText(opened(gridPage()), view)))).toEqual([]);
    });
    it(`Trend page, Details closed and opened (${view})`, () => {
      expect(repeats(figures(visibleText(trendPage(), view)))).toEqual([]);
      expect(repeats(figures(visibleText(opened(trendPage()), view)))).toEqual([]);
    });
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      it(`LP page ${id}, Details closed and opened (${view})`, () => {
        expect(repeats(figures(visibleText(lpPage(id), view))), 'closed').toEqual([]);
        expect(repeats(figures(visibleText(opened(lpPage(id)), view))), 'opened').toEqual([]);
      });
    }
  }
});

describe('LP pace card: Est. a day / 7 days / 365 days from botMetrics, hidden under a day (Kyle, #73; #86 windows)', () => {
  it('no "So far" line (Generated is the headline): only the Est. rows', () => {
    for (const id of ['lp-stonkd', 'lp-nvda']) expect(opened(lpPage(id)), id).not.toMatch(/So far|pace-so-far/);
  });
  it('8.8h: no pace card at all (botMetrics has no day estimate under a day)', () => {
    expect(s.lps[0].metrics.generatedRate.d1).toBeNull();
    expect(lpPage('lp-stonkd')).not.toMatch(/data-testid="generated-pace"|Est\. a day/);
  });
  it('3.2d: Generated ÷ 3.2 days × 1, 7, 365 per coin, exactly the server\'s generatedRate (1.1 NVDA and 214.27 USDG)', () => {
    const r = s.lps[1].metrics.generatedRate;
    expect(r.d1.NVDA).toBeCloseTo(1.1 / 3.2, 9);
    expect(r.d7.USDG).toBeCloseTo((214.27 / 3.2) * 7, 6);
    expect(r.d365.NVDA).toBeCloseTo((1.1 / 3.2) * 365, 6);
    const text = visibleText(lpPage('lp-nvda'), 'desktop');
    expect(text).toMatch(/Est\. a day \+0\.344 NVDA · \+66\.96 USDG Est\. 7 days \+2\.41 NVDA · \+468\.72 USDG Est\. 365 days \+125\.47 NVDA · \+24,440 USDG/);
  });
  it('no Est. 30d anywhere (Kyle: day, 7d, 365d) and no Est. table rows on the LP page (the pace card is their one place)', () => {
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      const html = opened(lpPage(id));
      expect(html, id).not.toMatch(/<th>Est\. (24h|7d|30d|365d)<\/th>|A month/);
      expect(visibleText(html, 'desktop'), id).not.toMatch(/30d|30 days/);
    }
    for (const b of bots) expect(render(h(StatTable, { b, s })), b.id).not.toMatch(/<th>Est\. 30d<\/th>/);
  });
});

describe('a percent that rounds to 0.0% reads "—" (display only; sort and APR keep the exact value)', () => {
  it('pctShown', () => {
    // two decimals: a small move is a number, and only what still rounds to 0.00% is a dash
    expect(pctShown(0.00004, 2, true)).toBe('—');
    expect(pctShown(-0.0004, 2, true)).toBe('−0.04%');
    expect(pctShown(0.0005, 2, true)).toBe('+0.05%');
    expect(pctShown(-0.00004)).toBe('—');
    expect(pctShown(0.1234, undefined, true)).toBe('+12.34%');
    // a zero amount carries no sign: "0 DAI", never "+0 DAI"
    expect(qty(0, 'DAI')).toBe('0 DAI');
    expect(qty(1.5, 'DAI')).toBe('+1.5 DAI');
    expect(qty(-1.5, 'DAI')).toBe('−1.5 DAI');
    expect(qtyFixed(0, 'DAI', 5, true)).toBe('0.0000 DAI');
  });
  it('sameShown: the precision shown, and a printed zero is never the same as a figure', () => {
    expect(sameShown('+26.415 USDC', '26.4153 USDC')).toBe(true);
    expect(sameShown('+26.415 USDC', '26.42 USDC')).toBe(true);
    expect(sameShown('+26.415 USDC', '27 USDC')).toBe(false);
    // the LP page said "ETH: all of Generated" for a waiting fee of 0.00005 ETH printed as "0 ETH"
    expect(sameShown('+0.00005 ETH', '0 ETH')).toBe(false);
    expect(sameShown('0 ETH', '+0.00005 ETH')).toBe(false);
    expect(pctShown(null)).toBe('—');
  });
  it('the Bots row and the Details: "—" for a tiny % (desktop and phone), and the sort still orders by the exact value', () => {
    const tiny = (id: string, p: number): Obj => ({ ...s.trends[0], id, name: id, metrics: { ...s.trends[0].metrics, totalPnlPct: p } });
    const a = tiny('t-a', 0.00004), b = tiny('t-b', -0.00003);
    const sx = { ...s, trends: [a, b], grids: [], lps: [] };
    const html = desk(sx, [{ ...a, kind: 'trend' }, { ...b, kind: 'trend' }]);
    expect(html.match(/<span class="desk-pct"><span class="[^"]*">—<\/span><\/span>/g)).toHaveLength(2);
    for (const view of ['desktop', 'phone'] as View[]) expect(visibleText(html, view)).not.toMatch(/(?<![±\d.])[+\-−]?0\.0+%/);
    const items = deskItems([{ ...a, kind: 'trend' }, { ...b, kind: 'trend' }], () => 'HOOD', NOW);
    expect(sortItems(items, 'pnlPct', 'desc').map((x) => x.b.id)).toEqual(['t-a', 't-b']);
    expect(sortItems(items, 'pnlPct', 'asc').map((x) => x.b.id)).toEqual(['t-b', 't-a']);
    expect(opened(trendPage('t-a', sx))).not.toMatch(/0\.00% of capital in/);
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
  it('Bots list, collapsed and each bot open; Home; grid, trend and LP pages closed and opened', () => {
    expect(hits(desk())).toEqual([]);
    for (const b of bots) expect(hits(row(b)), b.id).toEqual([]);
    // the home shows dollars beside its coins by Kyle's choice (2026-10-30; checked in noDollars.test.ts): no labels here
    expect(hits(home()).filter((x) => /\bRealized\b|\bUnrealized\b/i.test(x))).toEqual([]);
    for (const html of [gridPage(), trendPage(), lpPage('lp-stonkd'), lpPage('lp-nvda')]) {
      expect(hits(html)).toEqual([]);
      expect(hits(opened(html))).toEqual([]);
    }
  });
  it('the check itself catches a dollar sign and both labels', () => {
    expect(hits('<td>≈ $12.00</td>')).toHaveLength(1);
    expect(hits('<th>Realized</th>')).toHaveLength(1);
    expect(hits('<span title="Unrealized change">x</span>')).toHaveLength(1);
    expect(hits('<td>34,000 USDG</td>')).toHaveLength(0);
  });
});

/**
 * The grid's cash-out sale at stop/close (lead's call on #73 vs botMetrics): it stays out of Generated (botMetrics
 * reads stats.generated), and its value change shows as a row inside the collapsed Details, from the server's
 * stats.closeOutNet (src/live/ledger.ts roundTripStats). The real stopped grid g-mvpcx5sw-btln: one cash-out sale of
 * −0.004326115 ETH, nothing generated.
 */
describe('grid stop sale: out of Generated, a value-change row in the collapsed Details (g-mvpcx5sw-btln)', () => {
  const g = REAL.grids.find((x: Obj) => x.id === 'g-mvpcx5sw-btln');
  const page = () => gridPage(g.id, REAL);
  it('the fixture: one cash-out sale, closeOutNet −0.004326 ETH, stats.generated 0, botMetrics Generated 0 ETH', () => {
    expect(g.stats.closeOuts).toBe(1);
    expect(g.stats.closeOutNet).toBeCloseTo(-0.004326115153832513, 15);
    expect(g.stats.generated).toBe(0);
    expect(g.metrics.generated).toEqual({ ETH: 0 });
  });
  it('Generated shows 0 ETH; the stop sale is not in it', () => {
    const text = visibleText(page(), 'desktop');
    expect(text).toMatch(/Generated, in ETH i \+?0 ETH/);
  });
  it('Details opened: the −0.004326 ETH row, in plain words, crypto units only', () => {
    const html = opened(page());
    const m = /<tr title="[^"]*"><th>([^<]*Value change from the stop sale[^<]*)<\/th><td class="mono">([^<]*)<\/td><\/tr>/.exec(html);
    expect(m, 'the stop-sale row').not.toBeNull();
    expect(m![2]).toMatch(/^−0\.0043261 ETH/);
    expect(m![1]).not.toMatch(/Realized|Unrealized/i);
    expect(m![2]).not.toMatch(/\$|USD\b/);
    for (const view of ['desktop', 'phone'] as View[]) expect(visibleText(html, view).match(/−0\.0043261 ETH/g)).toHaveLength(1);
  });
  it('Details closed (the default): the row and its figure are hidden, and the fills table names the sale instead of repeating it', () => {
    const html = page();
    expect(html).toMatch(/<details class="more money-details" data-testid="money-details">/);
    for (const view of ['desktop', 'phone'] as View[]) {
      const text = visibleText(html, view);
      expect(text).not.toMatch(/stop sale|0\.004326/);
      expect(text).toMatch(/Sold at stop \(see Details\)/);
    }
    // opened, the figure still shows once
    expect(visibleText(opened(html), 'desktop').match(/0\.004326/g)).toHaveLength(1);
  });
  it('a grid without a cash-out sale has no such row', () => {
    expect(opened(gridPage())).not.toMatch(/stop sale|Sold at stop/);
  });
});

describe('live LP fixture: Generated straight from botMetrics (lp-mvnm73sx-hghe at 2.4927 d)', () => {
  const lp = REAL.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
  it('Generated = 63.2396 USDC + 0.0242035 ETH (fees − gas − swap fees), age 2.4927 d', () => {
    expect(lp.metrics.generated.USDC).toBeCloseTo(63.2396, 4);
    expect(lp.metrics.generated.ETH).toBeCloseTo(0.02420354, 8);
    expect(lp.metrics.ageSec / 86_400).toBeCloseTo(2.4927, 4);
  });
  it('the page headline shows it, and the pace card reads the same server rates', () => {
    const text = visibleText(lpPage(lp.id, REAL), 'desktop');
    expect(text).toMatch(/Generated i \+63\.24 USDC \+0\.024204 ETH/);
    expect(text).toMatch(/Est\. a day \+25\.37 USDC · \+0\.00971 ETH/);
    expect(text).toMatch(/Est\. 365 days \+9,260 USDC · \+3\.54 ETH/);
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
  chains: [{ chainId: 4663, name: 'Robinhood Chain', short: 'HOOD', color: '#ccff00', address: null, usd: 61_000, walletUsd: 40_000, freeUsd: 38_000, botsUsd: 2_000, lpUsd: 21_000, feesUsd: 34.5 }],
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

describe('Holdings (the Wallet page): dollars first with each coin under them (Kyle, 2026-10-30), each figure once', () => {
  it('shows each coin in its own units under its dollars, stablecoins as "34,000 USDG"', () => {
    const text = visibleText(holdingsPage(), 'desktop');
    for (const want of ['34,000 USDG', '2.5 ETH', '0.75 SPY', '1,234,570 PLS', '21.3 SPY · 16,950.2 USDG', '0.0102 SPY · 4.31 USDG']) expect(text).toContain(want);
  });
  it('the headline is the server\'s dust-free total (what the value history records); every row with a price shows its dollars', () => {
    const html = holdingsPage();
    expect(/class="wl-big">([^<]*)</.exec(html)![1]).toBe(fmtUsd(holdingsSnap.netWorthExDustUsd));
    const m = walletModel(holdingsSnap as never, 'all', false);
    for (const r of [...m.assets, ...m.pools, ...m.fees]) if (r.usd != null) expect(html).toContain(`<b>${fmtUsd(r.usd)}</b>`);
    expect(walletModel(holdingsSnap as never, 4663, false).total).toBe(61_000);
  });
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`each figure once (${view}), folds opened`, () => {
      expect(repeats(figures(visibleText(holdingsPage(), view)))).toEqual([]);
    });
  }
  it("the header's net-worth button is hidden on Holdings", () => {
    expect(HIDE_WORTH_ON.has('holdings')).toBe(true);
  });
  it('paper mode (no wallet): no figures, and it says why', () => {
    const paper = { ...holdingsSnap, hasSigner: false, address: null, wallet: [], positions: [], fees: [], bots: [], chains: [] };
    expect(hits(holdingsPage(paper))).toEqual([]);
    expect(visibleText(holdingsPage(paper), 'desktop')).toMatch(/No wallet key on this server/);
  });
});

describe('Value over time is collapsed and closed by default; the chart is drawn only when opened (Kyle, #73)', () => {
  const closedSection = /<details class="card net-details value-details"><summary>Details: value over time/;
  const pages: [string, () => string][] = [
    ['LP page lp-stonkd', () => lpPage('lp-stonkd')], ['LP page lp-nvda', () => lpPage('lp-nvda')],
    ['Grid page', () => gridPage()], ['Trend page', () => trendPage()],
  ];
  for (const [name, page] of pages) {
    it(`${name}: the section is there, closed, and the chart and its values are not rendered`, () => {
      const html = page();
      expect(html).toMatch(closedSection);
      expect(html).not.toMatch(/class="eq-chart"|empty-eq/);
      expect(html).not.toMatch(/value USDG|drawdown/);
      for (const view of ['desktop', 'phone'] as View[]) expect(visibleText(html, view)).not.toMatch(/5,415\.1|33,121\.6|2,000\.0748|1,057\.3/);
    });
  }
  it('opened, it renders the chart from the same data; closed, only its summary', () => {
    const html = renderToStaticMarkup(h(ValueOverTime, { q: 'USDG', note: 'after gas', data: nvdaLp.equityHist as [number, number][], initialOpen: true }));
    expect(html).toMatch(/<details class="card net-details value-details" open="">/);
    expect(html).toMatch(/<div class="eq-chart">value USDG 5415\.1 drawdown<\/div>/);
    const shut = renderToStaticMarkup(h(ValueOverTime, { q: 'USDG', data: nvdaLp.equityHist as [number, number][] }));
    expect(shut).not.toMatch(/eq-chart|value USDG|drawdown/);
    expect(shut).toMatch(/Details: value over time/);
  });
});

// ---------------------------------------------------------------- the lead's #88 fix list, one test per fix
const textOf = (html: string, view: View = 'desktop') => visibleText(html, view);

describe('#88 fixes: LP page', () => {
  it('an Invested tile first, then Generated, in coin units (the deposit is not repeated in Details)', () => {
    for (const id of ['lp-stonkd', 'lp-nvda']) {
      const html = opened(lpPage(id));
      const lp = s.lps.find((x: Obj) => x.id === id);
      expect(html, id).toMatch(/data-testid="invested"/);
      const strip = textOf(html).split('Generated')[0];
      expect(strip, id).toMatch(new RegExp(`Invested (i )?${qtyFixed(lp.metrics.quote.capitalIn, 'USDG', 5).replace(/[.+]/g, '\\$&')} put in at the start`));
      expect(textOf(html), id).not.toMatch(/\$|USD(?!G|C)/);
      expect(textOf(html).match(new RegExp(qtyFixed(lp.metrics.quote.capitalIn, 'USDG', 5).replace(/[.+]/g, '\\$&'), 'g')), id).toHaveLength(1);
    }
    expect(qtyFixed(3.5, 'ETH')).toBe('3.5000 ETH');
    expect(qtyFixed(34_000, 'USDG')).toBe('34,000 USDG');
    expect(qtyFixed(1, 'ETH')).toBe('1.0000 ETH');
  });
  it('the age shows once: a position opened at the start says so instead of a second age', () => {
    const text = textOf(opened(lpPage('lp-stonkd')));
    expect(text).toContain('Opened when the bot started');
    expect(text).not.toMatch(/Opened \d/);
    expect(textOf(opened(lpPage('lp-nvda')))).toMatch(/Opened 19h ago/); // a re-ranged position keeps its own age
  });
  it('Fees waiting that equal Generated point to it instead of a second figure', () => {
    const lp = withM({ ...stonkd, id: 'lp-w' });
    const sx = { ...s, lps: [{ ...lp, owed: { base: lp.metrics.generated.SPY, quote: 4.31 } }] };
    const text = textOf(opened(lpPage('lp-w', sx)));
    expect(text).toContain('SPY: all of Generated');
    expect(repeats(figures(text))).toEqual([]);
  });
});

describe('#88 fixes: Bots list (desktop and phone)', () => {
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`group total = sum of the rows as displayed: the group headers carry no figure, so there is no total to disagree (${view})`, () => {
      const html = desk();
      const heads = html.match(/<button type="button" class="desk-group"[\s\S]*?<\/button>/g) ?? [];
      expect(heads.length).toBeGreaterThan(0);
      for (const g of heads) expect(figures(visibleText(g, view)), g).toEqual([]);
    });
    it(`each row shows Invested (labelled) and Generated, and no zero without its unit (${view})`, () => {
      const html = desk();
      for (const b of bots) {
        const inv = qtyFixed(b.metrics.quote.capitalIn, b.metrics.quote.symbol, 5);
        expect(html, b.id).toContain(`${inv}<small class="inv-label"> invested</small>`);
      }
      expect(html.match(/class="desk-gen"/g)).toHaveLength(bots.length);
      const zero = withM({ ...grid, id: 'g-zero', pnl: { realized: 0, unrealized: 0, fees: 0, gas: 0 } });
      const t = visibleText(row({ ...zero, kind: 'grid' }), view);
      expect(t).not.toMatch(/(?:^|\s)0(?=\s|$)(?! [A-Za-z])/); // a count reads "0 fills"; a coin amount needs its coin
    });
  }
  it('the column header names Invested', () => {
    expect(desk()).toMatch(/<span class="num">Invested<\/span>/);
  });
});

describe('#88 fixes: grid page', () => {
  const lv = (n: number) => ({ index: n, lower: 2_100 + n * 50, upper: 2_150 + n * 50, status: 'waitingBuy', buyAmount: 200, plsAmount: 0 });
  const g2 = { ...grid, id: 'g-lv', intervals: [lv(0), lv(1), lv(2)] };
  it('an amount every waiting level buys is stated once above the levels', () => {
    const html = gridPage('g-lv', { ...s, grids: [withM(g2)] });
    expect(html).toMatch(/data-testid="levels-same">Each level waiting to buy buys 200 USDG</);
    expect(textOf(html).match(/200 USDG/g)).toHaveLength(1);
    expect(html.match(/buys \(above\)/g)).toHaveLength(3);
  });
  it('the amount hint does not echo the deposit in the box', () => {
    expect(textOf(gridPage())).not.toMatch(/\d \w+ of your wallet/);
  });
  it('APR on a stopped grid: "—", not 0.0%', () => {
    const stopped = withM({ ...grid, id: 'g-stop', status: 'stopped', startedAt: NOW - 3 * D });
    stopped.metrics = { ...stopped.metrics, aprPct: 0 };
    const sx = { ...s, grids: [stopped] };
    expect(render(h(StatTable, { b: { ...stopped, kind: 'grid' }, s: sx }))).toMatch(/<th>[^<]*APR[^<]*<\/th><td[^>]*>—</);
    expect(row({ ...stopped, kind: 'grid' }, sx)).toMatch(/<span class="desk-apr"[^>]*>—<\/span>/);
  });
});

describe('#88 fixes: the home with one live bot shows its figures once', () => {
  it('the headline is that bot\'s total; its cards show its open trades, not the total again', () => {
    const live = { ...s.lps[1], mode: 'live' };
    const sx = { ...s, lps: [s.lps[0], live] };
    const html = deskHtml(sx);
    for (const view of ['desktop', 'phone'] as View[]) expect(deskRepeats(html, view)).toEqual([]);
  });
});

describe('#88 fixes: phone Details value column wraps instead of clipping at the right edge', () => {
  it('styles.css: inside the phone media query the Details table is fixed-layout and its cells wrap', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const phone = css.split(/@media \(max-width: ?860px\)/).slice(1).join('\n');
    expect(phone).toMatch(/\.money-details \.stat-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(phone).toMatch(/\.money-details \.stat-table (td|th)[^{]*\{[^}]*(overflow-wrap:\s*anywhere|word-break)/);
  });
});

describe('each figure once on the real paper fixture too (every bot, every page, desktop and phone)', () => {
  const rows = [...REAL.grids.map((g: Obj) => ({ ...g, kind: 'grid' })), ...REAL.trends.map((t: Obj) => ({ ...t, kind: 'trend' })), ...REAL.lps.map((l: Obj) => ({ ...l, kind: 'lp' }))];
  for (const view of ['desktop', 'phone'] as View[]) {
    it(`Home and the Bots list (${view})`, () => {
      expect(deskRepeats(deskHtml(REAL, REAL_HOLDINGS), view), 'home').toEqual([]);
      expect(listRepeats(render(h(Bots, { s: REAL, nav: noop, busy: false, onStopAll: noop } as never)), view), 'bots').toEqual([]);
    });
    for (const b of rows) {
      it(`${b.id}: its row opened, and its page with Details closed and opened (${view})`, () => {
        expect(repeats(figures(visibleText(row(b, REAL), view))), 'row').toEqual([]);
        const page = (b.kind === 'lp' ? lpPage : b.kind === 'grid' ? gridPage : trendPage)(b.id, REAL);
        expect(repeats(figures(visibleText(page, view))), 'closed').toEqual([]);
        expect(repeats(figures(visibleText(opened(page), view))), 'opened').toEqual([]);
      });
    }
  }
});
