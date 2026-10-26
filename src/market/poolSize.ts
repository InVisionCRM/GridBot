/**
 * How much of a pool a buy or an entry swap can use.
 *
 * Price impact on a constant-product pool (V2, and the V3 active range modelled the same way):
 *   impact = inWithFee / (quoteReserve + inWithFee), inWithFee = quoteIn × (1 − fee).
 * So the most quote you can spend at a cap is (cap / (1 − cap)) × reserve / (1 − fee).
 *
 * A liquidity position also takes a share of the pool's active liquidity. Reported USD liquidity counts
 * out-of-range liquidity, which is why $10k on a ~$48k pool was 86% of the active range. Cap by active
 * liquidity and by the entry swap's impact, not by the headline number alone.
 */
import { simBuy } from './costs';

/** Default share of a pool's active liquidity a grid or liquidity position may be. */
export const DEFAULT_MAX_POOL_SHARE = 0.10;
/** A token-trader buy stays tighter: 2% of the spend-side reserve. */
export const TOKEN_MAX_POOL_SHARE = 0.02;

/** Price impact of spending `quoteIn` against `quoteReserve` (fee is a fraction, 0.003 = 0.3%). */
export function impactOf(quoteIn: number, quoteReserve: number, fee: number): number {
  if (!(quoteIn > 0)) return 0;
  if (!(quoteReserve > 0) || fee >= 1) return 1;
  const inF = quoteIn * (1 - Math.max(0, fee));
  return inF / (quoteReserve + inF);
}

/** Most quote that can be spent without crossing `maxImpact` (a fraction). */
export function maxQuoteIn(quoteReserve: number, fee: number, maxImpact: number): number {
  if (!(quoteReserve > 0) || !(maxImpact > 0)) return 0;
  if (maxImpact >= 1 || fee >= 1) return Infinity;
  return (maxImpact / (1 - maxImpact)) * quoteReserve / (1 - Math.max(0, fee));
}

export interface SizeCap {
  /** Quote (or capital) that fits */
  amount: number;
  /** What was asked */
  asked: number;
  impact: number;
  /** Share of the quote reserve the swap itself is, when a reserve was given */
  reserveShare: number;
  /** Why it was cut, or null when the ask already fits */
  why: string | null;
}

/**
 * Cap one swap. `maxPoolShare` limits the swap to that fraction of the quote reserve (the tokens it pulls
 * out of the pool), on top of the price-impact cap.
 */
export function capSwap(p: { quoteIn: number; quoteReserve: number; feeBps: number; maxImpact: number; maxPoolShare?: number }): SizeCap {
  const fee = p.feeBps / 10_000;
  const share = p.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE;
  const byImpact = maxQuoteIn(p.quoteReserve, fee, p.maxImpact);
  const byShare = p.quoteReserve > 0 ? p.quoteReserve * share : 0;
  const amount = Math.max(0, Math.min(p.quoteIn, byImpact, byShare));
  const impact = impactOf(amount, p.quoteReserve, fee);
  const reserveShare = p.quoteReserve > 0 ? amount / p.quoteReserve : 0;
  const why = amount < p.quoteIn * 0.999
    ? (byShare < byImpact
      ? `cut to ${(share * 100).toFixed(0)}% of the pool's ${fmt(p.quoteReserve)} quote side`
      : `cut so the price moves ${(impact * 100).toFixed(2)}% (cap ${(p.maxImpact * 100).toFixed(2)}%)`)
    : null;
  return { amount, asked: p.quoteIn, impact, reserveShare, why };
}

/**
 * Liquidity entry. `capital` is the whole deposit in quote units. `baseShare` of it is swapped into the base
 * coin (about half when the range is centred). The position's value stays within `maxPoolShare` of active
 * liquidity when `activeQuote` (the active range, in quote units) is known.
 */
