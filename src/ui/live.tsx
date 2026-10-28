/**
 * Live views: what each bot is about to do (price gliding between its next buy and sell), and one feed of everything
 * that happens — every fill with its own result, so a losing trade is never hidden inside a dollar total.
 */
import { useEffect, useRef, useState } from 'react';
import { nextLevels } from '../live/liveGrid';
import { ago, cls, px } from './fmt';
import { ChainBadge, chainOf } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { botView, gridName, quoteSym, type AnyObj, type Nav, type View } from './model';
import { humanAmount } from '../live/amount';
import { Tip } from './Tip';

/** Live price of a bot's market: the newest poll tick, else its last read. */
export function livePrice(ticks: Ticks | null, key: string, fallbackFromStatus: number | null): number | null {
  return ticks?.prices[key] ?? fallbackFromStatus;
}

/** ↑ / ↓ for a moment after the value changes. */
function useDirection(v: number | null) {
  const prev = useRef(v);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (v == null || prev.current == null || v === prev.current) { prev.current = v; return; }
    setDir(v > prev.current ? 'up' : 'down');
    prev.current = v;
    const t = setTimeout(() => setDir(null), 900);
    return () => clearTimeout(t);
  }, [v]);
  return dir;
}

export function LivePrice({ value }: { value: number | null }) {
  const dir = useDirection(value);
  return <span className={`live-px ${dir ? `px-${dir}` : ''}`}>{px(value)}</span>;
}

/** What the grid is doing this second. */
export function gridState(g: AnyObj): { label: string; busy: boolean } {
  if (g.status !== 'running') return { label: g.status === 'stopped' ? 'stopped' : g.status, busy: false };
  if (g.inFlight) return { label: g.inFlight.swapTxHash ? 'swap sent, confirming' : 'sending swap', busy: true };
  if (g.queue?.length) return { label: `${g.queue[0].seed ? 'start-up buy' : g.queue[0].side === 'buy' ? 'buying' : 'selling'}…`, busy: true };
  return { label: 'watching the price', busy: false };
}

/** Price gliding between the next buy (left) and the next sell (right). */
export function LiveLevels({ g, price }: { g: AnyObj; price: number | null }) {
  if (price == null || !g.config) return null;
  const { buy, sell } = nextLevels(g.intervals ?? [], price);
  const st = gridState(g);
  if (buy == null && sell == null) return <div className="levels"><span className={`state ${st.busy ? 'busy' : ''}`}>{st.label}</span></div>;
  const lo = buy ?? price * 0.995, hi = sell ?? price * 1.005;
  const at = Math.max(0, Math.min(100, ((price - lo) / (hi - lo || 1)) * 100));
  return (
    <div className="levels">
      <span className={`state ${st.busy ? 'busy' : ''}`}>{st.label}<Tip>The dot is the live price. The grid buys when it falls to BUY on the left and sells the coins it holds when it rises to SELL on the right. The % is how far away each one is.</Tip></span>
      <div className="lv-row">
        <span className="lv-end buy">{buy != null ? <>BUY {px(buy)} <i>{((1 - buy / price) * 100).toFixed(2)}%↓</i></> : <i>no buy armed</i>}</span>
        <div className="lv-track"><span className="lv-fill" style={{ width: `${at}%` }} /><span className="lv-dot" style={{ left: `${at}%` }} /></div>
        <span className="lv-end sell">{sell != null ? <><i>{((sell / price - 1) * 100).toFixed(2)}%↑</i> SELL {px(sell)}</> : <i>nothing to sell</i>}</span>
      </div>
    </div>
  );
}

