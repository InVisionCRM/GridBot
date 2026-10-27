/**
 * Honest reconstruction of the README's Robinhood ETH/USDG ±1% week — not the raw swap tape.
 *
 * The README (7 days to 2026-10-26, 1,234,950 swaps, 1,000 USDG, ±1%) reports 23 moves, 70.38 USDG
 * of fees and 84.23 USDG locked in by moves. Those totals were measured under an earlier rule
 * (move only once missed fees passed the move's cost). This repo does not contain that swap tape
 * (`data/pool-history/` is empty), and the live engine no longer implements that rule, so the three
 * published numbers cannot be replayed swap for swap.
 *
 * What this runs instead, on the same replay as the bot (`replayLp`):
 *  - Pool shape of that market: WETH token0 (18 dp), USDG token1 (6 dp), tick spacing 1, 0.01% swap fee.
 *  - 7 days of minutes. The close is an Ornstein-Uhlenbeck walk around tick −193440 (about 3,972
 *    quote per base) plus the scheduled excursions in `EXCURSIONS`. Seed and step sizes are fixed below.
 *  - Each minute is one tick. Its low/high runs from the previous close to this one, which is how
 *    `addSwaps` folds a jump into a minute. Fee density is flat (see `FEE_PER_UNIT`) and is scaled so a
 *    range that never moves earns about the README's stay-put 27.24 quote. It is not measured swaps.
 *  - Gas per move is the README's 1.12 quote / 23 moves. The pool is deep, so price impact is negligible
 *    and almost all of "lost to moves" is the coin mix a move locks in.
 *  - "Defaults" is today's rule on the README's ±1% band: move on the first minute that closes outside.
 *  - Preset A and Preset B are the optional named setups (see lpPolicy). Neither is selected here
 *    as a preference. They are replayed so the same path shows what those waits do.
 *  - "Stay put" is ±1% with auto-move off.
 *  - The first number on each row is net quote: fees − gas − swap cost − realized rebalancing loss.
 *    That is the dollars the bot made. A comparison with holding the coins is not in this report.
 *
 * An external harness (not in this repo) cross-checks the real candle tapes. This file does not
 * import it, and it does not contain wallets or transactions.
 */
import { replayLp, type PoolMinute, type ReplayPool, type ReplayResult } from './lpReplay';
import { LP_PRESET_A, LP_PRESET_B, type LpMovePreset } from './lpPolicy';

export const ETH_USDG_POOL: ReplayPool = {
  baseIs0: true, baseDecimals: 18, quoteDecimals: 6, spacing: 1, swapFee: 1e-4,
};

/** About 3,972 quote per base (1.0001^tick × 10^(18−6)). */
export const ANCHOR_TICK = -193_440;
export const WEEK_MINUTES = 7 * 24 * 60;
/** mulberry32 seed for the background walk. The test locks this seed's results. */
export const PATH_SEED = 20261026;
/**
 * Mean reversion per minute, and the Gaussian shock in ticks. Stationary width stays inside a
 * ±1% band (~100 ticks) most of the time; the excursions below are what push it out.
 */
export const OU_KAPPA = 0.04;
export const OU_SIGMA = 7;
/**
 * LP fee per unit of in-range liquidity per minute, raw token1, after the protocol's cut.
 * A trial density of 1.55e-7 earned about 2.32e6 quote on the stay-put path (liquidity is
 * constant there, so fees scale with this). 1.55e-7 × 27.24 / 2_316_082.69 brings that path
 * to about the README's stay-put 27.24 quote. It is a scale assumption, not measured swaps.
 */
export const FEE_PER_UNIT = 1.8227e-12;
/** README: 1.12 quote of gas across 23 moves. Applied per move and per open. */
export const GAS_PER_MOVE = 1.12 / 23;
export const CAPITAL = 1000;

/**
 * Flat trips away from the anchor, in ticks (~100 ticks = 1%).
 * Short ones are the wasted moves under today's first-reading rule.
 * The longest (240 and 180 minutes) are still shorter than Preset A's 12h dwell and Preset B's 4h dwell,
 * so on this seed those presets do not move. That is a property of this path, not a ranking.
 */
