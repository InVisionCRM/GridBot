/**
 * Map a /api/bot/status payload (plus activity events) into BotMetrics.
 * Dollars are only emitted when usdPerQuote is present. Token units stay in the coin they were earned in.
 * Missing figures stay null. This file does not read the network or a wallet.
 */
import { gridMetrics, lpMetrics, trendMetrics, type BotMetrics as ServerMetrics } from '../metrics/botMetrics';
import type { ActivityItem, BotDesk, BotMetrics, BotStatus, DeskSnapshot, PortfolioSnapshot, RangeBlock, TapePrice, TokenQty } from './metrics';

type Rec = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function rec(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
}
function rate(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}
function stripSecrets(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{6,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim();
}

export interface ActivityEvent {
  /** The activity bus's own id: unique and the same on every read, so a row keeps its id while the ring moves. */
  id: number;
  t?: number;
  type?: string;
  kind?: string;
  msg?: string;
  botId?: string;
  level?: string;
}

/** Drop the sentences the desk is not allowed to show. The numbers stay on the botMetrics fields. */
function screenCalc(calc: string): string {
  return calc
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/\$|\bAPR\b|\bAPY\b|Unrealized|Realized|Value change/.test(sentence))
    .join(' ');
}

/** The coins put in, from capitalCoins (a liquidity bot funded with both coins lists both). A USD book has none. */
function coinInvested(m: ServerMetrics): TokenQty[] {
  return Object.entries(m.capitalCoins ?? {}).map(([symbol, amount]) => ({ symbol, amount, usd: null }));
}

/** `keepZero` retains an explicit 0, such as a grid with no fills (`{PLS: 0}`). */
function recordTokens(rows: Record<string, number> | null, keepZero = false): TokenQty[] | null {
  if (rows == null) return null;
  return Object.entries(rows)
    .filter(([, amount]) => Number.isFinite(amount) && (keepZero || amount !== 0))
    .map(([symbol, amount]) => ({ symbol, amount, usd: null }));
}

/**
 * Always the botMetrics functions, never a metrics object already on the payload.
 * An old snapshot's attached metrics still has the pre-rebuild Generated.
 */
function metricsOf(raw: Rec, kind: 'grid' | 'lp' | 'trend', asOf: number): ServerMetrics {
  if (kind === 'grid') return gridMetrics(raw, asOf);
  if (kind === 'lp') return lpMetrics(raw, asOf);
  return trendMetrics(raw, asOf);
}

/**
 * Copy the screen fields off botMetrics. Per-coin fee, gas, and range-move rows are not on that
 * object, so those arrays stay empty and the sheet shows the Generated total with a note.
 */
function viewOf(m: ServerMetrics, asOf: number): BotMetrics {
  const pace = (rows: Record<string, number> | null) => (rows == null ? null : recordTokens(rows, true) ?? []);
  return {
    botId: m.botId,
    mode: m.mode === 'live' ? 'live' : 'paper',
    kind: m.kind,
    status: statusOf(m.status),
    startedAt: m.startedAt,
    ageSec: m.ageSec,
    capitalInUsd: m.capitalInUsd,
    currentValueUsd: m.currentValueUsd,
    realizedUsd: m.realizedUsd,
    unrealizedUsd: m.unrealizedUsd,
    feesCollected: [],
    feesOwed: [],
    feesCollectedUsd: m.feesCollectedUsd,
    feesUncollectedUsd: m.feesUncollectedUsd,
    gasUsd: m.gasUsd,
    swapCostUsd: m.swapCostUsd,
    tokenTaxesUsd: m.tokenTaxesUsd,
    realizedRebalanceLossUsd: m.realizedRebalanceLossUsd,
    priceChangeUsd: m.priceChangeUsd,
    generated: recordTokens(m.generated, true) ?? [],
    generatedUsd: m.generatedUsd,
    headline: 'generated',
    totalPnlUsd: m.totalPnlUsd,
    totalPnlPct: m.totalPnlPct,
    aprPct: m.aprPct,
    est: {
      d1: pace(m.generatedRate.d1),
      d7: pace(m.generatedRate.d7),
      d365: pace(m.generatedRate.d365),
      usd: { d1: m.est.d1, d7: m.est.d7, d365: m.est.d365 },
      needs: m.generated == null ? 'No generated figure in this snapshot yet.' : 'Estimate, not a forecast.',
    },
    moveCount: m.moveCount,
    fillCount: m.fillCount,
    range: null,
    asOf,
    calc: screenCalc(m.calc),
    invested: coinInvested(m),
    breakdownByCoin: m.breakdownByCoin,
    breakdownBasis: m.breakdownBasis,
    grossFees: [],
    feesPaid: [],
    moveLoss: [],
  };
}

