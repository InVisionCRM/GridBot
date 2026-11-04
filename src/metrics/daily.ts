/**
 * Each bot's Generated per local day, for the 30-day calendar (Home and each bot page). The server keeps one snapshot
 * per bot per day: its Generated (per coin, and in dollars where it has a rate) the first time it is read that day.
 * A day's figure is the next day's snapshot minus that day's; today's is now minus this morning's. When the server was
 * not running at midnight, a day starts at its first reading (`from`), so it can hold part of the night before.
 * Kept DAILY_KEEP days per bot, in the bot manager's state (MultiState.daily).
 */
export const DAILY_KEEP = 62;
export const DAILY_SHOWN = 30;

export interface DaySnap { at: number; gen: Record<string, number>; usd: number | null }
/** botId → local date (YYYY-MM-DD) → the first reading that day */
export type DailyBook = Record<string, Record<string, DaySnap>>;
export interface DayResult { d: string; from: number; gen: Record<string, number>; usd: number | null }

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Takes today's snapshot of each bot not yet read today; drops days past DAILY_KEEP. True when the book changed. */
export function noteDaily(book: DailyBook, bots: { id: string; generated: Record<string, number> | null; generatedUsd: number | null }[], now: number): boolean {
  const k = dayKey(now);
  let changed = false;
  for (const b of bots) {
    if (!b.generated) continue;
    const days = (book[b.id] ??= {});
    if (days[k]) continue;
    days[k] = { at: now, gen: { ...b.generated }, usd: b.generatedUsd };
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - DAILY_KEEP))) delete days[old];
    changed = true;
  }
  return changed;
}

const minus = (a: Record<string, number>, b: Record<string, number>) => {
  const out: Record<string, number> = {};
  for (const sym of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const v = (a[sym] ?? 0) - (b[sym] ?? 0);
    if (v !== 0) out[sym] = v;
  }
  return out;
};

/** A bot's days, oldest first (the last DAILY_SHOWN): each day's Generated per coin and in dollars (null without a rate). */
export function dailyOf(days: Record<string, DaySnap> | undefined, now: { generated: Record<string, number> | null; generatedUsd: number | null }): DayResult[] {
  if (!days) return [];
  const keys = Object.keys(days).sort();
  return keys.map((k, i) => {
    const a = days[k], z = i + 1 < keys.length ? days[keys[i + 1]] : { gen: now.generated ?? a.gen, usd: now.generatedUsd };
    return { d: k, from: a.at, gen: minus(z.gen, a.gen), usd: a.usd != null && z.usd != null ? z.usd - a.usd : null };
  }).slice(-DAILY_SHOWN);
}
