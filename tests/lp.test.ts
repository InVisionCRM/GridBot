import { describe, expect, it } from 'vitest';
import { bestLp, inRangeShare, LP_BAND, LP_BANDS, LP_GAS, lpShareFromFeeProtocol, runLpBacktest } from '../src/market/lp';
import type { Candle } from '../src/market/candles';
import { simBuy, type CostModel } from '../src/market/costs';
import { CHAINS } from '../src/live/chains';

const T0 = 1_700_000_000;
/** Hourly candles at a fixed price path (sell-side units) with `v` quote traded each hour. */
const path = (prices: number[], v = 0): Candle[] => prices.map((p, i) => ({ t: T0 + i * 3600, o: p, h: p, l: p, c: p, v }));
const flat = (n: number, p = 1, v = 0) => path(Array.from({ length: n }, () => p), v);
/** No fee, no impact (huge pool), no gas, no slippage: isolates the position maths. */
const FREE: CostModel = { feeBps: 0, pool: { quoteReserve: 1e15, plsReserve: 1e15 }, gasPricePls: 0, approval: 'max', slippageBps: 0 };

describe('LP fee share from slot0().feeProtocol (values read on-chain 2026-10-17)', () => {
  it('Uniswap V3: 68 → protocol 1/4 (LPs 75%), 102 → 1/6, 0 → LPs keep all', () => {
    expect(lpShareFromFeeProtocol(68, 'uniswap')).toBeCloseTo(0.75, 12);
    expect(lpShareFromFeeProtocol(102, 'uniswap')).toBeCloseTo(5 / 6, 12);
    expect(lpShareFromFeeProtocol(0, 'uniswap')).toBe(1);
  });
  it('PancakeSwap V3 forks: 9mm 209718400 (3200/3200) → 68%, Robinhood 216272100 (3300/3300) → 67%', () => {
    expect(lpShareFromFeeProtocol(209_718_400, 'pancake')).toBeCloseTo(0.68, 12);
    expect(lpShareFromFeeProtocol(216_272_100, 'pancake')).toBeCloseTo(0.67, 12);
  });
  it('rejects settings the contracts cannot hold', () => {
    expect(() => lpShareFromFeeProtocol(2, 'uniswap')).toThrow(/bad uniswap/);
    expect(() => lpShareFromFeeProtocol(20_000, 'pancake')).toThrow(/bad pancake/);
    expect(() => lpShareFromFeeProtocol(-1, 'pancake')).toThrow(/bad feeProtocol/);
  });
});

describe('DEX registry: every DEX the scan reads has a verified LP fee share', () => {
  it('V2 DEXes carry a measured share (9mm V2 is the one left unverified); V3 DEXes say how to read it', () => {
    const shares = Object.fromEntries(CHAINS.flatMap((c) => c.dexes.map((d) => [`${c.key}:${d.id}`, d.kind === 'v2' ? d.lpShare ?? null : d.protocolFee ?? null])));
    expect(shares).toEqual({
      'pulsechain:pulsex-v2': 22 / 29, 'pulsechain:pulsex-v1': 0, 'pulsechain:9mm-v2': null, 'pulsechain:9mm-v3': 'pancake',
      'robinhood:uniswap-v3': 'uniswap', 'robinhood:uniswap-v2': 5 / 6, 'robinhood:pancakeswap-v3': 'pancake', 'robinhood:uniswap-v4': null,
      'ethereum:uniswap-v3': 'uniswap', 'ethereum:uniswap-v2': 5 / 6,
      'base:uniswap-v3': 'uniswap', 'base:uniswap-v2': 5 / 6, 'arbitrum:uniswap-v3': 'uniswap', 'arbitrum:uniswap-v2': 5 / 6,
      'bsc:pancakeswap-v3': 'pancake', 'bsc:pancakeswap-v2': 17 / 25, 'polygon:uniswap-v3': 'uniswap', 'polygon:quickswap-v2': 5 / 6,
      'optimism:uniswap-v3': 'uniswap',
    });
  });
});

describe('inRangeShare', () => {
  it('splits a candle on a log scale; a flat candle counts fully when inside', () => {
    expect(inRangeShare(1, 4, 2, 8)).toBeCloseTo(0.5, 12); // log 1→4 spans 2 doublings, 2→4 is one
    expect(inRangeShare(3, 3, 2, 8)).toBe(1);
    expect(inRangeShare(9, 9, 2, 8)).toBe(0);
    expect(inRangeShare(9, 12, 2, 8)).toBe(0);
  });
});