function withRange(metrics: BotMetrics, base: string, quote: string, range: ServerMetrics['range']): BotMetrics {
  if (!range) return metrics;
  return { ...metrics, range: shownRange(base, quote, range.lower, range.upper, range.current, range.inRange) };
}

interface ChainInfo { short: string; name: string; color: string }

function chainOf(status: Rec, chainId: unknown): ChainInfo {
  const id = num(chainId);
  const chains = Array.isArray(status.chains) ? status.chains : [];
  for (const c of chains) {
    const row = rec(c);
    if (row && num(row.id) === id) {
      const short = str(row.short) || '—';
      return { short, name: str(row.name) || short, color: str(row.color) || '#848E9C' };
    }
  }
  return { short: '—', name: '—', color: '#848E9C' };
}

function statusOf(v: unknown): BotStatus {
  if (v === 'running' || v === 'paused' || v === 'stopped' || v === 'closed') return v;
  return 'stopped';
}

const STABLES = new Set(['USDC', 'USDG', 'USDT', 'DAI', 'USD']);

/** Same flip as the tape: a stable base priced under 1 is shown as quote per base. */
function readsInverted(base: string, quote: string, price: number | null): boolean {
  if (price == null || !(price > 0) || !(price < 1)) return false;
  return STABLES.has(base.toUpperCase()) && !STABLES.has(quote.toUpperCase());
}

/**
 * Range in the orientation the tape uses. Engine bounds are quote per base; a flipped pair
 * shows base per quote, so the ends swap when they are inverted.
 */
function shownRange(base: string, quote: string, lower: number | null, upper: number | null, current: number | null, inRange: boolean | null): RangeBlock | null {
  if (lower == null || upper == null || current == null || !(upper > lower) || !(current > 0)) return null;
  const flip = readsInverted(base, quote, current);
  const lo = flip ? 1 / upper : lower;
  const hi = flip ? 1 / lower : upper;
  const cur = flip ? 1 / current : current;
  if (!(hi > lo)) return null;
  return { lower: lo, upper: hi, current: cur, inRange: inRange ?? (cur >= lo && cur <= hi) };
}

function gridBot(status: Rec, g: Rec, asOf: number): BotDesk {
  const quote = str(g.quoteSym) || str(g.stable) || 'quote';
  const base = str(g.base) || 'base';
  const price = num(g.price);
  const chain = chainOf(status, g.chainId);
  const server = metricsOf(g, 'grid', asOf);
  const metrics = withRange(viewOf(server, asOf), base, quote, server.range);
  const k = rate(g.usdPerQuote);
  const trades = Array.isArray(g.trades) ? g.trades : [];
  let run = 0;
  const spark: number[] = [];
  const sells = trades.map(rec).filter((t): t is Rec => !!t && t.side === 'sell' && t.failed !== true);
  sells.sort((a, b) => (num(a.timestamp) ?? 0) - (num(b.timestamp) ?? 0));
  if (sells.length) spark.push(0);
  for (const t of sells) {
    const leg = num(t.realizedPnlUsd);
    if (leg == null) continue;
    run += k != null ? leg * k : leg;
    spark.push(run);
  }
  return desk(metrics, str(g.label) || `${base}/${quote}`, base, quote, chain, str(g.dexName), price, spark, num(g.feeBps), num(g.priceAt), !!g.archivedAt);
}

function trendBot(status: Rec, t: Rec, asOf: number): BotDesk {
  const quote = str(t.quoteSym) || str(t.quote) || 'quote';
  const base = str(t.base) || 'base';
  const price = num(t.price);
  const chain = chainOf(status, t.chainId);
  const server = metricsOf(t, 'trend', asOf);
  const metrics = viewOf(server, asOf);
  return desk(metrics, str(t.label) || str(t.name) || `${base}/${quote}`, base, quote, chain, str(t.dexName), price, [], num(t.feeBps), num(t.priceAt), !!t.archivedAt);
}

function lpBot(status: Rec, lp: Rec, asOf: number): BotDesk {
  const base = str(lp.base) || 'base';
  const quote = str(lp.quote) || 'quote';
  const price = num(lp.price);
  const chain = chainOf(status, lp.chainId);
  const server = metricsOf(lp, 'lp', asOf);
  const metrics = withRange(viewOf(server, asOf), base, quote, server.range);
  return desk(metrics, str(lp.label) || `${base}/${quote}`, base, quote, chain, str(lp.dexName), price, [], num(lp.feeBps), num(lp.priceAt), !!lp.archivedAt);
}

/** Pair people read, without a chain suffix. A stable base under $1 flips to quote/base. */
function shownPair(base: string, quote: string, price: number | null, label: string): string {
  if (base && quote) {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    if (price != null && price > 0 && price < 1 && STABLES.has(b) && !STABLES.has(q)) return `${quote}/${base}`;
    return `${base}/${quote}`;
  }
  return label.split('·')[0]?.trim() || label || '—';
}

