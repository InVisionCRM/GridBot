/**
 * Kyle's estimate rule: Est. day / 7d / 365d (API also d30) = Generated per token ÷ age in days × 1 / 7 / 365 (30). All null
 * (with "shows after a day") under a day of history; no other cap or minimum. Age is historyEnd-aware. Checked on the real
 * sanitized status payload of Oct 27 2026.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DAY_MS, EST_HINT, estHint, gridMetrics, lpMetrics } from '../src/metrics/botMetrics';
import { StatTable } from '../src/ui/StatTable';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const R = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const AS_OF: number = R.grids[0].metrics.asOf;

describe("estimates: Generated ÷ age in days × the window, nothing under a day", () => {
  it('live LP lp-mvnm73sx-hghe at 2.49 days: 365d = 9,260.18 USDC + 0.25342 ETH', () => {
    const l = R.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
    const m = lpMetrics(l, AS_OF);
    const days = (AS_OF - l.startedAt) / DAY_MS; // running: its history ends now (historyEnd)
    expect(days).toBeCloseTo(2.4927, 4);
    expect(m.generated!.USDC).toBeCloseTo(63.239573, 6);
    expect(m.generated!.ETH).toBeCloseTo(0.00173066, 8);
    expect(m.generatedRate.d365!.USDC).toBeCloseTo(9260.18, 2);
    expect(m.generatedRate.d365!.ETH).toBeCloseTo(0.25342, 5);
    for (const [k, w] of [['d1', 1], ['d7', 7], ['d30', 30], ['d365', 365]] as const) {
      for (const sym of ['USDC', 'ETH']) expect(m.generatedRate[k]![sym]).toBeCloseTo((m.generated![sym] / days) * w, 9);
      expect(m.generatedRate.needs[k]).toBeNull();
    }
    expect(m.aprPct).not.toBeNull();
  });

  it('the 0.48-day stopped grid g-mvnlxta0-y6t4: every estimate and APR null, "shows after a day"', () => {
    const g = R.grids.find((x: Obj) => x.id === 'g-mvnlxta0-y6t4');
    const m = gridMetrics({ ...g, kind: 'grid' }, AS_OF);
    expect(g.status).toBe('stopped');
    expect(m.ageSec! / 86_400).toBeCloseTo(0.478, 3); // to its stop (historyEnd), not to now
    expect(m.generatedRate).toEqual({ d1: null, d7: null, d30: null, d365: null, needs: { d1: 'shows after a day', d7: 'shows after a day', d30: 'shows after a day', d365: 'shows after a day' } });
    expect([m.est.d1, m.est.d7, m.est.d30, m.est.d365, m.aprPct]).toEqual([null, null, null, null, null]);
  });

  it('a day exactly is enough; just under is not', () => {
    const l = R.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
    expect(lpMetrics({ ...l, startedAt: AS_OF - DAY_MS }, AS_OF).generatedRate.d365).not.toBeNull();
    expect(lpMetrics({ ...l, startedAt: AS_OF - DAY_MS + 60_000 }, AS_OF).generatedRate.d365).toBeNull();
  });

  it('the stat table shows the dash with the hint under a day and the figures after', () => {
    const g = R.grids.find((x: Obj) => x.id === 'g-mvnlxta0-y6t4');
    const young = renderToStaticMarkup(createElement(StatTable, { b: { ...g, kind: 'grid', metrics: gridMetrics({ ...g, kind: 'grid' }, AS_OF) }, s: { chains: [] } }));
    expect(young).toMatch(/Est\. 365d<\/th><td class="mono">— \(shows after a day\)/);
    expect(young).toMatch(/APR<\/th><td class="mono">— \(shows after a day\)/);
    expect(young).not.toMatch(/of history/);
    const l = R.lps.find((x: Obj) => x.id === 'lp-mvnm73sx-hghe');
    const old = renderToStaticMarkup(createElement(StatTable, { b: { ...l, metrics: lpMetrics(l, AS_OF) }, s: { chains: [] } }));
    expect(old).toMatch(/Est\. 365d<\/th><td class="mono">\+9,260 USDC · \+0\.253 ETH</); // unitsText: whole units from 1,000
    expect(old).not.toMatch(/shows after a day/);
    expect(old).not.toMatch(/Est\. 30d/); // Kyle: day, 7d and 365d on screen; d30 stays in the API
    expect(lpMetrics(l, AS_OF).generatedRate.d30).not.toBeNull();
  });

  it('one wording on every screen: the hint is EST_HINT, and no screen has a 30d / month estimate', () => {
    expect(EST_HINT).toBe('shows after a day');
    expect(estHint(0.5 * DAY_MS, DAY_MS)).toBe(EST_HINT);
    const dir = new URL('../src/ui/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/needs 1 day|Est\. APR shows once|'Est\. 30d'|'A month'/);
    }
  });
});
