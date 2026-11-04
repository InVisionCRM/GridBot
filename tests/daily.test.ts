import { describe, expect, it } from 'vitest';
import { DAILY_KEEP, DAILY_SHOWN, dailyOf, dayKey, noteDaily, type DailyBook } from '../src/metrics/daily';

const H = 3_600_000;
const day0 = new Date(2026, 9, 1, 0, 5).getTime(); // 1 Oct 2026, 00:05 local

describe('Generated per day (the 30-day calendar)', () => {
  it('one snapshot per bot per local day, the first reading; a day is the next snapshot minus its own, today is now minus this morning', () => {
    const book: DailyBook = {};
    expect(noteDaily(book, [{ id: 'a', generated: { ETH: 1, USDG: 10 }, generatedUsd: 3000 }], day0)).toBe(true);
    // later the same day: no new snapshot
    expect(noteDaily(book, [{ id: 'a', generated: { ETH: 1.5, USDG: 12 }, generatedUsd: 4000 }], day0 + 10 * H)).toBe(false);
    expect(noteDaily(book, [{ id: 'a', generated: { ETH: 1.2, USDG: 15 }, generatedUsd: 3500 }], day0 + 24 * H)).toBe(true);
    const d = dailyOf(book.a, { generated: { ETH: 1.3, USDG: 15 }, generatedUsd: 3800 });
    expect(d).toEqual([
      { d: dayKey(day0), from: day0, gen: { ETH: expect.closeTo(0.2, 9), USDG: 5 }, usd: 500 },
      { d: dayKey(day0 + 24 * H), from: day0 + 24 * H, gen: { ETH: expect.closeTo(0.1, 9) }, usd: 300 }, // USDG unchanged: left out
    ]);
  });

  it('a bot with no figure yet is skipped; a missing dollar rate gives no dollar figure for that day', () => {
    const book: DailyBook = {};
    noteDaily(book, [{ id: 'x', generated: null, generatedUsd: null }, { id: 'y', generated: { PLS: 5 }, generatedUsd: null }], day0);
    expect(book.x).toBeUndefined();
    expect(dailyOf(book.y, { generated: { PLS: 9 }, generatedUsd: 2 })[0]).toMatchObject({ gen: { PLS: 4 }, usd: null });
    expect(dailyOf(undefined, { generated: {}, generatedUsd: 0 })).toEqual([]);
  });

  it(`keeps ${DAILY_KEEP} days and shows the last ${DAILY_SHOWN}`, () => {
    const book: DailyBook = {};
    for (let i = 0; i < DAILY_KEEP + 5; i++) noteDaily(book, [{ id: 'a', generated: { ETH: i }, generatedUsd: i }], day0 + i * 24 * H + 3 * H);
    expect(Object.keys(book.a)).toHaveLength(DAILY_KEEP);
    expect(Object.keys(book.a).sort()[0]).toBe(dayKey(day0 + 5 * 24 * H));
    const d = dailyOf(book.a, { generated: { ETH: 999 }, generatedUsd: 999 });
    expect(d).toHaveLength(DAILY_SHOWN);
    expect(d.slice(0, -1).every((x) => x.gen.ETH === 1)).toBe(true);
  });
});