export const EXCURSIONS: { atMin: number; minutes: number; ticks: number }[] = [
  { atMin: 400, minutes: 6, ticks: 220 },
  { atMin: 900, minutes: 8, ticks: -250 },
  { atMin: 1400, minutes: 5, ticks: 180 },
  { atMin: 1900, minutes: 12, ticks: -200 },
  { atMin: 2400, minutes: 7, ticks: 300 },
  { atMin: 2800, minutes: 9, ticks: -160 },
  { atMin: 3300, minutes: 4, ticks: 240 },
  { atMin: 3700, minutes: 11, ticks: -280 },
  { atMin: 4200, minutes: 6, ticks: 190 },
  { atMin: 4700, minutes: 8, ticks: -210 },
  { atMin: 5100, minutes: 5, ticks: 260 },
  { atMin: 5600, minutes: 10, ticks: -170 },
  // Clearly out, but only ~0.15% past a ±1% edge, for longer than the dwell.
  // A 0.3% buffer holds; a first-reading move does not.
  { atMin: 6100, minutes: 70, ticks: 115 },
  { atMin: 6800, minutes: 50, ticks: -118 },
  // Sustained. Both policies move (the dwell one, 30 minutes in).
  { atMin: 7600, minutes: 240, ticks: 420 },
  { atMin: 9000, minutes: 180, ticks: -380 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function excursionAt(minute: number): number | null {
  for (const e of EXCURSIONS) {
    if (minute >= e.atMin && minute < e.atMin + e.minutes) return e.ticks;
  }
  return null;
}

/** The reconstructed minute tape. Deterministic for `PATH_SEED`. */
export function ethUsdgMinutes(now = 1_761_400_000): PoolMinute[] {
  const rng = mulberry32(PATH_SEED);
  let x = 0;
  let prev = ANCHOR_TICK;
  const rows: PoolMinute[] = [];
  for (let i = 0; i < WEEK_MINUTES; i++) {
    const jump = excursionAt(i);
    if (jump == null) x += -OU_KAPPA * x + OU_SIGMA * gauss(rng);
    const c = jump == null ? ANCHOR_TICK + Math.round(x) : ANCHOR_TICK + jump;
    const lo = Math.min(prev, c);
    const hi = Math.max(prev, c);
    rows.push({ t: now + i * 60, lo, hi, c, f0: 0, f1: FEE_PER_UNIT, liq: 1e24, n: 1 });
    prev = c;
  }
  return rows;
}

export interface EthReplayRow {
  label: string;
  moves: number;
  fees: number;
  feeBase: number;
  feeQuote: number;
  moveLoss: number;
  gas: number;
  swapCost: number;
  net: number;
  inRange: number;
  compounds: number;
}

function row(label: string, r: ReplayResult): EthReplayRow {
  return {
    label, moves: r.moves, fees: r.fees, feeBase: r.feeCoins.base, feeQuote: r.feeCoins.quote,
    moveLoss: r.moveLoss, gas: r.gas, swapCost: r.swapCost, net: r.net, inRange: r.inRange, compounds: r.compounds,
  };
}

const base = {
  capital: CAPITAL, gasOpen: GAS_PER_MOVE, gasMove: GAS_PER_MOVE, maxImpact: 0.05,
};

function presetLabel(p: LpMovePreset): string {
  return `${p.label} (±${p.bandPct * 100}%, ${p.dwellMin / 60}h outside, ${p.cooldownMin / 60}h cooldown)`;
}

export interface EthReplayReport {
  /** What was replayed, and what was not. */
  source: string;
  assumptions: string[];
  /** Defaults first, then the two presets, then stay-put. Net is the lead figure. */
  rows: EthReplayRow[];
  /** The README's published totals, which this tape does not claim to equal. Net is fees − costs − move loss under the older rule. */
  readme: { moves: number; fees: number; moveLoss: number; net: number; stayNet: number; inRangeStay: number };
}

export function runEthUsdgReplay(rows = ethUsdgMinutes()): EthReplayReport {
  const defaults = replayLp(rows, ETH_USDG_POOL, { ...base, bandPct: 0.01, rerange: true });
  const preset = (p: LpMovePreset) => replayLp(rows, ETH_USDG_POOL, {
    ...base, bandPct: p.bandPct, rerange: true, range: { dwellMin: p.dwellMin, cooldownMin: p.cooldownMin },
  });
  const stay = replayLp(rows, ETH_USDG_POOL, { ...base, bandPct: 0.01, rerange: false });
  return {
    source: 'Reconstructed minute path (not the Robinhood swap tape). See src/market/ethUsdgReplay.ts.',
    assumptions: [
      'Net quote = fees earned − gas − swap cost − realized rebalancing loss. That is what the bot made. Holding the coins is not in this table.',
      'No swap tape in this repo. The README totals (23 moves, −16.22 net, 70.38 fees, 84.23 move loss) were produced by an earlier missed-fee rule and are not replayed here.',
      'An external harness cross-checks real candles. It is not in this repo, and this reconstruction does not copy it.',
      `Background: Ornstein-Uhlenbeck, kappa ${OU_KAPPA}/min, sigma ${OU_SIGMA} ticks, seed ${PATH_SEED}, anchor tick ${ANCHOR_TICK}.`,
      `${EXCURSIONS.length} scheduled excursions (short pokes plus two multi-hour trips). Each minute's low/high spans the previous close.`,
      `Flat fee density ${FEE_PER_UNIT} raw quote per unit of liquidity per minute, scaled toward the README stay-put ~27.24 quote. Deep pool (impact negligible).`,
      `Gas ${GAS_PER_MOVE.toFixed(4)} quote per open or move (1.12 / 23).`,
      'Preset A and Preset B are optional named setups. This report runs them on the same path. It does not pick one.',
      'On this seed the longest trip is 240 minutes, shorter than either preset dwell, so both presets record 0 moves here.',
    ],
    rows: [
      row('Defaults (±1%, move on the first minute outside)', defaults),
      row(presetLabel(LP_PRESET_A), preset(LP_PRESET_A)),
      row(presetLabel(LP_PRESET_B), preset(LP_PRESET_B)),
      row('Stay put (±1%, auto-move off)', stay),
    ],
    readme: { moves: 23, fees: 70.38, moveLoss: 84.23, net: -16.22, stayNet: 27.24, inRangeStay: 0.4 },
  };
}

export function formatEthReplay(r: EthReplayReport): string {
  const n = (x: number, d = 2) => x.toFixed(d);
  const line = (a: EthReplayRow) =>
    `| ${a.label} | ${n(a.net)} | ${n(a.fees)} | ${n(a.gas)} | ${n(a.swapCost)} | ${n(a.moveLoss)} | ${a.moves} | ${n(a.inRange * 100, 1)}% |`;
  return [
    '| Setting | Net | Fees | Gas | Swap cost | Move loss | Moves | In range |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...r.rows.map(line),
  ].join('\n');
}