/** A liquidity position's range with the price in it. */
export function LiveRange({ b, price }: { b: AnyObj; price: number | null }) {
  const p = b.position;
  if (!p || price == null) return <div className="levels"><span className={`state ${b.step ? 'busy' : ''}`}>{b.step ? `${b.step.action === 'rerange' ? 'moving the range' : b.step.action === 'close' ? 'closing' : 'opening'}…` : b.status}</span></div>;
  const pad = (p.upper - p.lower) * 0.2, lo = p.lower - pad, hi = p.upper + pad;
  const at = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const inside = price >= p.lower && price < p.upper;
  return (
    <div className="levels">
      <span className={`state ${b.step ? 'busy' : inside ? '' : 'out'}`}>{b.step ? 'transaction…' : inside ? 'in range, earning' : 'out of range'}<Tip>The amber band is the position's range and the dot is the live price. It earns a share of every trade's fee while the dot is inside the band.</Tip></span>
      <div className="lv-row">
        <span className="lv-end">{px(p.lower)}</span>
        <div className="lv-track"><span className="lv-band" style={{ left: `${at(p.lower)}%`, width: `${at(p.upper) - at(p.lower)}%` }} /><span className={`lv-dot ${inside ? '' : 'out'}`} style={{ left: `${at(price)}%` }} /></div>
        <span className="lv-end">{px(p.upper)}</span>
      </div>
    </div>
  );
}

// ── Feed ──────────────────────────────────────────────────────────────────
export interface FeedItem {
  key: string; t: number; chainId?: number; bot: string; tone: 'win' | 'loss' | 'neutral' | 'info' | 'warn' | 'error';
  action: string; detail: string; result?: { v: number; sym: string }; open?: View; busy?: boolean;
  /** From a paper bot: simulated, tagged so it never reads as a real trade */
  paper?: boolean;
}

const EVENT_TYPES = new Set(['queued', 'sent', 'skipped', 'error', 'range', 'started', 'stopped', 'signal', 'blocked', 'alert']);

/** Fills from the bots' trade records (exact amounts and results) plus what's happening from the live events. */
export function buildFeed(s: AnyObj, events: ActivityEvent[], limit = 30): FeedItem[] {
  const out: FeedItem[] = [];
  for (const g of s.grids ?? []) {
    const sym = quoteSym(g), base = g.base;
    for (const t of g.trades ?? []) {
      const iv = (g.intervals ?? []).find((i: AnyObj) => i.index === t.intervalIndex);
      const common = { key: `g:${g.id}:${t.id}`, t: t.timestamp, chainId: g.chainId, bot: gridName(g), open: botView('grid', g.id), paper: g.mode === 'paper' };
      if (t.failed) { out.push({ ...common, tone: 'error', action: 'FAILED', detail: `${t.side} didn't go through; only gas was spent`, result: { v: -t.gasQuote, sym } }); continue; }
      if (t.side === 'buy') {
        out.push({ ...common, tone: 'neutral', action: t.seed ? 'START-UP BUY' : 'BOUGHT', detail: `${humanAmount(t.plsAmount)} ${base} @ ${px(t.execPrice ?? t.price)}${t.seed ? ` for ${t.seed.length} levels above the price` : iv ? ` · sells at ${px(iv.sellPrice)}` : ''}` });
      } else {
        const net = t.roundTripNet ?? t.realizedPnlQuote;
        out.push({ ...common, tone: net > 0 ? 'win' : 'loss', action: 'SOLD', detail: `${humanAmount(t.plsAmount)} ${base} @ ${px(t.execPrice ?? t.price)}`, result: { v: net, sym } });
      }
    }
  }
  for (const b of s.trends ?? []) {
    const sym = quoteSym(b);
    for (const t of b.trades ?? []) {
      const common = { key: `t:${b.id}:${t.id}`, t: t.timestamp, chainId: b.chainId, bot: b.name, open: botView('trend', b.id), paper: b.mode === 'paper' };
      if (t.failed) { out.push({ ...common, tone: 'error', action: 'FAILED', detail: `${t.side} didn't go through; only gas was spent` }); continue; }
      out.push(t.side === 'buy'
        ? { ...common, tone: 'neutral', action: 'BOUGHT', detail: `${humanAmount(t.plsAmount)} ${b.base} @ ${px(t.execPrice ?? t.price)}` }
        : { ...common, tone: t.realizedPnlQuote > 0 ? 'win' : 'loss', action: 'SOLD', detail: `${humanAmount(t.plsAmount)} ${b.base} · ${t.reason}`, result: { v: t.realizedPnlQuote, sym } });
    }
  }
  const lpIds = new Set((s.lps ?? []).map((l: AnyObj) => l.id));
  // Event rows are named like trade rows: the bot's pair without the chain suffix (the chain badge shows it)
  const names = new Map<string, string>([...(s.grids ?? []), ...(s.lps ?? [])].map((b: AnyObj) => [b.id, gridName(b)] as [string, string]));
  for (const t of s.trends ?? []) names.set(t.id, t.name);
  const paperIds = new Set([...(s.grids ?? []), ...(s.trends ?? []), ...(s.lps ?? [])].filter((b: AnyObj) => b.mode === 'paper').map((b: AnyObj) => b.id));
  for (const e of events) {
    const lpFill = e.type === 'filled' && e.kind === 'lp';
    const infoWarn = e.type === 'info' && (e.level === 'warn' || e.level === 'error');
    if (!EVENT_TYPES.has(e.type) && !lpFill && !infoWarn) continue;
    const kind = e.kind === 'grid' || e.kind === 'trend' || e.kind === 'lp' ? e.kind : null;
    const tone: FeedItem['tone'] = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'win' : 'info';
    const [who, ...rest] = e.msg.split(': ');
    out.push({
      key: `e:${e.id}`, t: e.t, chainId: e.chainId, bot: (e.botId && names.get(e.botId)) || (rest.length ? who.replace(/^(Grid|Liquidity|Trend) /, '').replace(/·.*/, '') : 'GridBot'), tone,
      action: e.type === 'sent' && kind !== 'lp' ? 'TX SENT' : lpFill ? 'LIQUIDITY' : e.type.toUpperCase(), detail: rest.length ? rest.join(': ') : e.msg,
      busy: e.type === 'queued' || (e.type === 'sent' && kind !== 'lp'), paper: !!e.botId && paperIds.has(e.botId),
      ...(e.botId && kind && (kind !== 'lp' || lpIds.has(e.botId)) ? { open: botView(kind, e.botId) } : {}),
    });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit);
}

