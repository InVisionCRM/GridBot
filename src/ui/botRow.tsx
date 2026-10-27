/** One bot, at a glance. The Bots page can open the range, fees, and levels under the row. */
import { useContext, useEffect, useRef, useState } from 'react';
import { botApi } from './api';
import { RangeBar, Sparkline } from './charts';
import { chainOf, RefreshCtx } from './chains';
import { botFacts } from './deskStats';
import { cls, dur, pct, px, qty, usd } from './fmt';
import { ChainMark, TokenMark } from './icons';
import { useShowUsd } from './money';
import { botView, gridName, quoteSym, rangeState, type AnyObj, type Nav } from './model';
import { bookUsd, botSpark } from './series';
import { StatTable } from './StatTable';

export function listBots(s: AnyObj, chain: number | 'all'): AnyObj[] {
  return [
    ...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })),
    ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' })),
    ...(s.lps ?? []).map((t: AnyObj) => ({ ...t, kind: t.kind ?? 'lp' })),
  ].filter((b) => !b.archivedAt && (chain === 'all' || (b.chainId ?? s.legacyChainId) === chain));
}

export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pairOf(b: AnyObj): { base: string; quote: string; title: string } {
  const quote = String(quoteSym(b) ?? '');
  const base = String(b.base ?? '');
  if (b.kind === 'grid') return { base, quote, title: gridName(b) };
  if (b.kind === 'lp') return { base, quote, title: b.label ? String(b.label) : `${base}/${quote}` };
  if (b.kind === 'trader' || b.kind === 'sniper') {
    const name = String(b.label || b.name || '');
    return { base: String(b.token || b.base || name), quote: String(b.spend || quote), title: name || 'Token trader' };
  }
  const name = String(b.name ?? '');
  return { base: base || name.split('/')[0] || name, quote, title: name || `${base}/${quote}` };
}

function kindWord(b: AnyObj) {
  if (b.kind === 'sniper') return 'Sniper';
  if (b.kind === 'trader') return 'Token trader';
  return b.kind === 'lp' ? 'Liquidity' : b.kind === 'trend' ? 'Trend' : 'Grid';
}

function isTrader(b: AnyObj) {
  return b.kind === 'trader' || b.kind === 'sniper';
}

function statusWord(b: AnyObj) {
  if (b.closing || b.step?.action === 'close') return 'Closing';
  if (b.status === 'running') return 'Running';
  if (b.status === 'stopped') return 'Paused';
  return 'Idle';
}

/** Realized plus what is still unsold, in quote units, and as a fraction of the money put in. */
export function pnlParts(b: AnyObj): { quote: number | null; usd: number | null; pct: number | null } {
  const k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
  if (b.kind === 'trader' || b.kind === 'sniper') {
    const u = typeof b.pnlUsd === 'number' ? b.pnlUsd : typeof b.pnl?.unrealized === 'number' ? b.pnl.unrealized : null;
    const cap = typeof b.spentUsd === 'number' ? b.spentUsd : null;
    return { quote: u, usd: u, pct: u != null && cap ? u / cap : null };
  }
  if (b.kind === 'lp') {
    const net = typeof b.pnl?.net === 'number' ? b.pnl.net : null;
    const cap = b.config?.capital;
    return { quote: net, usd: net != null && k != null ? net * k : null, pct: net != null && cap ? net / cap : null };
  }
  if (b.kind === 'trend') {
    const q = (b.pnl?.realized ?? 0) + (b.pnl?.unrealized ?? 0);
    return { quote: q, usd: k != null ? q * k : null, pct: typeof b.pnl?.returnPct === 'number' ? b.pnl.returnPct : null };
  }
  const q = (b.pnl?.realized ?? 0) + (b.pnl?.unrealized ?? 0);
  const cap = b.config?.totalCapitalUsd;
  return { quote: q, usd: k != null ? q * k : null, pct: cap ? q / cap : null };
}

export function fillsToday(b: AnyObj, from = startOfDay()): number | null {
  if (b.kind !== 'grid') return null;
  return ((b.trades ?? []) as AnyObj[]).filter((t) => !t.failed && t.timestamp >= from).length;
}

