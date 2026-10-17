/** Home: totals, what needs attention, and one row per bot with ≈USD profit vs just holding. */
import { useCallback, useEffect, useState } from 'react';
import { http, botApi } from './api';
import { AnimatedNumber, StatusDot, useFlash } from './motion';
import { ago, cls, num, pct, px, qty, time, usd } from './fmt';
import { ChainBadge, DexTag, chainOf, chains, useChainFilter } from './chains';
import { humanAmount } from '../live/amount';
import { errMsg, gridName, gridPnlUsd, quoteSym, rangeState, trendPnlUsd, type AnyObj, type Nav } from './model';

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
              return <span key={c.address ?? 'native'} className="coin" title={`${c.amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${c.symbol}`}><b>{humanAmount(c.amount)}</b> {c.symbol}{used > 0 ? <small> · {humanAmount(used)} in live bots</small> : null}</span>;
            })}</span>}
        </div>
      ))}
    </section>
  );
}

const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`);

function PickRow({ k, use, busy }: { k: AnyObj; use: (k: AnyObj) => void; busy: boolean }) {
  const t = k.test;
  return (
    <div className="pick">
      <span className="pick-rank">{k.rank}</span>
      <div className="pick-main">
        <div className="pick-name"><b>{k.label}</b>{k.key ? null : <span className="tag" title={k.add.address}>new token {k.add.address.slice(0, 6)}…{k.add.address.slice(-4)}</span>}{k.risk && k.risk !== 'low' ? <span className="tag live">risk {k.risk}</span> : null}</div>
        <div className="small muted">±{Math.round(k.bandPct * 100)}% around {px(k.price)} · {k.gridCount} levels · spends {k.spend}{k.activity ? ` · ${money(k.activity.volume24Usd)} traded today · ${money(k.activity.liquidityUsd)} in the pool` : ''}</div>
      </div>
      <div className="pick-test">
        <b className={cls(t.returnPct)}>{pct(t.returnPct, 2, true)}</b>
        <span className="small muted">{t.roundTrips} trades in 7 days</span>
        <span className="small muted">holding {pct(t.holdPct, 1, true)} · worst dip {pct(t.maxDrawdownPct, 1)}</span>
      </div>
      <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => use(k)}>Use this</button>
    </div>
  );
}

/** "Scanning Robinhood Chain (2 of 3): testing pairs 5 of 11…" */
function scanStep(g: AnyObj | null): string {
  if (!g) return 'Scanning…';
  return `Scanning ${g.chain} (${g.chainNo} of ${g.chains}): ${g.phase}${g.phase === 'finding pools' ? '' : ` ${g.done + 1} of ${g.total}`}…`;
}

/** Today's picks: the daily scan's best grid setups per chain, tested on the last 7 days of hourly prices. */
function PicksPanel({ s, chain, nav, act, busy }: { s: AnyObj; chain: number | 'all'; nav: Nav; act: Props['act']; busy: boolean }) {
  const [p, setP] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => http('/api/picks').then((x) => { setP(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!p?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [p?.running, load]);
  if (err) return <div className="banner info"><span className="grow">Today's picks: {err}</span></div>;
  if (!p) return null;
  const scan = () => act(async () => { await http('/api/picks/scan', 'POST'); setP({ ...p, running: true }); });
  const use = (k: AnyObj) => act(async () => {
    const key = k.key ?? (await http('/api/picks/use', 'POST', { chainId: k.chainId, ...k.add })).key;
    nav({ v: 'new', kind: 'grid', gridPrefill: { pair: key, bandPct: k.bandPct, gridCount: k.gridCount, nonce: Date.now() } });
  });
  const shown: AnyObj[] = p.chains.filter((c: AnyObj) => chain === 'all' || c.chainId === chain);
  return (
    <section className="card" aria-label="Today's picks">
      <div className="card-head">
        <h3>Today's picks</h3>
        <span className="muted small">{p.running ? scanStep(p.progress) : p.at ? `scanned ${ago(p.at)} · next scan ${time(p.nextAt)}` : 'not scanned yet'}</span>
        <span className="grow" />
        <button type="button" className="btn small-btn" disabled={busy || p.running} onClick={scan}>{p.running ? 'Scanning…' : 'Scan now'}</button>
      </div>
      <p className="small muted picks-note">Each chain's busiest pools are checked for real trading and safety, then the grid is replayed on the last 7 days of hourly prices with the pool's fee, price impact and gas, using about ${p.testUsd.toLocaleString('en-US')} of the coin it spends. These are the setups that made the most. A good week doesn't promise the next one, so start in paper first.</p>
      {shown.map((c) => (
        <div key={c.chainId} className="pick-chain">
          <div className="pick-chain-head"><ChainBadge c={chainOf(s, c.chainId)} testnet={false} /><b>{c.name}</b><span className="muted small">{c.tested} pairs tested</span></div>
          {c.error ? <p className="small neg">{c.error}</p>
            : !c.picks.length ? <p className="small muted">Nothing made money here over the last 7 days. A grid would have lost to fees or to a one-way move.</p>
            : c.picks.map((k: AnyObj) => <PickRow key={`${k.rank}-${k.label}`} k={k} use={use} busy={busy} />)}
          {c.skipped.length > 0 && (
            <details className="more">
              <summary>Why other pools were left out ({c.skipped.length})</summary>
              <ul className="skip-list">{c.skipped.map((x: AnyObj, i: number) => <li key={i}><b>{x.name}</b> {x.why}</li>)}</ul>
            </details>
          )}
        </div>
      ))}
      {!shown.length && !p.running && <p className="small muted">No scan yet. Press Scan now.</p>}
    </section>
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
    const name = b.kind === 'grid' ? gridName(b) : b.name;
    const open = () => nav(b.kind === 'grid' ? { v: 'grid', id: b.id } : { v: 'trend', id: b.id });
    if (b.available === false) notices.push({ key: `na-${b.id}`, level: 'warn', text: <><b>{name}</b> trades on a chain or token this server doesn't load (removed, or turned off in .env). It is stopped; open it to remove it.</>, open });
    else if (b.lastError) notices.push({ key: `err-${b.id}`, level: 'error', text: <><b>{name}:</b> {b.lastError}</>, open });
    else if (b.kind === 'grid' && b.status === 'running') {
      const rs = rangeState(b);
      if (rs === 'above' && !b.recenter?.enabled) notices.push({ key: `rng-${b.id}`, level: 'warn', text: <><b>{name} is above its range.</b> Everything is sold and it waits for the price to come back. Open it to move the range or turn on Follow the price up.</>, open });
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

      <WalletPanel s={s} chain={chain} />

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

      <PicksPanel s={s} chain={chain} nav={nav} act={act} busy={busy} />
    </main>
  );
}
