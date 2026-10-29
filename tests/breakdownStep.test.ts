/**
 * a006: breakdown rows are each coin's real figures. The compact step of a big Generated (100 PLS at 12.3k,
 * 10,000 PLS at 2.5M) must not round 254 PLS of gas to 300, or hide it; the rows still add up to the Generated shown.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptStatus } from '../src/v2/adapt-status';
import { ledgerLines, sheetRows } from '../src/v2/figures';
import type { BotMetrics } from '../src/v2/metrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const status = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const now = status.grids[0].metrics.asOf as number;
const base = adaptStatus({ spotsAt: now, lps: [status.lps.find((r: Obj) => r.id === 'lp-mvnm73sx-hghe')] }, [], now).bots[0].metrics;
const row = (rows: { label: string; value: string }[], label: string) => rows.find((r) => r.label === label)?.value;

describe('breakdown step', () => {
  it.each([[12_345, 254, '−254.00 PLS'], [2_500_000, 2540, '−2,540.00 PLS']])('itemized: %d PLS generated, %d PLS gas', (gen, gas, want) => {
    const m = { ...base, generated: [{ symbol: 'PLS', amount: gen, usd: null }], grossFees: [], feesPaid: [], moveLoss: [],
      breakdownByCoin: { PLS: { earned: gen + gas, gasSwap: gas, rangeMoveLoss: 0, taxes: 0, bridge: 0, generated: gen } },
      breakdownBasis: { earned: 'tradeProfit', itemized: true, note: '' } } as BotMetrics;
    const rows = sheetRows(m, { base: 'X', quote: 'PLS' });
    expect(row(rows, 'Gas + swap fees')).toBe(want);
    expect(row(rows, 'Trade profit before gas')).toBe(`+${(gen + gas).toLocaleString('en-US')}.00 PLS`);
    expect(row(rows, 'Generated')).toBe(`+${gen.toLocaleString('en-US')}.00 PLS`);
  });
  it('fee/gas/move ledger: a big LP keeps its small gas exact', () => {
    const m = { ...base, kind: 'lp', generated: [{ symbol: 'PLS', amount: 12_345, usd: null }], grossFees: [{ symbol: 'PLS', amount: 12_599, usd: null }],
      feesPaid: [{ symbol: 'PLS', amount: 254, usd: null }], moveLoss: [], breakdownByCoin: null, breakdownBasis: null } as unknown as BotMetrics;
    const l = ledgerLines(m)!;
    expect(l.paid).toBe('−254.00 PLS');
    expect(l.gross).toBe('+12,599.00 PLS');
    expect(l.sheetGenerated).toBe('+12,345.00 PLS');
    expect(l.generated).toBe('+12.3k PLS'); // the headline stays compact
  });
});
