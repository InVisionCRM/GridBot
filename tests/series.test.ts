import { describe, expect, it } from 'vitest';
import { portfolioSeries, rangeTone, seriesChange } from '../src/ui/series';

describe('desk series', () => {
  const now = 1_700_000_000_000;
  const bot = (id: string, hist: [number, number][], usdPerQuote = 2) => ({ id, usdPerQuote, equityHist: hist });

  it('sums dollar equity and keeps points from before the window as the start', () => {
    const bots = [
      bot('a', [[now - 10 * 86_400_000, 10], [now - 3_600_000, 12], [now, 11]]),
      bot('b', [[now - 3_600_000, 5], [now, 8]]),
    ];
    const hour = portfolioSeries(bots, '1H', now);
    expect(hour[0]).toBe(10 * 2);
    expect(hour[hour.length - 1]).toBe(11 * 2 + 8 * 2);
    expect(seriesChange(hour).delta).toBe((11 * 2 + 8 * 2) - 20);
  });

  it('calls a price near either edge amber, and outside the band out', () => {
    expect(rangeTone(100, 200, 105, true)).toBe('near');
    expect(rangeTone(100, 200, 190, true)).toBe('near');
    expect(rangeTone(100, 200, 150, true)).toBe('in');
    expect(rangeTone(100, 200, 90, true)).toBe('out');
    expect(rangeTone(100, 200, 150, false)).toBe('out');
  });
});
