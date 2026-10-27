import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskCache, decodeV3Snapshot, geckoOhlcvUrl, invertCandles, parseDexscreenerOhlcv, parseGeckoOhlcv } from '../src/backtest/adapters';
import { candleLpFees, lpShareForFeeTier } from '../src/backtest/feeModel';
import { GAS_UNITS, gasQuote } from '../src/backtest/gasModel';
import { renderMarkdown, unlabeledNumberLines, type BotSummary } from '../src/backtest/report';
import { liveEngines, minutesFromCandles, runBot, type BotConfig, type HarnessData } from '../src/backtest/run';
import { maxCapitalWhereMarginalHolds, scoreOpportunity } from '../src/backtest/score';
import { blockReason, calibrateBot, calibrationMarkdown, loadAppState, NO_STATE_NOTE, replayExit, stripCredentials, ZERO_REPLAY_WARNING } from '../src/backtest/state';
import { lpShouldMove } from '../src/market/lpMove';
import { DEFAULT_TREND } from '../src/market/strategy';
import type { Candle } from '../src/market/candles';
import type { PoolMinute } from '../src/market/lpReplay';
import { V3_POOL, V3_POOL_FEES, V3_POOL_LP } from '../src/server/dex/abis';

const T = -200_000;
const T0 = Date.UTC(2026, 9, 19) / 1000;
/** Frozen so the ±1% stay case lands on the README figure. */
const README_F1 = 1.8546944584274794e-10;

function rhMinutes(f1 = README_F1, liq = 1e24): PoolMinute[] {
  return Array.from({ length: 169 }, (_, i) => {
    const inside = i === 0 || i % 5 < 2;
    const c = inside ? T : T + 2000;
    return { t: T0 + i * 3600, lo: c, hi: c, c, f0: 0, f1, liq, n: 1 };
  });
}

const rhCfg: BotConfig = {
  kind: 'lp', chain: 'robinhood', dex: 'uniswap-v3', pool: 'pool-rh',
  base: { symbol: 'WETH', decimals: 18 }, quote: { symbol: 'USDG', decimals: 6 },
  feeBps: 1, feeTier: 100, capital: 1000, bandPct: 0.01, rerange: false,
  baseIs0: true, spacing: 1, gasPriceNative: 0, gasToken: 'base', usdPerQuote: 1,
};

