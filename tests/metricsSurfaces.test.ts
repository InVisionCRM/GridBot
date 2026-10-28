/**
 * Bot pages lead with Generated only; Dollars made / Total P&L / price change sit in a collapsed Details expander; the
 * LP pace comes from BotMetrics (every window needs one day of history); the chart's units line is honest.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lpMetrics, DAY_MS } from '../src/metrics/botMetrics';
import { MoneyDetails } from '../src/ui/MoneyDetails';
import { qty } from '../src/ui/fmt';
import { midFactor, unitsLabel } from '../src/ui/Chart';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const FX = JSON.parse(readFileSync(new URL('./fixtures/real-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const H = 3_600_000;
const src = (f: string) => readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8');
/** The top KPI strip of a page's source. */
const strip = (f: string) => { const s = src(f); const i = s.indexOf('<div className="kpi-row detail-stats"'); return s.slice(i, s.indexOf('\n      </div>\n', i)); };

describe('one headline per bot page', () => {
  for (const page of ['LpDetail.tsx', 'GridDetail.tsx', 'TrendDetail.tsx']) {
    it(`${page}: the strip leads with Generated and has no Dollars made / Total P&L; Details holds them`, () => {
      const top = strip(page);
      expect(top).toMatch(/>Generated/);
      expect(top).not.toMatch(/Dollars made|Total P&amp;L|Price change/);
      expect(src(page)).toMatch(/<MoneyDetails b=\{/);
    });
  }
  it('the token trader page and the desk row also use the Details expander', () => {
    expect(src('TokenTrader.tsx')).toMatch(/<MoneyDetails b=\{t\} \/>/);
    expect(src('botRow.tsx')).toMatch(/<MoneyDetails b=\{b\}/);
    expect(src('StatTable.tsx')).not.toMatch(/'Total P&L'|'Price change'/);
  });
  it('Details is collapsed and shows exactly the metrics', () => {
    const b = { ...FX.lpLive };
    const m = lpMetrics(b, FX.now);
    const html = renderToStaticMarkup(createElement(MoneyDetails, { b: { ...b, metrics: m } }));
    expect(html).toMatch(/^<details class="more money-details"/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    for (const label of ['Made at event prices', 'Total P&amp;L', 'Price change', 'Open positions', 'Value vs deposit']) expect(html).toContain(label);
    // crypto units only: the quote-coin figures, no dollars, no Realized / Unrealized labels
    const units = (v: number) => qty(v, m.quote.symbol!, 5);
    expect(html).toContain(units(m.quote.made!));
    expect(html).toContain(units(m.quote.totalPnl!));
    expect(html).toContain(units(m.quote.priceChange!));
    expect(html).not.toMatch(/\$|\bUSD\b|dollar|[Rr]ealized/);
  });
});

describe('pace from BotMetrics, with the one-day rule', () => {
  const lp = (ageMs: number) => lpMetrics({ ...FX.lpLive, startedAt: FX.now - ageMs }, FX.now);
  it('every window needs a day: dashes and "needs 1 day" at 14h, the scaled figures from a day on', () => {
    const young = lp(14 * H);
    expect([young.est.d1, young.est.d7, young.est.d30, young.est.d365]).toEqual([null, null, null, null]);
    expect(young.generatedRate.d30).toBeNull();
    expect(young.est.needs).toEqual({ d1: 'needs 1 day', d7: 'needs 1 day', d30: 'needs 1 day', d365: 'needs 1 day' });
    const old = lp(26 * H);
    expect(old.est.needs.d30).toBeNull();
    expect(old.est.d30!).toBeCloseTo(old.generatedUsd! * (30 * DAY_MS) / (26 * H), 6);
    expect(old.generatedRate.d30!.ETH).toBeCloseTo(old.generated!.ETH * (30 * DAY_MS) / (26 * H), 12);
  });
  it('the LP page has no client-side pace math left', () => {
    const s = src('LpDetail.tsx');
    expect(s).not.toMatch(/3_600_000|PositionPace|\['A month', 720\]/);
    expect(s).toMatch(/m\.generatedRate\.d30, m\.generatedRate\.needs\.d30/);
  });
});

describe('chart units', () => {
  it('uses the pool\'s own fee tier, shows mid for LPs, and claims no fee for an unknown market', () => {
    const uni = { quote: 'ETH', base: 'USDC', feeBps: 5, feeTier: 500, kind: 'v3' as const };
    expect(unitsLabel(uni, true, true)).toBe('units ETH/USDC (mid price; 0.05% pool fee taken out)');
    expect(unitsLabel(uni, true, false)).toContain('after the 0.05% pool fee');
    expect(unitsLabel({ ...uni, feeBps: 29, feeTier: null, kind: 'v2' }, false, true)).toBe('units ETH/USDC');
    expect(midFactor(5, false)).toBeCloseTo(1 / 0.9995, 12);
    expect(midFactor(5, true)).toBeCloseTo(0.9995, 12);
    expect(midFactor(null, false)).toBe(1);
    expect(src('LpDetail.tsx')).toMatch(/<Chart [^>]* mid /);
  });
});
