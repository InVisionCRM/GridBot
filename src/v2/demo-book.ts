/**
 * Demo stand-in for the server that will own BotMetrics.
 * settle() is the only place dollars made, total P&L, APR, and estimates are produced.
 * Views must not import this file.
 * DEMO DATA. No wallets, no keys.
 */
import type { ActivityItem, BotDesk, BotMetrics, CandleBar, DeskSnapshot, PortfolioSnapshot } from './metrics';

const DAY = 86_400;
const round = (n: number) => Math.round(n * 100) / 100;

const CALC: Record<BotMetrics['kind'], string> = {
  lp: 'Dollars made = fees collected + fees owed − gas − swap fees − taxes − rebalance loss. Total P&L = dollars made + price change. APR and estimates use dollars made.',
  grid: 'Dollars made = realized trade profit − fees − gas − taxes. Total P&L = dollars made + price change. APR and estimates use dollars made.',
  trend: 'Dollars made = realized trade profit − fees − gas − taxes. Total P&L = dollars made + price change. APR and estimates use dollars made.',
  token: 'Dollars made = realized trade profit − fees − gas − taxes. Total P&L = dollars made + price change. APR and estimates use dollars made.',
};

/** Apply the owner's formulas. Input fields are the raw parts; outputs are the headline and the rollups. */
export function settle(m: BotMetrics): BotMetrics {
  const dollarsMadeUsd = round(m.kind === 'lp'
    ? m.feesCollectedUsd + m.feesUncollectedUsd - m.gasUsd - m.swapCostUsd - m.tokenTaxesUsd - m.realizedRebalanceLossUsd
    : m.realizedUsd - m.feesCollectedUsd - m.gasUsd - m.tokenTaxesUsd);
  const totalPnlUsd = round(dollarsMadeUsd + m.priceChangeUsd);
  const totalPnlPct = m.capitalInUsd > 0 ? totalPnlUsd / m.capitalInUsd : 0;
  const enough = m.ageSec >= 60;
  const aprPct = enough && m.capitalInUsd > 0 ? (dollarsMadeUsd / m.capitalInUsd) * ((365 * DAY) / m.ageSec) : null;
  const scale = (windowSec: number) => (enough ? round(dollarsMadeUsd * (windowSec / m.ageSec)) : null);
  const feesEarnedUsd = m.kind === 'lp' ? round(m.feesCollectedUsd + m.feesUncollectedUsd) : m.feesEarnedUsd;
  return {
    ...m,
    feesEarnedUsd,
    dollarsMadeUsd,
    headline: 'dollarsMade',
    totalPnlUsd,
    totalPnlPct,
    aprPct,
    est: {
      d1: scale(DAY),
      d7: scale(7 * DAY),
      d365: scale(365 * DAY),
      needs: enough ? 'Extrapolates dollars made so far. Not a forecast.' : 'Needs about a minute of history.',
    },
    calc: CALC[m.kind],
  };
}

function bars(price: number, step: number, n: number): CandleBar[] {
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const out: CandleBar[] = [];
  let prev = price * 0.99;
  for (let i = n; i >= 0; i--) {
    const wave = Math.sin((n - i) / 7) * price * 0.0035;
    const o = prev;
    const c = price * (0.99 + 0.01 * ((n - i) / n)) + wave;
    out.push({
      t: now - i * step,
      o,
      h: Math.max(o, c) + price * 0.0012,
      l: Math.min(o, c) - price * 0.0012,
      c,
      v: 8 + (i % 7),
    });
    prev = c;
  }
  const last = out[out.length - 1];
  last.c = price;
  last.h = Math.max(last.h, price);
  last.l = Math.min(last.l, price);
  return out;
}

function series(end: number, n = 48): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    out.push(round(end * p + Math.sin(i / 4) * Math.abs(end) * 0.04));
  }
  out[out.length - 1] = end;
  return out;
}

function levels(lo: number, hi: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
  return out;
}

interface Seed {
  metrics: BotMetrics;
  pair: string;
  base: string;
  quote: string;
  chain: string;
  chainColor: string;
  dex: string;
  tone: BotDesk['tone'];
  price: number;
  change24h: number;
  step: number;
  lo?: number;
  hi?: number;
  gridLines?: number;
}

function bot(seed: Seed): BotDesk {
  const metrics = settle(seed.metrics);
  const range = seed.lo != null && seed.hi != null
    ? { lower: seed.lo, upper: seed.hi, current: seed.price, inRange: metrics.range?.inRange ?? true }
    : null;
  metrics.range = range;
  return {
    metrics,
    pair: seed.pair,
    base: seed.base,
    quote: seed.quote,
    chain: seed.chain,
    chainColor: seed.chainColor,
    dex: seed.dex,
    tone: seed.tone,
    spark: series(metrics.dollarsMadeUsd),
    levels: seed.gridLines ? levels(seed.lo ?? seed.price * 0.95, seed.hi ?? seed.price * 1.05, seed.gridLines) : [],
    candles: bars(seed.price, seed.step, 80),
    fills: [],
    flashLevel: null,
    price: seed.price,
    change24h: seed.change24h,
  };
}