function gridCandles(): Candle[] {
  const t0 = 1_700_000_000;
  const closes = [120, 100, 90, 100, 110];
  return closes.map((c, i) => {
    const o = i === 0 ? 120 : closes[i - 1];
    return { t: t0 + i * 3600, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
  });
}

const gridCfg: BotConfig = {
  kind: 'grid', chain: 'pulsechain', dex: 'pulsex-v2', pool: 'pool-a',
  base: { symbol: 'WPLS', decimals: 18 }, quote: { symbol: 'USDC', decimals: 6 },
  feeBps: 30, capital: 1000, lowerPrice: 90, upperPrice: 110, gridCount: 2,
  slippageBps: 0, gasPriceNative: 0, gasToken: 'quote', reinvest: true,
};

describe('fee and gas models', () => {
  it('keeps 75% of a 0.05% pool and scales candle fees by k', () => {
    expect(lpShareForFeeTier(500)).toBe(0.75);
    expect(lpShareForFeeTier(100)).toBe(0.75);
    expect(lpShareForFeeTier(2500)).toBe(0.68);
    const base = { volumeQuote: 1_000_000, feeRate: 0.0005, lpShare: 0.75, k: 1, poolShare: 0.1, inRange: 1 };
    expect(candleLpFees({ ...base, k: 2 })).toBeCloseTo(2 * candleLpFees(base), 9);
  });

  it('uses the chain gas table', () => {
    expect(GAS_UNITS.pulsechain.approve).toBe(60_000);
    expect(GAS_UNITS.pulsechain.swap).toBe(220_000);
    expect(GAS_UNITS.ethereum.swap).toBe(180_000);
    expect(GAS_UNITS.ethereum.v3Open).toBe(402_000);
    expect(GAS_UNITS.robinhood.v3Open).toBe(460_000);
    expect(GAS_UNITS.pulsechain.v2Open).toBe(170_000);
    expect(GAS_UNITS.pulsechain.v2Close).toBe(215_000);
    expect(gasQuote('ethereum', 'swap', 1e-8, 2000)).toBeCloseTo(180_000 * 1e-8 * 2000, 6);
  });
});

describe('adapters', () => {
  it('asks GeckoTerminal for a whole-second timestamp', () => {
    const url = geckoOhlcvUrl('eth', '0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(20), 1793135234.008, { unit: 'minute', n: 15 });
    expect(url).toContain('/ohlcv/minute?');
    expect(url).toContain('aggregate=15');
    expect(url).toContain('before_timestamp=1793135234');
    expect(url).not.toContain('1793135234.008');
  });

  it('inverts a flipped pair so the quote and the volume swap sides', () => {
    const [c] = invertCandles([{ t: 1, o: 2, h: 4, l: 1, c: 2, v: 10 }]);
    expect(c.o).toBeCloseTo(0.5);
    expect(c.h).toBeCloseTo(1);
    expect(c.l).toBeCloseTo(0.25);
    expect(c.c).toBeCloseTo(0.5);
    expect(c.v).toBeCloseTo(5);
  });

  it('parses GeckoTerminal and DexScreener candles', () => {
    const g = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[200, 1, 3, 0.5, 2, 10], [100, 1, 1, 1, 1, 1]] } } });
    expect(g.map((c) => c.t)).toEqual([100, 200]);
    expect(g[1]).toMatchObject({ o: 1, h: 3, l: 0.5, c: 2, v: 10 });
    const d = parseDexscreenerOhlcv({ bars: [{ t: 5, o: 1, h: 2, l: 1, c: 2, v: 3 }] });
    expect(d).toEqual([{ t: 5, o: 1, h: 2, l: 1, c: 2, v: 3 }]);
  });

  it('reads a pool view from eth_call payloads', () => {
    const snap = decodeV3Snapshot({
      slot0: V3_POOL_FEES.encodeFunctionResult('slot0', [1000n, -200_000, 0, 1, 1, 68, true]),
      liquidity: V3_POOL.encodeFunctionResult('liquidity', [1234n]),
      token0: V3_POOL.encodeFunctionResult('token0', ['0x0000000000000000000000000000000000000001']),
      token1: V3_POOL.encodeFunctionResult('token1', ['0x0000000000000000000000000000000000000002']),
      fee: V3_POOL.encodeFunctionResult('fee', [500]),
      tickSpacing: V3_POOL_LP.encodeFunctionResult('tickSpacing', [10]),
    });
    expect(snap.tick).toBe(-200_000);
    expect(snap.fee).toBe(500);
    expect(snap.feeProtocol).toBe(68);
    expect(snap.tickSpacing).toBe(10);
    expect(snap.liquidity).toBe('1234');
    expect(snap.source).toBe('on-chain actual');
  });

  it('caches a payload on disk and does not load it twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-'));
    let loads = 0;
    const first = await diskCache(dir, 'candle-key', async () => { loads++; return { n: 1 }; });
    const second = await diskCache(dir, 'candle-key', async () => { loads++; return { n: 2 }; });
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.value).toEqual({ n: 1 });
    expect(loads).toBe(1);
  });
});

describe('markdown', () => {
  const summary = (): BotSummary => runBot(rhCfg, { minutes: rhMinutes() });

  it('leads with token rates, labels every number, and footnotes a 7 day window', () => {
    const s = summary();
    const total = s.rates[0].perDay * 7;
    expect(Math.abs(total - 27.24)).toBeLessThanOrEqual(1);
    expect(s.moves).toBe(0);
    expect(s.timeInRange).toBeCloseTo(67 / 168, 6);
    const md = renderMarkdown([s], { from: T0, to: T0 + 7 * 86_400 });
    const lines = md.split('\n').filter((l) => l.startsWith('**'));
    expect(lines[0]).toMatch(/USDG\/day \(modeled\)/);
    expect(lines[1]).toMatch(/WETH\/day \(modeled\)/);
    expect(md).not.toMatch(/per month|\/month/);
    expect(md).toMatch(/not the default last 30 days/);
    expect(unlabeledNumberLines(md)).toEqual([]);
  });

  it('does not add the footnote on a 30 day window', () => {
    const s = summary();
    const from = T0;
    const md = renderMarkdown([s], { from, to: from + 30 * 86_400 });
    expect(md).not.toMatch(/not the default/);
    expect(md).toMatch(/Last 30 days \(modeled\)/);
    expect(unlabeledNumberLines(md)).toEqual([]);
  });
});

