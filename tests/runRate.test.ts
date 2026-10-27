import { describe, expect, it } from 'vitest';
import { DAY_MS, isShortRun, rateOrRun, runLength, runSpan } from '../src/ui/runRate';

const net = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(0)} USDG`;
const perDay = (d: number) => `${net(d)}/day`;

describe('runRate: no per-day rate for a run under a day', () => {
  it('just under a day shows the net over the run, never a rate', () => {
    expect(isShortRun(DAY_MS - 1)).toBe(true);
    expect(rateOrRun(-866, DAY_MS - 1, net, perDay)).toBe('−866 USDG over 23.9h');
  });

  it('the STONKD LP #2 case: 8.8h paper run shows the run net, not −2,361/day', () => {
    const ms = 8.8 * 3_600_000;
    const out = rateOrRun(-866, ms, net, perDay);
    expect(out).toBe('−866 USDG over 8.8h');
    expect(out).not.toMatch(/day/);
  });

  it('exactly one day shows the per-day rate', () => {
    expect(isShortRun(DAY_MS)).toBe(false);
    expect(rateOrRun(-866, DAY_MS, net, perDay)).toBe('−866 USDG/day');
  });

  it('over a day divides the net by the days run', () => {
    expect(rateOrRun(300, 3 * DAY_MS, net, perDay)).toBe('+100 USDG/day');
    expect(rateOrRun(150, 1.5 * DAY_MS, net, perDay)).toBe('+100 USDG/day');
  });

  it('zero or missing run time shows the net so far, never a rate', () => {
    for (const ms of [0, -5, null, undefined, NaN]) {
      expect(isShortRun(ms as number)).toBe(true);
      expect(rateOrRun(12, ms as number, net, perDay)).toBe('+12 USDG so far');
    }
  });

  it('a missing net shows a dash', () => {
    expect(rateOrRun(NaN, DAY_MS * 2, net, perDay)).toBe('—');
    expect(rateOrRun(null as unknown as number, 3_600_000, net, perDay)).toBe('—');
  });

  it('runLength rounds down so a run under a day never reads as 1.0d', () => {
    expect(runLength(30_000)).toBe('<1m');
    expect(runLength(45 * 60_000)).toBe('45m');
    expect(runLength(8.8 * 3_600_000)).toBe('8.8h');
    expect(runLength(DAY_MS - 1)).toBe('23.9h');
    expect(runLength(DAY_MS)).toBe('1.0d');
    expect(runLength(2.57 * DAY_MS)).toBe('2.5d');
  });
});

describe('runSpan', () => {
  it('names the run length, or "so far" when unknown', () => {
    expect(runSpan(8.8 * 3_600_000)).toBe('over 8.8h');
    expect(runSpan(0)).toBe('so far');
    expect(runSpan(undefined)).toBe('so far');
  });
});