const now = Date.now();

function raw(partial: BotMetrics): BotMetrics {
  return partial;
}

export interface DeskState {
  bots: BotDesk[];
  activity: ActivityItem[];
  feesTodayLiveUsd: number;
  feesTodayPaperUsd: number;
  madeSeries: number[];
}

export function buildState(): DeskState {
  const bots: BotDesk[] = [
    bot({
      pair: 'ETH/USDC', base: 'ETH', quote: 'USDC', chain: 'ETH', chainColor: '#8c9eff', dex: 'Uniswap V3',
      tone: 'in', price: 3248.2, change24h: 0.0124, step: 60, lo: 3100, hi: 3500, gridLines: 8,
      metrics: raw({
        botId: 'demo-eth', mode: 'live', kind: 'grid', status: 'running',
        startedAt: now - 18 * DAY * 1000, ageSec: 18 * DAY,
        capitalInUsd: 2500, currentValueUsd: 2724,
        realizedUsd: 210, unrealizedUsd: 48,
        feesEarnedUsd: 0, feesCollectedUsd: 22.4, feesUncollectedUsd: 0,
        gasUsd: 6.8, swapCostUsd: 0, tokenTaxesUsd: 1.5, realizedRebalanceLossUsd: 0,
        priceChangeUsd: 48, dollarsMadeUsd: 0, headline: 'dollarsMade', totalPnlUsd: 0, totalPnlPct: 0, aprPct: null,
        est: { d1: null, d7: null, d365: null, needs: '' },
        moveCount: 4, fillCount: 86, range: null, asOf: now, calc: '',
      }),
    }),
    bot({
      pair: 'HEX/DAI', base: 'HEX', quote: 'DAI', chain: 'PLS', chainColor: '#e040fb', dex: '9mm V3',
      tone: 'near', price: 0.00482, change24h: -0.018, step: 300, lo: 0.00455, hi: 0.0049,
      metrics: raw({
        botId: 'demo-hex', mode: 'live', kind: 'lp', status: 'running',
        startedAt: now - 11 * DAY * 1000, ageSec: 11 * DAY,
        capitalInUsd: 4000, currentValueUsd: 4096,
        realizedUsd: 0, unrealizedUsd: -36,
        feesEarnedUsd: 0, feesCollectedUsd: 142, feesUncollectedUsd: 28.5,
        gasUsd: 9.2, swapCostUsd: 7.4, tokenTaxesUsd: 0, realizedRebalanceLossUsd: 18,
        priceChangeUsd: -36, dollarsMadeUsd: 0, headline: 'dollarsMade', totalPnlUsd: 0, totalPnlPct: 0, aprPct: null,
        est: { d1: null, d7: null, d365: null, needs: '' },
        moveCount: 3, fillCount: 0, range: null, asOf: now, calc: '',
      }),
    }),
    bot({
      pair: 'PLS/USDC', base: 'PLS', quote: 'USDC', chain: 'PLS', chainColor: '#e040fb', dex: 'PulseX V3',
      tone: 'out', price: 0.000041, change24h: -0.042, step: 300, lo: 0.000048, hi: 0.000056,
      metrics: raw({
        botId: 'demo-pls', mode: 'live', kind: 'lp', status: 'running',
        startedAt: now - 6 * DAY * 1000, ageSec: 6 * DAY,
        capitalInUsd: 1800, currentValueUsd: 1612,
        realizedUsd: 0, unrealizedUsd: -80,
        feesEarnedUsd: 0, feesCollectedUsd: 44, feesUncollectedUsd: 2,
        gasUsd: 10, swapCostUsd: 8, tokenTaxesUsd: 0, realizedRebalanceLossUsd: 40,
        priceChangeUsd: -80, dollarsMadeUsd: 0, headline: 'dollarsMade', totalPnlUsd: 0, totalPnlPct: 0, aprPct: null,
        est: { d1: null, d7: null, d365: null, needs: '' },
        moveCount: 2, fillCount: 0, range: { lower: 0.000048, upper: 0.000056, current: 0.000041, inRange: false },
        asOf: now, calc: '',
      }),
    }),
    bot({
      pair: 'WIDE/USDC', base: 'WIDE', quote: 'USDC', chain: 'ETH', chainColor: '#8c9eff', dex: 'Uniswap V2',
      tone: 'idle', price: 0.084, change24h: 0.086, step: 60,
      metrics: raw({
        botId: 'demo-wide', mode: 'live', kind: 'token', status: 'running',
        startedAt: now - 2 * DAY * 1000, ageSec: 2 * DAY,
        capitalInUsd: 500, currentValueUsd: 688,
        realizedUsd: 92, unrealizedUsd: 110,
        feesEarnedUsd: 0, feesCollectedUsd: 5.25, feesUncollectedUsd: 0,
        gasUsd: 2.4, swapCostUsd: 1.1, tokenTaxesUsd: 8, realizedRebalanceLossUsd: 0,
        priceChangeUsd: 110, dollarsMadeUsd: 0, headline: 'dollarsMade', totalPnlUsd: 0, totalPnlPct: 0, aprPct: null,
        est: { d1: null, d7: null, d365: null, needs: '' },
        moveCount: 1, fillCount: 3, range: null, asOf: now, calc: '',
      }),
    }),
    bot({
      pair: 'HEX/PLS', base: 'HEX', quote: 'PLS', chain: 'PLS', chainColor: '#e040fb', dex: 'PulseX V2',
      tone: 'idle', price: 1420, change24h: 0.004, step: 3600,
      metrics: raw({
        botId: 'demo-trend', mode: 'paper', kind: 'trend', status: 'running',
        startedAt: now - 25_000, ageSec: 25,
        capitalInUsd: 800, currentValueUsd: 807,
        realizedUsd: 3.2, unrealizedUsd: 4,
        feesEarnedUsd: 0, feesCollectedUsd: 0.35, feesUncollectedUsd: 0,
        gasUsd: 0.15, swapCostUsd: 0, tokenTaxesUsd: 0, realizedRebalanceLossUsd: 0,
        priceChangeUsd: 4, dollarsMadeUsd: 0, headline: 'dollarsMade', totalPnlUsd: 0, totalPnlPct: 0, aprPct: null,
        est: { d1: null, d7: null, d365: null, needs: '' },
        moveCount: 0, fillCount: 1, range: null, asOf: now, calc: '',
      }),
    }),
  ];
  // The out-of-range LP must keep inRange false. bot() rebuilt range from lo/hi and forced inRange true.
  const pls = bots.find((b) => b.metrics.botId === 'demo-pls');
  if (pls) {
    pls.metrics.range = { lower: 0.000048, upper: 0.000056, current: 0.000041, inRange: false };
    pls.metrics = settle(pls.metrics);
    pls.spark = series(pls.metrics.dollarsMadeUsd);
  }
  const made = bots.filter((b) => b.metrics.mode === 'live').reduce((s, b) => s + b.metrics.dollarsMadeUsd, 0);
  return {
    bots,
    activity: [
      { id: 'a1', t: now - 45_000, botId: 'demo-eth', pair: 'ETH/USDC', kind: 'fill', text: 'ETH/USDC grid filled a sell', tone: 'up' },
      { id: 'a2', t: now - 80_000, botId: 'demo-hex', pair: 'HEX/DAI', kind: 'fee', text: 'HEX/DAI fees accrued in the position', tone: 'up' },
      { id: 'a3', t: now - 140_000, botId: 'demo-pls', pair: 'PLS/USDC', kind: 'recenter', text: 'PLS/USDC left its range', tone: 'down' },
      { id: 'a4', t: now - 200_000, botId: 'demo-wide', pair: 'WIDE/USDC', kind: 'fill', text: 'WIDE/USDC token buy filled', tone: 'flat' },
    ],
    feesTodayLiveUsd: 18.42,
    feesTodayPaperUsd: 0.35,
    madeSeries: series(round(made)),
  };
}