describe('replay uses the live rules', () => {
  it('moves an ETH/USDC range after 12h outside and not again until the 24h cooldown', () => {
    const tickAt = (i: number) => {
      if (i <= 2 || (i >= 9 && i <= 10)) return T;
      if (i <= 23) return T + 400;
      return T + 800;
    };
    const rows = (n: number): PoolMinute[] => Array.from({ length: n }, (_, i) => {
      const c = tickAt(i);
      return { t: T0 + i * 3600, lo: c, hi: c, c, f0: 0, f1: 0, liq: 1e24, n: 1 };
    });
    const cfg: BotConfig = {
      ...rhCfg, chain: 'ethereum', quote: { symbol: 'USDC', decimals: 6 }, base: { symbol: 'WETH', decimals: 18 },
      feeBps: 5, feeTier: 500, bandPct: 0.02, spacing: 10, rerange: true, dwellMs: 12 * 3600_000, cooldownMs: 24 * 3600_000,
    };
    expect(runBot(cfg, { minutes: rows(11) }).moves).toBe(0);
    expect(runBot(cfg, { minutes: rows(24) }).moves).toBe(1);
    expect(runBot(cfg, { minutes: rows(49) }).moves).toBe(2);
    const held = runBot(cfg, { minutes: rows(49) }, { ...liveEngines, lpShouldMove: () => ({ move: false, outSince: null }) });
    expect(held.moves).toBe(0);
  });

  it('follows dwell and cooldown on the shared move rule', () => {
    const now = 1_000_000;
    expect(lpShouldMove({ rerange: true, outOfRange: false, blocked: false, now, outSince: null, lastMoveAt: null }).move).toBe(false);
    const waiting = lpShouldMove({ rerange: true, outOfRange: true, blocked: false, now, outSince: now - 1000, lastMoveAt: null, dwellMs: 10_000 });
    expect(waiting.move).toBe(false);
    expect(lpShouldMove({ rerange: true, outOfRange: true, blocked: false, now, outSince: now - 10_000, lastMoveAt: null, dwellMs: 10_000 }).move).toBe(true);
    expect(lpShouldMove({ rerange: true, outOfRange: true, blocked: false, now, outSince: now - 10_000, lastMoveAt: now - 1000, dwellMs: 10_000, cooldownMs: 5000 }).move).toBe(false);
  });

  it('fills a grid from evaluateTick, and not when that rule queues nothing', () => {
    const candles = gridCandles();
    const real = runBot(gridCfg, { candles, poolDepth: { quoteReserve: 1e8, baseReserve: 1e6 } });
    expect(real.moves).toBeGreaterThan(0);
    const quiet = runBot(gridCfg, { candles, poolDepth: { quoteReserve: 1e8, baseReserve: 1e6 } }, {
      ...liveEngines,
      evaluateTick: (intervals) => ({ intervals, queued: [] }),
    });
    expect(quiet.moves).toBe(0);
  });

  it('takes no trend trade when the signal never enters', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 3600, o: 100, h: 101, l: 99, c: 100, v: 1 }));
    const cfg: BotConfig = { ...gridCfg, kind: 'trend', trend: { ...DEFAULT_TREND }, tf: '1h' };
    const s = runBot(cfg, { candles }, { ...liveEngines, signalAt: () => ({ enter: false, exit: false, note: '' }) });
    expect(s.moves).toBe(0);
  });

  it('sells a token position on the hard stop', () => {
    const candles: Candle[] = [
      { t: T0, o: 100, h: 100, l: 100, c: 100, v: 10 },
      { t: T0 + 3600, o: 100, h: 100, l: 70, c: 70, v: 10 },
    ];
    const cfg: BotConfig = { ...gridCfg, kind: 'token', capital: 100, perTradeUsd: 100, totalUsd: 100, maxImpact: 0.5 };
    const s = runBot(cfg, { candles });
    expect(s.simFills.some((f) => f.side === 'sell')).toBe(true);
  });
});

