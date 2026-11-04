/**
 * A liquidity bot's day, for its page: fees and the pool's trading per hour today, today against yesterday at the same
 * time, the pool's last 24 hours, the price and the ranges it held today, and today's steps. (The APR and the projection
 * are botMetrics' Generated pace: one figure each, none scaled up from under a day.)
 * Computed on the server from the bot's status (lpEngine.status()): `feeHist` samples every 5 minutes
 * [ms, fees, fees base, fees quote, the pool's LP fees so far, price] (older samples hold only the first two), `done`
 * (finished steps, newest first), `poolFees` and `lpFeeRate` (the pool's fee rate to liquidity providers).
 * "Today" starts at local midnight, the same day Home's fees-today uses (lpFeesToday): its `today` figure is that one.
 */
import { localDayStart, lpFeesToday } from './feesToday';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const H = 3_600_000;

export interface LpHour {
  /** Local start of the hour (ms) */
  t: number;
  /** Not reached yet */
  future: boolean;
  /** Fees earned in the hour, in the quote coin (the current hour: so far); null when no reading covers it */
  fees: number | null;
  /** The same fees per coin */
  feeBase: number | null;
  feeQuote: number | null;
  /** Fees the pool paid all its liquidity providers in the hour (quote), and the trading that paid them */
  poolFees: number | null;
  volume: number | null;
  /** The last price read in the hour */
  price: number | null;
  /** Range moves that finished in the hour */
  moves: number;
}
export interface LpDone { t: number; action: 'open' | 'rerange' | 'close' | 'send' | 'compound'; asked: boolean; lower: number | null; upper: number | null; cost: number; fees: { base: number; quote: number } }
export interface LpDay {
  dayStart: number;
  hours: LpHour[];
  /** Fees earned since midnight (Home's figure) and yesterday from midnight to this time of day */
  today: number | null;
  yesterdayByNow: number | null;
  /** The pool over the last `hours` hours (up to 24): its LP fees, its trading volume, this bot's share of those fees */
  pool: { hours: number; lpFees: number; volume: number | null; volumeError: string | null; share: number | null } | null;
  /** Today's price readings [ms, price], the last one now */
  prices: [number, number][];
  /** The ranges held today, in order, each from when it opened (or midnight) to when it was replaced (or now) */
  ranges: { from: number; to: number; lower: number; upper: number }[];
  /** Steps finished today, newest first */
  moves: LpDone[];
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * A running total read at time t: the last sample at or before t (5 minutes apart at most while the bot runs), the live
 * figure at now; 0 before the bot started; null when the history doesn't reach back to t.
 */
function reader(samples: [number, number | null][], live: number | null, startedAt: number | null, now: number) {
  return (t: number): number | null => {
    if (startedAt != null && t <= startedAt) return 0;
    if (t >= now) return live;
    let v: number | null | undefined;
    for (const [st, x] of samples) { if (st > t) break; v = x; }
    return v === undefined ? null : v;
  };
}
const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);

