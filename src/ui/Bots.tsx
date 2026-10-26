/** Every bot. A row opens its range, fees, and levels; the full page is one tap further. */
import { useContext, useState } from 'react';
import { botApi } from './api';
import { humanAmount } from '../live/amount';
import { BotRow, listBots, useRowActions } from './botRow';
import { RefreshCtx, chains, useChainFilter } from './chains';
import type { AnyObj, Nav } from './model';

export function Bots({ s, nav, busy, onStopAll }: { s: AnyObj; nav: Nav; busy: boolean; onStopAll: () => void }) {
  const { chain } = useChainFilter();
  const refresh = useContext(RefreshCtx);
  const { err, pause, close } = useRowActions();
  const [rowErr, setRowErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [hide, setHide] = useState<Set<string>>(new Set());
  const [pend, setPend] = useState<Set<string>>(new Set());
  const here = (b: AnyObj) => chain === 'all' || (b.chainId ?? s.legacyChainId) === chain;
  const all: AnyObj[] = [
    ...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })),
    ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' })),
    ...(s.lps ?? []).map((t: AnyObj) => ({ ...t, kind: 'lp' })),
  ].filter(here);
  const kept = all.filter((b) => b.archivedAt).length;
  const bots = listBots(s, chain).filter((b) => !hide.has(b.id)).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  const isClosing = (b: AnyObj) => !!b.closing || pend.has(b.id) || b.step?.action === 'close';
  const closable = bots.filter((b) => !isClosing(b));
  const canClear = bots.some((b) => b.status !== 'running' && !isClosing(b));

  const closeAll = () => {
    if (!closable.length) return;
    if (!confirm(`Close ${closable.length} bot${closable.length === 1 ? '' : 's'}? Paper bots leave now. Live bots sell or withdraw on-chain, with the same safety limits.`)) return;
    setHide((cur) => { const n = new Set(cur); for (const b of closable) if (b.mode !== 'live') n.add(b.id); return n; });
    setPend((cur) => { const n = new Set(cur); for (const b of closable) if (b.mode === 'live') n.add(b.id); return n; });
    setRowErr(null);
    void botApi('close-all', 'POST', chain === 'all' ? {} : { chainId: chain }, 'close-all').then(() => refresh()).catch((e: Error) => {
      setHide(new Set()); setPend(new Set()); setRowErr(e.message);
    });
  };
  const clearClosed = () => {
    setRowErr(null);
    void botApi('archive-closed', 'POST', chain === 'all' ? {} : { chainId: chain }).then(() => refresh()).catch((e: Error) => setRowErr(e.message));
  };
  const short = s.allocations?.ok === false
    ? s.allocations.rows.filter((r: AnyObj) => r.ok === false).map((r: AnyObj) => `${humanAmount(r.allocated)} ${r.token} booked, ${r.wallet == null ? 'balance unknown' : humanAmount(r.wallet)} in the wallet`).join('. ')
    : '';
  const low = chains(s).filter((c) => c.hasSigner && c.lowGas && bots.some((b) => b.mode === 'live' && (b.chainId ?? s.legacyChainId) === c.id) && (chain === 'all' || chain === c.id));

  return (
    <main className="home">
      <div className="page-head">
        <h1>Bots</h1>
        <span className="head-links">
          <button type="button" onClick={() => nav({ v: 'new', kind: 'grid' })}>Grid</button>
          <button type="button" onClick={() => nav({ v: 'new', kind: 'trend' })}>Trend</button>
          <button type="button" onClick={() => nav({ v: 'new', kind: 'lp' })}>Liquidity</button>
        </span>
      </div>
      {short && <p className="note bad">{short}. Stop a bot or add funds.</p>}
      {low.map((c) => <p key={c.id} className="note">Low gas on {c.name}.</p>)}
      {(err || rowErr) && <p className="note bad">{err || rowErr}</p>}
      {!!bots.length && (
        <div className="desk-head" aria-hidden="true">
          <span>Pair</span><span>Type</span><span>Status</span><span /><span>Range</span><span>Value</span><span>P&amp;L</span><span />
        </div>
      )}
      {bots.map((b) => (
        <BotRow key={b.id} s={s} b={b} nav={nav} pause={pause} close={close} columns expandable open={open === b.id} onToggle={() => setOpen((id) => id === b.id ? null : b.id)} />
      ))}
      {!bots.length && <p className="muted home-empty">No bots{chain !== 'all' ? ' on this chain' : ''}. Start a grid above, in paper, to watch it with live prices.</p>}
      <p className="foot-links">
        <button type="button" className="text-stop" disabled={busy || running === 0} onClick={onStopAll}>Stop all</button>
        {closable.length > 0 && <button type="button" onClick={closeAll}>Close all</button>}
        {canClear && <button type="button" onClick={clearClosed}>Clear closed</button>}
        {kept > 0 && <button type="button" onClick={() => nav({ v: 'tools', tab: 'analytics' })}>{kept} closed in Analytics</button>}
      </p>
    </main>
  );
}
