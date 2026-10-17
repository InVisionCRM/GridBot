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