describe('runLpBacktest: position maths', () => {
  it('full range (V2) with no fees or costs follows √price: price ×4 → position ×2; it earned nothing apart from the price', () => {
    const r = runLpBacktest(path([1, 2, 4]), { kind: 'v2', capital: 1000, bandPct: null, lpShare: 1 }, FREE);
    expect(r.returnPct).toBeCloseTo(1, 6);
    expect(r.earnedPct).toBeCloseTo(0, 9);
    expect(r.inRangePct).toBe(1);
  });

  it('a narrow range sells the coin on the way up: past the top it is all quote and stops changing', () => {
    const r = runLpBacktest(path([1, 1.05, 1.5, 2]), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 1 }, FREE);
    // Value at the top of a ±10% range (all sold at an average of √(1·1.1)), then flat.
    const top = runLpBacktest(path([1, 1.1]), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 1 }, FREE);
    expect(r.returnPct).toBeCloseTo(top.returnPct, 9);
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.returnPct).toBeLessThan(0.05);
    expect(r.earnedPct).toBeCloseTo(0, 9);
  });

  it('fees = volume × pool fee × LP share × your share of the pool, only while in range', () => {
    const costs: CostModel = { ...FREE, feeBps: 30, pool: { quoteReserve: 100_000, plsReserve: 100_000 } };
    const hours = 100, v = 50_000;
    const r = runLpBacktest(flat(hours, 1, v), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 0.75 }, costs);
    expect(r.poolSharePct).toBeGreaterThan(0);
    expect(r.feesPct * 1000).toBeCloseTo(hours * v * 0.003 * 0.75 * r.poolSharePct, 6);
    // A narrower range is a bigger share of the same pool for the same money.
    const wide = runLpBacktest(flat(hours, 1, v), { kind: 'v3', capital: 1000, bandPct: 0.25, lpShare: 0.75 }, costs);
    expect(r.poolSharePct).toBeGreaterThan(wide.poolSharePct);
    // Out of range → no fees.
    const away = runLpBacktest(path([1, ...Array.from({ length: 99 }, () => 1.5)], v), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 0.75 }, costs);
    expect(away.feesPct).toBeLessThan(r.feesPct / 50);
  });

  it('PulseX V1 pays LPs nothing (share 0): same week, no fees', () => {
    const costs: CostModel = { ...FREE, feeBps: 29, pool: { quoteReserve: 100_000, plsReserve: 100_000 } };
    const r = runLpBacktest(flat(100, 1, 50_000), { kind: 'v2', capital: 1000, bandPct: null, lpShare: 0 }, costs);
    expect(r.feesPct).toBe(0);
  });

  it('charges the opening swap, two approvals, add and remove gas', () => {
    const gasPricePls = 1e-6; // base per gas unit; price 1 → quote per gas unit
    const costs: CostModel = { ...FREE, gasPricePls, approval: 'exact', gasUnits: { approve: 60_000, swap: 200_000 } };
    const r = runLpBacktest(flat(10), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 1 }, costs);
    const gas = (200_000 + 60_000 + 2 * 60_000 + LP_GAS.v3.open + LP_GAS.v3.close) * gasPricePls;
    expect(r.returnPct * 1000).toBeCloseTo(-gas, 6);
    expect(r.earnedPct * 1000).toBeCloseTo(-gas, 6); // a flat price: everything is costs
  });

  it('earned = fees − the opening swap\'s fee and impact − gas; the price move is left out', () => {
    // 0.3% pool of 100k each side, 50k traded an hour, price up 20% over the window
    const costs: CostModel = { ...FREE, feeBps: 30, pool: { quoteReserve: 100_000, plsReserve: 100_000 } };
    const k = path(Array.from({ length: 50 }, (_, i) => 1 + (0.2 * i) / 49), 50_000);
    const r = runLpBacktest(k, { kind: 'v2', capital: 1000, bandPct: null, lpShare: 1 }, costs);
    // full range at mid 1/(1−f): half the value is swapped to the base coin
    const p0 = 1 / 0.997, buy = simBuy(500, k[0].o, costs), swapCost = 500 - buy.pls * p0;
    expect(swapCost).toBeGreaterThan(500 * 0.003); // the fee plus some impact
    expect(r.earnedPct).toBeCloseTo(r.feesPct - swapCost / 1000, 9);
    expect(r.returnPct).toBeGreaterThan(r.earnedPct + 0.05); // the price rise is in the return, not in earned
  });

  it('fails fast on inputs it cannot model', () => {
    expect(() => runLpBacktest(flat(10), { kind: 'v2', capital: 1000, bandPct: 0.1, lpShare: 1 }, FREE)).toThrow(/always full range/);
    expect(() => runLpBacktest(flat(10), { kind: 'v3', capital: 1000, bandPct: 0.1, lpShare: 1 }, { ...FREE, pool: null })).toThrow(/pool depth/);
    expect(() => runLpBacktest(flat(10), { kind: 'v3', capital: 1, bandPct: 0.1, lpShare: 1 }, { ...FREE, gasPricePls: 1 })).toThrow(/opening costs more/);
  });
});

describe('bestLp', () => {
  it('V2 only tries full range; V3 tries every band a liquidity bot can open and keeps the one that earned most', () => {
    const k = flat(100, 1, 50_000);
    const costs: CostModel = { ...FREE, feeBps: 30, pool: { quoteReserve: 100_000, plsReserve: 100_000 } };
    expect(bestLp(k, costs, 1000, 'v2', 1).bandPct).toBeNull();
    const best = bestLp(k, costs, 1000, 'v3', 1);
    expect(best.bandPct).toBe(Math.min(...LP_BANDS)); // flat price: tightest range earns most
    expect(Math.max(...LP_BANDS)).toBe(LP_BAND.max);
    for (const b of LP_BANDS) expect(best.earnedPct).toBeGreaterThanOrEqual(runLpBacktest(k, { kind: 'v3', capital: 1000, bandPct: b, lpShare: 1 }, costs).earnedPct);
  });
  it('needs 72 hourly candles', () => {
    expect(() => bestLp(flat(71), FREE, 1000, 'v3', 1)).toThrow(/need 72/);
  });
});