/** Feed rows slide in as they arrive; a sold row shows exactly what that trade made or lost. */
export function LiveFeed({ s, items, nav }: { s: AnyObj; items: FeedItem[]; nav: Nav }) {
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current) for (const it of items) if (!seen.current.has(it.key)) fresh.add(it.key);
  useEffect(() => { seen.current = new Set([...(seen.current ?? []), ...items.map((i) => i.key)]); });
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 15_000); return () => clearInterval(i); }, []);
  if (!items.length) return <p className="muted small">Nothing yet. Buys, sells and every transaction appear here the moment they happen.</p>;
  return (
    <ol className="feed" aria-live="polite">
      {items.map((it) => (
        <li key={it.key} className={`fd fd-${it.tone} ${fresh.has(it.key) ? 'fd-new' : ''} ${it.open ? 'fd-link' : ''}`}
          onClick={it.open ? () => nav(it.open!) : undefined} role={it.open ? 'button' : undefined} tabIndex={it.open ? 0 : undefined}
          onKeyDown={it.open ? (e) => { if (e.key === 'Enter') nav(it.open!); } : undefined}>
          <time>{ago(it.t)}</time>
          <span className="fd-bot">{it.chainId ? <ChainBadge c={chainOf(s, it.chainId)} testnet={false} /> : null}{it.bot}{it.paper ? <span className="tag paper-tag">paper</span> : null}</span>
          <span className={`fd-act ${it.busy && Date.now() - it.t < 120_000 ? 'busy' : ''}`}>{it.action}</span>
          <span className="fd-detail">{it.detail}</span>
          {it.result ? <b className={`fd-res ${cls(it.result.v)}`}>{it.result.v > 0 ? '+' : it.result.v < 0 ? '−' : ''}{humanAmount(Math.abs(it.result.v))} {it.result.sym}</b> : <span />}
        </li>
      ))}
    </ol>
  );
}