/** Closed-trade profit since local midnight, as a running total in dollars. */
export function todaySeries(bots: AnyObj[], includePaper: boolean): number[] {
  const from = startOfDay();
  const ev: { t: number; usd: number }[] = [];
  for (const b of bots) {
    if (!includePaper && b.mode === 'paper') continue;
    const k = b.usdPerQuote as number | null;
    if (!(typeof k === 'number' && k > 0)) continue;
    for (const tr of (b.trades ?? []) as AnyObj[]) {
      if (tr.failed || tr.side === 'buy' || !(tr.timestamp >= from)) continue;
      const pnl = tr.roundTripNet ?? tr.realizedPnlUsd;
      if (typeof pnl === 'number' && Number.isFinite(pnl)) ev.push({ t: tr.timestamp, usd: pnl * k });
    }
  }
  ev.sort((a, c) => a.t - c.t);
  const pts = [0];
  let acc = 0;
  for (const e of ev) { acc += e.usd; pts.push(acc); }
  return pts;
}

export function feesTodayUsd(bots: AnyObj[]): number {
  const from = startOfDay();
  let sum = 0;
  for (const b of bots) {
    const k = b.usdPerQuote as number | null;
    if (!(typeof k === 'number' && k > 0)) continue;
    for (const tr of (b.trades ?? []) as AnyObj[]) {
      if (tr.failed || !(tr.timestamp >= from) || typeof tr.feeQuote !== 'number') continue;
      sum += tr.feeQuote * k;
    }
  }
  return sum;
}

export function totalPnlUsd(bots: AnyObj[]): number | null {
  let sum = 0, any = false;
  for (const b of bots) {
    const p = pnlParts(b);
    if (p.usd == null) continue;
    sum += p.usd;
    any = true;
  }
  return any ? sum : null;
}

function feeQuote(b: AnyObj): number {
  if (b.kind === 'lp') return typeof b.pnl?.fees === 'number' ? b.pnl.fees : 0;
  if (typeof b.pnl?.fees === 'number' && b.kind === 'trend') return b.pnl.fees;
  return ((b.trades ?? []) as AnyObj[]).reduce((a, t) => a + (typeof t.feeQuote === 'number' ? t.feeQuote : 0), 0);
}

function stem(b: AnyObj) {
  return b.kind === 'trend' ? 'trends' : b.kind === 'lp' ? 'lps' : 'grids';
}

export function useRowActions() {
  const refresh = useContext(RefreshCtx);
  const [err, setErr] = useState<string | null>(null);
  /** A LIVE resume runs a fresh safety check first (a few seconds): the row list shows "Checking safety…" meanwhile. */
  const [checking, setChecking] = useState(0);
  const pause = (b: AnyObj) => {
    const running = b.status === 'running';
    const path = `${stem(b)}/${b.id}/${running ? 'stop' : 'resume'}`;
    const check = !running && b.mode === 'live';
    setErr(null);
    if (check) setChecking((n) => n + 1);
    void botApi(path, 'POST', undefined, running ? 'row-stop' : undefined).then(() => refresh()).catch((e: Error) => setErr(e.message))
      .finally(() => { if (check) setChecking((n) => n - 1); });
  };
  const close = (b: AnyObj) => {
    const name = pairOf(b).title;
    if (b.mode === 'live' && !confirm(`Close ${name}? It sells or withdraws on-chain. The same price-impact and slippage limits still apply.`)) return;
    setErr(null);
    void botApi(`${stem(b)}/${b.id}/close`, 'POST', undefined, 'row-close').then(() => refresh()).catch((e: Error) => setErr(e.message));
  };
  return { err, pause, close, checking: checking > 0 };
}

