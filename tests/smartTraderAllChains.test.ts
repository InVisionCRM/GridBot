/**
 * The Smart trader works on every chain soon after one is added (Kyle, 2026-10-30: "update smart trader to work with all
 * chains"; its log said "OP Mainnet: not in the scan" for each of the 5 chains added back, while the scan rescanned
 * PulseChain, Robinhood and Ethereum ahead of them).
 */
import { describe, expect, it } from 'vitest';
import { scanMark, speaks, type ScanView } from '../src/server/bot/autopilot';
import { DailyScanner, type ScanDeps, type ScanFile } from '../src/server/market/scanner';
import { MemoryStore } from '../src/server/bot/store';

const NOW = 1_800_000_000_000;
const chain = (id: number, name: string) => ({ id, name, slug: name.toLowerCase(), wrapped: '0x' + '11'.repeat(20), spendable: [], dexes: ['d'], lpDexes: [] });

describe('new chains are scanned first', () => {
  it('a chain with no result goes ahead of chains that already have one', async () => {
    const order: string[] = [];
    const store = new MemoryStore<ScanFile>();
    store.save({ version: 4, at: NOW, testUsd: 1000, chains: [{ chainId: 369, name: 'PulseChain', at: NOW, items: [], tested: 0, skipped: [], error: null }] });
    const deps = {
      chains: () => [chain(369, 'PulseChain'), chain(8453, 'Base'), chain(10, 'Optimism')],
      existing: () => [],
      gecko: { topPools: async (slug: string) => { order.push(slug); return []; }, ohlcv: async () => [] },
      store, approval: 'exact', now: () => NOW,
    } as unknown as ScanDeps;
    const sc = new DailyScanner(deps);
    expect(sc.isDue()).toBe(true);
    await sc.run();
    expect(order).toEqual(['base', 'optimism', 'pulsechain']);
  });
});

describe('the Smart trader reviews each chain as its scan finishes', () => {
  const chainView = (chainId: number, at?: number, partial?: boolean) => ({ chainId, items: [], error: null, ...(at != null ? { at } : {}), ...(partial ? { partial } : {}) });

  it('a chain finished during a running scan moves the mark; a chain still being scanned does not', () => {
    const before: ScanView = { at: NOW, chains: [chainView(369, NOW)] };
    const midScan: ScanView = { at: NOW, running: true, chains: [chainView(8453, NOW + 60_000), chainView(10, NOW + 120_000, true), chainView(369, NOW)] };
    expect(scanMark(before)).toBe(NOW);
    expect(scanMark(midScan)).toBe(NOW + 60_000);
  });

  it('a first scan with one chain done already has a mark (no wait for the whole scan)', () => {
    expect(scanMark({ at: null, running: true, chains: [chainView(8453, NOW)] })).toBe(NOW);
    expect(scanMark({ at: null, running: true, chains: [chainView(8453, NOW, true)] })).toBeNull();
  });
});

describe("a scan that finishes chain by chain doesn't log every account each time", () => {
  const v = (chains: { chainId: number; at?: number }[], at: number | null = NOW): ScanView => ({ at, running: true, chains: chains.map((c) => ({ ...c, items: [], error: null })) });

  it('only the chain with a newer result than the last review speaks', () => {
    const prev = NOW; // the last review saw everything up to NOW
    const baseDone = v([{ chainId: 8453, at: NOW + 60_000 }, { chainId: 369, at: NOW }]);
    expect(speaks(baseDone, 8453, prev)).toBe(true);
    expect(speaks(baseDone, 369, prev)).toBe(false);
    // nothing new since the last review: nobody speaks
    expect(speaks(baseDone, 8453, NOW + 60_000)).toBe(false);
  });
  it('the first review speaks for every chain', () => {
    expect(speaks(v([{ chainId: 369, at: NOW }]), 369, null)).toBe(true);
  });
});