describe('scoreOpportunity', () => {
  it('returns the router shape, a five-point curve, and a shallow-pool cap', () => {
    const minutes = rhMinutes(1e-9, 1e16);
    const s = scoreOpportunity({ ...rhCfg, bandPct: 0.05 }, { from: T0, to: T0 + 168 * 3600, minutes });
    expect(s.chain).toBe('robinhood');
    expect(s.dex).toBe('uniswap-v3');
    expect(s.pool).toBe('pool-rh');
    expect(s.botType).toBe('lp');
    expect(s.horizonDays).toBe(7);
    expect(s.source).toBe('modeled');
    expect(s.asOf).toBe(new Date((T0 + 168 * 3600) * 1000).toISOString());
    expect(s.capitalUsd).toBe(1000);
    expect(Object.keys(s.ratePerDay).sort()).toEqual(['USDG', 'WETH']);
    expect(s.confidence.p10UsdPerDay).toBeLessThanOrEqual(s.confidence.p50UsdPerDay);
    expect(s.confidence.p50UsdPerDay).toBeLessThanOrEqual(s.confidence.p90UsdPerDay);
    expect(typeof s.confidence.oosStable).toBe('boolean');
    expect(s.ratePerDayAt.map((p) => p.capitalUsd)).toEqual([250, 1000, 2000, 4000, 10000]);
    const one = s.ratePerDayAt[1].usdPerDay;
    const ten = s.ratePerDayAt[4].usdPerDay;
    expect(ten).toBeLessThan(one * 10);
    expect(s.maxCapitalUsd).toBe(4000);
    expect(s.maxCapitalUsd).toBe(maxCapitalWhereMarginalHolds(s.ratePerDayAt, s.ratePerDayAt[1]));
  });

  it('lowers the grid cap when pool depth makes larger fills cost more', () => {
    const candles = gridCandles();
    const from = candles[0].t;
    const to = candles[candles.length - 1].t + 3600;
    const s = scoreOpportunity(gridCfg, { from, to, candles, poolDepth: { quoteReserve: 100_000, baseReserve: 1_000 }, horizonDays: 1 });
    const per = s.ratePerDayAt.map((p) => p.usdPerDay / p.capitalUsd);
    expect(s.ratePerDayAt[1].usdPerDay).toBeGreaterThan(0);
    for (let i = 1; i < per.length; i++) expect(per[i]).toBeLessThan(per[i - 1]);
    expect(s.maxCapitalUsd).toBe(2000);
    expect(s.maxCapitalUsd).toBeLessThan(s.capitalUsd * 10);
  });

  it('refuses to score without a series', () => {
    expect(() => scoreOpportunity(rhCfg, { from: T0, to: T0 + 86_400 })).toThrow(/candles or pool minutes/);
  });
});

