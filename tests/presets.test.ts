import { describe, expect, it } from 'vitest';
import { analyzeEconomics, MIN_SPACING_PCT } from '../src/live/economics';
import { analyzeSpacing } from '../src/live/spacing';
import { getPreset, listPresets, resolvePreset, STRATEGY_PRESETS, usdPerQuote } from '../src/live/presets';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain } from './helpers/mockChain';

const P0 = 0.00001;
// Mainnet snapshot (Oct 2026): spot quote/PLS, pool reserves (human), gas 0.000387 PLS/unit
const LIVE = {
  DAI: { spot: 0.0000089541, q: 3.952e4, p: 4.401e9 },
  USDC: { spot: 0.000008959, q: 1.214e4, p: 1.351e9 },
  USDT: { spot: 0.000008953, q: 1.518e3, p: 1.69e8 },
  HEX: { spot: 0.0040642, q: 1.426e8, p: 3.498e10 },
  eHEX: { spot: 0.010718, q: 1.574e8, p: 1.465e10 },
  PLSX: { spot: 1.2992, q: 5.307e10, p: 4.073e10 },
} as const;
const F = 0.0029;
// Flipped orientation (HEX~ = HEX/PLS): sell-side spot = (1 − f)² / classic spot, reserves swap, gas in base (token) units.
const SPOTS: Record<string, number> = Object.fromEntries(Object.entries(LIVE).flatMap(([k, v]) => [[k, v.spot], [`${k}~`, (1 - F) ** 2 / v.spot]]));
const GAS = 0.000387;

function econ(key: string, lower: number, upper: number, n: number, capital: number) {
  const flipped = key.endsWith('~');
  const v = LIVE[key.replace('~', '') as keyof typeof LIVE];
  const pool = flipped ? { quoteReserve: v.p, plsReserve: v.q } : { quoteReserve: v.q, plsReserve: v.p };
  return analyzeEconomics({ lowerPrice: lower, upperPrice: upper, gridCount: n, capital, spot: SPOTS[key], pool, gasPricePls: flipped ? GAS * v.spot : GAS, approval: 'exact' });
}

