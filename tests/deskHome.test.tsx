/**
 * The home (Desk.tsx): the headline is the live bots' Generated, a dollar figure with the coins under it; paper bots
 * never move it (they have their own Paper view). The board's three tabs, Next payday and the live river are on the one
 * screen; an empty board says what will appear there.
 */
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, useCount: (v: number | null) => v };
});
import { Desk } from '../src/ui/Desk';
import { generatedByMode, listBots, totalGeneratedUsd } from '../src/ui/botRow';
import { usd } from '../src/ui/fmt';
import { gridMetrics, lpMetrics } from '../src/metrics/botMetrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const S: Obj = {
  ...RAW,
  grids: RAW.grids.map((g: Obj) => ({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, g.metrics.asOf) })),
  lps: RAW.lps.map((l: Obj) => ({ ...l, metrics: lpMetrics(l, l.metrics.asOf) })),
};
const noop = () => {};
const page = (s: Obj, events: Obj[] = []) => renderToStaticMarkup(h(Desk, { s, nav: noop, act: noop, busy: false, holdings: null, events: events as never }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const big = (html: string) => /data-testid="dk-big">([^<]*)</.exec(html)![1];

describe('home headline', () => {
  it('is the live bots\' Generated: a dollar figure, with the coins under it', () => {
    const bots = listBots(S, 'all');
    const html = page(S);
    expect(big(html)).toBe(usd(totalGeneratedUsd(bots, 'live'), true));
    const units = text(/data-testid="dk-units">([\s\S]*?)<\/div>/.exec(html)![1]);
    for (const [sym, v] of Object.entries(generatedByMode(bots).live ?? {})) if (v !== 0) expect(units).toContain(sym); else expect(units).not.toContain(` ${sym}`);
    expect(html).toMatch(/role="radio" aria-checked="true" class="on">Live</);
  });
  it('paper bots earning a fortune do not move the live headline', () => {
    const rich = { ...S, grids: S.grids.map((g: Obj) => (g.mode === 'live' ? g : { ...g, metrics: { ...g.metrics, generated: { DAI: 1e9 }, generatedUsd: 1e9 } })) };
    expect(big(page(rich))).toBe(big(page(S)));
  });
  it('with only paper bots the home shows paper, labeled so', () => {
    const paper = { ...S, grids: S.grids.map((g: Obj) => ({ ...g, mode: 'paper' })), lps: S.lps.map((l: Obj) => ({ ...l, mode: 'paper' })) };
    const html = page(paper);
    expect(html).toContain('class="dk-chip">Paper<');
    expect(big(html)).toBe(usd(totalGeneratedUsd(listBots(paper, 'all'), 'paper'), true));
  });
});

describe('home board', () => {
  it('three board tabs, Next payday and the live river on one screen', () => {
    const html = page(S, [{ id: 7, t: Date.now() - 60_000, type: 'filled', level: 'success', msg: 'Grid HEX/PLS: SOLD level 3' }]);
    for (const t of ['Money flow', 'Price ladder', 'Kill funnel']) expect(text(html)).toContain(t);
    expect(text(html)).toContain('Next payday');
    expect(text(html)).toContain('Grid HEX/PLS: SOLD level 3');
    expect(html).toMatch(/class="dk-col-h">.*Open/);
    expect(html).toMatch(/Almost/);
    expect(html).toMatch(/Banked/);
  });
  it('an empty desk says what will show up, and offers to start a bot', () => {
    const html = page({ ...S, grids: [], lps: [], trends: [] });
    expect(text(html)).toContain('Nothing on the board yet');
    expect(text(html)).toContain('New bot');
    expect(text(html)).toContain('Fills, fees and range moves stream in here');
  });
});
