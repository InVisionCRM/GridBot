import { describe, expect, it } from 'vitest';
import { roundTripCost } from '../src/market/costs';
import {
  DEFAULT_TREND, computeIndicators, costGate, expectedMovePct, htfAllows, openRisk, positionSize, priceExit, signalAt, trail,
  validateTrendConfig, type TrendConfig,
} from '../src/market/strategy';
import { candlesFromCloses, wavePath } from './helpers/candles';

const cfg = (o: Partial<TrendConfig> = {}): TrendConfig => ({ ...DEFAULT_TREND, ...o });
const sigs = (k: ReturnType<typeof candlesFromCloses>, c: TrendConfig) => {
  const ind = computeIndicators(k, c);
  return k.map((_, i) => signalAt(ind, k, i, c));
};

describe('strategy signals (closed candles only)', () => {
  it('EMA cross: one entry on the first bar fast > slow, one exit on the cross back', () => {
    const closes = [...new Array(30).fill(1), ...Array.from({ length: 15 }, (_, i) => 1 + 0.01 * (i + 1)), ...Array.from({ length: 30 }, (_, i) => 1.15 - 0.01 * (i + 1))];
    const c = cfg({ fast: 3, slow: 8 });
    const k = candlesFromCloses(closes);
    const s = sigs(k, c);
    const ind = computeIndicators(k, c);
    const enters = s.flatMap((x, i) => (x.enter ? [i] : [])), exits = s.flatMap((x, i) => (x.exit ? [i] : []));
    expect(enters).toEqual([30]);
    expect(ind.fast[30]! > ind.slow[30]! && ind.fast[29]! <= ind.slow[29]!).toBe(true);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toBeGreaterThan(45);
  });

  it('EMA+RSI blocks entries outside the RSI band', () => {
    const closes = [...new Array(30).fill(1), ...Array.from({ length: 10 }, (_, i) => 1 + 0.05 * (i + 1))];
    const k = candlesFromCloses(closes);
    expect(sigs(k, cfg({ fast: 3, slow: 8 })).some((x) => x.enter)).toBe(true);
    const r = sigs(k, cfg({ strategy: 'ema_rsi', fast: 3, slow: 8, rsiMin: 50, rsiMax: 75 }));
    expect(r.some((x) => x.enter)).toBe(false); // RSI = 100 on a straight rise
    expect(r[30].note).toContain('RSI filter');
    expect(sigs(k, cfg({ strategy: 'ema_rsi', fast: 3, slow: 8, rsiMin: 50, rsiMax: 100 })).some((x) => x.enter)).toBe(true);
  });

  it('Donchian breaks the PRIOR N-bar high (current bar excluded) and exits under the prior low', () => {
    const closes = [...Array.from({ length: 25 }, (_, i) => 1 + (i % 2) * 0.02), 1.03, 1.0, 0.9];
    const k = candlesFromCloses(closes, undefined, undefined, 0);
    const c = cfg({ strategy: 'donchian', donchianEntry: 20, donchianExit: 10 });
    const s = sigs(k, c);
    expect(s[25].enter).toBe(true); // 1.03 > prior 20-bar high 1.02
    expect(s.slice(0, 25).some((x) => x.enter)).toBe(false);
    expect(s[27].exit).toBe(true); // 0.9 < prior 10-bar low
  });

  it('MACD signal cross enters on the hist sign change', () => {
    const k = candlesFromCloses(wavePath(300));
    const c = cfg({ strategy: 'macd' });
    const ind = computeIndicators(k, c);
    sigs(k, c).forEach((x, i) => {
      if (x.enter) expect(ind.macd[i]! > ind.macdSig[i]! && ind.macd[i - 1]! <= ind.macdSig[i - 1]!).toBe(true);
    });
    expect(sigs(k, c).filter((x) => x.enter).length).toBeGreaterThan(2);
  });

  it('no repaint: signals on a prefix equal signals on the full history', () => {
    const k = candlesFromCloses(wavePath(260));
    for (const strategy of ['ema', 'ema_rsi', 'macd', 'donchian'] as const) {
      const c = cfg({ strategy, rsiMin: 0, rsiMax: 100 });
      const full = sigs(k, c);
      for (let i = 60; i < k.length; i += 7) {
        const pre = k.slice(0, i + 1);
        const p = signalAt(computeIndicators(pre, c), pre, i, c);
        expect({ e: p.enter, x: p.exit }, `${strategy} @${i}`).toEqual({ e: full[i].enter, x: full[i].exit });
      }
    }
  });

  it('HTF filter uses closed higher-timeframe candles only', () => {
    const htf = candlesFromCloses([...new Array(10).fill(1), 2], 0, 14_400);
    const c = cfg({ htfEnabled: true, htfTf: '4h', htfEma: 5 });
    // at t = 10×4h the last HTF candle (close 2) has only just opened: still filtered on closes of 1 (1 > 1 false)
    expect(htfAllows(htf, 10 * 14_400, c).ok).toBe(false);
    expect(htfAllows(htf, 11 * 14_400, c).ok).toBe(true);
    expect(htfAllows(htf.slice(0, 3), 3 * 14_400, c).note).toContain('warming up');
    expect(htfAllows(htf, 0, cfg()).ok).toBe(true);
  });

  it('validates configs', () => {
    expect(validateTrendConfig(DEFAULT_TREND)).toEqual([]);
    expect(validateTrendConfig(cfg({ fast: 30, slow: 20 }))).toContain('fast must be < slow');
    expect(validateTrendConfig(cfg({ stopAtr: 0 })).length).toBe(1);
    expect(validateTrendConfig(cfg({ strategy: 'x' as never })).length).toBe(1);
  });
});

