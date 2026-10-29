/**
 * Audit a004: the LP page's "Fees waiting" reads "<coin>: all of Generated" only when the two amounts are the same
 * number; two different amounts that round alike (0.000188 and 0.000167 ETH) print the waiting amount.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LpDetail } from '../src/ui/LpDetail';
import { lpMetrics } from '../src/metrics/botMetrics';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const noop = () => {};
const page = (l: Obj) => {
  const s = { ...RAW, lps: RAW.lps.map((x: Obj) => (x.id === l.id ? l : x)) };
  const html = renderToStaticMarkup(createElement(LpDetail, { s, events: [], ticks: { prices: {} }, nav: noop, act: noop, busy: false, id: l.id } as never));
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

describe('LP fees waiting vs Generated', () => {
  it('different amounts that round alike are not "all of Generated"', () => {
    const l0 = RAW.lps.find((x: Obj) => x.id === 'lp-mvnlwdly-omac');
    const l = { ...l0, owed: { ...l0.owed, quote: 0.000187674 } };
    const m = lpMetrics(l, l0.metrics.asOf);
    const lm = { ...l, metrics: { ...m, generated: { ...m.generated, ETH: 0.000166866 } } };
    expect(page(lm)).not.toContain('ETH: all of Generated');
  });
});
