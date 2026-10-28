/** Where a price sits in a liquidity band. Shared by the push watcher and the Alerts screen. */

export type RangeZone = 'in' | 'near' | 'out';

/** 0 at the lower price, 1 at the upper. Null when the band is empty. */
export function bandPos(price: number, lower: number, upper: number): number | null {
  if (!(upper > lower) || !Number.isFinite(price)) return null;
  return (price - lower) / (upper - lower);
}

/** Share of the band between the price and the nearer edge. 0 on an edge, 0.5 in the middle. */
export function fromEdge(price: number, lower: number, upper: number): number | null {
  const pos = bandPos(price, lower, upper);
  if (pos == null) return null;
  return Math.min(pos, 1 - pos);
}

/**
 * Near means still inside, and past 80% of the way toward an edge (within 20% of a side).
 * Once near, it stays near until the price is 25% back from the edge, so a tick on the line does not flap.
 */
export function rangeZone(price: number, lower: number, upper: number, inRange: boolean | null, prev: RangeZone | null = null): RangeZone {
  if (inRange === false || price < lower || price > upper) return 'out';
  const edge = fromEdge(price, lower, upper);
  if (edge == null) return 'in';
  const limit = prev === 'near' ? 0.25 : 0.20;
  return edge <= limit ? 'near' : 'in';
}

/** 50 in the middle, 100 on an edge. "86% to edge" is a price 86% of the way across the band. */
export function pctToEdge(price: number, lower: number, upper: number): number | null {
  const pos = bandPos(price, lower, upper);
  if (pos == null) return null;
  const clamped = Math.min(1, Math.max(0, pos));
  return Math.round(Math.max(clamped, 1 - clamped) * 100);
}