describe('risk rules', () => {
  it('ATR stop, R-multiple take-profit, ratcheting trail', () => {
    const r = openRisk(100, 2, cfg({ stopAtr: 2, tpR: 2, trailAtr: 2.5 }));
    expect(r).toMatchObject({ stop: 96, initialStop: 96, tp: 108, highest: 100 });
    expect(priceExit(r, 97)).toBeNull();
    expect(priceExit(r, 96)).toBe('stop');
    expect(priceExit(r, 108.5)).toBe('tp');
    const c = cfg({ trailAtr: 2.5 });
    expect(trail(r, 99, c)).toBe(false); // 100 − 5 = 95 < initial 96
    expect(trail(r, 102, c)).toBe(true); expect(r.stop).toBe(97);
    expect(trail(r, 101, c)).toBe(false); expect(r.stop).toBe(97); // never loosens
    expect(priceExit(r, 96.9)).toBe('trail');
    const noTrail = openRisk(100, 2, cfg({ trailAtr: 0, tpR: 0 }));
    expect(trail(noTrail, 150, cfg({ trailAtr: 0 }))).toBe(false);
    expect(noTrail.tp).toBeNull();
    expect(expectedMovePct(noTrail, cfg({ expectedMoveAtr: 3 }))).toBeCloseTo(0.06, 12);
    expect(expectedMovePct(r, cfg())).toBeCloseTo(0.08, 12);
  });

  it('sizing: % of capital, or risk-% via the stop distance (capped at available)', () => {
    expect(positionSize(500, 1000, 100, 95, cfg({ sizing: 'pct', sizePct: 40 }))).toBe(200);
    expect(positionSize(5000, 1000, 100, 95, cfg({ sizing: 'risk', riskPct: 1 }))).toBeCloseTo(200, 9); // 1% of 1000 / 5%
    expect(positionSize(150, 1000, 100, 95, cfg({ sizing: 'risk', riskPct: 1 }))).toBe(150);
    expect(positionSize(150, 1000, 100, 100, cfg({ sizing: 'risk' }))).toBe(0);
  });
});

describe('cost gate', () => {
  const base = { feeBps: 29, pool: null, gasPricePls: 0, approval: 'exact' as const, slippageBps: 0 };
  it('round trip of 2 × 0.29% LP fee ≈ 0.579%', () => {
    const c = roundTripCost(1000, 0.00002, base);
    expect(c.feePct).toBeCloseTo(0.005792, 6);
    expect(c.totalPct).toBeCloseTo(0.005792, 6);
  });
  it('blocks moves that do not clear fee + impact + gas + margin', () => {
    expect(costGate(0.007, 1000, 2e-5, base, 0.0025).ok).toBe(false);
    expect(costGate(0.009, 1000, 2e-5, base, 0.0025).ok).toBe(true);
    // shallow pool: $1000 into a 20k/1e9 pool has ~10% impact both ways
    const shallow = { ...base, pool: { quoteReserve: 20_000, plsReserve: 1e9 } };
    const g = costGate(0.05, 1000, 2e-5 * 0.9971, shallow, 0.0025);
    expect(g.ok).toBe(false);
    expect(g.impactPct).toBeGreaterThan(0.08);
    expect(g.reason).toMatch(/impact/);
    // gas: (60k approve + 220k swap) + 220k swap = 500k units × 1 PLS/gas × 2e-5 = 10 quote on a 100 quote trade → 10%
    const gas = { ...base, gasPricePls: 1 };
    const gg = costGate(0.05, 100, 2e-5, gas, 0);
    expect(gg.gasPct).toBeCloseTo(0.1, 2);
    expect(gg.ok).toBe(false);
    expect(costGate(0.05, 100_000, 2e-5, gas, 0).ok).toBe(true);
    expect(costGate(1, 0, 1, base, 0).ok).toBe(false);
  });
});
