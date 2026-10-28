/**
 * When a liquidity position moves its range. Live `LpEngine.watchRange` and the backtest harness both call this,
 * so a change to the rule changes both. Dwell and cooldown default to 0: the live rule moves on the first reading
 * outside the range (unless the swap back to the mix would cross the price-impact cap).
 */
export interface LpMoveInput {
  /** Auto-move is on */
  rerange: boolean;
  outOfRange: boolean;
  /** The swap to the new range's mix would exceed the price-impact cap */
  blocked: boolean;
  /** Unix milliseconds, same clock as the live bot */
  now: number;
  /** When the price first left the range this stretch (null if this reading is the first) */
  outSince: number | null;
  /** When the range last moved (null if it never has) */
  lastMoveAt: number | null;
  /** Must have been outside at least this long. Live default 0. */
  dwellMs?: number;
  /** Minimum time between moves. Live default 0. */
  cooldownMs?: number;
}

export function lpShouldMove(i: LpMoveInput): { move: boolean; outSince: number | null } {
  if (!i.outOfRange) return { move: false, outSince: null };
  const outSince = i.outSince ?? i.now;
  if (!i.rerange || i.blocked) return { move: false, outSince };
  if (i.now - outSince < (i.dwellMs ?? 0)) return { move: false, outSince };
  if (i.lastMoveAt != null && i.now - i.lastMoveAt < (i.cooldownMs ?? 0)) return { move: false, outSince };
  return { move: true, outSince };
}
