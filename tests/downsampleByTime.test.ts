import { describe, expect, it } from 'vitest';
import { downsampleByTime } from '../src/market/stats';

describe('downsampleByTime', () => {
  const day = 86_400_000;
  it('covers the whole span: a 30-day minute history comes back as ≤ 600 points from its first to its last', () => {
    const pts: [number, number][] = Array.from({ length: 30 * 1440 }, (_, i) => [i * 60_000, i]);
    const d = downsampleByTime(pts, 600);
    expect(d.length).toBeLessThanOrEqual(600);
    expect(d.length).toBeGreaterThan(500);
    expect(d[0]).toEqual(pts[0]);
    expect(d[d.length - 1]).toEqual(pts[pts.length - 1]);
    expect(d[d.length - 1][0] - d[0][0]).toBeGreaterThan(29 * day);
    for (let i = 1; i < d.length; i++) expect(d[i][0]).toBeGreaterThan(d[i - 1][0]);
  });
  it('a short history is returned whole', () => {
    const pts: [number, number][] = [[0, 1], [60_000, 2]];
    expect(downsampleByTime(pts, 600)).toEqual(pts);
  });
});
