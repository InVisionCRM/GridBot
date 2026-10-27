/** Bots drawn on a chart: All, plus a checkbox for each bot on this market. A phone gets a bottom sheet. */
import { useEffect, useRef, useState } from 'react';
import { allOn, someOn, toggleEvery, toggleId } from './botPick';

export interface ChartBot { id: string; name: string; kind: string; chain: string }

function usePhone() {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 860px)');
    const go = () => setOn(q.matches);
    q.addEventListener('change', go);
    return () => q.removeEventListener('change', go);
  }, []);
  return on;
}

export function BotMenu({ bots, off, onChange }: { bots: ChartBot[]; off: string[]; onChange: (off: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  const root = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const ids = bots.map((b) => b.id);
  const every = allOn(ids, off);
  const any = someOn(ids, off);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = any && !every; }, [any, every]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!phone && !root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open, phone]);
  const shown = ids.filter((id) => !off.includes(id)).length;
  const label = !bots.length ? 'Bots' : every || shown === bots.length ? 'Bots · all' : shown === 0 ? 'Bots · off' : `Bots · ${shown}/${bots.length}`;
  const list = (
    <div className={phone ? 'bot-sheet' : 'bot-pop'} role="dialog" aria-label="Bots on this chart">
      {phone && <p className="bot-sheet-k">Bots on this chart</p>}
      <label className="bot-menu-row">
        <input ref={allRef} type="checkbox" checked={every} disabled={!bots.length} onChange={() => onChange(toggleEvery(ids, off))} />
        <span>All</span>
      </label>
      {bots.map((b) => {
        const on = !off.includes(b.id);
        return (
          <label key={b.id} className={`bot-menu-row${on ? ' on' : ''}`}>
            <input type="checkbox" checked={on} onChange={() => onChange(toggleId(off, b.id))} />
            <span className="bot-menu-name">{b.name}</span>
            <span className="kind-tag">{b.kind}</span>
            {b.chain && <span className="muted">{b.chain}</span>}
          </label>
        );
      })}
      {!bots.length && <p className="bot-menu-empty">No bots on this market.</p>}
    </div>
  );
  return (
    <div className="bot-menu-wrap" ref={root}>
      <button type="button" className={`bot-menu-btn${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label="Bots on this chart" onClick={() => setOpen((v) => !v)}>{label}</button>
      {open && phone && <button type="button" className="bot-shade" aria-label="Close bot list" onClick={() => setOpen(false)} />}
      {open && list}
    </div>
  );
}