export function lpDay(b: Obj, now: number): LpDay | null {
  if (b.kind !== 'lp' || !b.pnl) return null;
  const dayStart = localDayStart(now);
  const startedAt = num(b.startedAt);
  const hist = ((b.feeHist ?? []) as number[][]).filter((r) => Array.isArray(r) && num(r[0]) != null).sort((x, y) => x[0] - y[0]);
  const col = (i: number) => hist.map((r) => [r[0], r.length > i ? num(r[i]) : null] as [number, number | null]);
  const fees = reader(col(1), num(b.pnl.fees), startedAt, now);
  const feeBase = reader(col(2), num(b.pnl.feeCoins?.base), startedAt, now);
  const feeQuote = reader(col(3), num(b.pnl.feeCoins?.quote), startedAt, now);
  // the pool's fees were measured from the first reading on: before that sample nothing is known, even after the start
  const poolCol = col(4), firstPool = poolCol.find(([, v]) => v != null)?.[0] ?? null;
  const poolRead = reader(poolCol, num(b.poolFees), null, now);
  const pool = (t: number) => (firstPool == null || t < firstPool ? null : poolRead(t));
  const rate = num(b.lpFeeRate?.rate);
  const rateError: string | null = typeof b.lpFeeRate?.error === 'string' ? b.lpFeeRate.error : rate == null ? 'the pool\'s fee rate has not been read yet' : null;
  const vol = (f: number | null) => (f == null || rate == null || !(rate > 0) ? null : f / rate);

  const done = ((b.done ?? []) as LpDone[]).filter((d) => num(d.t) != null);
  const nextDay = localDayStart(dayStart + 36 * H);
  const hours: LpHour[] = [];
  for (let h = 0; ; h++) {
    const d = new Date(dayStart); d.setHours(h);
    const t = d.getTime();
    if (t >= nextDay) break;
    const end = Math.min(new Date(dayStart).setHours(h + 1), nextDay);
    const future = t > now, to = Math.min(end, now);
    const inHour = hist.filter((r) => r[0] >= t && r[0] < end && r.length > 5 && num(r[5]) != null);
    const pf = future ? null : diff(pool(to), pool(t));
    hours.push({
      t, future,
      fees: future ? null : diff(fees(to), fees(t)),
      feeBase: future ? null : diff(feeBase(to), feeBase(t)),
      feeQuote: future ? null : diff(feeQuote(to), feeQuote(t)),
      poolFees: pf, volume: vol(pf),
      price: future ? null : now < end ? num(b.price) : inHour.length ? num(inHour[inHour.length - 1][5]) : null,
      moves: done.filter((x) => x.action === 'rerange' && x.t >= t && x.t < end).length,
    });
  }

  const today = lpFeesToday(b, dayStart)?.quote ?? null;
  const yStart = localDayStart(dayStart - 12 * H);
  // only a bot that ran all of yesterday morning compares: one started since would read as a slow yesterday
  const yesterdayByNow = startedAt != null && startedAt <= yStart ? diff(fees(yStart + (now - dayStart)), fees(yStart)) : null;

  let poolDay: LpDay['pool'] = null;
  if (firstPool != null) {
    const from = Math.max(now - 24 * H, firstPool);
    const lp = diff(pool(now), pool(from));
    const mine = diff(fees(now), fees(from));
    if (lp != null && now - from >= H) poolDay = { hours: (now - from) / H, lpFees: lp, volume: vol(lp), volumeError: rate == null ? rateError : null, share: mine != null && lp > 0 ? mine / lp : null };
  }

  const prices = hist.filter((r) => r[0] >= dayStart && r.length > 5 && num(r[5]) != null).map((r) => [r[0], r[5]] as [number, number]);
  if (num(b.price) != null) prices.push([now, b.price]);

  // ranges: each open or move started one, a close ended the last; a bot with no log yet has only its open position
  const asc = [...done].sort((x, y) => x.t - y.t);
  const spans: { from: number; to: number; lower: number; upper: number }[] = [];
  let cur: { from: number; lower: number; upper: number } | null = null;
  for (const d of asc) {
    if (cur) spans.push({ ...cur, to: d.t });
    cur = d.lower != null && d.upper != null && (d.action === 'open' || d.action === 'rerange') ? { from: d.t, lower: d.lower, upper: d.upper }
      : d.action === 'close' || !cur ? null : { from: d.t, lower: cur.lower, upper: cur.upper };
  }
  if (cur) spans.push({ ...cur, to: now });
  if (!asc.length && b.position && num(b.position.lower) != null && num(b.position.upper) != null) spans.push({ from: num(b.position.openedAt) ?? dayStart, to: now, lower: b.position.lower, upper: b.position.upper });
  // a compound or send split a range into two pieces with the same edges: joined again
  const ranges: LpDay['ranges'] = [];
  for (const s of spans) {
    const from = Math.max(s.from, dayStart);
    if (s.to <= from) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.lower === s.lower && last.upper === s.upper && last.to === from) last.to = s.to;
    else ranges.push({ from, to: s.to, lower: s.lower, upper: s.upper });
  }

  return { dayStart, hours, today, yesterdayByNow, pool: poolDay, prices, ranges, moves: done.filter((d) => d.t >= dayStart) };
}
