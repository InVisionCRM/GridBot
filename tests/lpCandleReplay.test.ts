import { describe, expect, it } from 'vitest';
import eth1h from './fixtures/eth-usdc-005-1h.json';
import eth1m from './fixtures/eth-usdc-005-1m.json';
import hood1h from './fixtures/hood-ethusdg-1h.json';
import hood5m from './fixtures/hood-ethusdg-5m.json';
import {
  ETH_USDC_ACTIVE_L, ETH_USDC_MARKET, HOOD_ETH_USDG_ACTIVE_L, HOOD_GAS_PER_ACTION,
  README_WEEK_END, README_WEEK_START, ethUsdcTable, fixtureRows, formatCandleTable, hoodWeekTable,
  replayCandles, sliceHalfOpen, type CandleMarket, type Ohlcv,
} from '../src/market/lpCandleReplay';

const flat = (t: number, price: number, v = 0): Ohlcv => ({ t, o: price, h: price, l: price, c: price, v });

const ZERO_GAS: CandleMarket = {
  fee: 0.0005, lpShare: 0.75, lPool: 1e18, k: 1, lScale: 1e12,
  gasOpen: 0, gasMove: 0, impactBps: 1, capital: 1000,
};

describe('candle replay uses the bot clock', () => {
  it('moves on the first close outside, and a longer dwell does not', () => {
    const bars = [flat(0, 100), flat(3600, 110), flat(7200, 110)];
    const now = replayCandles(bars, ZERO_GAS, { label: 'now', bandPct: 0.01, rerange: true });
    const dwell = replayCandles(bars, ZERO_GAS, {
      label: 'dwell', bandPct: 0.01, rerange: true, range: { dwellMin: 180 },
    });
    expect(now.moves).toBe(1);
    expect(now.moveLoss).toBeGreaterThan(0);
    expect(dwell.moves).toBe(0);
    expect(dwell.moveLoss).toBe(0);
  });

  it('a cooldown holds the second move; dwell 0 does not', () => {
    const bars = [flat(0, 100), flat(3600, 110), ...Array.from({ length: 8 }, (_, i) => flat(7200 + i * 3600, 120))];
    const now = replayCandles(bars, ZERO_GAS, { label: 'now', bandPct: 0.01, rerange: true });
    const cooled = replayCandles(bars, ZERO_GAS, {
      label: 'cool', bandPct: 0.01, rerange: true, range: { cooldownMin: 24 * 60 },
    });
    expect(now.moves).toBe(2);
    expect(cooled.moves).toBe(1);
    expect(cooled.moveLoss).toBeLessThan(now.moveLoss);
  });

  it('stay put never locks in a move loss', () => {
    const bars = [flat(0, 100), flat(3600, 110), flat(7200, 90)];
    const stay = replayCandles(bars, ZERO_GAS, { label: 'stay', bandPct: 0.01, rerange: false });
    expect(stay.moves).toBe(0);
    expect(stay.moveLoss).toBe(0);
  });

  it('without active liquidity the fee and the net are unset, and the move still counts', () => {
    const bars = [flat(0, 100, 1e6), flat(3600, 110, 1e6)];
    const blind: CandleMarket = { ...ZERO_GAS, lPool: null };
    const r = replayCandles(bars, blind, { label: 'now', bandPct: 0.01, rerange: true });
    expect(r.moves).toBe(1);
    expect(r.fees).toBeNull();
    expect(r.net).toBeNull();
    expect(r.gas).toBe(0);
  });

  it('fees match the volume × share formula on two in-range bars', () => {
    const bars = [flat(0, 100, 1_000_000), flat(3600, 100, 1_000_000)];
    const r = replayCandles(bars, ZERO_GAS, { label: 'stay', bandPct: 0.01, rerange: false });
    // Worked independently of this module: L ≈ 10021.70, share ≈ 0.009922, two bars ≈ 7.44169.
    expect(r.moves).toBe(0);
    expect(r.inRange).toBe(1);
    expect(r.fees).toBeCloseTo(7.441693395795617, 8);
    expect(r.swapCost).toBeCloseTo(0.2985037219676416, 8);
    expect(r.net).toBeCloseTo(r.fees! - r.gas - r.swapCost - r.moveLoss, 8);
    expect(r.net).toBeCloseTo(7.143189673827975, 8);
  });
});

