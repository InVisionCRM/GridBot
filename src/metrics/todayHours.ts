/**
 * What each bot made in each local hour today, in its own quote coin, for Home's "today by bot, per hour" (the bars are
 * split by bot), and how many round trips each grid level made today (the grid page's level heat).
 * - grid and trend: the realized result of the fills in that hour (a sale's profit after fees and gas; a failed send
 *   costs its gas; buys carry their gas in the cost and count 0), from every fill of the bot's mode
 * - liquidity: its fees in that hour (lpDay) minus what its steps that hour cost in gas and swap fees
 * Hours come from the server's local day (the same day as Home's fees-today); hours to come are not listed.
 */
import type { LpDay } from './lpDay';

export type HourValue = [number, number | null];
interface Fill { timestamp: number; realizedPnlQuote: number; side: string; failed?: boolean; manual?: boolean; closeSale?: boolean; intervalIndex?: number }

/** The starts of the local hours of the day that starts at `dayStart`, up to and including the hour `now` is in. */
export function hourStarts(dayStart: number, now: number): number[] {
  const next = new Date(dayStart); next.setDate(next.getDate() + 1);
  const out: number[] = [];
  for (let h = 0; ; h++) {
    const d = new Date(dayStart); d.setHours(h);
    const t = d.getTime();
    if (t >= next.getTime() || t > now) break;
    out.push(t);
  }
  return out;
}

/** A grid's or trend bot's realized result per hour today, from its fills (manual test trades are not the bot's). */
export function tradeHours(fills: Fill[], dayStart: number, now: number): HourValue[] {
  const hs = hourStarts(dayStart, now);
  return hs.map((t, i) => {
    const end = hs[i + 1] ?? now + 1;
    const v = fills.filter((f) => !f.manual && f.timestamp >= t && f.timestamp < end).reduce((a, f) => a + f.realizedPnlQuote, 0);
    return [t, v];
  });
}

/** A liquidity bot's fees per hour today minus its steps' costs in that hour; an hour with no reading is null. */
export function lpHours(day: LpDay): HourValue[] {
  return day.hours.filter((h) => !h.future).map((h) => {
    if (h.fees == null) return [h.t, null];
    const end = h.t + 3_600_000;
    const cost = day.moves.filter((m) => m.t >= h.t && m.t < end).reduce((a, m) => a + m.cost, 0);
    return [h.t, h.fees - cost];
  });
}

/** Round trips each grid level (interval index) finished today: its completed sales, not a close's sale or a test trade. */
export function levelHeat(fills: Fill[], dayStart: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const f of fills) {
    if (f.side !== 'sell' || f.failed || f.manual || f.closeSale || f.timestamp < dayStart || f.intervalIndex == null) continue;
    out[f.intervalIndex] = (out[f.intervalIndex] ?? 0) + 1;
  }
  return out;
}
