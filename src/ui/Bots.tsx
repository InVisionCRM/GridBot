/** Every bot, one line each. Stop, close, and the details live here or on the bot’s own page. */
import { useContext, useState } from 'react';
import { botApi } from './api';
import { humanAmount } from '../live/amount';
import { RefreshCtx, chains, useChainFilter } from './chains';
import { BotLine } from './Home';
import { botView, type AnyObj, type Nav } from './model';

export function Bots({ s, nav, busy, onStopAll }: { s: AnyObj; nav: Nav; busy: boolean; onStopAll: () => void }) {
  const { chain } = useChainFilter();
  const refresh = useContext(RefreshCtx);
  const [hide, setHide] = useState<Set<string>>(new Set());
  const [pend, setPend] = useState<Set<string>>(new Set());
  const [rowErr, setRowErr] = useState<string | null>(null);
  const here = (b: AnyObj) => chain === 'all' || (b.chainId ?? s.legacyChainId) === chain;
  const all: AnyObj[] = [
    ...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })),
    ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' })),
    ...(s.lps ?? []).map((t: AnyObj) => ({ ...t, kind: 'lp' })),
  ].filter(here);
  const kept = all.filter((b) => b.archivedAt);
  const bots = all.filter((b) => !b.archivedAt && !hide.has(b.id)).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const running = bots.filter((b) => b.status === 'running').length;
  const isClosing = (b: AnyObj) => !!b.closing || pend.has(b.id) || b.step?.action === 'close';
  const closable = bots.filter((b) => !isClosing(b));
  const canClear = bots.some((b) => b.status !== 'running' && !isClosing(b));
  const nameOf = (b: AnyObj) => (b.kind === 'grid' ? String(b.label ?? b.stable ?? 'Grid') : b.kind === 'lp' ? `Liquidity ${b.label ?? ''}`.trim() : String(b.name ?? 'Trend'));

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
      {rowErr && <p className="note bad">{rowErr}</p>}
      {bots.map((b) => (
        <span key={b.id} className="line-wrap">
          <BotLine b={b} nav={nav} />
          {b.lastError && <button type="button" className="line-note" onClick={() => nav(botView(b.kind, b.id))}>{nameOf(b)}: {b.lastError}</button>}
        </span>
      ))}
      {!bots.length && <p className="muted home-empty">No bots{chain !== 'all' ? ' on this chain' : ''}. Start a grid above, in paper, to watch it with live prices.</p>}
      <p className="foot-links">
        <button type="button" className="text-stop" disabled={busy || running === 0} onClick={onStopAll}>Stop all</button>
        {closable.length > 0 && <button type="button" onClick={closeAll}>Close all</button>}
        {canClear && <button type="button" onClick={clearClosed}>Clear closed</button>}
        {kept.length > 0 && <button type="button" onClick={() => nav({ v: 'tools', tab: 'analytics' })}>{kept.length} closed in Analytics</button>}
      </p>
    </main>
  );
}
