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
    expect(hour[0]).toBe(0);
    // a: 20 before the hour, then 24, then 22. b starts at 10 inside the hour, then 16. Change is (22-20) + (16-10).
    expect(hour[hour.length - 1]).toBe(8);
    expect(seriesChange(hour).delta).toBe(8);
  });

  it('calls a price near either edge amber, and outside the band out', () => {
    expect(rangeTone(100, 200, 105, true)).toBe('near');
    expect(rangeTone(100, 200, 190, true)).toBe('near');
    expect(rangeTone(100, 200, 150, true)).toBe('in');
    expect(rangeTone(100, 200, 90, true)).toBe('out');
    expect(rangeTone(100, 200, 150, false)).toBe('out');
  });
});

describe('Home chip span', () => {
  it('names the range when history covers it, and the real span when it is shorter', async () => {
    const { coveredLabel } = await import('../src/ui/series');
    const H = 3_600_000;
    expect(coveredLabel('1D', 30 * H)).toBe('1D');
    expect(coveredLabel('1W', 10 * H)).toBe('last 10.0h');
    expect(coveredLabel('1M', 3 * 24 * H)).toBe('last 3.0d');
    expect(coveredLabel('ALL', 3 * 24 * H)).toBe('last 3.0d');
    expect(coveredLabel('1W', 0)).toBe('1W');
  });
});
