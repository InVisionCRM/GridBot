/**
 * The three liquidity strategies the New bot page offers (Kyle 2026-11-08), each a set of the bot's own settings. Pure:
 * the page and the engine share it.
 *
 *  patient — a wide range, moved rarely. Fees accrue while the coin wanders inside; a dip out is waited through, so
 *            nothing is locked in by a move. Width: how far the coin moved in the last 7 days (the bigger of up and
 *            down), clamped. Auto-move stays on, held by a day's dwell and three days' cooldown and the cost check.
 *            On the CASHCAT/ETH pool's own week every moves-off row beat holding; every row that moved at ±8% or
 *            tighter lost.
 *  orders  — paid limit orders. One coin, one side of the price, a few pool steps wide: the quote coin just below the
 *            price is a buy order, the base coin just above is a sell order. The pool fills it trade by trade and pays
 *            the fee on each; when it is filled through, the bot places the opposite order at the price (flip).
 *            Nothing is ever swapped.
 *  stable  — two coins that move together (dollar coins, ETH wrappers, BTC wrappers): a hair-thin range, no auto-move
 *            (a move would chase a depeg), a 1% loss limit.
 */
export type LpStrategyId = 'patient' | 'orders' | 'stable';
export const LP_STRATEGY_IDS: readonly LpStrategyId[] = ['patient', 'orders', 'stable'];

/** A one-sided position: an order. `steps` = its width in pool steps (tick spacings) from the next step edge. */
export interface OneSided { side: 'buy' | 'sell'; steps: number; flip: boolean }
export const ORDER_STEPS = { min: 1, max: 10, default: 2 } as const;

export const STRATEGY = {
  patient: {
    id: 'patient' as const, name: 'Patient range', lossLimitPct: 0.10,
    range: { dwellMin: 24 * 60, cooldownMin: 72 * 60, costCheck: true },
    width: { min: 0.05, max: 0.25, fallback: 0.10 },
  },
  orders: { id: 'orders' as const, name: 'Paid limit orders', lossLimitPct: 0.10, steps: ORDER_STEPS.default, flip: true },
  stable: { id: 'stable' as const, name: 'Thin range on a stable pair', lossLimitPct: 0.01, bandPct: 0.002, rerange: false },
};

/** How far the coin moved over the replay window, each way from its last price, as fractions (0.08 = 8%). */
export interface WeekMove { hiPct: number; loPct: number }

/** The patient width: as wide as the coin moved last week (the bigger side), clamped; the fallback until the week is read. */
export function patientWidth(week: WeekMove | null): { pct: number; from: 'week' | 'fallback' } {
  const w = STRATEGY.patient.width;
  if (!week || !(week.hiPct >= 0) || !(week.loPct >= 0)) return { pct: w.fallback, from: 'fallback' };
  const raw = Math.max(week.hiPct, week.loPct);
  return { pct: Math.min(w.max, Math.max(w.min, +raw.toFixed(3))), from: 'week' };
}

/** Checks an order's settings; throws in plain words. */
export function checkOneSided(o: Partial<OneSided> | null | undefined): OneSided {
  if (!o || (o.side !== 'buy' && o.side !== 'sell')) throw new Error('An order is a buy (the quote coin below the price) or a sell (the base coin above it).');
  const steps = Number(o.steps);
  if (!Number.isInteger(steps) || steps < ORDER_STEPS.min || steps > ORDER_STEPS.max) throw new Error(`An order is ${ORDER_STEPS.min} to ${ORDER_STEPS.max} pool steps wide.`);
  return { side: o.side, steps, flip: o.flip !== false };
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDT0', 'USD0', 'USDG', 'DAI', 'USDE', 'FRAX', 'PYUSD', 'USDS', 'GHO', 'LUSD', 'CRVUSD', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'USDB', 'USDM', 'DOLA', 'SUSD', 'EUSD', 'RLUSD', 'USD1', 'USDA', 'MUSD']);
export const ETH_LIKE = new Set(['ETH', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'RETH', 'WEETH', 'EZETH', 'METH', 'OSETH', 'FRXETH', 'SFRXETH', 'ETHX', 'RSETH', 'PUFETH', 'SWETH']);
export const BTC_LIKE = new Set(['BTC', 'WBTC', 'CBBTC', 'TBTC', 'BTCB', 'LBTC', 'FBTC', 'SOLVBTC', 'EBTC']);

/** Two coins that move together: both dollar coins, both ETH, or both BTC. null otherwise. */
export function correlatedPair(base: string, quote: string): 'stable' | 'eth' | 'btc' | null {
  const a = norm(base), b = norm(quote);
  if (STABLE_SYMBOLS.has(a) && STABLE_SYMBOLS.has(b)) return 'stable';
  if (ETH_LIKE.has(a) && ETH_LIKE.has(b)) return 'eth';
  if (BTC_LIKE.has(a) && BTC_LIKE.has(b)) return 'btc';
  return null;
}

/**
 * An order's tick range at the pool's current tick. The quote coin is held on the side where the base is cheaper: below
 * the tick when the base is token0 (its price rises with the tick), above it when the base is token1. A buy order holds
 * the quote coin, a sell order the base coin. The step the price sits in is skipped: it needs both coins.
 */
export function orderTicks(tick: number, spacing: number, baseIs0: boolean, side: 'buy' | 'sell', steps: number): { tickLower: number; tickUpper: number } {
  const s0 = Math.floor(tick / spacing) * spacing;
  const below = side === 'buy' ? baseIs0 : !baseIs0;
  return below ? { tickLower: s0 - steps * spacing, tickUpper: s0 } : { tickLower: s0 + spacing, tickUpper: s0 + spacing + steps * spacing };
}

/** Where the price stands against an order: inside it (filling), gone through it (filled), or away from it (waiting). */
export function orderState(tick: number, tl: number, tu: number, baseIs0: boolean, side: 'buy' | 'sell'): 'filling' | 'filled' | 'waiting' {
  const below = side === 'buy' ? baseIs0 : !baseIs0;
  if (below) return tick < tl ? 'filled' : tick >= tu ? 'waiting' : 'filling';
  return tick >= tu ? 'filled' : tick < tl ? 'waiting' : 'filling';
}
