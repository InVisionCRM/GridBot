/**
 * Range replay over real OHLCV candles (pure). No network.
 *
 * The move decision is `decideRangeMove`, the same clock the live bot uses.
 * Fees on a bar are candle volume × the pool fee tier × the LP share at the latest
 * sample × the position's share of active liquidity × the log-span of the bar inside
 * the range. There is no calibration multiplier. Every setting on a pair reads the
 * same sample series.
 *
 * Active liquidity and the protocol fee are sampled on a 6-hour grid (see the
 * fixtures). On Ethereum that is archive `liquidity()` and `slot0`. On Robinhood the
 * public RPCs do not serve historical state, so liquidity is the Swap event's
 * liquidity field. The fee tier is read from `fee()`.
 *
 * Net = fees − gas − swap cost − realized rebalancing loss. The coin's own price
 * move is not in that net. A still-open range does not lock in a loss. Gas is the
 * open plus each move. A close that never happens is not charged.
 *
 * The headline restates that net per day in ETH and in the quote token. The ETH
 * portion is the share of fee value that sampled swaps paid in WETH, minus Ethereum
 * gas. The quote portion is the rest, minus swap cost, realized rebalance loss, and
 * Robinhood gas (measured in USDG). The USD figure is the quote net per day.
 */
import { inRangeShare, lpShareFromFeeProtocol } from './lp';
import { decideRangeMove, LP_PRESET_A, LP_PRESET_B, rangePolicy, type LpRangePolicy } from './lpPolicy';

