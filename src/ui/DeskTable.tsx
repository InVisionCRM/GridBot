/** Grouped, filtered, sortable bot table. */
import { useMemo, useState } from 'react';
import { BotRow } from './botRow';
import { chainOf } from './chains';
import { bucketItems, emptyQuery, nextSort, type DeskQuery, type DeskSort, deskItems } from './deskTableModel';
import { cls, qty, usd } from './fmt';
import { pegged } from './money';
import { quoteSym } from './model';
import type { DeskBucket } from './deskTableModel';
import type { AnyObj, Nav } from './model';

const TYPES: [DeskQuery['type'], string][] = [['all', 'All'], ['grid', 'Grid'], ['trend', 'Trend'], ['lp', 'Liquidity'], ['trader', 'Token trader'], ['paper', 'Paper']];
const STATUSES: [DeskQuery['status'], string][] = [['all', 'Any status'], ['running', 'Running'], ['paused', 'Paused'], ['stopped', 'Stopped'], ['out', 'Out of range']];
const MODES: [DeskQuery['mode'], string][] = [['all', 'Live + paper'], ['live', 'Live'], ['paper', 'Paper']];
const SORTS: [DeskSort, string][] = [
  ['name', 'Name'], ['value', 'Value'], ['pnl', 'P&L $'], ['pnlPct', 'P&L %'], ['age', 'Age'], ['apr', 'Est. APR'], ['moves', 'Moves'], ['fees', 'Fees earned'],
];

