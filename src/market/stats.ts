/** Trade / equity statistics shared by analytics (grid + trend bots) and the UI. Pure. */
export interface ClosedTrade { pnl: number; t: number; holdMs?: number; cost?: number }

export function tradeStats(trades: ClosedTrade[]) {
  const wins = trades.filter((x) => x.pnl > 0), losses = trades.filter((x) => x.pnl <= 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -losses.reduce((a, x) => a + x.pnl, 0);
  let maxW = 0, maxL = 0, run = 0;
  for (const x of trades) {
    if (x.pnl > 0) run = run > 0 ? run + 1 : 1; else run = run < 0 ? run - 1 : -1;
    maxW = Math.max(maxW, run); maxL = Math.max(maxL, -run);
  }
  const pnls = trades.map((x) => x.pnl);
  return {
    count: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null,
    total: gw - gl,
    avg: trades.length ? (gw - gl) / trades.length : null,
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    maxWinStreak: maxW, maxLossStreak: maxL, streak: run,
    avgHoldMs: trades.some((x) => x.holdMs != null) ? trades.reduce((a, x) => a + (x.holdMs ?? 0), 0) / trades.length : null,
  };
}
export type TradeStats = ReturnType<typeof tradeStats>;

/** Max drawdown of an equity series, plus the drawdown curve (fractions ≥ 0). */
export function drawdown(points: [number, number][]) {
  let peak = -Infinity, max = 0;
  const curve: [number, number][] = [];
  for (const [t, v] of points) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? 1 - v / peak : 0;
    max = Math.max(max, dd);
    curve.push([t, dd]);
  }
  return { max, curve };
}

/** Append a point; when over cap, thin the older half (every other point) so long histories stay bounded. */
export function pushCapped<T>(arr: T[], p: T, cap = 3000): T[] {
  arr.push(p);
  if (arr.length > cap) {
    const half = Math.floor(arr.length / 2);
    const thinned = arr.slice(0, half).filter((_, i) => i % 2 === 0);
    arr.splice(0, arr.length, ...thinned, ...arr.slice(half));
  }
  return arr;
}
