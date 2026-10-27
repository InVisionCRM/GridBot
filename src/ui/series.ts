/** Portfolio series built only from bot equity history and fills. No invented prices. */
import type { AnyObj } from './model';

export type DeskRange = '1H' | '1D' | '1W' | '1M' | 'ALL';

const WIN: Record<DeskRange, number | null> = {
  '1H': 3_600_000,
  '1D': 86_400_000,
  '1W': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
  ALL: null,
};

export function quoteUsd(b: AnyObj): number {
  return typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : 0;
}

/** Equity history in dollars. Empty when the quote has no dollar price. */
export function equityPoints(b: AnyObj): [number, number][] {
  const k = quoteUsd(b);
  if (!k) return [];
  return ((b.equityHist ?? []) as [number, number][]).map(([t, v]) => [t, v * k]);
}

export function botSpark(b: AnyObj): number[] {
  const pts = equityPoints(b).map(([, v]) => v);
  return pts.length > 1 ? pts.slice(-48) : [0, 0];
}

/** Latest book value in dollars, or the capital that was assigned when history has not started. */
export function bookUsd(b: AnyObj): number | null {
  const hist = equityPoints(b);
  if (hist.length) return hist[hist.length - 1][1];
  const k = quoteUsd(b);
  // totalCapitalUsd is in the quote coin (see deskStats); without a dollar rate there is no dollar value.
  if (b.kind === 'grid' && typeof b.config?.totalCapitalUsd === 'number') return k ? b.config.totalCapitalUsd * k : null;
  if (b.kind === 'trend' && k && typeof b.capital === 'number') return b.capital * k;
  if (b.kind === 'lp' && k && typeof b.config?.capital === 'number') return b.config.capital * k;
  if ((b.kind === 'trader' || b.kind === 'sniper') && typeof b.spentUsd === 'number') {
    return b.spentUsd + (typeof b.pnlUsd === 'number' ? b.pnlUsd : 0);
  }
  return null;
}

function downsample(pts: number[], n: number): number[] {
  if (pts.length <= n) return pts;
  const out: number[] = [];
  const step = (pts.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

/**
 * Change in dollar equity over the window. A bot's first sample is its baseline,
 * so capital showing up is not counted as profit. Points before the window are the baseline.
 */
export function portfolioSeries(bots: AnyObj[], range: DeskRange, now = Date.now()): number[] {
  const win = WIN[range];
  const from = win == null ? 0 : now - win;
  const before = new Map<string, number>();
  const inside: { t: number; id: string; v: number }[] = [];
  for (const b of bots) {
    for (const [t, v] of equityPoints(b)) {
      if (t < from) before.set(b.id, v);
      else inside.push({ t, id: b.id, v });
    }
  }
  if (!inside.length && before.size === 0) return [0, 0];
  inside.sort((a, c) => a.t - c.t);
  const base = new Map(before);
  const cur = new Map(before);
  const pnl = () => {
    let s = 0;
    for (const [id, v] of cur) s += v - (base.get(id) ?? v);
    return s;
  };
  const pts = [pnl()];
  for (const e of inside) {
    if (!base.has(e.id)) base.set(e.id, e.v);
    cur.set(e.id, e.v);
    pts.push(pnl());
  }
  return downsample(pts, 64);
}

export function seriesChange(pts: number[]): { delta: number; pct: number | null } {
  if (pts.length < 2) return { delta: 0, pct: null };
  const a = pts[0];
  const b = pts[pts.length - 1];
  return { delta: b - a, pct: a !== 0 ? (b - a) / Math.abs(a) : null };
}

/** How long equity history actually covers. */
export function equitySpan(bots: AnyObj[], now = Date.now()): number {
  let min = Infinity;
  for (const b of bots) for (const [t] of equityPoints(b)) if (t < min) min = t;
  return min === Infinity ? 0 : now - min;
}

/** Cumulative fees since local midnight, in dollars. */
export function feeSeries(bots: AnyObj[], now = Date.now()): number[] {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const start = from.getTime();
  const ev: { t: number; usd: number }[] = [];
  for (const b of bots) {
    const k = quoteUsd(b);
    if (!k) continue;
    for (const tr of (b.trades ?? []) as AnyObj[]) {
      if (tr.failed || !(tr.timestamp >= start) || typeof tr.feeQuote !== 'number') continue;
      ev.push({ t: tr.timestamp, usd: tr.feeQuote * k });
    }
  }
  ev.sort((a, c) => a.t - c.t);
  const pts = [0];
  let acc = 0;
  for (const e of ev) { acc += e.usd; pts.push(acc); }
  return pts;
}

/** Where a price sits in a range. Near means inside, within 12% of either edge. */
export function rangeTone(lower: number, upper: number, price: number | null, inRange: boolean | null): 'out' | 'near' | 'in' | 'flat' {
  if (!(upper > lower)) return 'flat';
  if (inRange === false || (price != null && (price < lower || price > upper))) return 'out';
  if (price == null) return 'in';
  const edge = Math.min(price - lower, upper - price) / (upper - lower);
  return edge < 0.12 ? 'near' : 'in';
}
