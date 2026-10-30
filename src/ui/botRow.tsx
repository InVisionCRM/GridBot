/** One bot, at a glance. The Bots page can open the range, fees, and levels under the row. */
import { useContext, useEffect, useRef, useState } from 'react';
import { botApi } from './api';
import { RangeBar, Sparkline } from './charts';
import { chainOf, RefreshCtx } from './chains';
import { botFacts, EST_HINT, metricsOf, unitsText } from './deskStats';
import { isShortRun } from './runRate';
import { bagFixed, cls, dur, pctShown, px, qty } from './fmt';
import { ChainMark, TokenMark } from './icons';
import { botView, gridName, lpName, quoteSym, rangeState, type AnyObj, type Nav } from './model';
import { botSpark } from './series';
import { StatTable } from './StatTable';
import { MoneyDetails } from './MoneyDetails';

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
  if (b.kind === 'lp') return { base, quote, title: lpName(b) };
  if (b.kind === 'trader' || b.kind === 'sniper') {
    const name = String(b.label || b.name || '');
    return { base: String(b.token || b.base || name), quote: String(b.spend || quote), title: name || 'Token trader' };
  }
  const name = String(b.name ?? '');
  return { base: base || name.split('/')[0] || name, quote, title: name || `${base}/${quote}` };
}

/** A pair name may wrap after its slash on a narrow phone ("ETH/" then "USDG"), never inside a coin's name. */
const wrappable = (title: string) => title.replace('/', '/\u200B');

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

/** Total P&L in the quote coin, in dollars and as a fraction of capital in: the server's metrics, nothing recomputed. */
export function pnlParts(b: AnyObj): { quote: number | null; usd: number | null; pct: number | null } {
  const m = metricsOf(b);
  if (!m) return { quote: null, usd: null, pct: null };
  return { quote: m.quote.totalPnl, usd: m.totalPnlUsd, pct: m.totalPnlPct };
}

/** The headline per bot: units generated and their dollar value now (server metrics). */
export function generatedParts(b: AnyObj): { units: Record<string, number> | null; usd: number | null; text: string } {
  const m = metricsOf(b);
  return { units: m?.generated ?? null, usd: m?.generatedUsd ?? null, text: unitsText(m?.generated) };
}

export function fillsToday(b: AnyObj, from = startOfDay()): number | null {
  if (b.kind !== 'grid') return null;
  return ((b.trades ?? []) as AnyObj[]).filter((t) => !t.failed && t.timestamp >= from).length;
}


/** Units per token added up over bots (null when none has any). */
export function sumUnits(recs: (Record<string, number> | null | undefined)[]): Record<string, number> | null {
  let out: Record<string, number> | null = null;
  for (const r of recs) {
    if (!r) continue;
    out ??= {};
    for (const [k, u] of Object.entries(r)) if (Number.isFinite(u)) out[k] = (out[k] ?? 0) + u;
  }
  return out;
}

/** Home's headline: Generated per token, live bots only; paper bots separately (never mixed in). */
export function generatedByMode(bots: AnyObj[]): { live: Record<string, number> | null; paper: Record<string, number> | null } {
  return {
    live: sumUnits(bots.filter((b) => b.mode === 'live').map((b) => metricsOf(b)?.generated)),
    paper: sumUnits(bots.filter((b) => b.mode !== 'live').map((b) => metricsOf(b)?.generated)),
  };
}


/** Total P&L per quote coin over the bots of one mode (units; the server's metrics.quote.totalPnl). */
export function pnlUnits(bots: AnyObj[], mode: 'live' | 'paper' = 'live'): Record<string, number> | null {
  return sumUnits(bots.filter((b) => (mode === 'live' ? b.mode === 'live' : b.mode !== 'live')).map((b) => {
    const m = metricsOf(b);
    return m?.quote.symbol && m.quote.totalPnl != null ? { [m.quote.symbol]: m.quote.totalPnl } : null;
  }));
}


