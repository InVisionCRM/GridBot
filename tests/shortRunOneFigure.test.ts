/**
 * PR #72 review (pr-72.md) MEDs 1-3, after main's server metrics (#48 onward): under a day, no figure is shown twice
 * on one screen, and the APR sort follows the APR cell.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotRow } from '../src/ui/botRow';
import { LpDetail } from '../src/ui/LpDetail';
import { StatTable } from '../src/ui/StatTable';
import { ShowUsdCtx } from '../src/ui/money';
import { sortItems, type DeskItem } from '../src/ui/deskTableModel';
import { botFacts } from '../src/ui/deskStats';
import { gridMetrics, lpMetrics } from '../src/metrics/botMetrics';
import { aprShown, DAY_MS } from '../src/ui/runRate';
import { S } from './helpers/unitsScreens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const H = 3_600_000;
const noop = () => undefined;
const render = (el: ReactElement) => renderToStaticMarkup(createElement(ShowUsdCtx.Provider, { value: { on: false, set: noop } }, el));
const text = (h: string) => h.replace(/<[^>]+>/g, '');
/** The inner markup of a desk cell, up to the next desk cell. */
const cell = (html: string, c: string) => { const i = html.indexOf(`class="${c}"`); if (i < 0) return ''; const j = html.indexOf('<span class="desk-', i + 1); return html.slice(html.indexOf('>', i) + 1, j < 0 ? undefined : j); };

/** A real sanitized grid from the status payload (tests/helpers/unitsScreens.ts), with its run length set. */
const GRID: Obj = S.grids.find((g: Obj) => g.id === 'g-mvpdl7h8-px5w');
const grid = (id: string, ageMs: number): Obj => {
  const now = Date.now();
  const b: Obj = { ...GRID, id, label: id, startedAt: now - ageMs };
  b.metrics = gridMetrics(b, now);
  return b;
};
const row = (b: Obj) => render(createElement(BotRow, { s: { chains: [] }, b, nav: noop, pause: noop, close: noop, columns: true, metrics: true } as never));

describe('aprShown', () => {
  it('no APR under a day, the yearly figure from a day on', () => {
    expect(aprShown(8.8 * H, 0.5)).toBeNull();
    expect(aprShown(DAY_MS - 1, 0.5)).toBeNull();
    expect(aprShown(null, 0.5)).toBeNull();
    expect(aprShown(DAY_MS, 0.5)).toBe(0.5);
    expect(aprShown(3 * DAY_MS, null)).toBeNull();
  });
});

describe('MED 1: the Bots row APR cell does not repeat the % column', () => {
  it('a run under a day shows a dash only in the APR cell, with the % in its own column', () => {
    const html = row(grid('short', 8.8 * H));
    const pctCell = text(cell(html, 'desk-pct'));
    expect(pctCell).toMatch(/\d\.\d\d%/); // two decimals (Kyle)
    expect(text(cell(html, 'desk-apr'))).toBe('—');
  });
  it('a stale yearly figure on a run under a day still is not shown', () => {
    const b = grid('short-stale', 8.8 * H);
    b.metrics = { ...b.metrics, aprPct: 12.34 };
    expect(text(cell(row(b), 'desk-apr'))).toBe('—');
  });
  it('a run with enough history still shows its APR', () => {
    const html = row(grid('long', 10 * DAY_MS));
    expect(text(cell(html, 'desk-apr'))).toMatch(/%$/);
  });
});

describe('MED 2: the APR sort uses the value the APR cell shows', () => {
  const item = (name: string, ageMs: number, aprPct: number | null): DeskItem => {
    const b = grid(name, ageMs);
    b.metrics = { ...b.metrics, aprPct, est: { ...b.metrics.est, d365: aprPct == null ? null : 1 } };
    return { b, name, chain: 'Robinhood', chainId: null, group: 'Grid', facts: botFacts(b) };
  };
  it('a run under a day (APR cell "—") sorts after every bot with an APR, both ways, even with a stale APR', () => {
    const items = [item('a-short-stale', 2 * H, 99), item('b-long', 10 * DAY_MS, 0.5), item('c-long-small', 10 * DAY_MS, 0.1)];
    for (const it of items) expect(text(cell(row(it.b), 'desk-apr')) === '—').toBe(it.name.includes('short'));
    expect(sortItems(items, 'apr', 'desc').map((i) => i.name)).toEqual(['b-long', 'c-long-small', 'a-short-stale']);
    expect(sortItems(items, 'apr', 'asc').map((i) => i.name)).toEqual(['c-long-small', 'b-long', 'a-short-stale']);
  });
});

describe('MED 3: the LP page does not restate its headline under a day', () => {
  const lp = (ageMs: number) => {
    const now = Date.now();
    const b: Obj = { ...S.lps.find((l: Obj) => l.status === 'running') ?? S.lps[1], startedAt: now - ageMs };
    b.metrics = lpMetrics(b, now);
    return b;
  };
  const page = (b: Obj) => render(createElement(LpDetail, { s: { ...S, lps: [b] }, id: b.id, events: [], ticks: null, nav: noop, act: noop, busy: false } as never));
  const strip = (html: string) => { const i = html.indexOf('data-testid="top-strip"'); return html.slice(i, html.indexOf('data-testid="generated-pace"', i) > 0 ? html.indexOf('data-testid="generated-pace"', i) : undefined); };
  /** The Pace card's text only. */
  const pace = (html: string) => { const t = text(html.slice(html.indexOf('data-testid="generated-pace"'))); return t.slice(0, t.indexOf('not a forecast')); };
  it('under a day: Generated shows once in the top strip, with no "net over the run" sub-line, and no pace scaled up', () => {
    const b = lp(8.8 * H);
    const html = page(b);
    const top = text(strip(html));
    expect(top).not.toMatch(/Earned after costs/);
    expect(top).not.toMatch(/over 8\.8h/);
    expect(top).not.toMatch(/of what you put in/);
    // each coin of Generated is printed once in the strip's Generated tile
    const tile = text(top.slice(top.indexOf('Generated'), top.indexOf('Liquidity provided'))); // the Generated tile (Invested sits before it)
    for (const [sym, u] of Object.entries(b.metrics.generated as Record<string, number>)) {
      expect(tile.split(` ${sym}`).length - 1, `${u} ${sym}`).toBe(1);
    }
    // Kyle (#73): no pace card at all under a day (botMetrics' day estimate is null then, #86)
    expect(html).not.toMatch(/data-testid="generated-pace"/);
  });
  it('from a day on, the pace rows are back', () => {
    const html = page(lp(2 * DAY_MS));
    expect(pace(html)).not.toMatch(/shows after a day/);
    expect(pace(html)).toMatch(/Est\. a day[−+-]?\d/);
  });
});

describe('kept from #72 through the merge: no Est. rows scaled up from under a day', () => {
  const table = (ageMs: number) => text(render(createElement(StatTable, { b: grid('t', ageMs), s: S })));
  it('under a day the Est. rows are dashes until a day', () => {
    const t = table(8.8 * H);
    for (const k of ['Est. 24h', 'Est. 7d', 'Est. 365d', 'APR']) expect(t).toContain(`${k}— (shows after a day)`); // botMetrics' EST_HINT (#86)
    expect(t).not.toContain('Est. 30d'); // Kyle: day, 7d and 365d only
  });
  it('from a day on the Est. 24h row has a figure', () => {
    expect(table(2 * DAY_MS)).not.toContain('Est. 24h— (shows after a day)');
    expect(table(2 * DAY_MS)).toMatch(/Est\. 24h[−+-]?\d/);
  });
});
