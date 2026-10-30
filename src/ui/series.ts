/** Portfolio series built only from bot equity history and fills. No invented prices. */
import type { AnyObj } from './model';


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
  // totalCapitalQuote is in the quote coin (see deskStats); without a dollar rate there is no dollar value.
  if (b.kind === 'grid' && typeof b.config?.totalCapitalQuote === 'number') return k ? b.config.totalCapitalQuote * k : null;
  if (b.kind === 'trend' && k && typeof b.capital === 'number') return b.capital * k;
  if (b.kind === 'lp' && k && typeof b.config?.capital === 'number') return b.config.capital * k;
  if ((b.kind === 'trader' || b.kind === 'sniper') && typeof b.spentUsd === 'number') {
    return b.spentUsd + (typeof b.pnlUsd === 'number' ? b.pnlUsd : 0);
  }
  return null;
}

/** Where a price sits in a range. Near means inside, within 12% of either edge. */
export function rangeTone(lower: number, upper: number, price: number | null, inRange: boolean | null): 'out' | 'near' | 'in' | 'flat' {
  if (!(upper > lower)) return 'flat';
  if (inRange === false || (price != null && (price < lower || price > upper))) return 'out';
  if (price == null) return 'in';
  const edge = Math.min(price - lower, upper - price) / (upper - lower);
  return edge < 0.12 ? 'near' : 'in';
}