/** Σ generatedUsd over the bots of one mode (API / tests; the page shows units). Null when none has a dollar value. */
export function totalGeneratedUsd(bots: AnyObj[], mode: 'live' | 'paper' = 'live'): number | null {
  let sum = 0, any = false;
  for (const b of bots.filter((x) => (mode === 'live' ? x.mode === 'live' : x.mode !== 'live'))) {
    const v = metricsOf(b)?.generatedUsd;
    if (v == null) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

export function totalPnlUsd(bots: AnyObj[], mode: 'live' | 'paper' = 'live'): number | null {
  let sum = 0, any = false;
  for (const b of bots.filter((x) => (mode === 'live' ? x.mode === 'live' : x.mode !== 'live'))) {
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

/**
 * What a desk row's columns (Value, Generated, P&L, %, Fees, Age, APR, Moves) and its expanded summary (range) already
 * show, left out of the expanded stat table and Details so no number appears twice.
 */
const DESK_SHOWN_ELSEWHERE = ['Generated', 'Age', 'APR', 'Fees earned', 'Moves', 'Range'] as const;

function Expanded({ b, nav, desk = false }: { b: AnyObj; nav: Nav; desk?: boolean }) {
  if (isTrader(b)) return null;
  const sym = String(quoteSym(b) ?? '');
  const fees = feeQuote(b);
  if (b.kind === 'lp') {
    const pos = b.position;
    return (
      <div className="bot-more">
        <p>{b.inRange === false ? 'Out of range' : b.inRange ? 'In range' : 'No position'}{pos ? ` · ${px(pos.lower)} – ${px(pos.upper)}` : ''}</p>
        {!desk && <p>Fees earned {qty(fees, sym, 4, false)}</p>}
        <button type="button" className="text-link" onClick={() => nav(botView(b.kind, b.id))}>Open</button>
      </div>
    );
  }
  if (b.kind === 'trend') {
    return (
      <div className="bot-more">
        <p>{b.tf} · {b.cfg?.strategy ?? 'trend'} · {b.position ? 'in a trade' : 'flat'}</p>
        {!desk && <p>Fees {qty(fees, sym, 4, false)}</p>}{/* desktop: Fees paid is in the table under it */}
        <button type="button" className="text-link" onClick={() => nav(botView(b.kind, b.id))}>Open</button>
      </div>
    );
  }
  const rs = rangeState(b);
  const levels = (b.intervals ?? []) as AnyObj[];
  return (
    <div className="bot-more">
      <p>Range {b.config ? `${px(b.config.lowerPrice)} – ${px(b.config.upperPrice)}` : '—'}{rs ? ` · ${rs}` : ''} · {b.config?.gridCount ?? levels.length} levels</p>
      <p>{!desk && <>Fees {qty(fees, sym, 4, false)} · </>}{b.stats?.roundTrips ?? 0} round trips</p>
      <div className="lvls" data-testid="levels" style={{ display: 'contents' }}>{levels.slice(0, 6).map((iv) => (
        <p key={iv.index} className="lvl">{px(iv.buyPrice)} → {px(iv.sellPrice)} · {iv.status === 'holding' ? 'filled' : iv.status === 'waitingBuy' ? 'waiting' : iv.status}</p>
      ))}</div>
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
  const pair = pairOf(b);
  const chain = chainOf(s, b.chainId ?? s.legacyChainId);
  const pnl = pnlParts(b);
  const fills = fillsToday(b);
  const bad = !!b.lastError;
  const on = b.status === 'running' && !bad;
  const money = pnl.quote != null ? qty(pnl.quote, pair.quote, 4) : '—';
  const pos = b.position;
  const m = metricsOf(b);
  // Crypto units only: the value and fees in the bot's quote coin
  const value = m?.quote.currentValue ?? null;
  const invested = m?.capitalCoins ?? null; // Kyle: each row shows Invested and Generated; a liquidity bot funded with both coins lists both
  const feesEarned = m?.quote.feesEarned ?? null;
  const facts = metrics ? botFacts(b) : null;
  const gen = generatedParts(b);
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
              <span className="bot-title">{wrappable(pair.title)}</span>
              <span className="bot-meta">
                <i className={`status-dot${on ? ' on' : ''}${bad ? ' bad' : ''}`} />
                {[chain?.short, kindWord(b), statusWord(b), b.mode === 'paper' ? 'paper' : ''].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
          <span className="desk-spark"><Sparkline points={botSpark(b)} width={112} height={32} /></span>
          <span className="desk-range"><BotRange b={b} fills={fills} /></span>
          {metrics && <span className="desk-inv" title="Invested: what was put into this bot at the start, in its quote coin">{bagFixed(invested)}<small className="inv-label"> invested</small></span>}
          <span className="desk-val">{value == null ? '—' : qty(value, pair.quote, 5, false)}</span>
          {metrics && facts ? <>
            <span className="desk-gen" title={m?.calc ?? undefined}>
              {/* one coin per line: a two-coin figure never breaks inside an amount */}
              <b className={cls(gen.usd)}>{gen.text.split(' · ').map((part, i, all) => <span key={i} className="coin-line">{part}{i < all.length - 1 ? ' ·' : ''}</span>)}</b>
            </span>
            <span className="desk-pnl" title={m?.calc ?? undefined}>
              <b className={cls(pnl.quote)}>{money}</b>
            </span>
            <span className="desk-pct"><span className={cls(facts.pnlPct)}>{pctShown(facts.pnlPct, 2, true)}</span></span>
            <span className="desk-fees">{feesEarned == null ? '—' : qty(feesEarned, pair.quote, 4, false)}</span>
            <span className="desk-age">{facts.ageMs == null ? '—' : dur(facts.ageMs)}</span>
            <span className="desk-apr" title={isShortRun(facts.ageMs) ? `Est. APR ${EST_HINT}. Until then P&L % is the figure for the run, and Age its length.` : facts.aprPct == null ? facts.estHint.d365 ?? undefined : m?.calc ?? undefined}>{
              // under a day: no yearly rate, and not the run's % again (it is one column to the left): a dash only (pr-72 MED 1)
              isShortRun(facts.ageMs) || facts.aprPct == null ? '—' : pctShown(facts.aprPct, 2, true)}</span>
            <span className="desk-moves">{facts.moves.n == null ? '—' : facts.moves.n}</span>
          </> : (
            <span className="desk-pnl" title={m?.calc ?? undefined}>
              <b className={cls(gen.usd)}>{gen.text}</b>
              <small className="muted">{gen.units ? 'generated' : ''}</small>
            </span>
          )}
          <RowMenu b={b} nav={nav} pause={pause} close={close} />
        </div>
        {bad && <p className="line-note">{b.lastError}</p>}
        {open && <div className="desk-expand"><Expanded b={b} nav={nav} desk /><StatTable b={b} s={s} hide={DESK_SHOWN_ELSEWHERE} /><MoneyDetails b={b} hide={['Total P&L', 'Value now', 'Deposit']} /></div>}
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
            <span className="bot-title">{wrappable(pair.title)}</span>
            <span className="bot-meta">
              <i className={`status-dot${on ? ' on' : ''}${bad ? ' bad' : ''}`} />
              {statusWord(b)} · {kindWord(b)}{chain ? ` · ${chain.short}` : ''}
              {b.mode === 'paper' ? ' · paper' : ''}
              {fills != null ? ` · ${fills} fill${fills === 1 ? '' : 's'} today` : ''}
            </span>
            {b.kind === 'lp' && pos && <RangeBar lower={pos.lower} upper={pos.upper} price={b.price} inRange={b.inRange} />}
          </span>
          <span className="bot-pnl" title={m?.calc ?? undefined}>
            <b className={cls(gen.usd)}>{gen.text}</b>
            <small className="muted">{gen.units ? 'generated' : ''}</small>
          </span>
        </button>
        <RowMenu b={b} nav={nav} pause={pause} close={close} />
      </div>
      {bad && <p className="line-note">{b.lastError}</p>}
      {open && <Expanded b={b} nav={nav} />}
    </div>
  );
}