describe('strategy presets', () => {
  it('lists named packs; no preset carries a tight-spacing override', () => {
    expect(listPresets().map((p) => p.id)).toEqual(['tight-scalp', 'hex', 'ehex', 'plsx', 'pulse-pack', 'stack-hex', 'stack-plsx', 'stack-ehex', 'stable-ladder']);
    for (const p of STRATEGY_PRESETS) for (const l of p.legs) expect((l as Record<string, unknown>).allowTightSpacing).toBeUndefined();
  });

  it('OLD tight scalp (±2.5%×36) loses money every round-trip; NEW one clears fee + impact + gas', () => {
    const old = econ('DAI', LIVE.DAI.spot * 0.975, LIVE.DAI.spot * 1.025, 36, 100);
    expect(old.spacingPct).toBeLessThan(old.roundTripFeePct);
    expect(old.netPerRoundTrip).toBeLessThan(0);
    expect(old.ok).toBe(false);

    const t = getPreset('tight-scalp').legs[0];
    expect(t).toMatchObject({ bandPct: 0.08, gridCount: 12, capitalUsd: 100 });
    const sp = analyzeSpacing(0.92, 1.08, t.gridCount);
    expect(sp.worstSpacingFrac).toBeGreaterThanOrEqual(0.0125 - 1e-9);
    const e = econ('DAI', LIVE.DAI.spot * 0.92, LIVE.DAI.spot * 1.08, 12, 100);
    expect(e.ok).toBe(true);
    expect(e.netPct).toBeGreaterThan(0.005);
  });

  it('OLD token packs were sized in raw token units (200 HEX ≈ $0.44): gas makes them net-negative', () => {
    const h = econ('HEX', LIVE.HEX.spot * 0.92, LIVE.HEX.spot * 1.08, 20, 200);
    expect(h.levelSize * usdPerQuote(SPOTS, 'HEX')).toBeLessThan(0.05); // ~4¢ per level
    expect(h.netPerRoundTrip).toBeLessThan(0);
    expect(h.ok).toBe(false);
  });

  it('every preset leg is net-positive per round-trip on live mainnet reserves', () => {
    for (const p of STRATEGY_PRESETS) {
      for (const leg of resolvePreset(p, SPOTS, 'DAI')) {
        const e = econ(leg.quote, leg.lowerPrice, leg.upperPrice, leg.gridCount, leg.totalCapitalUsd);
        expect(leg.spacing.worstSpacingFrac, `${p.id}/${leg.quote}`).toBeGreaterThanOrEqual(MIN_SPACING_PCT);
        expect(e.ok, `${p.id}/${leg.quote}: ${e.reasons.join(' ')}`).toBe(true);
        expect(e.netPerRoundTrip).toBeGreaterThan(0);
      }
    }
  });

  it('capital is USD, converted to quote units from live spots', () => {
    const [h] = resolvePreset(getPreset('hex'), SPOTS, 'DAI');
    // $100 / ($0.0022 per HEX) ≈ 45k HEX
    expect(h.capitalUsd).toBe(100);
    expect(h.totalCapitalUsd).toBeCloseTo(100 * LIVE.HEX.spot / LIVE.DAI.spot, 3);
    expect(h.totalCapitalUsd).toBeGreaterThan(40_000);
    const [p] = resolvePreset(getPreset('plsx'), SPOTS, 'DAI', { capitalUsd: 10 });
    expect(p.totalCapitalUsd).toBeCloseTo(10 * LIVE.PLSX.spot / LIVE.DAI.spot, 0);
    const ladder = resolvePreset(getPreset('stable-ladder'), SPOTS, 'DAI');
    expect(ladder.map((l) => l.quote)).toEqual(['DAI', 'USDC']);
    expect(ladder[0].lowerPrice).toBeCloseTo(LIVE.DAI.spot * 0.9, 12);
  });

  it('USDT is excluded because its pool is too shallow (impact eats the edge)', () => {
    const e = econ('USDT', LIVE.USDT.spot * 0.9, LIVE.USDT.spot * 1.1, 12, 50);
    expect(e.impactPct).toBeGreaterThan(0.009);
    expect(e.ok).toBe(false);
  });

  it('MultiBot preview attaches economics; startPreset creates grids; live is blocked when not net-positive', async () => {
    const chain = new MockChain(P0);
    const bot = new MultiBot({
      net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0,
    });
    const prev = await bot.previewPreset('stable-ladder');
    expect(prev.legs).toHaveLength(2);
    expect(prev.ok).toBe(true);
    for (const l of prev.legs) {
      expect([6, 7]).toContain(l.econ.buyLevels);
      expect(l.econ.levelSize).toBeCloseTo(l.totalCapitalUsd / l.econ.buyLevels, 6);
      expect(l.econ.netPerRoundTrip).toBeGreaterThan(0);
    }
    const { ids } = await bot.startPreset('stable-ladder', { mode: 'paper' });
    expect(ids).toHaveLength(2);
    // engine sizing matches the economics preview
    const g0 = bot.status().grids.find((g) => g.id === ids[0])!;
    expect(g0.usdPerBuy).toBeCloseTo(prev.legs[0].econ.levelSize, 6);
    expect(new Set(bot.status().grids.map((g) => g.stable))).toEqual(new Set(['DAI', 'USDC']));

    const { ids: one } = await bot.startPreset('tight-scalp', { mode: 'paper', quote: 'HEX' });
    expect(bot.status().grids.find((g) => g.id === one[0])!.config!.gridCount).toBe(12);

    // Drain the USDC pool so the ladder is no longer net-positive: live refuses (no override), nothing started.
    const usdc = chain.pool('USDC');
    usdc.rQ = 300n * 10n ** 6n; chain.setPrice(P0, 'USDC');
    const before = bot.status().grids.length;
    await expect(bot.startPreset('stable-ladder', { mode: 'live', allowTightSpacing: true })).rejects.toThrow(/LIVE start blocked/);
    expect(bot.status().grids.length).toBe(before);
    // Paper may simulate it with the explicit override
    const { ids: sim } = await bot.startPreset('stable-ladder', { mode: 'paper', allowTightSpacing: true });
    expect(sim).toHaveLength(2);
  });
});
