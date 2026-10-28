/**
 * No number appears twice on a screen. Kyle saw "63.24 USDC" twice on the LP page (Generated and Fees earned) and
 * read them as two different results. The bot pages now lead with Generated only; Fees earned, Costs and what's
 * waiting in the position are the breakdown in the collapsed Details; and the stat table, Pace and the position card
 * leave out whatever the page already shows. Checked on every LP and grid in the real (sanitized) status payload, with
 * the "$" switch both off and on, and on every desk row expanded.
 *
 * What counts as a number: anything with a decimal point or a thousands separator ("63.24", "$8,014", "0.68%"),
 * compared without sign, "$" and commas, so "+63.24 USDC" and "$63.24" are the same figure. Zero is not a figure.
 * Out of scope: the chart (its units line names the pool fee), the grid's level ladder (each level's top is the
 * next one's bottom) and the fills table.
 */
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// a server render shows AnimatedNumber's first frame (0); render the real value so the headline is checked too
vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  const { createElement: h } = await import('react');
  return { ...m, AnimatedNumber: ({ value, format }: { value: number | null | undefined; format: (x: number) => string }) => h('span', { className: 'num' }, value == null ? '—' : format(value)) };
});
import { LpDetail } from '../src/ui/LpDetail';
import { GridDetail } from '../src/ui/GridDetail';
import { BotRow } from '../src/ui/botRow';
import { ShowUsdCtx } from '../src/ui/money';
import { gridMetrics, lpMetrics } from '../src/metrics/botMetrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
// the fixture's bots are the real pull; their metrics are recomputed with this checkout's code (same asOf), so new
// fields and wording are what the pages get
const S: Obj = {
  ...RAW,
  grids: RAW.grids.map((g: Obj) => ({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, g.metrics.asOf) })),
  lps: RAW.lps.map((l: Obj) => ({ ...l, metrics: lpMetrics(l, l.metrics.asOf) })),
};
const noop = () => {};

const render = (el: ReactElement, usd: boolean) =>
  renderToStaticMarkup(createElement(ShowUsdCtx.Provider, { value: { on: usd, set: noop } }, el));

/** The outer HTML of the element carrying data-testid=id (balanced on its tag name). */
export function region(html: string, id: string): string {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at < 0) return '';
  const open = html.lastIndexOf('<', at);
  const tag = /^<([a-z]+)/.exec(html.slice(open))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return html.slice(open);
}

/** The figures in some HTML, normalized (no sign, "$" or commas); zero dropped. */
export function figures(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&amp;|&quot;|&lt;|&gt;/g, ' ');
  return (text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g) ?? [])
    .map((t) => t.replace(/,/g, ''))
    .filter((t) => Number(t) !== 0);
}

export function repeats(parts: string[]): string[] {
  const n = new Map<string, number>();
  for (const f of parts.flatMap(figures)) n.set(f, (n.get(f) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([f, c]) => `${f} ×${c}`);
}

const page = { s: S, events: [], ticks: { prices: {} }, nav: noop, act: noop, busy: false };

/** Kyle's rules: crypto units only (no dollars, even with the "$" switch on), no Realized / Unrealized labels. */
export function dollarsOrRealized(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const attrs = [...html.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
  return [text, ...attrs].flatMap((t) => t.match(/\$\s?\d|\bUSD\b|[Dd]ollar|\b[Uu]nrealized\b|\b[Rr]ealized\b/g) ?? []);
}

describe('no number twice on a bot page', () => {
  for (const usd of [false, true]) {
    for (const lp of S.lps as Obj[]) {
      it(`LP ${lp.id} (${lp.status}${usd ? ', $ on' : ''})`, () => {
        const html = render(createElement(LpDetail, { ...page, id: lp.id } as never), usd);
        const parts = ['top-strip', 'money-details', 'generated-pace', 'stat-table', 'position-card'].map((id) => region(html, id));
        expect(parts[0]).toMatch(/>Generated</);
        expect(parts[0]).not.toMatch(/Fees earned|Costs/);
        expect(parts[1]).toMatch(/^<details/);
        expect(repeats(parts)).toEqual([]);
        expect(dollarsOrRealized(parts.join(''))).toEqual([]);
      });
    }
    for (const g of S.grids as Obj[]) {
      it(`grid ${g.id} (${g.status}${usd ? ', $ on' : ''})`, () => {
        const html = render(createElement(GridDetail, { ...page, id: g.id } as never), usd);
        const parts = ['top-strip', 'money-details', 'stat-table', 'range-line'].map((id) => region(html, id));
        expect(parts[0]).toMatch(/>Generated, in /);
        expect(parts[0]).not.toMatch(/>Unrealized</);
        expect(repeats(parts)).toEqual([]);
        expect(dollarsOrRealized(parts.join(''))).toEqual([]);
      });
    }
  }

  it('the desk row, expanded, repeats none of its columns', () => {
    for (const b of [...S.grids.map((g: Obj) => ({ ...g, kind: 'grid' })), ...S.lps.map((l: Obj) => ({ ...l, kind: 'lp' }))]) {
      for (const usd of [false, true]) {
        const html = render(createElement(BotRow, { s: S, b, nav: noop, pause: noop, close: noop, expandable: true, open: true, columns: true, metrics: true }), usd);
        const ladder = region(html, 'levels');
        expect(repeats([ladder ? html.replace(ladder, '') : html]), `${b.id}${usd ? ' $' : ''}`).toEqual([]);
        expect(dollarsOrRealized(html), `${b.id}${usd ? ' $' : ''}`).toEqual([]);
      }
    }
  });

  it('the checker catches the case Kyle saw', () => {
    expect(repeats(['<b>+63.24 USDC</b>', '<span>Fees earned +63.24 USDC</span>'])).toEqual(['63.24 ×2']);
    expect(repeats(['<b>−$0.56</b> $0.00', '<i>$0.00</i> +$0.56'])).toEqual(['0.56 ×2']);
    expect(region('<p><div data-testid="x"><div>a</div>b</div>c</p>', 'x')).toBe('<div data-testid="x"><div>a</div>b</div>');
  });
});