/** One OHLCV bar. `t` is unix seconds. Volume is in the quote coin (USD or USDG). */
export interface Ohlcv {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** One observation of the pool, shared by every setting. */
export interface PoolSample {
  /** Block timestamp, unix seconds. */
  t: number;
  block: number;
  /** Active liquidity in raw units, decimal string (float64 is enough for the share). */
  liquidity: string;
  feeProtocol: number;
  /** Share of the swap fee LPs keep, from `feeProtocol`. */
  lpShare: number;
  /** Pool fee() in hundredths of a bip (500 = 0.05%). Absent only in a hand-built test. */
  feeTier?: number;
  /** Swaps read around this sample, for the fee-token mix. */
  swaps: number;
  /**
   * Fraction of those swaps' fee value that was paid in WETH.
   * Null when the bucket had no priced swaps.
   */
  ethValueShare: number | null;
  /** Quote-token fees in the bucket, human units. Weights `ethValueShare`. */
  feeQuote?: number;
  /** WETH-paid fees in the bucket, valued in the quote at each swap's price. */
  feeEthUsd?: number;
}

export interface LiquiditySeries {
  pool: string;
  /** How the samples were read, for the report. */
  method: string;
  /** Whether archive eth_call reached this window. */
  archive: string;
  /** SetFeeProtocol logs in the window. */
  setFeeProtocolEvents: number;
  samples: PoolSample[];
}

export interface CandleMarket {
  /** Pool fee as a fraction (0.0005 = 0.05%). */
  fee: number;
  /** Human liquidity → raw. 1e12 for an 18-decimal ETH / 6-decimal stable pool. */
  lScale: number;
  /** Quote paid to open, and to move the range once. */
  gasOpen: number;
  gasMove: number;
  /** ETH paid to open and to move. 0 when gas is charged only in the quote. */
  gasOpenEth: number;
  gasMoveEth: number;
  /** Extra price impact, in bps, on the rebalance notional, on top of the pool fee. */
  impactBps: number;
  /** Quote put in, all of it quote before the opening swap. */
  capital: number;
  quote: 'USDC' | 'USDG';
  /** Same series for every setting on this pair. Sorted by `t`. */
  samples: PoolSample[];
  /**
   * Fraction of fee value paid in ETH, value-weighted across the sampled swaps.
   * Applied to every bar so a thin 6-hour snapshot does not steer the whole next bucket.
   */
  ethValueShare: number;
}

export interface CandlePolicy {
  label: string;
  bandPct: number;
  rerange: boolean;
  range?: Partial<LpRangePolicy>;
}

export interface CandleReplayResult {
  label: string;
  bandPct: number;
  rerange: boolean;
  days: number;
  bars: number;
  fees: number;
  /** WETH fees, in ETH, before gas. */
  feeEth: number;
  /** Stablecoin fees, in the quote token, before quote costs. */
  feeQuote: number;
  gas: number;
  /** Ethereum gas, in ETH. 0 when gas is only in the quote. */
  gasEth: number;
  swapCost: number;
  /** Coins put in at the last open, minus coins held, valued at the move price. 0 if it never moved. */
  moveLoss: number;
  net: number;
  /** (fee ETH − ETH gas) / days. */
  ethPerDay: number;
  /** (stable fees − swap cost − realized loss − quote gas) / days. */
  quotePerDay: number;
  /** Quote net / days. */
  usdPerDay: number;
  moves: number;
  /** Mean of each bar's low–high log-span inside the range that was open during that bar. */
  inRange: number;
  /** How many liquidity samples the pair was given. Same for every setting. */
  samples: number;
  /**
   * Position value at the last close, plus fees, minus a hold of the opening mix.
   * Includes the coin's price move. Not the headline.
   */
  netVsHold: number;
}

/** Defaults, then the two named presets, then the ±1% range with auto-move off. */
export function candlePolicies(): CandlePolicy[] {
  return [
    { label: 'Defaults (±1%, move on the first close outside)', bandPct: 0.01, rerange: true },
    {
      label: 'Preset A (±2%, 12h outside, 24h cooldown)',
      bandPct: LP_PRESET_A.bandPct, rerange: true,
      range: { dwellMin: LP_PRESET_A.dwellMin, cooldownMin: LP_PRESET_A.cooldownMin },
    },
    {
      label: 'Preset B (±3%, 4h outside, 12h cooldown)',
      bandPct: LP_PRESET_B.bandPct, rerange: true,
      range: { dwellMin: LP_PRESET_B.dwellMin, cooldownMin: LP_PRESET_B.cooldownMin },
    },
    { label: 'Stay put (±1%, auto-move off)', bandPct: 0.01, rerange: false },
  ];
}

/** ETH/USD used only to turn Ethereum gas units into dollars. Candle prices are already USD. */
export const GAS_ETH_USD = 2343.5;
/** Base-case gas price from the public assumptions (0.3 gwei). */
export const GAS_GWEI_BASE = 0.3;

export function ethGasUsd(units: number): number {
  return units * GAS_GWEI_BASE * 1e-9 * GAS_ETH_USD;
}

export function ethGasEth(units: number): number {
  return units * GAS_GWEI_BASE * 1e-9;
}

/** 1.12 USDG for 23 Robinhood ETH/USDG moves, the README measurement. */
export const HOOD_GAS_PER_ACTION = 1.12 / 23;

/** 7 days ending 2026-10-26 00:00 UTC: the README ETH/USDG week. End is exclusive. */
export const README_WEEK_START = Date.UTC(2026, 9, 19) / 1000;
export const README_WEEK_END = Date.UTC(2026, 9, 26) / 1000;

/** Shown above every results table. */
export const REPLAY_LABEL = 'Replay model on real candles, not actual bot results';

export function fixtureRows(data: { rows: number[][] }): Ohlcv[] {
  return data.rows.map(([t, o, h, l, c, v]) => {
    const bar = { t, o, h, l, c, v };
    if (![t, o, h, l, c, v].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error('bad candle row');
    return bar;
  });
}

/** Latest sample at or before `t`. A bar before the first sample uses the first. */
export function sampleAsOf(samples: readonly PoolSample[], t: number): PoolSample {
  if (!samples.length) throw new Error('no liquidity samples');
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return samples[Math.max(0, lo - 1)];
}

/** Value-weighted WETH share of sampled swap fees. Falls back to a swap-count weighting. */
export function weightedEthShare(samples: readonly PoolSample[]): number {
  let eth = 0;
  let quote = 0;
  for (const s of samples) {
    if (s.feeEthUsd == null || s.feeQuote == null) continue;
    eth += s.feeEthUsd;
    quote += s.feeQuote;
  }
  if (eth + quote > 0) return eth / (eth + quote);
  let acc = 0;
  let n = 0;
  for (const s of samples) {
    if (s.ethValueShare == null || !(s.swaps > 0)) continue;
    acc += s.ethValueShare * s.swaps;
    n += s.swaps;
  }
  if (!(n > 0)) throw new Error('no swap-fee mix in the samples');
  return acc / n;
}

export function liquidityNumbers(samples: readonly PoolSample[]): number[] {
  return samples.map((s) => {
    const n = Number(s.liquidity);
    if (!(n > 0)) throw new Error('bad liquidity sample');
    return n;
  });
}

export function median(xs: readonly number[]): number {
  if (!xs.length) throw new Error('empty');
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Bars with t >= last.t − seconds, the harness window (the last bar is included). */
export function sliceLastSeconds(rows: Ohlcv[], seconds: number): Ohlcv[] {
  if (rows.length < 2) throw new Error('need at least 2 candles');
  const start = rows[rows.length - 1].t - seconds;
  const out = rows.filter((r) => r.t >= start);
  if (out.length < 2) throw new Error('window has fewer than 2 candles');
  return out;
}

/** Half-open [start, end) on unix seconds. */
export function sliceHalfOpen(rows: Ohlcv[], start: number, end: number): Ohlcv[] {
  const out = rows.filter((r) => r.t >= start && r.t < end);
  if (out.length < 2) throw new Error('window has fewer than 2 candles');
  return out;
}

/** Amounts of base (x) and quote (y) per unit of human liquidity, price clamped into [pa, pb]. */
function mix(price: number, pa: number, pb: number): { x: number; y: number } {
  const s = Math.sqrt(Math.min(Math.max(price, pa), pb));
  return { x: 1 / s - 1 / Math.sqrt(pb), y: s - Math.sqrt(pa) };
}

export function replayCandles(candles: Ohlcv[], market: CandleMarket, policy: CandlePolicy): CandleReplayResult {
  if (candles.length < 2) throw new Error('need at least 2 candles');
  if (!(market.capital > 0) || !(policy.bandPct > 0 && policy.bandPct < 1)) throw new Error('bad capital or band');
  if (!market.samples.length) throw new Error('liquidity samples are required');
  if (!(market.ethValueShare >= 0 && market.ethValueShare <= 1)) throw new Error('bad ETH fee share');
  const gates = rangePolicy(policy.range);
  const openPrice = candles[0].o;
  if (!(openPrice > 0)) throw new Error('bad open');
  let pa = openPrice * (1 - policy.bandPct);
  let pb = openPrice * (1 + policy.bandPct);
  const unitValue = (price: number) => {
    const m = mix(price, pa, pb);
    return m.x * price + m.y;
  };
  const m0 = mix(openPrice, pa, pb);
  const ethLeg = (m0.x * openPrice) / (m0.x * openPrice + m0.y);
  const drag = market.fee + market.impactBps / 1e4;
  let swapCost = market.capital * ethLeg * drag;
  let gas = market.gasOpen;
  let gasEth = market.gasOpenEth;
  let L = (market.capital - swapCost - gas) / unitValue(openPrice);
  if (!(L > 0)) throw new Error('opening costs more than the capital');
  let putX = L * m0.x;
  let putY = L * m0.y;
  const hodlEth = (market.capital * ethLeg) / openPrice;
  const hodlUsd = market.capital * (1 - ethLeg);

  let fees = 0;
  let feeEth = 0;
  let feeQuote = 0;
  let moves = 0;
  let inSum = 0;
  let moveLoss = 0;
  let outSince: number | null = null;
  let lastMoveAt: number | null = null;

  for (const c of candles) {
    if (!(c.c > 0) || !(c.h > 0) || !(c.l > 0)) throw new Error(`bad price at ${c.t}`);
    const r = inRangeShare(c.l, c.h, pa, pb);
    inSum += r;
    const sample = sampleAsOf(market.samples, c.t);
    const lPool = Number(sample.liquidity);
    if (!(lPool > 0)) throw new Error(`bad liquidity at ${sample.t}`);
    const lRaw = L * market.lScale;
    const fee = sample.feeTier != null ? sample.feeTier / 1e6 : market.fee;
    const feeUsd = c.v * fee * sample.lpShare * (lRaw / (lRaw + lPool)) * r;
    fees += feeUsd;
    feeEth += (feeUsd * market.ethValueShare) / c.c;
    feeQuote += feeUsd * (1 - market.ethValueShare);
    const now = c.t * 1000;
    const tickOut = c.c < pa || c.c > pb;
    const dec = decideRangeMove({
      tickOut, price: c.c, lower: pa, upper: pb,
      outSince, lastMoveAt, now, rerange: policy.rerange, policy: gates,
    });
    outSince = dec.outSince;
    if (!dec.move) continue;
    const held = mix(c.c, pa, pb);
    const heldX = L * held.x;
    const heldY = L * held.y;
    moveLoss += putX * c.c + putY - (heldX * c.c + heldY);
    const value = heldX * c.c + heldY;
    pa = c.c * (1 - policy.bandPct);
    pb = c.c * (1 + policy.bandPct);
    const next = mix(c.c, pa, pb);
    const targetEth = (next.x * c.c) / (next.x * c.c + next.y);
    const notional = Math.abs(targetEth * value - heldX * c.c);
    const sc = notional * drag;
    swapCost += sc;
    gas += market.gasMove;
    gasEth += market.gasMoveEth;
    L = (value - sc - market.gasMove) / unitValue(c.c);
    if (!(L > 0)) throw new Error(`move at ${c.t} costs more than the position`);
    const deposited = mix(c.c, pa, pb);
    putX = L * deposited.x;
    putY = L * deposited.y;
    moves++;
    outSince = null;
    lastMoveAt = now;
  }

  const last = candles[candles.length - 1];
  const endMix = mix(last.c, pa, pb);
  const posValue = L * (endMix.x * last.c + endMix.y);
  const quoteGas = gasEth > 0 ? 0 : gas;
  const net = fees - gas - swapCost - moveLoss;
  const days = (last.t - candles[0].t) / 86400;
  return {
    label: policy.label, bandPct: policy.bandPct, rerange: policy.rerange,
    days, bars: candles.length,
    fees, feeEth, feeQuote, gas, gasEth, swapCost, moveLoss, net,
    ethPerDay: (feeEth - gasEth) / days,
    quotePerDay: (feeQuote - swapCost - moveLoss - quoteGas) / days,
    usdPerDay: net / days,
    moves, inRange: inSum / candles.length, samples: market.samples.length,
    netVsHold: posValue + fees - (hodlEth * last.c + hodlUsd),
  };
}

export function replayPolicies(candles: Ohlcv[], market: CandleMarket, policies = candlePolicies()): CandleReplayResult[] {
  return policies.map((p) => replayCandles(candles, market, p));
}

export interface CandleTable {
  title: string;
  window: string;
  source: string;
  assumptions: string[];
  rows: CandleReplayResult[];
  quote: 'USDC' | 'USDG';
}

export function formatDetroit(unix: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(unix * 1000));
}

function money(n: number): string {
  return n.toFixed(2);
}

function ethAmt(n: number): string {
  return n.toFixed(6);
}

/** Both tables. Each one carries the replay-model label. USD sits in small text on the headline. */
export function formatCandleTable(table: CandleTable): string {
  const head = (r: CandleReplayResult) =>
    `| ${r.label} | ${ethAmt(r.ethPerDay)} ETH and ${money(r.quotePerDay)} ${table.quote} <small>(${money(r.usdPerDay)} USD)</small> / day |`;
  const full = (r: CandleReplayResult) =>
    `| ${r.label} | ${money(r.net)} | ${money(r.fees)} | ${money(r.gas)} | ${money(r.swapCost)} | ${money(r.moveLoss)} | ${r.moves} | ${(r.inRange * 100).toFixed(1)}% |`;
  return [
    `**${table.title}**`,
    table.window,
    '',
    REPLAY_LABEL,
    '',
    '| Setting | Per day, net of gas, swap cost, and realized rebalance loss |',
    '| --- | --- |',
    ...table.rows.map(head),
    '',
    REPLAY_LABEL,
    '',
    '| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...table.rows.map(full),
  ].join('\n');
}

/** One line per row, for the cross-check. This is not the headline net. */
export function formatVsHold(rows: CandleReplayResult[]): string {
  const bits = rows.map((r) => {
    const name = r.label.startsWith('Preset') ? r.label.slice(0, 8) : r.label.split(' ')[0];
    return `${name} ${money(r.netVsHold)}`;
  });
  return `Versus a hold of the opening mix (includes the coin's price move; not the headline): ${bits.join('; ')}.`;
}

function sci(n: number): string {
  return n.toExponential(3);
}

function seriesNotes(series: LiquiditySeries, candles: Ohlcv[], market: CandleMarket): string[] {
  const ls = liquidityNumbers(series.samples);
  const protocols = [...new Set(series.samples.map((s) => s.feeProtocol))];
  const shares = series.samples.map((s) => s.ethValueShare).filter((x): x is number => x != null);
  const swaps = series.samples.reduce((a, s) => a + s.swaps, 0);
  const stay = candlePolicies()[3];
  const at = (liquidity: number) => replayCandles(candles, {
    ...market,
    samples: [{
      t: 0, block: 0, liquidity: String(liquidity), feeProtocol: series.samples[0].feeProtocol,
      lpShare: series.samples[0].lpShare, swaps: 0, ethValueShare: null,
    }],
  }, stay);
  const lo = Math.min(...ls);
  const mid = median(ls);
  const hi = Math.max(...ls);
  const feeLo = at(lo).fees;
  const feeMid = at(mid).fees;
  const feeHi = at(hi).fees;
  return [
    `${series.samples.length} liquidity samples. ${series.method}`,
    series.archive,
    `SetFeeProtocol events in the window: ${series.setFeeProtocolEvents}. feeProtocol on the samples: ${protocols.join(', ')} (LP share ${protocols.map((p) => lpShareFromFeeProtocol(p, 'uniswap').toFixed(4)).join(', ')}).`,
    `Active liquidity across the samples: min ${sci(lo)}, median ${sci(mid)}, max ${sci(hi)}. The tables use every sample. Holding stay-put at that min / median / max instead changes its fees to ${money(feeLo)} / ${money(feeMid)} / ${money(feeHi)} ${market.quote}.`,
    `Fee-token mix: ${swaps} swaps beside the samples. Value-weighted share paid in WETH is ${(market.ethValueShare * 100).toFixed(1)}%. Per-sample shares run from ${(Math.min(...shares) * 100).toFixed(0)}% to ${(Math.max(...shares) * 100).toFixed(0)}%; a single bucket is too thin to assign the next 6 hours, so every bar uses the window weight. The same weight is used for every setting.`,
  ];
}

const SHARED = [
  'Per day, the ETH figure is the WETH-paid portion of fees (at each bar\'s close) minus ETH gas. The stablecoin figure is the rest of the fees, minus swap cost, realized rebalance loss, and any gas charged in the quote. USD in small text is that quote net per day: fees − gas − swap cost − realized rebalance loss. The coin\'s own price move is not in it.',
  'Fees on a bar = candle volume × fee tier × the sampled LP share × L / (L + sampled active liquidity) × the log-span of the bar inside the range. No calibration multiplier. Every setting reads the same samples.',
  'A move pays the pool fee plus 1 bp on the swapped notional. The open pays that on the base-coin leg. No terminal close is charged.',
  'Preset A and Preset B are optional named setups. This report runs them. It does not pick one.',
];

function marketWith(base: Omit<CandleMarket, 'samples' | 'ethValueShare'>, series: LiquiditySeries): CandleMarket {
  for (const s of series.samples) {
    const again = lpShareFromFeeProtocol(s.feeProtocol, 'uniswap');
    if (Math.abs(again - s.lpShare) > 1e-12) throw new Error('sample LP share does not match feeProtocol');
  }
  return { ...base, samples: series.samples, ethValueShare: weightedEthShare(series.samples) };
}

const ETH_BASE: Omit<CandleMarket, 'samples' | 'ethValueShare'> = {
  fee: 500 / 1e6,
  lScale: 1e12,
  gasMove: ethGasUsd(1_240_000),
  gasOpen: ethGasUsd(940_000) / 2,
  gasMoveEth: ethGasEth(1_240_000),
  gasOpenEth: ethGasEth(940_000) / 2,
  impactBps: 1,
  capital: 8000,
  quote: 'USDC',
};

const HOOD_BASE: Omit<CandleMarket, 'samples' | 'ethValueShare'> = {
  fee: 100 / 1e6,
  lScale: 1e12,
  gasMove: HOOD_GAS_PER_ACTION,
  gasOpen: HOOD_GAS_PER_ACTION,
  gasMoveEth: 0,
  gasOpenEth: 0,
  impactBps: 1,
  capital: 1000,
  quote: 'USDG',
};

export function ethUsdcTable(rows: Ohlcv[], series: LiquiditySeries): CandleTable {
  const window = sliceLastSeconds(rows, 30 * 86400);
  const first = window[0];
  const last = window[window.length - 1];
  const market = marketWith(ETH_BASE, series);
  return {
    title: 'Ethereum Uniswap V3 WETH/USDC 0.05%',
    window: `${window.length} hourly bars, ${formatDetroit(first.t)} – ${formatDetroit(last.t)}. Capital $8,000. Open ${first.o}, last close ${last.c}.`,
    source: 'Candles: tests/fixtures/eth-usdc-005-1h.json (GeckoTerminal). Liquidity: tests/fixtures/eth-usdc-005-liquidity.json. Pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640.',
    assumptions: [
      ...SHARED,
      ...seriesNotes(series, window, market),
      `Pool fee 0.05% (tier 500), token0 USDC, token1 WETH. Raw liquidity scale 1e12.`,
      `Gas: 1,240,000 units a move and half of 940,000 for the open, at 0.3 gwei. That is ${ethGasEth(1_240_000).toExponential(3)} ETH a move ($${ethGasUsd(1_240_000).toFixed(4)} at $${GAS_ETH_USD}) and ${ethGasEth(940_000 / 2).toExponential(3)} ETH to open. The $${GAS_ETH_USD} price is only for the USD gas column; the path uses the candle prices.`,
    ],
    rows: replayPolicies(window, market),
    quote: 'USDC',
  };
}

export function hoodWeekTable(rows: Ohlcv[], series: LiquiditySeries): CandleTable {
  const window = sliceHalfOpen(rows, README_WEEK_START, README_WEEK_END);
  const first = window[0];
  const last = window[window.length - 1];
  const market = marketWith(HOOD_BASE, series);
  return {
    title: 'Robinhood Chain Uniswap V3 WETH/USDG 0.01%',
    window: `${window.length} five-minute bars, ${formatDetroit(first.t)} – ${formatDetroit(last.t)}. Capital 1,000 USDG. Open ${first.o}, last close ${last.c}.`,
    source: 'Candles: tests/fixtures/hood-ethusdg-5m.json (GeckoTerminal). Liquidity: tests/fixtures/hood-ethusdg-liquidity.json. Pool 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca.',
    assumptions: [
      ...SHARED,
      ...seriesNotes(series, window, market),
      'Pool fee 0.01% (tier 100), token0 WETH, token1 USDG. Raw liquidity scale 1e12. This is not the Ethereum pool\'s liquidity.',
      `Gas: ${HOOD_GAS_PER_ACTION.toFixed(4)} USDG to open and the same per move (README: 1.12 USDG across 23 moves). No ETH gas amount was measured, so this gas stays in the USDG leg.`,
      'The README\'s published week (23 moves, 70.38 fees, 84.23 move loss, −16.22 net, stay-put +27.24) used the pool\'s swap tape and an older missed-fee rule. This table does not reproduce that tape.',
    ],
    rows: replayPolicies(window, market),
    quote: 'USDG',
  };
}

/** Load a committed sample file. Liquidity strings are kept as text. */
export function loadSeries(data: LiquiditySeries): LiquiditySeries {
  if (!data.samples?.length) throw new Error('empty liquidity series');
  const samples = data.samples.map((s) => {
    if (!(s.t > 0) || !(Number(s.liquidity) > 0)) throw new Error('bad sample');
    if (s.lpShare !== lpShareFromFeeProtocol(s.feeProtocol, 'uniswap')) {
      throw new Error('LP share was not derived from feeProtocol');
    }
    return s;
  });
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < samples[i - 1].t) throw new Error('samples are not in time order');
  }
  return { ...data, samples };
}
