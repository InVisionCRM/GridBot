import { describe, expect, it } from 'vitest';
import eth1h from './fixtures/eth-usdc-005-1h.json';
import eth1m from './fixtures/eth-usdc-005-1m.json';
import ethLiq from './fixtures/eth-usdc-005-liquidity.json';
import hood1h from './fixtures/hood-ethusdg-1h.json';
import hood5m from './fixtures/hood-ethusdg-5m.json';
import hoodLiq from './fixtures/hood-ethusdg-liquidity.json';
import {
  HOOD_GAS_PER_ACTION, README_WEEK_END, README_WEEK_START, REPLAY_LABEL,
  candlePolicies, ethUsdcTable, fixtureRows, formatCandleTable, formatDetroit, hoodWeekTable,
  loadSeries, median, replayCandles, replayPolicies, sampleAsOf, sliceHalfOpen, weightedEthShare,
  type CandleMarket, type LiquiditySeries, type Ohlcv, type PoolSample,
} from '../src/market/lpCandleReplay';

const flat = (t: number, price: number, v = 0): Ohlcv => ({ t, o: price, h: price, l: price, c: price, v });

function sample(t: number, liquidity: string, lpShare = 0.75, feeProtocol = 68): PoolSample {
  return { t, block: 1, liquidity, feeProtocol, lpShare, swaps: 10, ethValueShare: 0.4, feeQuote: 60, feeEthUsd: 40 };
}

const BASE: CandleMarket = {
  fee: 0.0005, lScale: 1e12, gasOpen: 0, gasMove: 0, gasOpenEth: 0, gasMoveEth: 0,
  impactBps: 1, capital: 1000, quote: 'USDC', ethValueShare: 0.4,
  samples: [sample(0, '1000000000000000000')],
};

describe('candle replay uses the bot clock', () => {
  it('moves on the first close outside, and a longer dwell does not', () => {
    const bars = [flat(0, 100), flat(3600, 110), flat(7200, 110)];
    const now = replayCandles(bars, BASE, { label: 'now', bandPct: 0.01, rerange: true });
    const dwell = replayCandles(bars, BASE, {
      label: 'dwell', bandPct: 0.01, rerange: true, range: { dwellMin: 180 },
    });
    expect(now.moves).toBe(1);
    expect(now.moveLoss).toBeGreaterThan(0);
    expect(dwell.moves).toBe(0);
    expect(dwell.moveLoss).toBe(0);
  });

  it('a cooldown holds the second move; dwell 0 does not', () => {
    const bars = [flat(0, 100), flat(3600, 110), ...Array.from({ length: 8 }, (_, i) => flat(7200 + i * 3600, 120))];
    const now = replayCandles(bars, BASE, { label: 'now', bandPct: 0.01, rerange: true });
    const cooled = replayCandles(bars, BASE, {
      label: 'cool', bandPct: 0.01, rerange: true, range: { cooldownMin: 24 * 60 },
    });
    expect(now.moves).toBe(2);
    expect(cooled.moves).toBe(1);
    expect(cooled.moveLoss).toBeLessThan(now.moveLoss);
  });

  it('stay put never locks in a move loss', () => {
    const bars = [flat(0, 100), flat(3600, 110), flat(7200, 90)];
    const stay = replayCandles(bars, BASE, { label: 'stay', bandPct: 0.01, rerange: false });
    expect(stay.moves).toBe(0);
    expect(stay.moveLoss).toBe(0);
  });

  it('fees match the volume × share formula on two in-range bars', () => {
    const bars = [flat(0, 100, 1_000_000), flat(3600, 100, 1_000_000)];
    const r = replayCandles(bars, BASE, { label: 'stay', bandPct: 0.01, rerange: false });
    // Worked independently of this module: L ≈ 10021.70, share ≈ 0.009922, two bars ≈ 7.44169.
    expect(r.moves).toBe(0);
    expect(r.inRange).toBe(1);
    expect(r.fees).toBeCloseTo(7.441693395795617, 8);
    expect(r.swapCost).toBeCloseTo(0.2985037219676416, 8);
    expect(r.net).toBeCloseTo(r.fees - r.gas - r.swapCost - r.moveLoss, 8);
    expect(r.net).toBeCloseTo(7.143189673827975, 8);
    expect(r.feeEth * 100 + r.feeQuote).toBeCloseTo(r.fees, 8);
  });
});

