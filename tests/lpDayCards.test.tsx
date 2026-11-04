import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayMoves } from '../src/ui/LpDayCards';
import type { LpDay } from '../src/metrics/lpDay';

const H = 3_600_000, T = new Date(2026, 10, 4, 0, 0).getTime();
const done = [
  { t: T + 20 * H, action: 'rerange', asked: false, lower: 2399.97, upper: 2414.66, cost: 0.23, fees: { base: 0.001, quote: 2.7 } },
  { t: T + 19 * H, action: 'rerange', asked: false, lower: 2407.43, upper: 2422.16, cost: 0.07, fees: { base: 0.002, quote: 4.1 } },
  { t: T + 17 * H, action: 'open', asked: true, lower: 2415.38, upper: 2430.16, cost: 0.23, fees: { base: 0, quote: 0 } },
];

describe("today's moves: which way each move went", () => {
  it('compares each move with the range before it, on the copies the page gets over JSON (not the same objects)', () => {
    // the status arrives as JSON: day.moves and done are separate copies of the same steps
    const status = JSON.parse(JSON.stringify({ done, day: { dayStart: T, prices: [[T + 17 * H, 2420], [T + 21 * H, 2405]], ranges: [], moves: done, hours: [] } }));
    const html = renderToStaticMarkup(createElement(DayMoves, { day: status.day as LpDay, all: status.done, base: 'ETH', quote: 'USDG' }));
    const rows = html.match(/class="lpb-what">[^<]*/g)!.map((x) => x.replace('class="lpb-what">', ''));
    expect(rows).toEqual([
      'price left the range, moved it down, fees collected', // 2,407.43 → 2,399.97
      'price left the range, moved it down, fees collected', // 2,415.38 → 2,407.43
      'opened the position',
    ]);
  });
});
