/** Group, filter, and sort the bots table. Presentation only. */
import { rangeState, type AnyObj } from './model';
import { botFacts, type DeskFacts } from './deskStats';

export const GROUPS = ['Grid', 'Trend', 'Liquidity', 'Token trader', 'Paper'] as const;
export type DeskGroup = typeof GROUPS[number];

export type DeskSort = 'name' | 'value' | 'generated' | 'pnl' | 'pnlPct' | 'age' | 'apr' | 'moves' | 'fees';
export type SortDir = 'asc' | 'desc';

export interface DeskQuery {
  q: string;
  type: 'all' | 'grid' | 'trend' | 'lp' | 'trader' | 'paper';
  chain: number | 'all';
  status: 'all' | 'running' | 'paused' | 'stopped' | 'out';
  mode: 'all' | 'live' | 'paper';
  sort: DeskSort;
  dir: SortDir;
}

export const emptyQuery = (): DeskQuery => ({ q: '', type: 'all', chain: 'all', status: 'all', mode: 'all', sort: 'name', dir: 'asc' });

export function groupOf(b: AnyObj): DeskGroup {
  if (b.kind === 'trader' || b.kind === 'sniper') return 'Token trader';
  if (b.kind === 'lp') return 'Liquidity';
  if (b.kind === 'trend') return 'Trend';
  if (b.kind === 'grid') return 'Grid';
  return b.mode === 'paper' ? 'Paper' : 'Grid';
}

export function outOfRange(b: AnyObj): boolean {
  if (b.kind === 'lp') return b.inRange === false;
  if (b.kind === 'grid') {
    const rs = rangeState(b);
    return rs === 'above' || rs === 'below';
  }
  return false;
}

export function statusOf(b: AnyObj): 'running' | 'paused' | 'stopped' {
  if (b.status === 'running') return 'running';
  if (b.status === 'stopped' || b.status === 'paused') return 'paused';
  return 'stopped';
}

export interface DeskItem {
  b: AnyObj;
  name: string;
  chain: string;
  chainId: number | null;
  group: DeskGroup;
  facts: DeskFacts;
}

export function deskItems(bots: AnyObj[], chainName: (b: AnyObj) => string, now = Date.now()): DeskItem[] {
  return bots.map((b) => ({
    b,
    name: String(b.label || b.name || (b.kind === 'grid' ? `${b.base ?? ''}/${b.quoteSym ?? ''}` : b.base) || b.id),
    chain: chainName(b),
    chainId: typeof b.chainId === 'number' ? b.chainId : null,
    group: groupOf(b),
    facts: botFacts(b, now, { chain: chainName(b) || null, dex: typeof b.dexName === 'string' ? b.dexName : null, pool: typeof b.pool === 'string' ? b.pool : null }),
  }));
}

function hay(it: DeskItem): string {
  return `${it.name} ${it.b.base ?? ''} ${it.b.quoteSym ?? ''} ${it.b.quote ?? ''} ${it.chain} ${it.b.id}`.toLowerCase();
}

export function matchItem(it: DeskItem, q: DeskQuery): boolean {
  const text = q.q.trim().toLowerCase();
  if (text && !hay(it).includes(text)) return false;
  if (q.type === 'paper' && it.b.mode !== 'paper') return false;
  if (q.type === 'grid' && it.b.kind !== 'grid') return false;
  if (q.type === 'trend' && it.b.kind !== 'trend') return false;
  if (q.type === 'lp' && it.b.kind !== 'lp') return false;
  if (q.type === 'trader' && it.b.kind !== 'trader' && it.b.kind !== 'sniper') return false;
  if (q.chain !== 'all' && it.chainId !== q.chain) return false;
  if (q.mode === 'live' && it.b.mode === 'paper') return false;
  if (q.mode === 'paper' && it.b.mode !== 'paper') return false;
  if (q.status === 'out') return outOfRange(it.b);
  if (q.status !== 'all' && statusOf(it.b) !== q.status) return false;
  return true;
}

function sortValue(it: DeskItem, key: DeskSort): number | string | null {
  const f = it.facts;
  if (key === 'name') return it.name.toLowerCase();
  if (key === 'value') return f.valueUsd;
  if (key === 'generated') return f.generatedUsd;
  if (key === 'pnl') return f.pnlUsd;
  if (key === 'pnlPct') return f.pnlPct;
  if (key === 'age') return f.ageMs;
  if (key === 'apr') return f.est.d365?.pct ?? null;
  if (key === 'moves') return f.moves.n;
  return f.feesEarnedUsd;
}

export function sortItems(items: DeskItem[], key: DeskSort, dir: SortDir): DeskItem[] {
  const mul = dir === 'asc' ? 1 : -1;
  return items.slice().sort((a, b) => {
    const av = sortValue(a, key), bv = sortValue(b, key);
    const an = av == null || av === '', bn = bv == null || bv === '';
    if (an && bn) return a.name.localeCompare(b.name);
    if (an) return 1;
    if (bn) return -1;
    const c = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : (av as number) - (bv as number);
    return c * mul || a.name.localeCompare(b.name);
  });
}

export interface DeskBucket { name: DeskGroup; rows: DeskItem[]; value: number | null; pnl: number | null }

function sumOf(xs: (number | null)[]): number | null {
  const n = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return n.length ? n.reduce((a, b) => a + b, 0) : null;
}

export function bucketItems(items: DeskItem[], q: DeskQuery): DeskBucket[] {
  const kept = sortItems(items.filter((it) => matchItem(it, q)), q.sort, q.dir);
  const by = new Map<DeskGroup, DeskItem[]>();
  for (const it of kept) {
    const g = q.type === 'paper' ? 'Paper' : it.group;
    const list = by.get(g);
    if (list) list.push(it); else by.set(g, [it]);
  }
  return GROUPS.filter((name) => by.has(name)).map((name) => {
    const rows = by.get(name)!;
    return { name, rows, value: sumOf(rows.map((r) => r.facts.valueUsd)), pnl: sumOf(rows.map((r) => r.facts.pnlUsd)) };
  });
}

/** First click on a number column sorts high to low. Name and age start low to high. */
export function nextSort(cur: DeskSort, dir: SortDir, key: DeskSort): { sort: DeskSort; dir: SortDir } {
  if (cur === key) return { sort: key, dir: dir === 'asc' ? 'desc' : 'asc' };
  const numeric = key !== 'name' && key !== 'age';
  return { sort: key, dir: numeric ? 'desc' : 'asc' };
}