describe('real GeckoTerminal fixtures', () => {
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
  });

  it('the Ethereum headline is the last 30 days of the hourly file', () => {
    const table = ethUsdcTable(eth);
    expect(table.rows).toHaveLength(4);
    expect(table.rows[0].bars).toBe(721);
    expect(table.rows[0].days).toBeCloseTo(30, 5);
    const text = formatCandleTable(table);
    expect(text).toContain('| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |');
    expect(text.toLowerCase()).not.toContain('recommend');
    expect(text).not.toContain('-236.68');
    const [defaults, a, b, stay] = table.rows;
    expect(defaults.moves).toBe(79);
    expect(defaults.inRange).toBeCloseTo(0.938253683659459, 8);
    expect(defaults.fees).toBeCloseTo(1918.0105992387855, 6);
    expect(defaults.gas).toBeCloseTo(69.2012115, 6);
    expect(defaults.swapCost).toBeCloseTo(153.47129958175003, 6);
    expect(defaults.moveLoss).toBeCloseTo(2334.7792584634017, 6);
    expect(defaults.net).toBeCloseTo(-639.4411703063661, 6);
    expect(a.moves).toBe(5);
    expect(a.inRange).toBeCloseTo(0.7837500093639388, 8);
    expect(a.net).toBeCloseTo(307.435633547322, 6);
    expect(a.fees).toBeCloseTo(925.8374036213676, 6);
    expect(b.moves).toBe(9);
    expect(b.net).toBeCloseTo(-124.670381422471, 6);
    expect(stay.moves).toBe(0);
    expect(stay.moveLoss).toBe(0);
    expect(stay.inRange).toBeCloseTo(0.24769429068676804, 8);
    expect(stay.net).toBeCloseTo(574.5961100834836, 6);
    for (const r of table.rows) expect(r.net).toBeCloseTo(r.fees! - r.gas - r.swapCost - r.moveLoss, 6);
    // Preset A versus a hold of the opening mix is not the published +359.
    expect(a.netVsHold).toBeCloseTo(301.53452438708973, 6);
    expect(ETH_USDC_MARKET.k).toBe(0.958);
    expect(ETH_USDC_MARKET.capital).toBe(8000);
    expect(ETH_USDC_ACTIVE_L).toBeGreaterThan(2.3e18);
    expect(ETH_USDC_ACTIVE_L).toBeLessThan(2.4e18);
  });

  it('the Robinhood headline is the README week of 5-minute bars', () => {
    expect(README_WEEK_START).toBe(1792368000);
    expect(README_WEEK_END).toBe(1792972800);
    const week = sliceHalfOpen(hood, README_WEEK_START, README_WEEK_END);
    expect(week).toHaveLength(2016);
    const table = hoodWeekTable(hood);
    const text = formatCandleTable(table);
    expect(text.split('\n')[3]).toBe('| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |');
    const [defaults, a, b, stay] = table.rows;
    expect(defaults.moves).toBe(30);
    expect(defaults.inRange).toBeCloseTo(0.9917464706765557, 8);
    expect(defaults.net).toBeCloseTo(1.6691337509760018, 6);
    expect(defaults.fees).toBeCloseTo(94.44515000238573, 6);
    expect(defaults.moveLoss).toBeCloseTo(88.31698660608322, 6);
    expect(a.moves).toBe(2);
    expect(a.net).toBeCloseTo(8.303105319881176, 6);
    expect(b.moves).toBe(2);
    expect(b.net).toBeCloseTo(-0.5079888626966174, 6);
    expect(stay.moves).toBe(0);
    expect(stay.moveLoss).toBe(0);
    expect(stay.inRange).toBeCloseTo(0.40663582915246665, 8);
    expect(stay.fees).toBeCloseTo(46.75356671327142, 6);
    expect(stay.net).toBeCloseTo(46.60536982044163, 6);
    expect(defaults.gas).toBeCloseTo(HOOD_GAS_PER_ACTION * (30 + 1), 8);
    expect(HOOD_ETH_USDG_ACTIVE_L).toBeGreaterThan(1.9e18);
    expect(HOOD_ETH_USDG_ACTIVE_L).toBeLessThan(2e18);
    for (const r of table.rows) expect(r.net).toBeCloseTo(r.fees! - r.gas - r.swapCost - r.moveLoss, 6);
  });
});