describe('app state', () => {
  const fixture = join(__dirname, 'fixtures', 'state.json');
  const loaded = () => loadAppState(fixture);

  it('replays every saved bot, on the chain named by its market key', () => {
    const state = loaded();
    expect(state.source).toBe('state');
    expect(state.note).toMatch(/loaded from the app state/);
    expect(state.note).toMatch(/Defaults were not used/);
    expect(state.bots.map((b) => b.id)).toEqual([
      'g-mvowdsys-i5iq', 'g-mvnlyq6p-76zc', 'g-mvpdla8b-fmkg',
      'lp-mvnm73sx-hghe', 'lp-mvkbewe0-ldou', 'lp-mvfv3g7g-to6l',
    ]);
    const chain: Record<string, string> = {
      'g-mvowdsys-i5iq': 'pulsechain',
      'g-mvnlyq6p-76zc': 'ethereum',
      'g-mvpdla8b-fmkg': 'pulsechain',
      'lp-mvnm73sx-hghe': 'ethereum',
      'lp-mvkbewe0-ldou': 'pulsechain',
      'lp-mvfv3g7g-to6l': 'robinhood',
    };
    for (const bot of state.bots) {
      expect(blockReason(bot.config)).toBeNull();
      expect(bot.config.chain).toBe(chain[bot.id]);
      expect(bot.config.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(bot.config.base.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    const hex = state.bots[0];
    expect(hex.config.base.symbol).toBe('HEX');
    expect(hex.config.base.decimals).toBe(8);
    expect(hex.config.quote.symbol).toBe('PLS');
    const usdc = state.bots[1];
    expect(usdc.config.quote.symbol).toBe('USDC');
    expect(usdc.config.quote.decimals).toBe(6);
    const dai = state.bots[2];
    expect(dai.config.base.symbol).toBe('PLS');
    expect(dai.config.quote.symbol).toBe('DAI');
    expect(dai.config.quote.decimals).toBe(18);
    const live = state.bots[3];
    expect(live.config.base.symbol).toBe('USDC');
    expect(live.config.base.decimals).toBe(6);
    expect(live.config.quote.symbol).toBe('ETH');
    expect(live.config.quote.decimals).toBe(18);
    expect(live.config.baseIs0).toBe(true);
    expect(live.config.gasToken).toBe('quote');
    expect(live.actual?.moves).toBe(3);
    expect(live.window && (live.window.to - live.window.from) / 86_400).toBeCloseTo(2.49, 1);
    const hood = state.bots[5];
    expect(hood.config.quote.symbol).toBe('USDG');
    expect(hood.config.quote.decimals).toBe(6);
  });

  it('runs every fixture bot instead of skipping it, and prints a calibration error for grids and LPs', () => {
    const state = loaded();
    const spot: Record<string, number> = {
      'g-mvowdsys-i5iq': 222, 'g-mvnlyq6p-76zc': 2300, 'g-mvpdla8b-fmkg': 5.3e-6,
      'lp-mvnm73sx-hghe': 0.00043, 'lp-mvkbewe0-ldou': 220, 'lp-mvfv3g7g-to6l': 2400,
    };
    for (const bot of state.bots) {
      const t0 = 1_700_000_000;
      const p = spot[bot.id];
      const candles = [0, 1, 2, 3].map((i) => ({ t: t0 + i * 3600, o: p, h: p * 1.002, l: p * 0.998, c: p, v: p }));
      const data: HarnessData = bot.config.kind === 'lp'
        ? { minutes: minutesFromCandles(candles, bot.config, 1e30), poolLiquidity: 1e30 }
        : { candles, poolDepth: bot.depth ?? { quoteReserve: 1e12, baseReserve: 1e12 } };
      const summary = runBot(bot.config, data);
      expect(summary.rates).toHaveLength(2);
      const cal = calibrateBot(bot, data);
      expect(cal.fitted).toBe(true);
      const md = calibrationMarkdown(cal);
      expect(md).toMatch(/Calibration error/);
      expect(unlabeledNumberLines(md)).toEqual([]);
    }
  });

  it('replays the HEX/PLS grid, which bought and never sold, to about zero net', () => {
    const hex = loaded().bots.find((b) => b.id === 'g-mvowdsys-i5iq')!;
    expect(hex.fills.filter((f) => f.side === 'buy')).toHaveLength(2);
    expect(hex.fills.filter((f) => f.side === 'sell')).toHaveLength(0);
    const t0 = hex.window?.from ?? 1_700_000_000;
    const path = [222.99, 224.33, 223.2, 220.77];
    const candles = path.map((c, i) => {
      const o = i === 0 ? c : path[i - 1];
      return { t: t0 + i * 3600, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
    });
    const s = runBot(hex.config, { candles, poolDepth: hex.depth });
    const days = (candles[candles.length - 1].t - candles[0].t) / 86_400;
    expect(s.simFills.filter((f) => f.side === 'sell')).toHaveLength(0);
    expect(Math.abs(s.rates[0].perDay * days)).toBeLessThan(1);
    expect(s.rates[1].perDay).toBe(0);
  });

  it('replays the live ETH/USDC LP close to its recorded totals', () => {
    const live = loaded().bots.find((b) => b.id === 'lp-mvnm73sx-hghe')!;
    const candles = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'eth-usdc-lp-15m.json'), 'utf8')) as Candle[];
    expect(candles.length).toBeGreaterThan(100);
    // Open plus three moves, at the gas the bot actually paid, so a matching move count matches the recorded gas.
    const openUnits = 402_000 + 180_000 + 2 * 60_000;
    const moveUnits = 402_000 + 250_000 + 180_000 + 60_000;
    const gasPriceNative = live.actual!.gas / (openUnits + live.actual!.moves * moveUnits);
    const cfg: BotConfig = {
      ...live.config,
      gasPriceNative,
      quotePerNative: 1,
      spacing: 10,
      baseIs0: true,
    };
    const data: HarnessData = { candles, poolLiquidity: 2_381_335_368_967_757_228 };
    const cal = calibrateBot({ ...live, config: cfg }, data);
    expect(cal.fitted).toBe(true);
    expect(cal.error!.recorded).toBe(3);
    expect(cal.error!.replayed).toBe(3);
    const run = runBot(cal.config, data);
    const note = (label: string) => run.modelNotes.find((n) => n.label === label)!.value;
    const net = note('Fees collected') - note('Gas') - note('Swap cost') - note('Move loss');
    const recorded = live.actual!.fees - live.actual!.gas - live.actual!.swapCost - live.actual!.moveLoss;
    const days = (candles[candles.length - 1].t - candles[0].t) / 86_400;
    expect(days).toBeGreaterThan(2.2);
    expect(days).toBeLessThan(2.8);
    expect(run.moves).toBe(3);
    expect(cal.config.dwellMs).toBe(15 * 60_000);
    // Recorded earned-after-costs is +0.0125 ETH over 2.49 days (about +0.005 ETH/day). A 15-minute dwell
    // matches the 3 moves; the quote-valued replay lands within 0.005 ETH of that total.
    expect(Math.abs(net - recorded)).toBeLessThan(0.005);
    expect(Math.abs(net / days - recorded / ((live.window!.to - live.window!.from) / 86_400))).toBeLessThan(0.003);
    const md = calibrationMarkdown(cal);
    expect(md).toMatch(/Calibration error/);
    expect(unlabeledNumberLines(md)).toEqual([]);
  });

  it('fails the run when state is present and nothing was replayed', () => {
    expect(replayExit('state', 18, 0)).toBe(1);
    expect(replayExit('state', 18, 1)).toBe(0);
    expect(replayExit('defaults', 2, 2)).toBe(0);
    expect(ZERO_REPLAY_WARNING).toMatch(/WARNING/);
    expect(ZERO_REPLAY_WARNING).toMatch(/0 bots were replayed/);
  });

  it('fits a grid fee and fill model to recorded fills', () => {
    const data: HarnessData = { candles: gridCandles(), poolDepth: { quoteReserve: 1e8, baseReserve: 1e6 } };
    const made = runBot({ ...gridCfg, slippageBps: 10 }, data);
    const cal = calibrateBot({
      id: 'g-paper',
      config: gridCfg,
      fills: made.simFills.map((f) => ({ ...f, levelPrice: null })),
    }, data);
    expect(cal.fitted).toBe(true);
    expect(cal.feeK).toBe(1);
    expect(cal.slippageBps).toBe(10);
    expect(cal.error!.recorded).toBe(made.simFills.length);
    expect(cal.error!.replayed).toBe(made.simFills.length);
    expect(cal.error!.combined).toBeLessThan(1e-6);
    expect(unlabeledNumberLines(calibrationMarkdown(cal))).toEqual([]);
  });

  it('says so when the state file is missing and uses the examples only then', () => {
    const missing = loadAppState(join(tmpdir(), 'no-such-state.json'));
    expect(missing.source).toBe('defaults');
    expect(missing.note).toBe(NO_STATE_NOTE);
    expect(missing.bots.map((b) => b.id)).toEqual(['default-eth-usdc', 'default-hex-wpls']);
    expect(missing.bots.every((b) => b.fills.length === 0)).toBe(true);
  });

  it('does not keep a credential that was nested in the file', () => {
    const raw = {
      grids: [{ config: { lowerPrice: 1 }, wallet: { ['private' + 'Key']: 'hidden-value', note: 'ok' } }],
      ['seed' + 'Phrase']: 'hidden-phrase',
    };
    const clean = JSON.stringify(stripCredentials(raw));
    expect(clean).not.toContain('hidden-value');
    expect(clean).not.toContain('hidden-phrase');
    expect(clean).toContain('ok');
  });
});

describe('harness sources', () => {
  it('does not load the process environment', () => {
    const dir = join(__dirname, '..', 'src', 'backtest');
    for (const name of ['run.ts', 'score.ts', 'state.ts', 'adapters.ts', 'report.ts', 'index.ts']) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(/server\/env/);
    }
  });
});
