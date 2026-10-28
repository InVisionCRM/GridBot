/**
 * "Fees today" for Home, computed on the server from bot status payloads.
 * Headline: fees live liquidity bots earned since local midnight (collected + waiting). Paper bots and the pool
 * fees grid / trend trades paid (a cost) are separate figures, never added into the headline.
 */
import { unitOf } from '../lib/marketKey';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FeesToday {
  liveEarnedUsd: number;
  paperEarnedUsd: number;
  livePaidUsd: number;
  paperPaidUsd: number;
  /** Running total of live fees earned today (sparkline). */
  liveSeries: number[];
  dayStart: number;
  /** Per bot, so a chain-filtered view can add up only its bots. */
  byBot: Record<string, FeesTodayBot>;
}

/** One bot's fees today: in its quote coin (`sym`, what the page shows) and in dollars (null-price bots: 0). */
export interface FeesTodayBot {
  mode: 'live' | 'paper';
  earnedUsd: number;
  paidUsd: number;
  sym: string | null;
  earned: number;
  paid: number;
}

export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A liquidity bot's fees earned today in its quote coin, from `feeHist` ([ms, pnl.fees]): now − the last sample
 * before midnight. A bot started today counts everything; with no sample before midnight (history began later) the
 * first sample is the baseline, so nothing older is counted as today.
 */
export function lpFeesToday(b: Obj, dayStart: number): { quote: number; points: [number, number][] } | null {
  const nowFees = typeof b.pnl?.fees === 'number' && Number.isFinite(b.pnl.fees) ? (b.pnl.fees as number) : null;
  if (nowFees == null) return null;
  const hist = ((b.feeHist ?? []) as [number, number][]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  const before = hist.filter(([t]) => t < dayStart);
  let base: number;
  if (before.length) base = before[before.length - 1][1];
  else if (typeof b.startedAt === 'number' && b.startedAt >= dayStart) base = 0;
  else if (hist.length) base = hist[0][1];
  else return null;
  return { quote: nowFees - base, points: hist.filter(([t]) => t >= dayStart).map(([t, v]) => [t, v - base] as [number, number]) };
}

export function feesToday(bots: Obj[], now = Date.now()): FeesToday {
  const start = localDayStart(now);
  const out: FeesToday = { liveEarnedUsd: 0, paperEarnedUsd: 0, livePaidUsd: 0, paperPaidUsd: 0, liveSeries: [0], dayStart: start, byBot: {} };
  const ev: { t: number; id: string; usd: number }[] = [];
  for (const b of bots) {
    if (b.archivedAt) continue;
    const k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
    const sym = (unitOf(b.metrics?.quote?.symbol) ?? unitOf(b.quoteSym) ?? unitOf(b.quote) ?? unitOf(b.stable) ?? null) as string | null; // never a market key
    const paper = b.mode !== 'live';
    const row: FeesTodayBot = { mode: paper ? 'paper' : 'live', earnedUsd: 0, paidUsd: 0, sym, earned: 0, paid: 0 };
    // In coins every bot counts; the dollar figures (and the sparkline) only those with a dollar price, as before
    if (k != null || sym != null) out.byBot[String(b.id)] = row;
    if (b.kind === 'lp') {
      const f = lpFeesToday(b, start);
      if (!f) continue;
      row.earned = f.quote;
      if (k == null) continue;
      row.earnedUsd = f.quote * k;
      if (paper) out.paperEarnedUsd += f.quote * k;
      else {
        out.liveEarnedUsd += f.quote * k;
        for (const [t, v] of f.points) ev.push({ t, id: String(b.id), usd: v * k });
        ev.push({ t: now, id: String(b.id), usd: f.quote * k });
      }
      continue;
    }
    for (const tr of (b.trades ?? []) as Obj[]) {
      if (tr.failed || !(tr.timestamp >= start) || typeof tr.feeQuote !== 'number') continue;
      row.paid += tr.feeQuote;
      if (k == null) continue;
      row.paidUsd += tr.feeQuote * k;
      if (paper) out.paperPaidUsd += tr.feeQuote * k;
      else out.livePaidUsd += tr.feeQuote * k;
    }
  }
  ev.sort((a, c) => a.t - c.t);
  const cur = new Map<string, number>();
  for (const e of ev) {
    cur.set(e.id, e.usd);
    out.liveSeries.push([...cur.values()].reduce((s, x) => s + x, 0));
  }
  return out;
}
