/**
 * Grid spacing vs PulseX V2 round-trip fees.
 * Round-trip fee ≈ 1 − (1 − fee)^2. With fee = 29 bps → ~0.5791%.
 * Worst interval is the highest buy (smallest relative step on an arithmetic grid).
 */

export const PULSEX_FEE_BPS = 29;
export const ROUND_TRIP_FEE = 1 - (1 - PULSEX_FEE_BPS / 10_000) ** 2;

export const MAX_GRID_COUNT = 50;
export const MIN_GRID_COUNT = 2;
/** Dense presets offered in the UI (still editable). */
export const DENSE_PRESETS = [10, 20, 30, 40] as const;

export interface SpacingAnalysis {
  step: number;
  /** Relative spacing of the worst (highest) buy interval: step / buyPrice */
  worstSpacingFrac: number;
  roundTripFee: number;
  clearsFees: boolean;
  /** Human tip when spacing is tight */
  warning: string | null;
}

export function analyzeSpacing(lowerPrice: number, upperPrice: number, gridCount: number): SpacingAnalysis {
  const step = (upperPrice - lowerPrice) / gridCount;
  const worstBuy = lowerPrice + step * (gridCount - 1); // levels[n-1]
  const worstSpacingFrac = worstBuy > 0 ? step / worstBuy : 0;
  const clearsFees = worstSpacingFrac > ROUND_TRIP_FEE;
  const warning = clearsFees
    ? null
    : `Spacing ${(worstSpacingFrac * 100).toFixed(3)}% < PulseX round-trip ~${(ROUND_TRIP_FEE * 100).toFixed(3)}% — fills may lose to fees.`;
  return { step, worstSpacingFrac, roundTripFee: ROUND_TRIP_FEE, clearsFees, warning };
}

export function validateGridParams(lowerPrice: number, upperPrice: number, gridCount: number, totalCapitalUsd: number): string[] {
  const e: string[] = [];
  if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) e.push('upperPrice must be > lowerPrice > 0');
  if (!Number.isInteger(gridCount) || gridCount < MIN_GRID_COUNT || gridCount > MAX_GRID_COUNT) {
    e.push(`gridCount must be ${MIN_GRID_COUNT}–${MAX_GRID_COUNT}`);
  }
  if (!(totalCapitalUsd > 0)) e.push('totalCapitalUsd must be > 0');
  return e;
}