function desk(metrics: BotMetrics, label: string, base: string, quote: string, chain: ChainInfo, dex: string, price: number | null, spark: number[], feeBps: number | null, priceAt: number | null, archived = false): BotDesk {
  const tone = metrics.status !== 'running' ? 'idle'
    : metrics.range == null ? 'idle'
    : metrics.range.inRange ? 'in' : 'out';
  return {
    metrics, pair: shownPair(base, quote, price, label), base, quote, chain: chain.short, chainName: chain.name, chainColor: chain.color, dex: dex || '—',
    tone, spark: spark.length > 1 ? spark : [],
    price, change24h: null, feeBps, priceAt, archived,
  };
}

/** Archived and closed bots stay on the desk, but they are not part of a section total. */
function inSectionTotal(b: BotDesk): boolean {
  return !b.archived && b.metrics.status !== 'closed';
}

function sumUsd(bots: BotDesk[], runningOnlyMissing: boolean): number | null {
  const rows = bots;
  if (runningOnlyMissing && rows.some((b) => b.metrics.status === 'running' && b.metrics.generatedUsd == null)) return null;
  const known = rows.map((b) => b.metrics.generatedUsd).filter((n): n is number => n != null);
  if (!known.length) return null;
  return known.reduce((s, n) => s + n, 0);
}

function perDayUsd(bots: BotDesk[]): number | null {
  const running = bots.filter((b) => b.metrics.status === 'running');
  if (!running.length) return null;
  if (running.some((b) => b.metrics.est.usd.d1 == null)) return null;
  return running.reduce((s, b) => s + (b.metrics.est.usd.d1 ?? 0), 0);
}

function perDayTokens(bots: BotDesk[]): TokenQty[] | null {
  const running = bots.filter((b) => b.metrics.status === 'running');
  if (!running.length) return null;
  if (running.some((b) => b.metrics.est.d1 == null)) return null;
  const map = new Map<string, TokenQty>();
  for (const b of running) {
    for (const t of b.metrics.est.d1 ?? []) {
      const cur = map.get(t.symbol) ?? { symbol: t.symbol, amount: 0, usd: 0 as number | null };
      cur.amount += t.amount;
      if (t.usd == null || cur.usd == null) cur.usd = null;
      else cur.usd += t.usd;
      map.set(t.symbol, cur);
    }
  }
  return [...map.values()].filter((t) => t.amount !== 0);
}

function sumTokens(bots: BotDesk[]): TokenQty[] {
  const map = new Map<string, TokenQty>();
  for (const b of bots) {
    for (const t of b.metrics.generated) {
      const cur = map.get(t.symbol) ?? { symbol: t.symbol, amount: 0, usd: 0 as number | null };
      cur.amount += t.amount;
      if (t.usd == null || cur.usd == null) cur.usd = null;
      else cur.usd += t.usd;
      map.set(t.symbol, cur);
    }
  }
  return [...map.values()].filter((t) => t.amount !== 0);
}

function sumField(bots: BotDesk[], pick: (b: BotDesk) => number | null): number | null {
  const vals = bots.map(pick);
  if (vals.some((v) => v == null)) return null;
  return vals.reduce<number>((s, v) => s + (v ?? 0), 0);
}

function portfolio(bots: BotDesk[], asOf: number): PortfolioSnapshot {
  const live = bots.filter((b) => b.metrics.mode === 'live' && inSectionTotal(b));
  const paper = bots.filter((b) => b.metrics.mode === 'paper' && inSectionTotal(b));
  return {
    asOf,
    generatedUsd: sumUsd(live, true),
    generatedPerDay: perDayTokens(live),
    generatedPerDayUsd: perDayUsd(live),
    paperGeneratedUsd: sumUsd(paper, true),
    tokens: sumTokens(live),
    paperTokens: sumTokens(paper),
    priceChangeUsd: sumField(live.filter((b) => b.metrics.status === 'running'), (b) => b.metrics.priceChangeUsd),
    currentValueUsd: sumField(live.filter((b) => b.metrics.status === 'running'), (b) => b.metrics.currentValueUsd),
    capitalInUsd: sumField(live.filter((b) => b.metrics.status === 'running'), (b) => b.metrics.capitalInUsd),
    feesTodayLiveUsd: null,
    feesTodayPaperUsd: null,
    botsRunning: live.filter((b) => b.metrics.status === 'running').length,
    botsTotal: live.length,
  };
}

