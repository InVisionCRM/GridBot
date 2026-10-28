/**
 * Daily summary text from a status snapshot. Read-only: it does not start, stop, or resize a bot.
 * Live and paper stay apart. Amounts are token units. The P&L word is Generated.
 */

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
function symbol(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9]{1,12}$/.test(v) ? v : null;
}

/** Token units. No dollar sign. */
function qty(n: number): string {
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  const digits = a >= 100 ? 2 : 4;
  const s = a.toLocaleString('en-US', { maximumFractionDigits: digits });
  return `${sign}${s}`;
}

interface Row { chain: string; symbol: string; amount: number }

function add(rows: Map<string, Row>, id: number | null, chain: string, sym: string | null, amount: number) {
  if (id == null || !sym || !Number.isFinite(amount) || amount === 0) return;
  const key = `${id}:${sym}`;
  const cur = rows.get(key);
  if (cur) cur.amount += amount;
  else rows.set(key, { chain, symbol: sym, amount });
}

function section(label: string, rows: Map<string, Row>, trips: number): string | null {
  if (!rows.size) return null;
  const parts = [...rows.values()].map((r) => `${r.chain} ${qty(r.amount)} ${r.symbol}`);
  const tripText = trips ? ` ${trips} round trip${trips === 1 ? '' : 's'}.` : '';
  return `${label} — ${parts.join(' · ')}.${tripText}`;
}

/**
 * Live first, then paper labeled Paper. When nothing is paper, the paper line is left out.
 * Cumulative, not "today".
 */
export function dailySummary(status: unknown): { title: string; body: string } {
  const s = asObj(status) ?? {};
  const names = new Map<number, string>();
  for (const c of asArr(s.chains)) {
    const id = chainId(c.id);
    if (id != null && typeof c.name === 'string') names.set(id, c.name);
  }
  const live = new Map<string, Row>();
  const paper = new Map<string, Row>();
  let liveTrips = 0;
  let paperTrips = 0;
  const book = (mode: unknown, id: number | null, sym: string | null, amount: number, trips = 0) => {
    const chain = id == null ? 'chain' : names.get(id) ?? `chain ${id}`;
    if (mode === 'paper') {
      add(paper, id, chain, sym, amount);
      paperTrips += trips;
    } else {
      add(live, id, chain, sym, amount);
      liveTrips += trips;
    }
  };
  for (const g of asArr(s.grids)) {
    const sym = symbol(g.quoteSym) ?? symbol(g.stable);
    book(g.mode, chainId(g.chainId), sym, num(asObj(g.pnl)?.realized), num(asObj(g.stats)?.roundTrips));
  }
  for (const t of asArr(s.trends)) {
    const sym = symbol(t.quoteSym) ?? symbol(t.quote);
    book(t.mode, chainId(t.chainId), sym, num(asObj(t.pnl)?.realized), num(asObj(t.stats)?.count));
  }
  for (const lp of asArr(s.lps)) {
    const net = asObj(lp.pnl)?.net;
    if (typeof net !== 'number') continue;
    book(lp.mode, chainId(lp.chainId), symbol(lp.quote), net);
  }
  const lines = [section('Generated', live, liveTrips), section('Paper', paper, paperTrips)].filter((x): x is string => !!x);
  return {
    title: 'GridBot · daily summary',
    body: lines.length ? lines.join(' ') : 'No generated profit to report.',
  };
}
