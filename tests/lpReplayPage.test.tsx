/**
 * The replay page shows what was earned in units (fees less swap fees and gas), gas and swap fees as separate figures
 * (on Robinhood gas is a few cents and nearly all the cost is the swaps), and the coin-mix change on its own, measured
 * the same for a range that moves and one left open.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { replayTable, type PoolMinute, type ReplayPool, type ReplayRow } from '../src/market/lpReplay';
import { Ready } from '../src/ui/LpReplay';

const POOL: ReplayPool = { baseIs0: true, baseDecimals: 18, quoteDecimals: 6, spacing: 1, swapFee: 5e-4 };
const T = -200_000, T0 = 1_800_000_000;
const ticks = [...Array(100).fill(T), ...Array(100).fill(T + 300)]; // up 3% and it stays there
const rows: PoolMinute[] = ticks.map((c, i) => ({ t: T0 + i * 60, lo: c, hi: c, c, f0: 0, f1: 1e-12, liq: 1e24, n: 1 }));
const table: ReplayRow[] = replayTable(rows, POOL, { capital: 1000, gasOpen: 0.01, gasMove: 0.02, maxImpact: 1 }, [0.01])
  .map((r) => ({ ...r, coinsNow: { base: 0.2, quote: 500 }, poolShareNow: 0.01 }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const page = (rerange: boolean) => text(renderToStaticMarkup(
  <Ready a={{ state: 'ready', from: T0, to: T0 + 200 * 60, swaps: 200, capital: 1000, base: 'ETH', quote: 'USDG', gasMove: 0.02, maxImpact: 1, rows: table }}
    band={0.01} rerange={rerange} usdPer={null} onPick={() => {}} />,
));

describe('liquidity replay page', () => {
  it('earned in units per coin, gas and swap fees apart, and the mix change shown but not taken out', () => {
    const [on, off] = table;
    expect(off.openLoss).toBeGreaterThan(10);
    expect(off.openLoss).toBeCloseTo(on.moveLoss, 6); // same mix change, moved or left open
    for (const r of table) expect(r.net).toBeCloseTo(r.fees - r.gas - r.swapCost, 9);
    const shown = page(false);
    expect(shown).toMatch(/gas 0\.01 USDG · swap fees [\d.]+ USDG/);
    expect(shown).toMatch(/mix change, not counted: −[\d.]+ USDG/);
    expect(shown).toContain('Earned');
    expect(page(true)).toMatch(/1 move/);
  });
});