describe('sampled liquidity path', () => {
  const bars = [flat(0, 100, 1_000_000), flat(3600, 100, 1_000_000), flat(7200, 100, 1_000_000), flat(10800, 100, 1_000_000)];
  const series = [sample(0, '1000000000000000000'), sample(7200, '100000000000000000')];

  it('uses the sample in force for that bar, on every setting', () => {
    expect(sampleAsOf(series, 0).liquidity).toBe(series[0].liquidity);
    expect(sampleAsOf(series, 7199).liquidity).toBe(series[0].liquidity);
    expect(sampleAsOf(series, 7200).liquidity).toBe(series[1].liquidity);
    expect(sampleAsOf(series, 99999).liquidity).toBe(series[1].liquidity);
    expect(sampleAsOf(series, -1).liquidity).toBe(series[0].liquidity);

    const deep = { ...BASE, samples: [sample(0, '5000000000000000000')] };
    const thin = { ...BASE, samples: series };
    const policies = candlePolicies();
    const deepRows = replayPolicies(bars, deep, policies);
    const thinRows = replayPolicies(bars, thin, policies);
    for (const row of thinRows) expect(row.samples).toBe(2);
    for (const row of deepRows) expect(row.samples).toBe(1);
    // Same band and a price that never leaves: Defaults and stay-put earn the same fees. Presets are wider, so their liquidity is lower.
    expect(thinRows[3].fees).toBeCloseTo(thinRows[0].fees, 8);
    expect(deepRows[3].fees).toBeCloseTo(deepRows[0].fees, 8);
    expect(thinRows[0].fees).toBeGreaterThan(deepRows[0].fees);
    expect(thinRows[1].fees).toBeGreaterThan(deepRows[1].fees);
    expect(thinRows.every((r) => r.moves === 0)).toBe(true);
  });

  it('a lower sampled LP share reduces fees, and the fee tier on the sample is the one charged', () => {
    const full = replayCandles(bars, { ...BASE, samples: series }, { label: 'stay', bandPct: 0.01, rerange: false });
    const cut = series.map((s, i) => i === 0 ? s : { ...s, lpShare: 0.5, feeProtocol: 68 });
    const less = replayCandles(bars, { ...BASE, samples: cut }, { label: 'stay', bandPct: 0.01, rerange: false });
    expect(less.fees).toBeLessThan(full.fees);
    const tier = series.map((s) => ({ ...s, feeTier: 100 }));
    const cheap = replayCandles(bars, { ...BASE, samples: tier }, { label: 'stay', bandPct: 0.01, rerange: false });
    expect(cheap.fees).toBeCloseTo(full.fees * (100 / 500), 6);
  });

  it('weights the ETH fee share by the sampled swap value', () => {
    const samples = [
      { ...sample(0, '1'), swaps: 1, ethValueShare: 0.1, feeQuote: 10, feeEthUsd: 90 },
      { ...sample(1, '1'), swaps: 100, ethValueShare: 0.9, feeQuote: 90, feeEthUsd: 10 },
    ];
    // 100 / 200 = 0.5 by value. A swap-count weighting would sit near 0.9.
    expect(weightedEthShare(samples)).toBeCloseTo(0.5, 8);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('real GeckoTerminal candle fixtures', () => {
  const eth = fixtureRows(eth1h);
  const minute = fixtureRows(eth1m);
  const hood = fixtureRows(hood5m);
  const hoodHour = fixtureRows(hood1h);

  it('keeps the attached series, including the ones that are not the headline window', () => {
    expect(eth).toHaveLength(2198);
    expect(eth[0].t).toBe(1785222000);
    expect(eth[eth.length - 1].t).toBe(1793131200);
    expect(eth[1].t - eth[0].t).toBe(3600);
    expect(minute).toHaveLength(4000);
    expect((minute[minute.length - 1].t - minute[0].t) / 86400).toBeLessThan(4);
    expect(hood).toHaveLength(2898);
    expect(hood[1].t - hood[0].t).toBe(300);
    expect(hoodHour).toHaveLength(2198);
    expect(eth1h.note).toMatch(/GeckoTerminal/);
    expect(hood5m.note).toMatch(/before_timestamp/);
    expect(JSON.stringify(eth1h)).not.toMatch(/0x4168/);
    expect(JSON.stringify(ethLiq)).not.toMatch(/0x4168/);
    expect(JSON.stringify(hoodLiq)).not.toMatch(/0x4168/);
    expect(README_WEEK_START).toBe(1792368000);
    expect(README_WEEK_END).toBe(1792972800);
    expect(sliceHalfOpen(hood, README_WEEK_START, README_WEEK_END)).toHaveLength(2016);
    expect(formatDetroit(README_WEEK_START)).toMatch(/EDT|EST/);
    expect(HOOD_GAS_PER_ACTION).toBeCloseTo(1.12 / 23, 12);
    expect(REPLAY_LABEL).toBe('Replay model on real candles, not actual bot results');
    expect(formatCandleTable({
      title: 't', window: 'w', source: '', assumptions: [], quote: 'USDC',
      rows: [replayCandles([flat(0, 100, 1), flat(3600, 100, 1)], BASE, { label: 'Stay put', bandPct: 0.01, rerange: false })],
    })).toContain(REPLAY_LABEL);
  });
});

describe('sampled liquidity on the real candle windows', () => {
  const ethSeries = loadSeries(ethLiq as LiquiditySeries);
  const hoodSeries = loadSeries(hoodLiq as LiquiditySeries);
  const eth = ethUsdcTable(fixtureRows(eth1h), ethSeries);
  const hood = hoodWeekTable(fixtureRows(hood5m), hoodSeries);

  it('rejects a sample whose LP share was not derived from feeProtocol', () => {
    const broken = {
      ...ethSeries,
      samples: ethSeries.samples.map((s, i) => (i === 0 ? { ...s, lpShare: 0.5 } : s)),
    };
    expect(() => loadSeries(broken)).toThrow(/feeProtocol/);
  });

  it('uses the same 6-hour series for every setting', () => {
    expect(ethSeries.samples).toHaveLength(121);
    expect(hoodSeries.samples).toHaveLength(29);
    expect(ethSeries.setFeeProtocolEvents).toBe(0);
    expect(hoodSeries.setFeeProtocolEvents).toBe(0);
    expect(ethSeries.samples.every((s) => s.feeTier === 500 && s.feeProtocol === 68 && s.lpShare === 0.75)).toBe(true);
    expect(hoodSeries.samples.every((s) => s.feeTier === 100 && s.feeProtocol === 68 && s.lpShare === 0.75)).toBe(true);
    expect(ethSeries.archive).toMatch(/reached every sample/);
    expect(hoodSeries.archive).toMatch(/historical state is not available/);
    expect(new Set(eth.rows.map((r) => r.samples))).toEqual(new Set([121]));
    expect(new Set(hood.rows.map((r) => r.samples))).toEqual(new Set([29]));
    expect(eth.rows.map((r) => r.moves)).toEqual([79, 5, 9, 0]);
    expect(hood.rows.map((r) => r.moves)).toEqual([30, 2, 2, 0]);
    for (const row of [...eth.rows, ...hood.rows]) {
      expect(row.net).toBeCloseTo(row.fees - row.gas - row.swapCost - row.moveLoss, 6);
    }
    // A pool stuck at the fattest sample pays the position less than the sampled path.
    const fat = (series: LiquiditySeries): LiquiditySeries => {
      const top = series.samples.reduce((a, s) => (BigInt(s.liquidity) > BigInt(a.liquidity) ? s : a));
      return { ...series, samples: [{ ...top, t: 0 }] };
    };
    const ethFat = ethUsdcTable(fixtureRows(eth1h), fat(ethSeries));
    const hoodFat = hoodWeekTable(fixtureRows(hood5m), fat(hoodSeries));
    expect(eth.rows[3].fees).toBeGreaterThan(ethFat.rows[3].fees);
    expect(hood.rows[3].fees).toBeGreaterThan(hoodFat.rows[3].fees);
    expect(ethFat.rows[3].moves).toBe(0);
    expect(hoodFat.rows[3].moves).toBe(0);
  });

  it('locks the per-day token headline and the cost columns', () => {
    const ethText = formatCandleTable(eth);
    const hoodText = formatCandleTable(hood);
    expect(ethText.match(new RegExp(REPLAY_LABEL, 'g'))).toHaveLength(2);
    expect(hoodText.match(new RegExp(REPLAY_LABEL, 'g'))).toHaveLength(2);
    expect(ethText).toContain('Sep 27, 2026, 16:00 EDT – Oct 27, 2026, 16:00 EDT');
    expect(hoodText).toContain('Oct 18, 2026, 20:00 EDT – Oct 25, 2026, 19:55 EDT');
    expect(ethText).not.toMatch(/recommend/i);
    expect(hoodText).not.toMatch(/recommend/i);
    const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('Setting'));
    expect(lines(ethText)).toEqual([
      '| Defaults (±1%, move on the first close outside) | 0.011479 ETH and -53.21 USDC <small>(-24.29 USD)</small> / day |',
      '| Preset A (±2%, 12h outside, 24h cooldown) | 0.005822 ETH and -6.32 USDC <small>(8.38 USD)</small> / day |',
      '| Preset B (±3%, 4h outside, 12h cooldown) | 0.004719 ETH and -17.05 USDC <small>(-5.21 USD)</small> / day |',
      '| Stay put (±1%, auto-move off) | 0.002994 ETH and 7.60 USDC <small>(15.66 USD)</small> / day |',
      '| Defaults (±1%, move on the first close outside) | -728.69 | 1828.76 | 69.20 | 153.47 | 2334.78 | 79 | 93.8% |',
      '| Preset A (±2%, 12h outside, 24h cooldown) | 251.31 | 869.71 | 4.69 | 13.31 | 600.40 | 5 | 78.4% |',
      '| Preset B (±3%, 4h outside, 12h cooldown) | -156.42 | 708.85 | 8.18 | 21.71 | 835.39 | 9 | 92.7% |',
      '| Stay put (±1%, auto-move off) | 469.73 | 472.44 | 0.33 | 2.39 | 0.00 | 0 | 24.8% |',
    ]);
    expect(lines(hoodText)).toEqual([
      '| Defaults (±1%, move on the first close outside) | 0.002087 ETH and -8.39 USDG <small>(-3.38 USD)</small> / day |',
      '| Preset A (±2%, 12h outside, 24h cooldown) | 0.000746 ETH and -1.96 USDG <small>(-0.17 USD)</small> / day |',
      '| Preset B (±3%, 4h outside, 12h cooldown) | 0.000607 ETH and -2.70 USDG <small>(-1.24 USD)</small> / day |',
      '| Stay put (±1%, auto-move off) | 0.000865 ETH and 2.00 USDG <small>(4.08 USD)</small> / day |',
      '| Defaults (±1%, move on the first close outside) | -23.63 | 69.14 | 1.51 | 2.95 | 88.32 | 30 | 99.2% |',
      '| Preset A (±2%, 12h outside, 24h cooldown) | -1.20 | 24.68 | 0.15 | 0.30 | 25.44 | 2 | 76.4% |',
      '| Preset B (±3%, 4h outside, 12h cooldown) | -8.70 | 20.14 | 0.15 | 0.30 | 28.40 | 2 | 88.0% |',
      '| Stay put (±1%, auto-move off) | 28.54 | 28.69 | 0.05 | 0.10 | 0.00 | 0 | 40.7% |',
    ]);
    expect(eth.assumptions.join('\n')).toContain('779.34 / 525.20 / 436.86');
    expect(hood.assumptions.join('\n')).toContain('93.51 / 29.44 / 25.51');
    expect(eth.assumptions.join('\n')).toContain('8887 swaps');
    expect(hood.assumptions.join('\n')).toContain('10845 swaps');
  });
});
