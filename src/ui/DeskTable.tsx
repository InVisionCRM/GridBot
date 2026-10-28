/** Grouped, filtered, sortable bot table. */
import { useMemo, useState } from 'react';
import { BotRow } from './botRow';
import { chainOf } from './chains';
import { bucketItems, emptyQuery, nextSort, type DeskQuery, type DeskSort, deskItems } from './deskTableModel';
import type { AnyObj, Nav } from './model';

const TYPES: [DeskQuery['type'], string][] = [['all', 'All'], ['grid', 'Grid'], ['trend', 'Trend'], ['lp', 'Liquidity'], ['trader', 'Token trader'], ['paper', 'Paper']];
const STATUSES: [DeskQuery['status'], string][] = [['all', 'Any status'], ['running', 'Running'], ['paused', 'Paused'], ['stopped', 'Stopped'], ['out', 'Out of range']];
const MODES: [DeskQuery['mode'], string][] = [['all', 'Live + paper'], ['live', 'Live'], ['paper', 'Paper']];
const SORTS: [DeskSort, string][] = [
  ['name', 'Name'], ['value', 'Value'], ['generated', 'Generated'], ['pnl', 'P&L'], ['pnlPct', 'P&L %'], ['fees', 'Fees earned'], ['age', 'Age'], ['apr', 'Est. APR'], ['moves', 'Moves'],
];

function Chip({ on, children, onClick }: { on: boolean; children: string; onClick: () => void }) {
  return <button type="button" className={`chip-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

export function DeskTable({ s, bots, nav, pause, close }: {
  s: AnyObj;
  bots: AnyObj[];
  nav: Nav;
  pause: (b: AnyObj) => void;
  close: (b: AnyObj) => void;
}) {
  const [q, setQ] = useState<DeskQuery>(emptyQuery());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
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
          <span className="num">Invested</span>
          {head('value', 'Value', true)}
          {head('generated', 'Generated', true)}
          {head('pnl', 'P&L', true)}
          {head('pnlPct', 'P&L %', true)}
          {head('fees', 'Fees earned', true)}
          {head('age', 'Age', true)}
          {head('apr', 'APR', true)}
          {head('moves', 'Moves', true)}
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
              {/* no group totals (Kyle): a total must equal the sum of the rows as shown, and per-coin rounding can't promise that */}
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
