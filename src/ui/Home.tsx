/**
 * Home: what the bots earned by trading (in the coins themselves, so daily price moves don't blur it), what they are
 * doing right now (each grid's price gliding between its next buy and sell), a live feed where every trade shows its
 * own result, and what needs attention.
 */
import { useContext, useEffect, useMemo, useState } from 'react';
import { http, botApi } from './api';
import { AnimatedNumber, StatusDot, useFlash } from './motion';
import { ago, cls, num, pct, px, qty, usd } from './fmt';
import { Usd, useShowUsd } from './money';
import { ChainBadge, DexTag, RefreshCtx, chainOf, chains, useChainFilter } from './chains';
import { humanAmount } from '../live/amount';
import { botView, earnedByCoin, gridName, quoteSym, rangeState, type AnyObj, type Nav } from './model';
import { buildFeed, LiveFeed, LiveLevels, LivePrice, livePrice, LiveRange } from './live';
import { nextLevels } from '../live/liveGrid';
import type { ActivityEvent, Ticks } from './useStream';
import { L } from './Tip';
import { scanStep, useOpportunities } from './Opportunities';
import { gridRank, lpRank, type Opportunity } from '../market/scan';

interface Props { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }
interface HomeProps extends Props { events: ActivityEvent[]; ticks: Ticks | null; ver: AnyObj | null }

function BotRow({ s, b, price, nav, act, busy, closing, onClose }: { s: AnyObj; b: AnyObj; price: number | null; nav: Nav; act: Props['act']; busy: boolean; closing: boolean; onClose: () => void }) {
  const grid = b.kind === 'grid';
  const flash = useFlash(b.trades.length);
  const q = quoteSym(b), k: number | null = b.usdPerQuote ?? null;
  const rs = grid ? rangeState(b) : null;
  const state = closing ? 'closing' : b.lastError ? 'error' : b.status;
  const meta = closing ? ['Closing…'] : grid
    ? [b.status === 'running' ? 'Running' : 'Stopped', `${b.stats.roundTrips} completed trades${b.stats.roundTrips ? ` (${b.stats.wins} won${b.stats.roundTrips - b.stats.wins ? `, ${b.stats.roundTrips - b.stats.wins} lost` : ''})` : ''}`, rs === 'in' ? null : rs ? `price ${rs} range` : null]
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
        {price != null && <LivePrice value={price} />}
        {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
      </div>
      <div className={`bot-pnl ${cls(b.pnl.realized)}`} title="Earned by trading: completed buy → sell trades, after fees and gas">
        <AnimatedNumber value={b.pnl.realized} format={(x) => qty(x, q, 4)} /><Usd v={b.pnl.realized} k={k} />
      </div>
      <div className="bot-meta">{b.available === false ? <span className="warn-t">Unavailable on this server</span> : b.lastError ? <span className="neg">{b.lastError}</span> : meta.filter(Boolean).join(' · ')}</div>
      {grid
        ? <div className="bot-hold" title="Coins bought and not sold yet: their value moves with the price until they sell">{b.pnl.plsHeld > 0 ? `not sold yet: ${qty(b.pnl.unrealized, q, 4)}` : ''}</div>
        : <div className="bot-hold" title="The trade it holds now: its value moves with the price until it sells">{b.position ? `open trade: ${qty(b.position.unrealized, q, 4)}` : ''}</div>}
      {grid && b.status === 'running' && <div className="bot-live"><LiveLevels g={b} price={price} /></div>}
      <div className="bot-act" onClick={(e) => e.stopPropagation()}>
        {b.status === 'running'
          ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(() => botApi(`${path}/stop`, 'POST'))}>Stop</button>
          : (grid ? b.config : true) && <button type="button" className="btn small-btn" disabled={busy || b.available === false} onClick={() => act(() => botApi(`${path}/resume`, 'POST'))}>Resume</button>}
        <button type="button" className="btn small-btn" disabled={closing || b.available === false} onClick={onClose}>{closing ? 'Closing…' : 'Close'}</button>
      </div>
    </div>
  );
}