export function portfolioOf(state: DeskState): PortfolioSnapshot {
  const live = state.bots.filter((b) => b.metrics.mode === 'live');
  const paper = state.bots.filter((b) => b.metrics.mode === 'paper');
  const sum = (rows: BotDesk[], pick: (b: BotDesk) => number) => round(rows.reduce((s, b) => s + pick(b), 0));
  return {
    asOf: Date.now(),
    dollarsMadeUsd: sum(live, (b) => b.metrics.dollarsMadeUsd),
    paperDollarsMadeUsd: sum(paper, (b) => b.metrics.dollarsMadeUsd),
    priceChangeUsd: sum(live, (b) => b.metrics.priceChangeUsd),
    currentValueUsd: sum(live, (b) => b.metrics.currentValueUsd),
    capitalInUsd: sum(live, (b) => b.metrics.capitalInUsd),
    feesTodayLiveUsd: round(state.feesTodayLiveUsd),
    feesTodayPaperUsd: round(state.feesTodayPaperUsd),
    botsRunning: state.bots.filter((b) => b.metrics.status === 'running').length,
    botsTotal: state.bots.length,
    madeSeries: state.madeSeries.slice(),
  };
}

export function snapshotOf(state: DeskState): DeskSnapshot {
  return {
    portfolio: portfolioOf(state),
    bots: state.bots.map((b) => ({ ...b, metrics: { ...b.metrics }, candles: b.candles.slice(), fills: b.fills.slice(), spark: b.spark.slice(), levels: b.levels.slice() })),
    prices: state.bots.map((b) => ({ symbol: b.pair, price: b.price, change24h: b.change24h })),
    activity: state.activity.slice(),
  };
}
