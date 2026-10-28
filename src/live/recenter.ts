/** Auto-recenter (follow the price up) timing, shared by the grid engine and the UI. */

/** Price must stay above the range this long before the range moves… */
export const RECENTER_AFTER_MS = 2 * 3600_000;
/** …and the range moves at most once per this long. */
export const RECENTER_COOLDOWN_MS = 6 * 3600_000;

export interface RecenterState { enabled: boolean; aboveSince: number | null; lastAt: number | null; count: number }

/** When the range will move if the price stays above it (null when it isn't above or the feature is off). */
export function recenterAt(r: RecenterState | null | undefined): number | null {
  if (!r?.enabled || r.aboveSince == null) return null;
  return Math.max(r.aboveSince + RECENTER_AFTER_MS, r.lastAt == null ? 0 : r.lastAt + RECENTER_COOLDOWN_MS);
}

/**
 * The live grid's follow-up decision, also what the backtest harness calls. Move up only, after the price has
 * stayed above the range for RECENTER_AFTER_MS, at most once per RECENTER_COOLDOWN_MS, and only when nothing is
 * held or in flight (`flat`). A price at or below the top clears the timer. Defaults match the live bot.
 */
export function shouldRecenter(r: RecenterState, price: number, upperPrice: number, now: number, flat: boolean): { aboveSince: number | null; move: boolean } {
  if (!r.enabled) return { aboveSince: r.aboveSince, move: false };
  if (!(price > upperPrice)) return { aboveSince: null, move: false };
  const aboveSince = r.aboveSince ?? now;
  if (!flat || now - aboveSince < RECENTER_AFTER_MS) return { aboveSince, move: false };
  if (r.lastAt != null && now - r.lastAt < RECENTER_COOLDOWN_MS) return { aboveSince, move: false };
  return { aboveSince, move: true };
}
