/**
 * Token taxes (fee-on-transfer). Pure helpers shared by the quoter, the cost / start / spacing / trend gates,
 * the backtester and the tax watcher.
 *
 * Measured per token by the eth_call SafetyProbe as three separate numbers:
 *   buy      = pool → wallet transfer (you receive less than the router quoted)
 *   sell     = wallet → pool transfer (the pool receives less than you sent, so the swap prices a smaller input)
 *   transfer = wallet → wallet
 *
 * POLICY (documented in README "Decimals & taxes"):
 *   - V2 forks (PulseX V1/V2, 9mm V2, Uniswap V2): taxed tokens up to MAX_TAX per side may trade
 *     live. Swaps use the router's *SupportingFeeOnTransferTokens methods, amountOutMin is computed AFTER tax, and
 *     both taxes are part of every cost gate.
 *   - V3 pools: taxed tokens are blocked live unless the simulated buy → transfer → sell through that exact V3 pool
 *     succeeded ("proven"); then the router's minimum is set on the pre-tax pool output and the post-tax amount is
 *     checked from the actual balance change.
 *   - Any tax above MAX_TAX, a honeypot, paused trading or an unknown simulation → paper only.
 */
import { MAX_DECIMALS } from './decimals';

export interface Taxes { buy: number; sell: number; transfer: number }
export const NO_TAX: Taxes = { buy: 0, sell: 0, transfer: 0 };

/** Measured taxes below this are rounding, not a tax. */
export const TAX_TOLERANCE = 0.001;
/** Highest per-side tax allowed for live trading (fraction). Override: MAX_TOKEN_TAX_PCT=10. */
function envNum(name: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const v = Number(g?.process?.env?.[name]);
    return Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}
export const MAX_TAX = (() => {
  const v = envNum('MAX_TOKEN_TAX_PCT');
  return Number.isFinite(v) && v >= 0 && v <= 50 ? v / 100 : 0.10;
})();
/** A re-check counts as a tax increase above this many percentage points (fraction). */
export const TAX_RISE_EPS = 0.005;

export const isTaxed = (t: Taxes | null | undefined) => !!t && (t.buy > TAX_TOLERANCE || t.sell > TAX_TOLERANCE || t.transfer > TAX_TOLERANCE);
export const roundTripTax = (t: Taxes) => 1 - (1 - t.buy) * (1 - t.sell);

/** Taxes of a safety report (null / unmeasured → 0; callers gate on report.liveAllowed separately). */
export function taxesOf(s: { buyTaxPct: number | null; sellTaxPct: number | null; transferTaxPct: number | null } | null | undefined): Taxes {
  const c = (x: number | null | undefined) => (x != null && x > TAX_TOLERANCE ? Math.min(x, 0.99) : 0);
  return s ? { buy: c(s.buyTaxPct), sell: c(s.sellTaxPct), transfer: c(s.transferTaxPct) } : NO_TAX;
}

const PPM = 1_000_000n;
/** amount × (1 − pct), rounded down, in raw units (bigint; exact for any decimals). */
export function afterTax(amount: bigint, pct: number): bigint {
  if (!(pct > 0)) return amount;
  if (pct >= 1) return 0n;
  const keep = PPM - BigInt(Math.ceil(pct * 1e6));
  return (amount * keep) / PPM;
}

/** Describe what rose between two tax readings (null = no rise beyond TAX_RISE_EPS). */
export function taxRise(prev: Taxes, next: Taxes, eps = TAX_RISE_EPS): string | null {
  const parts: string[] = [];
  for (const k of ['buy', 'sell', 'transfer'] as const) {
    if (next[k] > prev[k] + eps) parts.push(`${k} ${(prev[k] * 100).toFixed(2)}% → ${(next[k] * 100).toFixed(2)}%`);
  }
  return parts.length ? parts.join(', ') : null;
}

export const fmtTax = (t: Taxes) => `buy ${(t.buy * 100).toFixed(2)}% / sell ${(t.sell * 100).toFixed(2)}%${t.transfer > TAX_TOLERANCE ? ` / transfer ${(t.transfer * 100).toFixed(2)}%` : ''}`;

export { MAX_DECIMALS };