/** Engine price is quote per 1 base. The pair text is already conventional; only the price flips. */
function shownPrice(b: BotDesk): number | null {
  const px = b.price;
  if (px == null) return null;
  const base = b.base.toUpperCase();
  const quote = b.quote.toUpperCase();
  const flip = px > 0 && px < 1 && STABLES.has(base) && !STABLES.has(quote);
  return flip ? 1 / px : px;
}

function feeText(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/**
 * One row per pool. Several bots on the same pair, chain, fee, and DEX share a price:
 * a running bot beats a stopped one, live beats paper, and a newer read wins a tie.
 * A second pool on that pair is labeled with its fee, or the DEX when the fees match.
 */
function deskPrices(bots: BotDesk[]): TapePrice[] {
  type Cand = { symbol: string; chain: string; price: number; feeBps: number | null; dex: string; rank: number; priceAt: number };
  const best = new Map<string, Cand>();
  for (const b of bots) {
    const price = shownPrice(b);
    if (price == null) continue;
    const symbol = b.pair;
    const chain = b.chain === '—' ? '' : b.chain;
    const dex = b.dex === '—' ? '' : b.dex;
    const key = `${symbol}|${chain}|${b.feeBps ?? ''}|${dex}`;
    const rank = (b.metrics.status === 'running' ? 2 : 0) + (b.metrics.mode === 'live' ? 1 : 0);
    const priceAt = b.priceAt ?? 0;
    const prev = best.get(key);
    if (prev && (rank < prev.rank || (rank === prev.rank && priceAt < prev.priceAt))) continue;
    best.set(key, { symbol, chain, price, feeBps: b.feeBps, dex, rank, priceAt });
  }
  const rows = [...best.values()];
  return rows.map((row) => {
    const siblings = rows.filter((r) => r.symbol === row.symbol && r.chain === row.chain);
    let fee: string | null = null;
    if (siblings.length > 1) {
      const fees = new Set(siblings.map((s) => s.feeBps));
      fee = fees.size > 1 && row.feeBps != null ? feeText(row.feeBps) : (row.dex || null);
    }
    return { symbol: row.symbol, chain: row.chain, price: row.price, change24h: null, fee };
  });
}

/** Log lines say `USDC/ETH·ETH`. The chain already has a badge, so the suffix comes off. */
function withoutChainSuffix(text: string, chain: string): string {
  if (!chain || chain === '—') return text;
  return text.split(`·${chain}`).join('');
}

function activityOf(events: ActivityEvent[], names: Map<string, { pair: string; chain: string }>): ActivityItem[] {
  const want = new Set(['filled', 'range', 'queued']);
  const items: ActivityItem[] = [];
  for (const e of events) {
    if (!e || !want.has(e.type ?? '')) continue;
    const named = names.get(str(e.botId));
    const text = withoutChainSuffix(stripSecrets(str(e.msg)), named?.chain ?? '');
    if (!text) continue;
    const t = num(e.t);
    if (t == null) continue;
    const kind = e.type === 'range' ? 'recenter' : e.type === 'filled' && /fee/i.test(text) ? 'fee' : 'fill';
    const tone = e.level === 'success' ? 'up' : e.level === 'warn' || e.level === 'error' ? 'down' : 'flat';
    items.push({
      id: `a${e.id}`,
      t,
      botId: str(e.botId),
      pair: named?.pair ?? '',
      chain: named?.chain ?? '',
      kind,
      text,
      tone,
    });
  }
  items.sort((a, b) => b.t - a.t);
  return items.slice(0, 48);
}

export function adaptStatus(status: Rec, events: ActivityEvent[] = [], asOf = num(status.spotsAt) ?? Date.now(), source: DeskSnapshot['source'] = 'snapshot'): DeskSnapshot {
  const grids = (Array.isArray(status.grids) ? status.grids : []).map(rec).filter((g): g is Rec => !!g);
  const lps = (Array.isArray(status.lps) ? status.lps : []).map(rec).filter((g): g is Rec => !!g);
  const trends = (Array.isArray(status.trends) ? status.trends : []).map(rec).filter((g): g is Rec => !!g);
  const bots = [
    ...grids.map((g) => gridBot(status, g, asOf)),
    ...lps.map((lp) => lpBot(status, lp, asOf)),
    ...trends.map((t) => trendBot(status, t, asOf)),
  ];
  const rank = (b: BotDesk) => (b.metrics.status === 'running' ? 0 : 1) + (b.metrics.mode === 'live' ? 0 : 2);
  bots.sort((a, b) => rank(a) - rank(b) || Math.abs(b.metrics.generatedUsd ?? 0) - Math.abs(a.metrics.generatedUsd ?? 0));
  return {
    source,
    portfolio: portfolio(bots, asOf),
    bots,
    prices: deskPrices(bots),
    activity: activityOf(events, new Map(bots.map((b) => [b.metrics.botId, { pair: b.pair, chain: b.chain }]))),
  };
}
