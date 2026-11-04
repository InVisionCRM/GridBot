import { describe, expect, it } from 'vitest';
import { hourStarts, levelHeat, lpHours, tradeHours } from '../src/metrics/todayHours';
import { localDayStart } from '../src/metrics/feesToday';
import type { LpDay } from '../src/metrics/lpDay';

const H = 3_600_000;
const DAY = localDayStart(new Date(2026, 10, 4, 12).getTime());
const NOW = DAY + 5 * H + 20 * 60_000; // 05:20

describe("today by hour: what each bot made in each local hour, in its own coin", () => {
  it('lists the hours up to the one now is in', () => {
    expect(hourStarts(DAY, NOW)).toEqual([0, 1, 2, 3, 4, 5].map((h) => DAY + h * H));
  });

  it("grid / trend: the fills' realized result per hour; a failed send costs its gas; test trades and yesterday are not counted", () => {
    const fills = [
      { timestamp: DAY - 10 * 60_000, realizedPnlQuote: 9, side: 'sell' },
      { timestamp: DAY + 0.5 * H, realizedPnlQuote: 0, side: 'buy' },
      { timestamp: DAY + 1.2 * H, realizedPnlQuote: 2.5, side: 'sell' },
      { timestamp: DAY + 1.7 * H, realizedPnlQuote: 1.5, side: 'sell' },
      { timestamp: DAY + 3.1 * H, realizedPnlQuote: -0.2, side: 'buy', failed: true },
      { timestamp: DAY + 5.1 * H, realizedPnlQuote: 4, side: 'sell', manual: true },
    ];
    expect(tradeHours(fills, DAY, NOW)).toEqual([[DAY, 0], [DAY + H, 4], [DAY + 2 * H, 0], [DAY + 3 * H, -0.2], [DAY + 4 * H, 0], [DAY + 5 * H, 0]]);
    expect(levelHeat([...fills.map((f, i) => ({ ...f, intervalIndex: i % 2 })), { timestamp: DAY + 2 * H, realizedPnlQuote: 1, side: 'sell', closeSale: true, intervalIndex: 0 }], DAY))
      .toEqual({ 0: 1, 1: 1 }); // two sales today on levels 0 and 1; yesterday's, the failed buy, the test trade and the close's sale don't count
  });

  it("liquidity: the hour's fees minus what its steps that hour cost; an hour with no reading stays unknown", () => {
    const day = {
      hours: [
        { t: DAY, future: false, fees: 1 }, { t: DAY + H, future: false, fees: 2 }, { t: DAY + 2 * H, future: false, fees: null }, { t: DAY + 3 * H, future: true, fees: null },
      ],
      moves: [{ t: DAY + H + 60_000, cost: 0.5 }, { t: DAY + H + 120_000, cost: 0.25 }],
    } as unknown as LpDay;
    expect(lpHours(day)).toEqual([[DAY, 1], [DAY + H, 1.25], [DAY + 2 * H, null]]);
  });
});
