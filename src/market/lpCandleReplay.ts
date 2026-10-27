/**
 * Range replay over real OHLCV candles (pure). No network.
 *
 * The move decision is `decideRangeMove`, the same one the live bot uses: a default policy
 * moves on the first close outside the price band, and Preset A / Preset B wait out their
 * dwell and cooldown on the candle timestamps. This is the bot's clock, not a count of bars.
 *
 * Fees follow the public candle model: volume × fee tier × the share LPs keep ×
 * L / (L + active liquidity) × the log-span of the candle inside the range × k.
 * Active liquidity is one `liquidity()` reading, held constant (archive reads were refused).
 * k is 0.958 where that model was checked against collected fees, and 1 where it was not.
 * Dollars of fees are that model. Moves, time in range, gas, swap cost and realized
 * rebalancing loss do not use k.
 *
 * Net = fees − gas − swap cost − realized rebalancing loss. The coin's own price move is
 * not in that net. A still-open range does not lock in a loss: the loss is counted when a
 * move takes the position out. Gas is the open plus each move. A close that never happens
 * is not charged.
 */
import { inRangeShare } from './lp';
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

export interface CandleMarket {
  /** Pool fee as a fraction (0.0005 = 0.05%). */
  fee: number;
  /** Share of the swap fee liquidity providers keep. */
  lpShare: number;
  /**
   * Active liquidity() in raw units, held constant. The fee model needs it.
   * Null leaves fees and net unset; moves and costs are still computed.
   */
  lPool: number | null;
  /** 1 = uncalibrated. 0.958 = the ETH/USDC 0.05% check against collected fees. */
  k: number;
  /** Human liquidity → raw. 1e12 for an 18-decimal ETH / 6-decimal stable pool. */
  lScale: number;
  /** Quote paid to open, and to move the range once. */
  gasOpen: number;
  gasMove: number;
  /** Extra price impact, in bps, on the rebalance notional, on top of the pool fee. */
  impactBps: number;
  /** Quote put in, all of it quote before the opening swap. */
  capital: number;
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
  /** Null when `lPool` was null. */
  fees: number | null;
  gas: number;
  swapCost: number;
  /** Coins put in at the last open, minus coins held, valued at the move price. 0 if it never moved. */
  moveLoss: number;
  /** Null when fees were not estimated. */
  net: number | null;
  moves: number;
  /** Mean of each bar's low–high log-span inside the range that was open during that bar. */
  inRange: number;
  /**
   * Position value at the last close, plus fees, minus a hold of the opening mix.
   * Includes the coin's price move. Not the headline net.
   */
  netVsHold: number | null;
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

/**
 * `liquidity()` at latest on 2026-10-27 (ethereum-rpc.publicnode.com), hex 0x20e8105a361c39fd.
 * The harness note rounded this pool to about 2.3e18. Float64 cannot hold the integer; the
 * fee share only needs the leading digits.
 */
export const ETH_USDC_ACTIVE_L = 0x20e8105a361c39fd;
/**
 * `liquidity()` at latest on 2026-10-27 (rpc.mainnet.chain.robinhood.com), hex 0x1aaf50a0b27c28d0.
 * Same float64 caveat.
 */
export const HOOD_ETH_USDG_ACTIVE_L = 0x1aaf50a0b27c28d0;

/** 1.12 USDG for 23 Robinhood ETH/USDG moves, the README measurement. */
export const HOOD_GAS_PER_ACTION = 1.12 / 23;

/** Ethereum Uniswap V3 WETH/USDC 0.05%, $8,000. */
export const ETH_USDC_MARKET: CandleMarket = {
  fee: 500 / 1e6,
  lpShare: 0.75,
  lPool: ETH_USDC_ACTIVE_L,
  k: 0.958,
  lScale: 1e12,
  gasMove: ethGasUsd(1_240_000),
  gasOpen: ethGasUsd(940_000) / 2,
  impactBps: 1,
  capital: 8000,
};

/**
 * Robinhood Uniswap V3 WETH/USDG 0.01%, $1,000.
 * k = 1: this pool was not in the fee calibration. lpShare 0.75 is feeProtocol 68.
 */
export const HOOD_ETH_USDG_MARKET: CandleMarket = {
  fee: 100 / 1e6,
  lpShare: 0.75,
  lPool: HOOD_ETH_USDG_ACTIVE_L,
  k: 1,
  lScale: 1e12,
  gasMove: HOOD_GAS_PER_ACTION,
  gasOpen: HOOD_GAS_PER_ACTION,
  impactBps: 1,
  capital: 1000,
};

/** 7 days ending 2026-10-26 00:00 UTC: the README ETH/USDG week. End is exclusive. */
export const README_WEEK_START = Date.UTC(2026, 9, 19) / 1000;
export const README_WEEK_END = Date.UTC(2026, 9, 26) / 1000;

export function fixtureRows(data: { rows: number[][] }): Ohlcv[] {
  return data.rows.map(([t, o, h, l, c, v]) => {
    const bar = { t, o, h, l, c, v };
    if (![t, o, h, l, c, v].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error('bad candle row');
    return bar;
  });
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
  const ethShare = (m0.x * openPrice) / (m0.x * openPrice + m0.y);
  const drag = market.fee + market.impactBps / 1e4;
  let swapCost = market.capital * ethShare * drag;
  let gas = market.gasOpen;
  let L = (market.capital - swapCost - gas) / unitValue(openPrice);
  if (!(L > 0)) throw new Error('opening costs more than the capital');
  let putX = L * m0.x;
  let putY = L * m0.y;
  const hodlEth = (market.capital * ethShare) / openPrice;
  const hodlUsd = market.capital * (1 - ethShare);

  let fees = 0;
  let moves = 0;
  let inSum = 0;
  let moveLoss = 0;
  let outSince: number | null = null;
  let lastMoveAt: number | null = null;

  for (const c of candles) {
    if (!(c.c > 0) || !(c.h > 0) || !(c.l > 0)) throw new Error(`bad price at ${c.t}`);
    const r = inRangeShare(c.l, c.h, pa, pb);
    inSum += r;
    if (market.lPool != null) {
      const lRaw = L * market.lScale;
      fees += c.v * market.fee * market.lpShare * (lRaw / (lRaw + market.lPool)) * r * market.k;
    }
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
  const feesOut = market.lPool == null ? null : fees;
  const net = feesOut == null ? null : feesOut - gas - swapCost - moveLoss;
  const netVsHold = feesOut == null ? null : posValue + feesOut - (hodlEth * last.c + hodlUsd);
  return {
    label: policy.label, bandPct: policy.bandPct, rerange: policy.rerange,
    days: (last.t - candles[0].t) / 86400, bars: candles.length,
    fees: feesOut, gas, swapCost, moveLoss, net, moves,
    inRange: inSum / candles.length, netVsHold,
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
}

function money(n: number): string {
  return n.toFixed(2);
}

/** Markdown table. Net is the first number. A null fee is shown as n/a, not as zero. */
export function formatCandleTable(table: CandleTable): string {
  const line = (r: CandleReplayResult) => {
    const fees = r.fees == null || r.net == null ? 'n/a' : money(r.fees);
    const net = r.net == null ? 'n/a' : money(r.net);
    return `| ${r.label} | ${net} | ${fees} | ${money(r.gas)} | ${money(r.swapCost)} | ${money(r.moveLoss)} | ${r.moves} | ${(r.inRange * 100).toFixed(1)}% |`;
  };
  return [
    `**${table.title}**`,
    table.window,
    '',
    '| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...table.rows.map(line),
  ].join('\n');
}

/** One line per row, for the cross-check. This is not the headline net. */
export function formatVsHold(rows: CandleReplayResult[]): string {
  const bits = rows.map((r) => `${r.label.split(' ')[0] === 'Preset' ? r.label.slice(0, 8) : r.label.split(' ')[0]} ${r.netVsHold == null ? 'n/a' : money(r.netVsHold)}`);
  return `Versus a hold of the opening mix (includes the coin's price move; not the headline): ${bits.join('; ')}.`;
}

const SHARED = [
  'Net = fees − gas − swap cost − realized rebalancing loss, in the quote coin. That is what the bot made. The coin\'s own price move is not in this net, and a range that is still open has not locked its mix in.',
  'Fees = candle volume × fee tier × LP share × L / (L + active liquidity) × in-range share of the bar × k. Active liquidity is one liquidity() reading on 2026-10-27, held constant over the window. In-range share is the log-span of the bar\'s low–high inside the range.',
  'A move pays the pool fee plus 1 bp on the swapped notional. The open pays that on the base-coin leg. No terminal close is charged.',
  'Preset A and Preset B are optional named setups. This report runs them. It does not pick one.',
];

export function ethUsdcTable(rows: Ohlcv[]): CandleTable {
  const window = sliceLastSeconds(rows, 30 * 86400);
  const first = window[0];
  const last = window[window.length - 1];
  return {
    title: 'Ethereum Uniswap V3 WETH/USDC 0.05% — real hourly candles',
    window: `${window.length} hourly bars, ${new Date(first.t * 1000).toISOString().slice(0, 16)}Z → ${new Date(last.t * 1000).toISOString().slice(0, 16)}Z (last 30 days of the fixture, through the last bar). Capital $8,000. Open ${first.o}, last close ${last.c}.`,
    source: 'tests/fixtures/eth-usdc-005-1h.json — GeckoTerminal OHLCV, pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640.',
    assumptions: [
      ...SHARED,
      `Pool fee 0.05% (tier 500), LPs keep 0.75 (feeProtocol 68). k = 0.958, from the harness check of this model against collected fees on this pool.`,
      `Active liquidity held at ${ETH_USDC_ACTIVE_L.toExponential(4)} (liquidity() on 2026-10-27; the harness note rounded it to ~2.3e18). Raw scale 1e12 (WETH 18 decimals, USDC 6).`,
      `Gas: 1,240,000 units a move and half of 940,000 for the open, at 0.3 gwei and $${GAS_ETH_USD} ETH. That is $${ethGasUsd(1_240_000).toFixed(4)} a move and $${(ethGasUsd(940_000) / 2).toFixed(4)} to open. The $${GAS_ETH_USD} price is only for gas; the path uses the candle prices.`,
    ],
    rows: replayPolicies(window, ETH_USDC_MARKET),
  };
}

export function hoodWeekTable(rows: Ohlcv[]): CandleTable {
  const window = sliceHalfOpen(rows, README_WEEK_START, README_WEEK_END);
  const first = window[0];
  const last = window[window.length - 1];
  return {
    title: 'Robinhood Chain Uniswap V3 WETH/USDG 0.01% — real 5-minute candles',
    window: `${window.length} five-minute bars, ${new Date(first.t * 1000).toISOString().slice(0, 16)}Z → ${new Date(last.t * 1000).toISOString().slice(0, 16)}Z, the half-open week [2026-10-19, 2026-10-26) UTC. Capital 1,000 USDG. Open ${first.o}, last close ${last.c}.`,
    source: 'tests/fixtures/hood-ethusdg-5m.json — GeckoTerminal OHLCV, pool 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca.',
    assumptions: [
      ...SHARED,
      'Pool fee 0.01% (tier 100), LPs keep 0.75 (feeProtocol 68). k = 1 because this pool was not in the fee calibration, so the fee dollars are an uncalibrated estimate. Moves, time in range, gas, swap cost and realized loss do not use k.',
      `Active liquidity held at ${HOOD_ETH_USDG_ACTIVE_L.toExponential(4)} (liquidity() on 2026-10-27). Raw scale 1e12 (WETH 18 decimals, USDG 6). This is not the Ethereum pool's liquidity.`,
      `Gas: ${HOOD_GAS_PER_ACTION.toFixed(4)} USDG to open and the same per move (README: 1.12 USDG across 23 moves). No separate open measurement was in the public assumptions, so the open uses that per-action figure.`,
      'The README\'s published week (23 moves, 70.38 fees, 84.23 move loss, −16.22 net, stay-put +27.24) used the pool\'s swap tape and an older missed-fee rule. This table does not reproduce that tape.',
    ],
    rows: replayPolicies(window, HOOD_ETH_USDG_MARKET),
  };
}
