/** Home: totals, what needs attention, and one row per bot with ≈USD profit vs just holding. */
import { useEffect, useState } from 'react';
import { http, botApi } from './api';
import { AnimatedNumber, StatusDot, useFlash } from './motion';
import { cls, num, qty, usd } from './fmt';
import { ChainBadge, DexTag, chainOf, chains, useChainFilter } from './chains';
import { gridName, gridPnlUsd, quoteSym, rangeState, trendPnlUsd, type AnyObj, type Nav } from './model';

interface Props { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

function Kpi({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="kpi"><span>{label}</span><div className="kpi-v">{children}</div>{sub ? <span className="sub">{sub}</span> : null}</div>;
}

function BotRow({ s, b, hold, nav, act, busy }: { s: AnyObj; b: AnyObj; hold: number | null; nav: Nav; act: Props['act']; busy: boolean }) {
  const grid = b.kind === 'grid';
  const flash = useFlash(b.trades.length);
  const pnl = grid ? gridPnlUsd(b) : trendPnlUsd(b);
  const pnlQuote = grid ? b.pnl.realized + b.pnl.unrealized : b.pnl.equity - b.capital;
  const rs = grid ? rangeState(b) : null;
  const state = b.lastError ? 'error' : b.status;
  const meta = grid
    ? [b.status === 'running' ? 'Running' : 'Stopped', `${b.stats.roundTrips} completed trades`, rs === 'in' ? 'price in range' : rs ? `price ${rs} range` : null]
    : [b.status === 'running' ? (b.position ? `Holding ${b.base}` : 'Waiting for a signal') : 'Stopped', `${b.tf} candles`, `${b.stats.count} trades`];
  const path = grid ? `grids/${b.id}` : `trends/${b.id}`;
  const open = () => nav(grid ? { v: 'grid', id: b.id } : { v: 'trend', id: b.id });
  return (
    <div className={`bot-row ${flash ? 'fill-flash' : ''}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <div className="bot-name">
        <StatusDot beat={b.priceAt} state={state} />
        {b.available !== false && <ChainBadge c={chainOf(s, b.chainId ?? s.legacyChainId)} testnet={false} />}
        {grid ? gridName(b) : b.name}
        <span className="tag">{grid ? 'Grid' : 'Trend'}</span>
        {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
      </div>
      <div className={`bot-pnl ${cls(pnl ?? pnlQuote)}`}>
        {pnl != null ? <AnimatedNumber value={pnl} format={(x) => usd(x, true)} /> : qty(pnlQuote, quoteSym(b), 4)}
      </div>
      <div className="bot-meta">{b.available === false ? <span className="warn-t">Unavailable on this server</span> : b.lastError ? <span className="neg">{b.lastError}</span> : meta.filter(Boolean).join(' · ')}</div>
      <div className="bot-hold" title="What the same money would have made by buying and holding at the bot's start">{hold != null ? `holding: ${usd(hold, true)}` : ''}</div>
      <div className="bot-act" onClick={(e) => e.stopPropagation()}>
        {b.status === 'running'
          ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(() => botApi(`${path}/stop`, 'POST'))}>Stop</button>
          : (grid ? b.config : true) && <button type="button" className="btn small-btn" disabled={busy || b.available === false} onClick={() => act(() => botApi(`${path}/resume`, 'POST'))}>Resume</button>}
      </div>
    </div>
  );
}

export function Home({ s, nav, act, busy }: Props) {
  const { chain } = useChainFilter();
  const [ov, setOv] = useState<AnyObj | null>(null);
  const sig = `${s.grids.length}:${(s.trends ?? []).length}:${s.aggregate?.roundTrips}`;
  useEffect(() => {
    let dead = false;
    const load = () => http('/api/analytics/overview').then((o) => { if (!dead) setOv(o); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [sig]);

  const here = (b: AnyObj) => chain === 'all' || (b.chainId ?? s.legacyChainId) === chain;
  const bots: AnyObj[] = [...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })), ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' }))]
    .filter(here)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const ovBots: AnyObj[] = (ov?.bots ?? []).filter(here);
  const holdOf = (id: string) => {
    const o = ovBots.find((x) => x.id === id);
    return o && o.hodlUsd != null ? o.hodlUsd - o.capitalUsd : null;
  };
  const priced = bots.map((b) => (b.kind === 'grid' ? gridPnlUsd(b) : trendPnlUsd(b))).filter((x): x is number => x != null);
  const profit = priced.length ? priced.reduce((a, b) => a + b, 0) : null;
  const holds = ovBots.filter((o) => o.hodlUsd != null).map((o) => o.hodlUsd - o.capitalUsd);
  const held = holds.length ? holds.reduce((a, b) => a + b, 0) : null;
  const value = ovBots.length ? ovBots.reduce((a, o) => a + o.equityUsd, 0) : null;
  const running = bots.filter((b) => b.status === 'running').length;

  const notices: { key: string; level: 'warn' | 'error'; text: React.ReactNode; open?: () => void }[] = [];
  for (const c of chains(s)) {
    if (c.hasSigner && c.lowGas && (chain === 'all' || chain === c.id)) {
      notices.push({ key: `gas-${c.id}`, level: 'warn', text: <><b>{c.name} gas is low.</b> {num(c.gasNative, 6)} {c.nativeSymbol} left, below the {c.lowGasNative} {c.nativeSymbol} warning level. Trades there are skipped when gas runs out.</> });
    }
  }
  if (s.allocations && s.allocations.ok === false) {
    const short = s.allocations.rows.filter((r: AnyObj) => r.ok === false).map((r: AnyObj) => `${r.token} needs ${num(r.allocated, 4)}, wallet has ${num(r.wallet, 4)}`).join('; ');
    notices.push({ key: 'alloc', level: 'error', text: <><b>Your wallet doesn't cover every live bot.</b> {short}.</> });
  }
  for (const b of bots) {
    const name = b.kind === 'grid' ? gridName(b) : b.name;
    const open = () => nav(b.kind === 'grid' ? { v: 'grid', id: b.id } : { v: 'trend', id: b.id });
    if (b.available === false) notices.push({ key: `na-${b.id}`, level: 'warn', text: <><b>{name}</b> trades on a chain or token this server doesn't load (removed, or turned off in .env). It is stopped; open it to remove it.</>, open });
    else if (b.lastError) notices.push({ key: `err-${b.id}`, level: 'error', text: <><b>{name}:</b> {b.lastError}</>, open });
    else if (b.kind === 'grid' && b.status === 'running') {
      const rs = rangeState(b);
      if (rs === 'above') notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is above its range.</b> Everything is sold and it waits for the price to come back. Open it to move the range.</>, open });
      if (rs === 'below') notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is below its range.</b> Every level has bought and it holds {b.base} until the price recovers. Open it to move the range.</>, open });
    }
  }

  return (
    <main className="stack">
      <div className="summary">
        <Kpi label="Total value" sub={`${bots.length} bots · ${running} running`}>{value != null ? usd(value) : '—'}</Kpi>
        <Kpi label="Bot profit" sub="since each bot started"><span className={cls(profit)}>{profit != null ? <AnimatedNumber value={profit} format={(x) => usd(x, true)} /> : '—'}</span></Kpi>
        <Kpi label="If you'd held" sub={profit != null && held != null ? (profit >= held ? `bots ahead by ${usd(profit - held)}` : `holding ahead by ${usd(held - profit)}`) : 'buying at each bot\'s start'}>{held != null ? usd(held, true) : '—'}</Kpi>
      </div>

      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n) => (
            <div key={n.key} className={`banner ${n.level === 'error' ? 'error' : ''}`}>
              <span className="grow">{n.text}</span>
              {n.open && <button type="button" className="btn ghost small-btn" onClick={n.open}>Open</button>}
            </div>
          ))}
        </div>
      )}

      <section className="bots" aria-label="Your bots">
        <div className="bots-head">
          <h3>Your bots</h3>
          <button type="button" className="btn primary small-btn" onClick={() => nav({ v: 'new', kind: 'grid' })}>New bot</button>
        </div>
        {bots.map((b) => <BotRow key={b.id} s={s} b={b} hold={holdOf(b.id)} nav={nav} act={act} busy={busy} />)}
        {bots.length === 0 && (
          <div className="empty">
            <p>No bots{chain !== 'all' ? ' on this chain' : ''} yet. Start one in paper mode to see how it behaves with real prices and no real money.</p>
            <button type="button" className="btn primary" onClick={() => nav({ v: 'new', kind: 'grid' })}>Start a paper bot</button>
          </div>
        )}
      </section>
    </main>
  );
}