/** A liquidity bot: fees earned after costs is what it makes; the fees themselves come in both coins. */
function LpRow({ s, b, price, nav, act, busy, closing, onClose }: { s: AnyObj; b: AnyObj; price: number | null; nav: Nav; act: Props['act']; busy: boolean; closing: boolean; onClose: () => void }) {
  const flash = useFlash(b.reranges);
  const q = quoteSym(b), pnl: AnyObj | null = b.pnl;
  const state = closing ? 'closing' : b.lastError ? 'error' : b.status === 'closed' ? 'stopped' : b.status;
  const meta = closing ? ['Closing…'] : [
    b.status === 'closed' ? 'Closed' : b.status === 'running' ? 'Running' : 'Paused',
    b.position ? (b.inRange == null ? null : b.inRange ? 'in range' : 'out of range') : b.step ? 'opening' : null,
    `${b.reranges} range move${b.reranges === 1 ? '' : 's'}`,
  ];
  const open = () => nav(botView('lp', b.id));
  return (
    <div className={`bot-row ${flash ? 'fill-flash' : ''}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <div className="bot-name">
        <StatusDot beat={b.priceAt} state={state} />
        {b.available !== false && <ChainBadge c={chainOf(s, b.chainId)} testnet={false} />}
        {gridName(b)}
        <span className="tag">Liquidity</span>
        {price != null && <LivePrice value={price} />}
        {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
      </div>
      <div className={`bot-pnl ${cls(pnl?.net)}`} title="Earned after costs: fees (collected + waiting in the position) minus gas, swap costs and what range moves lost">
        {pnl ? <><AnimatedNumber value={pnl.net} format={(x) => qty(x, q, 4)} /><Usd v={pnl.net} k={b.usdPerQuote} /></> : '—'}
      </div>
      <div className="bot-meta">{b.available === false ? <span className="warn-t">Unavailable on this server</span> : b.lastError ? <span className="neg">{b.lastError}</span> : meta.filter(Boolean).join(' · ')}</div>
      <div className="bot-hold" title="Fees earned so far, in the coins they were paid in">{pnl ? `fees ${qty(pnl.feeCoins.base, b.base, 4)} · ${qty(pnl.feeCoins.quote, q, 4)}` : ''}</div>
      {b.status !== 'closed' && <div className="bot-live"><LiveRange b={b} price={price} /></div>}
      <div className="bot-act" onClick={(e) => e.stopPropagation()}>
        {b.status === 'running'
          ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(() => botApi(`lps/${b.id}/stop`, 'POST'))}>Pause</button>
          : b.status === 'stopped' && <button type="button" className="btn small-btn" disabled={busy || b.available === false} onClick={() => act(() => botApi(`lps/${b.id}/resume`, 'POST'))}>Resume</button>}
        <button type="button" className="btn small-btn" disabled={closing || b.available === false} onClick={onClose}>{closing ? 'Closing…' : 'Close'}</button>
      </div>
    </div>
  );
}

/** What the signing wallet holds on each chain, and how much of each coin running live bots already use. */
function WalletPanel({ s, chain }: { s: AnyObj; chain: number | 'all' }) {
  const wallets: AnyObj[] = (s.wallets ?? []).filter((w: AnyObj) => chain === 'all' || w.chainId === chain);
  if (!s.hasSigner) return <div className="banner info"><span className="grow"><b>No signing key in .env</b>, so every bot runs in paper mode with simulated trades. Add your key to .env and restart to trade live.</span></div>;
  if (!wallets.length) return null;
  const inUse = (w: AnyObj, c: AnyObj) => (s.allocations?.rows ?? []).find((r: AnyObj) => r.chainId === w.chainId && (c.native ? r.native : String(r.address).toLowerCase() === c.address))?.allocated ?? 0;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  return (
    <section className="card" aria-label="Your wallet">
      <div className="card-head"><h3>Your wallet</h3>{wallets[0]?.address && <span className="muted small mono" title={wallets[0].address}>{short(wallets[0].address)}</span>}</div>
      {wallets.map((w) => (
        <div key={w.chainId} className="wallet-row">
          <span className="wallet-chain"><ChainBadge c={chainOf(s, w.chainId)} testnet={false} />{w.name}</span>
          {w.error && !w.coins.length ? <span className="small neg">Couldn't read balances: {w.error}</span>
            : !w.coins.length ? <span className="small muted">Loading…</span>
            : <span className="coins">{w.coins.map((c: AnyObj) => {
              const used = inUse(w, c);
              if (c.error) return <span key={c.address} className="coin neg" title={c.error}><b>?</b> {c.symbol} <small>couldn't read: {c.error}</small></span>;
              return <span key={c.address ?? 'native'} className="coin" title={`${c.amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${c.symbol}`}><b>{humanAmount(c.amount)}</b> {c.symbol}{used > 0 ? <small> · {humanAmount(used)} in live bots</small> : null}</span>;
            })}</span>}
        </div>
      ))}
    </section>
  );
}

/** Home's glance at Opportunities: the 2 safe pools ranked first for a grid and for liquidity, on the chain shown. */
function BestThisWeek({ s, chain, nav }: { s: AnyObj; chain: number | 'all'; nav: Nav }) {
  const { p, err } = useOpportunities();
  if (err || !p) return null;
  const safe = ((p.chains ?? []) as AnyObj[]).filter((c) => chain === 'all' || c.chainId === chain).flatMap((c) => c.items as Opportunity[])
    .filter((o) => o.liveAllowed && (o.risk == null || o.risk === 'low'));
  const top = (rank: (o: Opportunity) => number | null) => safe.filter((o) => rank(o) != null).sort((a, b) => rank(b)! - rank(a)!).slice(0, 2);
  const rows = [...top(gridRank).map((o) => ({ o, how: 'grid' as const })), ...top(lpRank).map((o) => ({ o, how: 'lp' as const }))];
  return (
    <section className="card" aria-label="Best this week">
      <div className="card-head">
        <h3><L tip="The safe pools ranked first in Opportunities: for a grid (how much the price swings, where a grid earned) and for liquidity (what it earned after costs), over the last 7 days at your test size.">Best this week</L></h3>
        <span className="muted small">{p.running ? scanStep(p.progress) : p.at ? `scanned ${ago(p.at)}` : 'not scanned yet'}</span>
        <span className="grow" />
        <button type="button" className="btn small-btn primary" onClick={() => nav({ v: 'opps' })}>See all opportunities</button>
      </div>
      {rows.map(({ o, how }) => {
        const e = how === 'grid' ? o.grid!.earnedPct : o.lp!.earnedPct;
        return (
          <div key={`${how}-${o.chainId}-${o.add?.pool ?? o.key}`} className="best-row">
            <span className="best-name"><ChainBadge c={chainOf(s, o.chainId)} testnet={false} /><b>{o.label}</b><span className="small muted">{how === 'lp' ? `liquidity ±${num(o.lp!.bandPct * 100, 0)}%` : `grid ±${num(o.grid!.bandPct * 100, 0)}%, ${o.grid!.gridCount} levels · swings ${pct(o.swingPct, 0)} a day`}</span></span>
            <span className="n"><b className={cls(e)}>{qty(e * o.capital, o.spend, 4)}</b> <span className="small muted">last week</span></span>
          </div>
        );
      })}
      {!rows.length && <p className="small muted">{p.at ? 'No safe pool earned from trading here last week.' : 'The first scan runs on its own; it takes a while.'}</p>}
    </section>
  );
}

/** The trade most likely to happen next: the running grid whose next level is closest to its price. */
function closestNext(grids: AnyObj[], priceOf: (g: AnyObj) => number | null) {
  let best: { bot: string; paper: boolean; side: 'buy' | 'sell'; at: number; dist: number } | null = null;
  for (const g of grids) {
    const p = priceOf(g);
    if (g.status !== 'running' || p == null) continue;
    const n = nextLevels(g.intervals ?? [], p);
    for (const [side, at] of [['buy', n.buy], ['sell', n.sell]] as const) {
      if (at == null) continue;
      const dist = Math.abs(at / p - 1);
      if (!best || dist < best.dist) best = { bot: gridName(g), paper: g.mode === 'paper', side, at, dist };
    }
  }
  return best;
}

export function Home({ s, events, ticks, ver, nav, act, busy }: HomeProps) {
  const { chain } = useChainFilter();
  const refresh = useContext(RefreshCtx);
  // Paper closes leave the list before the status round-trip. Live closes show "Closing…" until the unwind finishes.
  const [hide, setHide] = useState<Set<string>>(new Set());
  const [pend, setPend] = useState<Set<string>>(new Set());
  const [rowErr, setRowErr] = useState<string | null>(null);
  // Totals here are live only (real money); paper bots get their own line and never add into them.
  const [ov, setOv] = useState<{ live: AnyObj | null; paper: AnyObj | null }>({ live: null, paper: null });
  const sig = `${s.grids.length}:${(s.trends ?? []).length}:${s.aggregate?.roundTrips}`;
  useEffect(() => {
    let dead = false;
    const load = () => Promise.all([http('/api/analytics/overview?mode=live'), http('/api/analytics/overview?mode=paper')])
      .then(([live, paper]) => { if (!dead) setOv({ live, paper }); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [sig]);

  const here = (b: AnyObj) => chain === 'all' || (b.chainId ?? s.legacyChainId) === chain;
  const hereBots: AnyObj[] = [...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })), ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' })), ...(s.lps ?? [])].filter(here);
  const kept = hereBots.filter((b) => b.archivedAt);
  const bots = hereBots.filter((b) => !b.archivedAt && !hide.has(b.id)).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const isClosing = (b: AnyObj) => !!b.closing || pend.has(b.id) || b.step?.action === 'close';
  const liveBots = bots.filter((b) => b.mode === 'live'), paperBots = bots.filter((b) => b.mode === 'paper');
  const ovLive: AnyObj[] = (ov.live?.bots ?? []).filter((b: AnyObj) => here(b) && !kept.some((k) => k.id === b.id));
  const { on: showUsd } = useShowUsd();
  // The change on coins not sold yet in ≈USD at today's prices (bots spend different coins, so dollars are the only way
  // to add them up); for a liquidity bot, what price moves did to its coins.
  const sumUsd = (part: (b: AnyObj) => number) => {
    const xs = liveBots.filter((b) => b.usdPerQuote != null && (b.kind !== 'lp' || b.pnl)).map((b) => part(b) * b.usdPerQuote);
    return xs.length ? xs.reduce((a, x) => a + x, 0) : null;
  };
  const unsold = sumUsd((b) => (b.kind === 'grid' ? b.pnl.unrealized : b.kind === 'lp' ? b.pnl.price : b.pnl.equity - b.capital - b.pnl.realized));
  const value = ovLive.length ? ovLive.reduce((a, o) => a + o.equityUsd, 0) : null;
  const running = bots.filter((b) => b.status === 'running').length;
  const priceOf = (b: AnyObj) => livePrice(ticks, b.kind === 'lp' ? b.market : b.kind === 'grid' ? b.stable : b.quote, b.price);
  const earn = earnedByCoin(liveBots), paperEarn = earnedByCoin(paperBots);
  const count = (es: typeof earn) => es.reduce((a, e) => ({ trades: a.trades + e.trades, wins: a.wins + e.wins, losses: a.losses + e.losses, fees: a.fees + e.fees }), { trades: 0, wins: 0, losses: 0, fees: 0 });
  const tot = count(earn), paperTot = count(paperEarn);
  const last = bots.flatMap((b) => (b.trades ?? []).map((t: AnyObj) => ({ t: t.timestamp as number, paper: b.mode === 'paper' }))).sort((a, b) => b.t - a.t)[0] ?? null;
  const next = closestNext(bots.filter((b) => b.kind === 'grid'), priceOf);
  const feed = useMemo(() => buildFeed(s, events).filter((it) => chain === 'all' || it.chainId == null || it.chainId === chain), [s, events, chain]);

  const botName = (b: AnyObj) => (b.kind === 'grid' ? gridName(b) : b.kind === 'lp' ? `Liquidity ${b.label}` : b.name);
  const closePath = (b: AnyObj) => (b.kind === 'grid' ? `grids/${b.id}/close` : b.kind === 'trend' ? `trends/${b.id}/close` : `lps/${b.id}/close`);
  const forget = (id: string) => {
    setHide((cur) => { const n = new Set(cur); n.delete(id); return n; });
    setPend((cur) => { const n = new Set(cur); n.delete(id); return n; });
  };
  const closeBot = (b: AnyObj) => {
    if (b.mode === 'live' && !confirm(`Close ${botName(b)}? It sells or withdraws on-chain. The same price-impact and slippage limits still apply.`)) return;
    if (b.mode === 'live') setPend((cur) => new Set(cur).add(b.id));
    else setHide((cur) => new Set(cur).add(b.id));
    setRowErr(null);
    void botApi(closePath(b), 'POST').then(() => refresh()).catch((e: Error) => { forget(b.id); setRowErr(e.message); });
  };
  const closable = bots.filter((b) => !isClosing(b));
  const canClear = bots.some((b) => b.status !== 'running' && !isClosing(b));
  const closeAll = () => {
    if (!closable.length) return;
    if (!confirm(`Close ${closable.length} bot${closable.length === 1 ? '' : 's'}? Paper bots leave now. Live bots sell or withdraw on-chain, with the same safety limits.`)) return;
    setHide((cur) => { const n = new Set(cur); for (const b of closable) if (b.mode !== 'live') n.add(b.id); return n; });
    setPend((cur) => { const n = new Set(cur); for (const b of closable) if (b.mode === 'live') n.add(b.id); return n; });
    setRowErr(null);
    void botApi('close-all', 'POST', chain === 'all' ? {} : { chainId: chain }).then(() => refresh()).catch((e: Error) => {
      setHide(new Set()); setPend(new Set()); setRowErr(e.message);
    });
  };
  const clearClosed = () => {
    setRowErr(null);
    void botApi('archive-closed', 'POST', chain === 'all' ? {} : { chainId: chain }).then(() => refresh()).catch((e: Error) => setRowErr(e.message));
  };

  const notices: { key: string; level: 'warn' | 'error'; text: React.ReactNode; open?: () => void }[] = [];
  if (ver && ver.state !== 'current') {
    notices.push({ key: 'version', level: ver.state === 'update-available' ? 'warn' : 'error', text: <><b>{ver.title}.</b> {ver.detail} Fix: {ver.steps.join(' → ')}.</>, open: () => nav({ v: 'tools', tab: 'system' }) });
  }
  for (const c of chains(s)) {
    // Only where a live bot runs: paper bots and unused chains spend no real gas.
    const liveHere = bots.some((b) => b.mode === 'live' && (b.chainId ?? s.legacyChainId) === c.id);
    if (c.hasSigner && c.lowGas && liveHere && (chain === 'all' || chain === c.id)) {
      notices.push({ key: `gas-${c.id}`, level: 'warn', text: <><b>{c.name} gas is low.</b> {num(c.gasNative, 6)} {c.nativeSymbol} left, below the {c.lowGasNative} {c.nativeSymbol} warning level. Trades there are skipped when gas runs out.</> });
    }
  }
  if (s.allocations && s.allocations.ok === false) {
    const short = s.allocations.rows.filter((r: AnyObj) => r.ok === false).map((r: AnyObj) => `your live bots use ${humanAmount(r.allocated)} ${r.token} but the wallet has ${humanAmount(r.wallet)} ${r.token}`).join('; ');
    notices.push({ key: 'alloc', level: 'error', text: <><b>Not enough in your wallet for your running live bots:</b> {short}. Stop a bot or add funds.</> });
  }
  for (const b of bots) {
    const name = b.kind === 'grid' ? gridName(b) : b.kind === 'lp' ? `Liquidity ${b.label}` : b.name;
    const open = () => nav(botView(b.kind, b.id));
    if (b.available === false) notices.push({ key: `na-${b.id}`, level: 'warn', text: <><b>{name}</b> trades on a chain or token this server doesn't load (removed, or turned off in .env). It is stopped; open it to remove it.</>, open });
    else if (b.lastError) notices.push({ key: `err-${b.id}`, level: 'error', text: <><b>{name}:</b> {b.lastError}</>, open });
    else if (b.kind === 'lp' && b.status === 'running' && b.position && b.inRange === false && !b.config?.rerange) {
      notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is out of range</b> and isn't earning. Auto-move is off, so it waits for the price to come back. Open it to move the range or turn Auto-move on.</>, open });
    } else if (b.kind === 'grid' && b.status === 'running') {
      const rs = rangeState(b);
      if (rs === 'above' && !b.recenter?.enabled) notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is above its range.</b> Everything is sold and it waits for the price to come back. Open it to move the range or turn on Follow the price up.</>, open });
      if (rs === 'below') notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is below its range.</b> Every level has bought and it holds {b.base} until the price recovers. Open it to move the range.</>, open });
    }
  }

  return (
    <main className="stack">
      <section className="hero" aria-label="Earned by trading">
        <div className="hero-earn">
          <span className="k"><L tip="Profit from your live bots' completed buy → sell trades (and liquidity fees after gas), counted in each coin. A falling price doesn't lower it; only a losing trade does. Paper bots are never counted here.">Earned by live trading</L></span>
          <div className="coins-earned">
            {earn.length ? earn.map((e) => (
              <span key={e.symbol} className={`ce ${cls(e.amount)}`}>
                <AnimatedNumber value={e.amount} duration={900} format={(x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${humanAmount(Math.abs(x))}`} /><small>{e.symbol}</small>
              </span>
            )) : <span className="muted">{liveBots.length ? 'nothing yet' : 'no live bots'}</span>}
          </div>
          <span className="sub">
            {tot.trades} completed trade{tot.trades === 1 ? '' : 's'} · <b className="pos">{tot.wins} won</b> · <b className={tot.losses ? 'neg' : ''}>{tot.losses} lost</b>{tot.fees > 0 ? ' · liquidity fees after gas included' : ''}.
            {' '}Counted in the coins themselves: a price drop doesn't change it, only a losing trade does.
          </span>
        </div>
        <div className="hero-now">
          <span className="k"><L tip="Bots running, the last trade, and the closest level any grid is waiting for: the trade most likely to happen next.">Right now</L></span>
          <div className="now-line"><span className={`pulse ${running ? '' : 'off'}`} key={ticks?.t ?? 0} />{running} of {bots.length} bot{bots.length === 1 ? '' : 's'} running</div>
          <div className="small">{last ? <>Last trade <b>{ago(last.t)}</b>{last.paper ? <span className="tag paper-tag">paper</span> : null}</> : 'No trades yet'}</div>
          {next && <div className="small">Next likely trade: <b>{next.bot}</b>{next.paper ? <span className="tag paper-tag">paper</span> : null} {next.side === 'buy' ? 'buys' : 'sells'} at <b>{px(next.at)}</b>, {pct(next.dist, 2)} away</div>}
        </div>
      </section>
      {showUsd && (
        <p className="hero-foot muted small">
          <L tip="Your live bots' coins valued at today's prices. It moves with the market every day, whether or not the bots trade. Paper bots aren't included.">Live holdings at today's prices:</L> <b>{value != null ? usd(value) : '—'}</b>{unsold != null && unsold !== 0 ? <> (coins not sold yet: <span className={cls(unsold)}>{usd(unsold, true)}</span>)</> : null}. This moves with the market every day; it isn't a trading result.
        </p>
      )}
      {paperBots.length > 0 && (
        <p className="paper-line small">
          <span className="tag paper-tag">paper</span> Simulated, not counted above: {paperEarn.length ? paperEarn.map((e) => `${e.amount > 0 ? '+' : e.amount < 0 ? '−' : ''}${humanAmount(Math.abs(e.amount))} ${e.symbol}`).join(' · ') : 'nothing yet'} from {paperTot.trades} trade{paperTot.trades === 1 ? '' : 's'} on {paperBots.length} paper bot{paperBots.length === 1 ? '' : 's'}.{' '}
          <button type="button" className="linklike" onClick={() => nav({ v: 'tools', tab: 'analytics', analytics: 'paper' })}>Paper analytics</button>
        </p>
      )}

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

      <div className="split live-split">
        <section className="bots" aria-label="Your bots">
          <div className="bots-head">
            <h3>Your bots</h3>
            <div className="bots-actions">
              {canClear && <button type="button" className="btn small-btn" onClick={clearClosed}>Clear closed</button>}
              {closable.length > 0 && <button type="button" className="btn small-btn" onClick={closeAll}>Close all</button>}
              <button type="button" className="btn primary small-btn" onClick={() => nav({ v: 'new', kind: 'grid' })}>New bot</button>
            </div>
          </div>
          {kept.length > 0 && (
            <p className="bots-note small muted">{kept.length} closed bot{kept.length === 1 ? '' : 's'} kept in <button type="button" className="linklike" onClick={() => nav({ v: 'tools', tab: 'analytics' })}>Analytics</button>.</p>
          )}
          {rowErr && <div className="banner error" role="alert"><span className="grow">{rowErr}</span><button type="button" className="btn ghost small-btn" onClick={() => setRowErr(null)}>Dismiss</button></div>}
          {bots.map((b) => (b.kind === 'lp'
            ? <LpRow key={b.id} s={s} b={b} price={priceOf(b)} nav={nav} act={act} busy={busy} closing={isClosing(b)} onClose={() => closeBot(b)} />
            : <BotRow key={b.id} s={s} b={b} price={priceOf(b)} nav={nav} act={act} busy={busy} closing={isClosing(b)} onClose={() => closeBot(b)} />))}
          {bots.length === 0 && (
            <div className="empty">
              <p>No bots{chain !== 'all' ? ' on this chain' : ''} yet. Start one in paper mode to see how it behaves with real prices and no real money.</p>
              <button type="button" className="btn primary" onClick={() => nav({ v: 'new', kind: 'grid' })}>Start a paper bot</button>
            </div>
          )}
        </section>
        <section className="card live-card" aria-label="Live">
          <div className="card-head"><h3><span className="pulse" key={ticks?.t ?? 0} /><L tip="Every buy, sell and transaction the moment it happens. Each sell shows what that one trade made or lost after fees and gas; a buy shows the level it will sell at. Tap a row to open its bot.">Live</L></h3><span className="muted small">every buy, sell and transaction as it happens</span></div>
          <LiveFeed s={s} items={feed} nav={nav} />
        </section>
      </div>

      <WalletPanel s={s} chain={chain} />

      <BestThisWeek s={s} chain={chain} nav={nav} />
    </main>
  );
}