export function capLpEntry(p: {
  capital: number; quoteReserve: number; feeBps: number; maxImpact: number;
  baseShare?: number; maxPoolShare?: number; activeQuote?: number; buyTax?: number;
}): SizeCap {
  const share = p.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE;
  const baseShare = Math.min(1, Math.max(0, p.baseShare ?? 0.5));
  const byPool = p.activeQuote != null && p.activeQuote > 0 ? (share / (1 - share)) * p.activeQuote : Infinity;
  const swapRoom = capSwap({
    quoteIn: Infinity, quoteReserve: p.quoteReserve, feeBps: p.feeBps, maxImpact: p.maxImpact, maxPoolShare: share,
  }).amount;
  const bySwap = baseShare > 0 ? swapRoom / baseShare : Infinity;
  const amount = Math.max(0, Math.min(p.capital, byPool, bySwap));
  const swapIn = amount * baseShare;
  const impact = impactOf(swapIn, p.quoteReserve, p.feeBps / 10_000);
  const why = amount < p.capital * 0.999
    ? (byPool <= bySwap
      ? `cut to ${(share * 100).toFixed(0)}% of the pool's active liquidity (${fmt(p.activeQuote ?? 0)} quote)`
      : `the entry swap of ${fmt(swapIn)} would move the price more than ${(p.maxImpact * 100).toFixed(2)}%`)
    : null;
  return { amount, asked: p.capital, impact, reserveShare: p.quoteReserve > 0 ? swapIn / p.quoteReserve : 0, why: why && p.buyTax ? `${why}; buy tax ${(p.buyTax * 100).toFixed(1)}% is in the cost` : why };
}

/**
 * Grid entry. Levels below the price buy immediately; assume up to half the capital does, spread over
 * `gridCount / 2` buys. Each of those must fit the impact cap and the pool-share cap.
 */
export function capGridEntry(p: { capital: number; quoteReserve: number; feeBps: number; maxImpact: number; gridCount: number; maxPoolShare?: number }): SizeCap {
  const immediateLevels = Math.max(1, Math.ceil(p.gridCount / 2));
  const perLevelRoom = capSwap({
    quoteIn: Infinity, quoteReserve: p.quoteReserve, feeBps: p.feeBps, maxImpact: p.maxImpact, maxPoolShare: p.maxPoolShare,
  }).amount;
  const byLevels = perLevelRoom * p.gridCount;
  // The buys that fire at the open, together, also have to fit (they hit the same reserves).
  const openRoom = capSwap({
    quoteIn: Infinity, quoteReserve: p.quoteReserve, feeBps: p.feeBps, maxImpact: p.maxImpact, maxPoolShare: p.maxPoolShare,
  }).amount;
  const byOpen = openRoom * (p.gridCount / immediateLevels);
  const amount = Math.max(0, Math.min(p.capital, byLevels, byOpen));
  const openIn = amount * (immediateLevels / p.gridCount);
  const impact = impactOf(openIn / immediateLevels, p.quoteReserve, p.feeBps / 10_000);
  const why = amount < p.capital * 0.999
    ? `suggested ${fmt(amount)}: a level buy at ${fmt(p.capital)} would move the price more than ${(p.maxImpact * 100).toFixed(2)}% or take more than ${((p.maxPoolShare ?? DEFAULT_MAX_POOL_SHARE) * 100).toFixed(0)}% of the pool`
    : null;
  return { amount, asked: p.capital, impact, reserveShare: p.quoteReserve > 0 ? (amount / p.gridCount) / p.quoteReserve : 0, why };
}

/**
 * Fraction of capital the entry swap costs (fee + impact + tax) at the size that will actually be deployed.
 * null = even a 1% slice cannot enter under the cap, so the pool should not be ranked on this size.
 */
export function entryCostFraction(p: {
  capital: number; quoteReserve: number; feeBps: number; maxImpact: number;
  baseShare?: number; maxPoolShare?: number; buyTax?: number;
}): number | null {
  const fit = capLpEntry(p);
  if (!(fit.amount > 0)) return null;
  const swapIn = fit.amount * (p.baseShare ?? 0.5);
  if (!(swapIn > 0)) return 0;
  const minUseful = fit.asked * 0.01;
  if (fit.amount < minUseful && fit.why) return null;
  const b = simBuy(swapIn, 1, { feeBps: p.feeBps, pool: { quoteReserve: p.quoteReserve, plsReserve: p.quoteReserve }, gasPricePls: 0, approval: 'exact', slippageBps: 0, buyTaxPct: p.buyTax ?? 0 });
  return Math.max(0, (swapIn - b.pls) / fit.amount);
}

const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
};
