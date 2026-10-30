/**
 * The home board's data, from the status payloads only (no invented prices). Units first; a dollar figure only where
 * the bot's own quote price gives one.
 *
 *  - Open: what is in the market now and how close it is to paying. A grid level bought (close = how far the price has
 *    come from its buy towards its sell), a liquidity range (close = how near an edge it is, when it moves on its own,
 *    since a move collects its fees), a trend position (no fixed target: close 0), a coin the token trader holds (close
 *    = the gain towards its next take-profit).
 *  - Banked: profits that landed. Grid and trend round trips (roundTripNet), liquidity fee collections, token trader
 *    sells.
 *  - Ladders: each grid's levels, which are holding, and the price.
 *  - Funnel: the token trader's counts for today and the last coin each stage decided on.
 */
import { EXIT } from '../market/tokenTrader';
import { quoteSym, type AnyObj } from './model';

export type Mode = 'live' | 'paper';
export interface Amount { sym: string; amt: number }

export interface OpenItem {
  key: string; botId: string; kind: 'grid' | 'lp' | 'trend' | 'token';
  sym: string; title: string; sub: string;
  /** 0 = just opened, 1 = at its target */
  close: number;
  /** What it pays at its target (grid: one round trip), or what it holds now (liquidity fees waiting, open result) */
  value: Amount[];
  usd: number | null;
}
export interface BankedItem { key: string; botId: string; kind: OpenItem['kind']; sym: string; title: string; sub: string; t: number; amounts: Amount[]; usd: number | null }
export interface Ladder { botId: string; title: string; base: string; quote: string; prices: number[]; holding: boolean[]; price: number | null; lastSold: number | null }
export interface FunnelView {
  scouted: number; rules: number; checks: number; buy: number; bought: number;
  last: Partial<Record<'rules' | 'checks' | 'buy' | 'bought', { label: string; why: string; t: number }>>;
}

/** Point at which an open item counts as almost there */
export const ALMOST = 0.8;
const clamp = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ofMode = (b: AnyObj, mode: Mode) => (b.mode === 'live' ? 'live' : 'paper') === mode;

/** Dollars per coin a bot knows: its quote coin, and its base coin at its own price */
function usdPer(b: AnyObj, sym: string): number | null {
  const k = num(b.usdPerQuote);
  if (!k) return null;
  if (sym === quoteSym(b)) return k;
  const p = num(b.price);
  return sym === b.base && p != null ? p * k : null;
}
const usdOf = (b: AnyObj, amounts: Amount[]): number | null => {
  let s = 0;
  for (const a of amounts) { const k = usdPer(b, a.sym); if (k == null) return null; s += a.amt * k; }
  return s;
};
const pairTitle = (b: AnyObj) => `${b.base}/${quoteSym(b)}`;

export function openItems(bots: AnyObj[], trader: AnyObj | null, mode: Mode): OpenItem[] {
  const out: OpenItem[] = [];
  for (const b of bots.filter((x) => ofMode(x, mode) && x.status !== 'closed')) {
    const q = String(quoteSym(b) ?? ''), price = num(b.price);
    if (b.kind === 'grid' && price != null) {
      const fee = (num(b.feeBps) ?? 0) / 10_000;
      for (const iv of (b.intervals ?? []) as AnyObj[]) {
        if (iv.status !== 'holding') continue;
        const pay = iv.plsAmount * iv.sellPrice * (1 - fee) - (num(iv.buyAmount) ?? 0);
        const value = [{ sym: q, amt: pay }];
        const away = iv.sellPrice / price - 1;
        out.push({
          key: `${b.id}:${iv.index}`, botId: b.id, kind: 'grid', sym: String(b.base), title: `${pairTitle(b)} · level ${iv.index + 1}`,
          sub: away > 0 ? `sells at ${iv.sellPrice.toPrecision(5)} · ${(away * 100).toFixed(2)}% away` : `sells at ${iv.sellPrice.toPrecision(5)} · selling`,
          close: clamp((price - iv.buyPrice) / (iv.sellPrice - iv.buyPrice)), value, usd: usdOf(b, value),
        });
      }
    } else if (b.kind === 'lp' && b.position && price != null) {
      const lo = num(b.position.lower), hi = num(b.position.upper);
      if (lo == null || hi == null || !(hi > lo)) continue;
      const inside = price >= lo && price <= hi, edge = inside ? Math.min(price - lo, hi - price) / ((hi - lo) / 2) : 0;
      const value = [{ sym: String(b.base), amt: num(b.owed?.base) ?? 0 }, { sym: q, amt: num(b.owed?.quote) ?? 0 }].filter((a) => a.amt !== 0);
      const moves = b.config?.rerange !== false;
      out.push({
        key: `${b.id}:lp`, botId: b.id, kind: 'lp', sym: String(b.base), title: `${pairTitle(b)} · liquidity`,
        sub: !inside ? (moves ? 'outside · moving to the price' : 'outside · not earning') : `${Math.round(edge * 100)}% from the edge · earning`,
        close: moves ? clamp(1 - edge) : 0, value, usd: usdOf(b, value),
      });
    } else if (b.kind === 'trend' && b.position && price != null) {
      const r = num(b.position.unrealizedPct), value = [{ sym: q, amt: num(b.position.unrealized) ?? 0 }];
      out.push({
        key: `${b.id}:trend`, botId: b.id, kind: 'trend', sym: String(b.base), title: `${pairTitle(b)} · trend`,
        sub: `${r == null ? '—' : `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(2)}%`} · exits on its signal`, close: 0, value, usd: usdOf(b, value),
      });
    }
  }
  for (const p of (trader?.positions ?? []) as AnyObj[]) {
    if ((p.mode === 'live' ? 'live' : 'paper') !== mode) continue;
    const pct = num(p.pnlPct), target = p.tp1Done ? EXIT.tp2 : EXIT.tp1, spend = String(p.spendSym ?? p.label?.split('/').pop() ?? '');
    const value = num(p.pnl) != null ? [{ sym: spend, amt: p.pnl as number }] : [];
    out.push({
      key: `tt:${p.id}`, botId: 'token-trader', kind: 'token', sym: String(p.label?.split('/')[0] ?? '?'), title: `$${p.label?.split('/')[0] ?? '?'}`,
      sub: `${pct == null ? '—' : `${pct >= 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%`} · takes profit at +${Math.round(target * 100)}%`,
      close: pct == null ? 0 : clamp(pct / target), value, usd: num(p.pnlUsd),
    });
  }
  return out;
}