function Chip({ on, children, onClick }: { on: boolean; children: string; onClick: () => void }) {
  return <button type="button" className={`chip-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

/**
 * A group's totals. One bot: nothing (its row has the figures; each figure once per screen). Several in one coin: the
 * coin first, dollars small (left out for a coin worth about a dollar, where they'd repeat it). Mixed coins: dollars.
 */
export function GroupTotals({ g }: { g: DeskBucket }) {
  if (g.rows.length < 2) return null;
  const syms = new Set(g.rows.map((it) => String(quoteSym(it.b) ?? '')));
  const ks = g.rows.map((it) => it.b.usdPerQuote);
  const sym = syms.size === 1 ? [...syms][0] : '';
  const k = sym && ks.every((x) => typeof x === 'number' && x > 0) ? ks[0] as number : null;
  const one = k != null && ks.every((x) => Math.abs((x as number) - k) < 1e-9 * k);
  if (!sym || !one) {
    return <>
      <span className="mono">{g.value == null ? '—' : usd(g.value)}</span>
      <span className={cls(g.pnl)}>{g.pnl == null ? '—' : usd(g.pnl, true)}</span>
    </>;
  }
  const small = !pegged(k);
  return <>
    <span className="mono">{g.value == null ? '—' : qty(g.value / k, sym, 5, false)}{small && g.value != null && <small className="muted"> {usd(g.value)}</small>}</span>
    <span className={cls(g.pnl)}>{g.pnl == null ? '—' : qty(g.pnl / k, sym, 4)}{small && g.pnl != null && <small> {usd(g.pnl, true)}</small>}</span>
  </>;
}

export function DeskTable({ s, bots, nav, pause, close, initialOpen = null }: {
  s: AnyObj;
  bots: AnyObj[];
  nav: Nav;
  pause: (b: AnyObj) => void;
  close: (b: AnyObj) => void;
  /** A bot whose row starts open (the duplicate-figure test renders it this way). */
  initialOpen?: string | null;
}) {
  const [q, setQ] = useState<DeskQuery>(emptyQuery());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(initialOpen);
  const items = useMemo(() => deskItems(bots, (b) => chainOf(s, b.chainId ?? s.legacyChainId)?.short ?? b.chainShort ?? '', Date.now()), [bots, s]);
  const buckets = useMemo(() => bucketItems(items, q), [items, q]);
  const chains = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of items) if (it.chainId != null) m.set(it.chainId, it.chain || String(it.chainId));
    return [...m.entries()];
  }, [items]);
  const set = (patch: Partial<DeskQuery>) => setQ((cur) => ({ ...cur, ...patch }));
  const sortBy = (key: DeskSort) => set(nextSort(q.sort, q.dir, key));
  const mark = (key: DeskSort) => q.sort === key ? (q.dir === 'asc' ? '↑' : '↓') : '';
  const head = (key: DeskSort, label: string, num = false) => (
    <button type="button" className={`desk-sort${num ? ' num' : ''}${q.sort === key ? ' on' : ''}`} aria-sort={q.sort === key ? (q.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(key)}>
      {label}{mark(key) && <i>{mark(key)}</i>}
    </button>
  );

  return (
    <div className="desk desk-book">
      <div className="desk-tools">
        <input className="desk-search" value={q.q} placeholder="Search" aria-label="Search bots" onChange={(e) => set({ q: e.target.value })} />
        <div className="desk-chips" role="group" aria-label="Type">
          {TYPES.map(([id, label]) => <Chip key={id} on={q.type === id} onClick={() => set({ type: id })}>{label}</Chip>)}
        </div>
        <div className="desk-chips" role="group" aria-label="Status">
          {STATUSES.map(([id, label]) => <Chip key={id} on={q.status === id} onClick={() => set({ status: id })}>{label}</Chip>)}
        </div>
        <div className="desk-chips" role="group" aria-label="Live or paper">
          {MODES.map(([id, label]) => <Chip key={id} on={q.mode === id} onClick={() => set({ mode: id })}>{label}</Chip>)}
        </div>
        {chains.length > 1 && (
          <div className="desk-chips" role="group" aria-label="Chain">
            <Chip on={q.chain === 'all'} onClick={() => set({ chain: 'all' })}>All chains</Chip>
            {chains.map(([id, name]) => <Chip key={id} on={q.chain === id} onClick={() => set({ chain: id })}>{name}</Chip>)}
          </div>
        )}
        <select className="desk-sort-select" aria-label="Sort" value={`${q.sort}:${q.dir}`} onChange={(e) => { const [sort, dir] = e.target.value.split(':') as [DeskSort, DeskQuery['dir']]; set({ sort, dir }); }}>
          {SORTS.flatMap(([key, label]) => [
            <option key={`${key}:desc`} value={`${key}:desc`}>{label} ↓</option>,
            <option key={`${key}:asc`} value={`${key}:asc`}>{label} ↑</option>,
          ])}
        </select>
      </div>
      {!!buckets.length && (
        <div className="desk-head" aria-hidden="true">
          {head('name', 'Pair')}
          <span />
          <span>Range</span>
          {head('value', 'Value', true)}
          {head('pnl', 'P&L $', true)}
          {head('pnlPct', 'P&L %', true)}
          {head('age', 'Age', true)}
          {head('apr', 'APR', true)}
          {head('moves', 'Moves', true)}
          {head('fees', 'Fees', true)}
          <span />
        </div>
      )}
      {buckets.map((g) => {
        const shut = closed.has(g.name);
        return (
          <div key={g.name} className="desk-bucket">
            <button type="button" className="desk-group" aria-expanded={!shut} onClick={() => setClosed((cur) => { const n = new Set(cur); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n; })}>
              <span className="desk-chev" aria-hidden="true">{shut ? '▸' : '▾'}</span>
              <b>{g.name}</b>
              <span className="muted">{g.rows.length}</span>
              <span className="grow" />
              <GroupTotals g={g} />
            </button>
            {!shut && g.rows.map((it) => (
              <BotRow key={it.b.id} s={s} b={it.b} nav={nav} pause={pause} close={close} columns metrics expandable open={open === it.b.id} onToggle={() => setOpen((id) => id === it.b.id ? null : it.b.id)} />
            ))}
          </div>
        );
      })}
      {!buckets.length && <p className="muted home-empty">No bots match.</p>}
    </div>
  );
}
