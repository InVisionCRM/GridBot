/** Daily summary text from a status snapshot. Read-only: it does not start, stop, or resize a bot. */

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}
function asArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : [];
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function chainId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function money(n: number): string {
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  const s = a >= 100 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${s}`;
}

/** Realized grid and trend profit, plus liquidity net, in dollars per chain. Cumulative, not "today". */
export function dailySummary(status: unknown): { title: string; body: string } {
  const s = asObj(status) ?? {};
  const names = new Map<number, string>();
  for (const c of asArr(s.chains)) {
    const id = chainId(c.id);
    if (id != null && typeof c.name === 'string') names.set(id, c.name);
  }
  const usd = new Map<number, number>();
  let trips = 0;
  const add = (id: number | null, amount: number) => {
    if (id == null || !Number.isFinite(amount) || amount === 0) return;
    usd.set(id, (usd.get(id) ?? 0) + amount);
  };
  for (const g of asArr(s.grids)) {
    const k = g.usdPerQuote;
    if (typeof k === 'number') add(chainId(g.chainId), num(asObj(g.pnl)?.realized) * k);
    trips += num(asObj(g.stats)?.roundTrips);
  }
  for (const t of asArr(s.trends)) {
    const k = t.usdPerQuote;
    if (typeof k === 'number') add(chainId(t.chainId), num(asObj(t.pnl)?.realized) * k);
    trips += num(asObj(t.stats)?.count);
  }
  for (const lp of asArr(s.lps)) {
    const k = lp.usdPerQuote;
    const net = asObj(lp.pnl)?.net;
    if (typeof k === 'number' && typeof net === 'number') add(chainId(lp.chainId), net * k);
  }
  const parts = [...usd.entries()].map(([id, n]) => `${names.get(id) ?? `chain ${id}`}: ${money(n)}`);
  const tripText = trips ? ` ${trips} round trip${trips === 1 ? '' : 's'}.` : '';
  const body = parts.length
    ? `Realized so far — ${parts.join(' · ')}.${tripText}`
    : 'No priced realized profit to report.';
  return { title: 'GridBot · daily summary', body };
}