export function bankedItems(bots: AnyObj[], trader: AnyObj | null, mode: Mode): BankedItem[] {
  const out: BankedItem[] = [];
  for (const b of bots.filter((x) => ofMode(x, mode))) {
    const q = String(quoteSym(b) ?? '');
    if (b.kind === 'grid' || b.kind === 'trend') {
      for (const t of (b.trades ?? []) as AnyObj[]) {
        const net = num(t.roundTripNet);
        if (t.side !== 'sell' || t.failed || net == null) continue;
        const amounts = [{ sym: q, amt: net }], cost = num(t.lotCost);
        out.push({
          key: `${b.id}:${t.id ?? t.timestamp}`, botId: b.id, kind: b.kind, sym: String(b.base), title: `${pairTitle(b)} · ${b.kind}`,
          sub: b.kind === 'grid' && t.intervalIndex != null
            ? `sold level ${t.intervalIndex + 1}${cost ? ` · ${net >= 0 ? '+' : '−'}${Math.abs((net / cost) * 100).toFixed(2)}%` : ''}`
            : `closed${cost ? ` · ${net >= 0 ? '+' : '−'}${Math.abs((net / cost) * 100).toFixed(2)}%` : ''}`,
          t: t.timestamp, amounts, usd: usdOf(b, amounts),
        });
      }
    } else if (b.kind === 'lp') {
      for (const c of (b.collections ?? []) as AnyObj[]) {
        const amounts = [{ sym: String(b.base), amt: c.base }, { sym: q, amt: c.quote }].filter((a) => a.amt !== 0);
        out.push({
          key: `${b.id}:fees:${c.t}`, botId: b.id, kind: 'lp', sym: String(b.base), title: `${pairTitle(b)} · liquidity`,
          sub: c.why === 'moved' ? 'fees collected on a range move' : c.why === 'closed' ? 'fees collected at the close' : c.why === 'compounded' ? 'fees compounded back in' : 'fees sent out',
          t: c.t, amounts, usd: usdOf(b, amounts),
        });
      }
    }
  }
  for (const t of (trader?.trades ?? []) as AnyObj[]) {
    if ((t.mode === 'live' ? 'live' : 'paper') !== mode || t.side !== 'sell' || num(t.pnl) == null) continue;
    const sym = String(t.label?.split('/')[0] ?? '?');
    out.push({
      key: `tt:${t.t}:${t.pool}`, botId: 'token-trader', kind: 'token', sym, title: `$${sym}`, sub: String(t.why ?? 'sold'),
      t: t.t, amounts: [{ sym: String(t.spendSym ?? t.label?.split('/').pop() ?? ''), amt: t.pnl }], usd: num(t.pnlUsd),
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

export function ladders(bots: AnyObj[], mode: Mode): Ladder[] {
  return bots.filter((b) => b.kind === 'grid' && ofMode(b, mode) && b.status !== 'closed' && (b.intervals ?? []).length).map((b) => {
    const iv = (b.intervals as AnyObj[]).slice().sort((x, y) => x.buyPrice - y.buyPrice);
    const sold = ((b.trades ?? []) as AnyObj[]).find((t) => t.side === 'sell' && !t.failed);
    return {
      botId: b.id, title: pairTitle(b), base: String(b.base), quote: String(quoteSym(b) ?? ''),
      prices: [...iv.map((x) => x.buyPrice as number), iv[iv.length - 1].sellPrice as number],
      holding: iv.map((x) => x.status === 'holding'), price: num(b.price), lastSold: sold?.intervalIndex ?? null,
    };
  });
}

export function funnelOf(trader: AnyObj | null): FunnelView | null {
  const f = trader?.funnel;
  if (!f) return null;
  const last: FunnelView['last'] = {};
  for (const it of (trader!.feed ?? []) as AnyObj[]) {
    const k = it.verdict === 'bought' ? 'bought' : it.stage;
    if (!k || last[k as keyof FunnelView['last']]) continue;
    last[k as keyof FunnelView['last']] = { label: String(it.label), why: String(it.why), t: it.t };
  }
  return { scouted: f.scouted, rules: f.rules, checks: f.checks, buy: f.buy, bought: f.bought, last };
}

/** Profits banked in [from, now], cumulative in dollars, oldest first: the hero chart (items without a price are left out) */
export function bankedCurve(items: BankedItem[], from: number): { t: number; v: number; item: BankedItem }[] {
  let v = 0;
  return items.filter((i) => i.t >= from && i.usd != null).sort((a, b) => a.t - b.t).map((item) => ({ t: item.t, v: (v += item.usd!), item }));
}