function RowMenu({ b, nav, pause, close }: { b: AnyObj; nav: Nav; pause: (b: AnyObj) => void; close: (b: AnyObj) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  const running = b.status === 'running';
  const trader = isTrader(b);
  const openBot = () => { setOpen(false); trader ? nav({ v: 'auto' }) : nav(botView(b.kind, b.id)); };
  return (
    <div className="row-menu" ref={root}>
      <button type="button" className="menu-btn" aria-expanded={open} aria-label={`Actions for ${pairOf(b).title}`} onClick={() => setOpen((v) => !v)}><span /><span /><span /></button>
      {open && (
        <div className="row-pop" role="menu">
          {!trader && <button type="button" role="menuitem" onClick={() => { setOpen(false); pause(b); }}>{running ? 'Pause' : 'Resume'}</button>}
          {!trader && <button type="button" role="menuitem" onClick={() => { setOpen(false); close(b); }}>Close</button>}
          <button type="button" role="menuitem" onClick={openBot}>Open</button>
        </div>
      )}
    </div>
  );
}

function Expanded({ b, nav }: { b: AnyObj; nav: Nav }) {
  if (isTrader(b)) return null;
  const sym = String(quoteSym(b) ?? '');
  const fees = feeQuote(b);
  if (b.kind === 'lp') {
    const pos = b.position;
    return (
      <div className="bot-more">
        <p>{b.inRange === false ? 'Out of range' : b.inRange ? 'In range' : 'No position'}{pos ? ` · ${px(pos.lower)} – ${px(pos.upper)}` : ''}</p>
        <p>Fees {qty(fees, sym, 4, false)}</p>
        <button type="button" className="text-link" onClick={() => nav(botView(b.kind, b.id))}>Open</button>
      </div>
    );
  }
  if (b.kind === 'trend') {
    return (
      <div className="bot-more">
        <p>{b.tf} · {b.cfg?.strategy ?? 'trend'} · {b.position ? 'in a trade' : 'flat'}</p>
        <p>Fees {qty(fees, sym, 4, false)}</p>
        <button type="button" className="text-link" onClick={() => nav(botView(b.kind, b.id))}>Open</button>
      </div>
    );
  }
  const rs = rangeState(b);
  const levels = (b.intervals ?? []) as AnyObj[];
  return (
    <div className="bot-more">
      <p>Range {b.config ? `${px(b.config.lowerPrice)} – ${px(b.config.upperPrice)}` : '—'}{rs ? ` · ${rs}` : ''} · {b.config?.gridCount ?? levels.length} levels</p>
      <p>Fees {qty(fees, sym, 4, false)} · {b.stats?.roundTrips ?? 0} round trips</p>
      {levels.slice(0, 6).map((iv) => (
        <p key={iv.index} className="lvl">{px(iv.buyPrice)} → {px(iv.sellPrice)} · {iv.status === 'holding' ? 'filled' : iv.status === 'waitingBuy' ? 'waiting' : iv.status}</p>
      ))}
      {levels.length > 6 && <p className="lvl">{levels.length - 6} more levels</p>}
      <button type="button" className="text-link" onClick={() => nav(botView(b.kind, b.id))}>Open</button>
    </div>
  );
}

function BotRange({ b, fills }: { b: AnyObj; fills: number | null }) {
  if (b.kind === 'lp' && b.position) return <RangeBar wide lower={b.position.lower} upper={b.position.upper} price={b.price} inRange={b.inRange} />;
  if (b.kind === 'grid') {
    const n = fills ?? 0;
    return <span className="desk-fills">{n} fill{n === 1 ? '' : 's'}</span>;
  }
  return <span className="muted">—</span>;
}

export function BotRow({ s, b, nav, pause, close, expandable, open, onToggle, columns, metrics }: {
  s: AnyObj;
  b: AnyObj;
  nav: Nav;
  pause: (b: AnyObj) => void;
  close: (b: AnyObj) => void;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  columns?: boolean;
  metrics?: boolean;
}) {
  const { on: showUsd } = useShowUsd();
  const pair = pairOf(b);
  const chain = chainOf(s, b.chainId ?? s.legacyChainId);
  const pnl = pnlParts(b);
  const fills = fillsToday(b);
  const bad = !!b.lastError;
  const on = b.status === 'running' && !bad;
  const money = showUsd && pnl.usd != null ? usd(pnl.usd, true) : pnl.quote != null ? qty(pnl.quote, pair.quote, 4) : '—';
  const pos = b.position;
  const value = bookUsd(b);
  const facts = metrics ? botFacts(b) : null;
  const go = () => (isTrader(b) ? nav({ v: 'auto' }) : expandable ? onToggle?.() : nav(botView(b.kind, b.id)));
  if (columns) {
    return (
      <div className={`bot-block${open ? ' open' : ''}`}>
        <div className="desk-row">
          <button type="button" className="desk-pair" onClick={go} aria-expanded={expandable ? !!open : undefined}>
            <span className="pair-marks">
              <TokenMark symbol={pair.base} size={22} />
              <TokenMark symbol={pair.quote} size={22} />
              {chain && <span className="chain-coin"><ChainMark short={chain.short} color={chain.color} size={14} /></span>}
            </span>
            <span className="desk-id">
              <span className="bot-title">{pair.title}</span>
              <span className="bot-meta">
                <i className={`status-dot${on ? ' on' : ''}${bad ? ' bad' : ''}`} />
                {[chain?.short, kindWord(b), statusWord(b), b.mode === 'paper' ? 'paper' : ''].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
          <span className="desk-spark"><Sparkline points={botSpark(b)} width={112} height={32} /></span>
          <span className="desk-range"><BotRange b={b} fills={fills} /></span>
          <span className="desk-val">{value == null ? '—' : usd(value)}</span>
          <span className="desk-pnl">
            <b className={cls(showUsd ? pnl.usd : pnl.quote)}>{money}</b>
            {!metrics && <small className={cls(pnl.pct)}>{pct(pnl.pct, 1, true)}</small>}
          </span>
          {metrics && facts && <>
            <span className="desk-pct"><span className={cls(facts.pnlPct)}>{pct(facts.pnlPct, 1, true)}</span></span>
            <span className="desk-age">{facts.ageMs == null ? '—' : dur(facts.ageMs)}</span>
            <span className="desk-apr">{facts.est.d365?.pct == null ? '—' : pct(facts.est.d365.pct, 1, true)}</span>
            <span className="desk-moves">{facts.moves.n == null ? '—' : facts.moves.n}</span>
            <span className="desk-fees">{facts.feesEarnedUsd == null ? '—' : usd(facts.feesEarnedUsd)}</span>
          </>}
          <RowMenu b={b} nav={nav} pause={pause} close={close} />
        </div>
        {bad && <p className="line-note">{b.lastError}</p>}
        {open && <div className="desk-expand"><Expanded b={b} nav={nav} /><StatTable b={b} s={s} /></div>}
      </div>
    );
  }
  return (
    <div className={`bot-block${open ? ' open' : ''}`}>
      <div className="bot-row">
        <button type="button" className="bot-main" onClick={() => (expandable ? onToggle?.() : nav(botView(b.kind, b.id)))} aria-expanded={expandable ? !!open : undefined}>
          <span className="pair-marks">
            <TokenMark symbol={pair.base} size={22} />
            <TokenMark symbol={pair.quote} size={22} />
          </span>
          <span className="bot-mid">
            <span className="bot-title">{pair.title}</span>
            <span className="bot-meta">
              <i className={`status-dot${on ? ' on' : ''}${bad ? ' bad' : ''}`} />
              {statusWord(b)} · {kindWord(b)}{chain ? ` · ${chain.short}` : ''}
              {b.mode === 'paper' ? ' · paper' : ''}
              {fills != null ? ` · ${fills} fill${fills === 1 ? '' : 's'} today` : ''}
            </span>
            {b.kind === 'lp' && pos && <RangeBar lower={pos.lower} upper={pos.upper} price={b.price} inRange={b.inRange} />}
          </span>
          <span className="bot-pnl">
            <b className={cls(showUsd ? pnl.usd : pnl.quote)}>{money}</b>
            <small className={cls(pnl.pct)}>{pct(pnl.pct, 1, true)}</small>
          </span>
        </button>
        <RowMenu b={b} nav={nav} pause={pause} close={close} />
      </div>
      {bad && <p className="line-note">{b.lastError}</p>}
      {open && <Expanded b={b} nav={nav} />}
    </div>
  );
}
