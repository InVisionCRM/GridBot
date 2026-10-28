/**
 * Map a /api/bot/status payload (plus activity events) into BotMetrics.
 * Dollars are only emitted when usdPerQuote is present. Token units stay in the coin they were earned in.
 * Missing figures stay null. This file does not read the network or a wallet.
 */
import type { ActivityItem, BotDesk, BotKind, BotMetrics, BotMode, BotStatus, DeskSnapshot, EstimateBlock, PortfolioSnapshot, RangeBlock, TokenQty } from './metrics';

const DAY = 86_400;
/** 24h needs ~28 min, 7d ~3.2h, 365d 30 days. A week of history is not a year. */
const MIN_AGE = { d1: 28 * 60, d7: 3.2 * 3600, d365: 30 * DAY };
const WIN = { d1: DAY, d7: 7 * DAY, d365: 365 * DAY };

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
function mul(q: number | null, k: number | null): number | null {
  if (q == null || k == null) return null;
  return q * k;
}
/** One rounding for every headline dollar, so a sum cannot disagree with its parts. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}
function centsOrNull(n: number | null): number | null {
  return n == null ? null : cents(n);
}
function qty(symbol: string, amount: number | null, usd: number | null): TokenQty | null {
  if (!symbol || amount == null) return null;
  return { symbol, amount, usd };
}
function keep(rows: (TokenQty | null)[]): TokenQty[] {
  return rows.filter((r): r is TokenQty => r != null && r.amount !== 0);
}

function stripSecrets(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{6,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim();
}

export interface ActivityEvent {
  t?: number;
  type?: string;
  kind?: string;
  msg?: string;
  botId?: string;
  level?: string;
}

function ageOf(startedAt: number | null, asOf: number): number | null {
  if (startedAt == null || startedAt <= 0 || startedAt > asOf) return null;
  return (asOf - startedAt) / 1000;
}

function estimates(age: number | null, tokens: TokenQty[], usd: number | null): EstimateBlock {
  if (usd == null && !tokens.length) {
    return {
      d1: null, d7: null, d365: null,
      usd: { d1: null, d7: null, d365: null },
      needs: 'No generated figure in this snapshot yet.',
    };
  }
  const one = (min: number, window: number) => {
    if (age == null || !(age >= min) || !(age > 0)) return { tokens: null as TokenQty[] | null, usd: null as number | null };
    const f = window / age;
    return {
      tokens: tokens.map((t) => ({ symbol: t.symbol, amount: t.amount * f, usd: t.usd == null ? null : t.usd * f })),
      usd: usd == null ? null : cents(usd * f),
    };
  };
  const d1 = one(MIN_AGE.d1, WIN.d1);
  const d7 = one(MIN_AGE.d7, WIN.d7);
  const d365 = one(MIN_AGE.d365, WIN.d365);
  const waiting = [d1, d7, d365].some((e) => e.tokens == null);
  return {
    d1: d1.tokens,
    d7: d7.tokens,
    d365: d365.tokens,
    usd: { d1: d1.usd, d7: d7.usd, d365: d365.usd },
    needs: waiting ? 'Day, week and year results appear once the bot has run that long.' : '',
  };
}

/** Age gate matches D1. A known fill count also needs two samples, so one fill cannot print a yearly figure. */
function apr(generatedUsd: number | null, capital: number | null, ageSec: number | null, samples: number | null): number | null {
  if (generatedUsd == null || capital == null || !(capital > 0)) return null;
  if (ageSec == null || ageSec < MIN_AGE.d1) return null;
  if (samples != null && samples < 2) return null;
  return generatedUsd / capital;
}

function blankCalc(kind: BotKind): string {
  if (kind === 'lp') return 'Generated = fees in each coin, with gas, swap fees and rebalance loss taken out of the quote coin. Dollars are the engine net × the quote price. Taxes are not in this payload.';
  return 'Generated = realized trade profit in the quote coin (already net of pool fees and gas). Taxes and a separate swap fee are not in this payload.';
}

interface ChainInfo { short: string; color: string }

function chainOf(status: Rec, chainId: unknown): ChainInfo {
  const id = num(chainId);
  const chains = Array.isArray(status.chains) ? status.chains : [];
  for (const c of chains) {
    const row = rec(c);
    if (row && num(row.id) === id) return { short: str(row.short) || '—', color: str(row.color) || '#848E9C' };
  }
  return { short: '—', color: '#848E9C' };
}

function modeOf(v: unknown): BotMode {
  return v === 'live' ? 'live' : 'paper';
}
function statusOf(v: unknown): BotStatus {
  if (v === 'running' || v === 'paused' || v === 'stopped' || v === 'closed') return v;
  return 'stopped';
}

function rangeBlock(lower: number | null, upper: number | null, current: number | null, inRange: boolean | null): RangeBlock | null {
  if (lower == null || upper == null || current == null || !(upper > lower)) return null;
  const inside = inRange ?? (current >= lower && current <= upper);
  return { lower, upper, current, inRange: inside };
}

function shell(partial: Omit<BotMetrics, 'est' | 'aprPct' | 'totalPnlUsd' | 'totalPnlPct' | 'headline' | 'generatedUsd'> & { generated: TokenQty[]; generatedUsd: number | null }, samples: number | null): BotMetrics {
  const generatedUsd = centsOrNull(partial.generatedUsd);
  const totalPnlUsd = generatedUsd != null && partial.priceChangeUsd != null
    ? generatedUsd + partial.priceChangeUsd
    : null;
  const totalPnlPct = totalPnlUsd != null && partial.capitalInUsd != null && partial.capitalInUsd > 0
    ? totalPnlUsd / partial.capitalInUsd
    : null;
  return {
    ...partial,
    generatedUsd,
    headline: 'generated',
    totalPnlUsd,
    totalPnlPct,
    aprPct: apr(generatedUsd, partial.capitalInUsd, partial.ageSec, samples),
    est: estimates(partial.ageSec, partial.generated, generatedUsd),
  };
}

function gridBot(status: Rec, g: Rec, asOf: number): BotDesk {
  const k = rate(g.usdPerQuote);
  const quote = str(g.quoteSym) || str(g.stable) || 'quote';
  const base = str(g.base) || 'base';
  const pnl = rec(g.pnl);
  const stats = rec(g.stats);
  const cfg = rec(g.config);
  const realizedQ = num(pnl?.realized);
  const unrealQ = num(pnl?.unrealized);
  const feesQ = num(stats?.totalFees);
  const gasUsd = num(pnl?.gasUsd);
  const capitalQ = num(cfg?.totalCapitalUsd);
  const price = num(g.price);
  const startedAt = num(g.startedAt);
  const generatedUsd = mul(realizedQ, k);
  const generated = keep([qty(quote, realizedQ, generatedUsd)]);
  const chain = chainOf(status, g.chainId);
  const lower = num(cfg?.lowerPrice);
  const upper = num(cfg?.upperPrice);
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
  const metrics = shell({
    botId: str(g.id),
    mode: modeOf(g.mode),
    kind: 'grid',
    status: statusOf(g.status),
    startedAt,
    ageSec: ageOf(startedAt, asOf),
    capitalInUsd: mul(capitalQ, k),
    currentValueUsd: mul(capitalQ != null && realizedQ != null && unrealQ != null ? capitalQ + realizedQ + unrealQ : null, k),
    realizedUsd: centsOrNull(generatedUsd),
    unrealizedUsd: mul(unrealQ, k),
    feesCollected: keep([qty(quote, feesQ, mul(feesQ, k))]),
    feesOwed: [],
    feesCollectedUsd: mul(feesQ, k),
    feesUncollectedUsd: stats ? 0 : null,
    gasUsd,
    swapCostUsd: null,
    tokenTaxesUsd: null,
    realizedRebalanceLossUsd: null,
    priceChangeUsd: mul(unrealQ, k),
    generated,
    generatedUsd,
    moveCount: num(g.moveCount),
    fillCount: num(stats?.roundTrips),
    range: rangeBlock(lower, upper, price, null),
    asOf,
    calc: blankCalc('grid'),
  }, num(stats?.roundTrips) ?? (trades.length ? trades.map(rec).filter((t) => t && t.failed !== true).length : null));
  return desk(metrics, str(g.label) || `${base}/${quote}`, base, quote, chain, str(g.dexName), price, spark);
}

function lpBot(status: Rec, lp: Rec, asOf: number): BotDesk {
  const k = rate(lp.usdPerQuote);
  const base = str(lp.base) || 'base';
  const quote = str(lp.quote) || 'quote';
  const pnl = rec(lp.pnl);
  const price = num(lp.price);
  const startedAt = num(lp.startedAt);
  const capitalQ = num(lp.startValue) ?? num(rec(lp.config)?.capital);
  const chain = chainOf(status, lp.chainId);
  const pos = rec(lp.position);
  const totals = rec(lp.totals);
  const owed = rec(lp.owed);
  const feeCoins = rec(pnl?.feeCoins);
  const collectedCoins = rec(totals?.feeCoins);
  let generated: TokenQty[] = [];
  let generatedUsd: number | null = null;
  let priceChangeUsd: number | null = null;
  let gasUsd: number | null = null;
  let swapUsd: number | null = null;
  let moveUsd: number | null = null;
  let feesCollected: TokenQty[] = [];
  let feesOwed: TokenQty[] = [];
  let feesCollectedUsd: number | null = null;
  let feesUncollectedUsd: number | null = null;
  if (pnl && num(pnl.net) != null) {
    const net = num(pnl.net);
    generatedUsd = mul(net, k);
    priceChangeUsd = mul(num(pnl.price), k);
    gasUsd = mul(num(pnl.gas), k);
    swapUsd = mul(num(pnl.swapCost), k);
    moveUsd = mul(num(pnl.moveLoss), k);
    const costs = (num(pnl.gas) ?? 0) + (num(pnl.swapCost) ?? 0) + (num(pnl.moveLoss) ?? 0);
    const baseAmt = num(feeCoins?.base);
    const quoteAmt = num(feeCoins?.quote);
    const baseUsd = baseAmt != null && price != null ? mul(baseAmt * price, k) : null;
    const quoteNet = quoteAmt == null ? null : quoteAmt - costs;
    generated = keep([
      qty(base, baseAmt, baseUsd),
      qty(quote, quoteNet, mul(quoteNet, k)),
    ]);
    if (!generated.length && net != null) generated = keep([qty(quote, net, generatedUsd)]);
    const cBase = num(collectedCoins?.base);
    const cQuote = num(collectedCoins?.quote);
    feesCollected = keep([
      qty(base, cBase, cBase != null && price != null ? mul(cBase * price, k) : null),
      qty(quote, cQuote, mul(cQuote, k)),
    ]);
    feesCollectedUsd = mul(num(totals?.fees), k);
    const oBase = num(owed?.base);
    const oQuote = num(owed?.quote);
    feesOwed = keep([
      qty(base, oBase, oBase != null && price != null ? mul(oBase * price, k) : null),
      qty(quote, oQuote, mul(oQuote, k)),
    ]);
    const owedQuoteValue = oBase != null && oQuote != null && price != null ? oBase * price + oQuote : null;
    feesUncollectedUsd = mul(owedQuoteValue, k);
  }
  const valueQ = num(lp.value) ?? num(pnl?.equity);
  const inRange = typeof lp.inRange === 'boolean' ? lp.inRange : null;
  const metrics = shell({
    botId: str(lp.id),
    mode: modeOf(lp.mode),
    kind: 'lp',
    status: statusOf(lp.status),
    startedAt,
    ageSec: ageOf(startedAt, asOf),
    capitalInUsd: mul(capitalQ, k),
    currentValueUsd: mul(valueQ, k),
    realizedUsd: null,
    unrealizedUsd: priceChangeUsd,
    feesCollected,
    feesOwed,
    feesCollectedUsd,
    feesUncollectedUsd,
    gasUsd,
    swapCostUsd: swapUsd,
    tokenTaxesUsd: null,
    realizedRebalanceLossUsd: moveUsd,
    priceChangeUsd,
    generated,
    generatedUsd,
    moveCount: num(lp.reranges),
    fillCount: null,
    range: rangeBlock(num(pos?.lower), num(pos?.upper), price, inRange),
    asOf,
    calc: blankCalc('lp'),
  }, null);
  return desk(metrics, str(lp.label) || `${base}/${quote}`, base, quote, chain, str(lp.dexName), price, []);
}

const STABLES = new Set(['USDC', 'USDG', 'USDT', 'DAI', 'USD']);

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

function desk(metrics: BotMetrics, label: string, base: string, quote: string, chain: ChainInfo, dex: string, price: number | null, spark: number[]): BotDesk {
  const tone = metrics.status !== 'running' ? 'idle'
    : metrics.range == null ? 'idle'
    : metrics.range.inRange ? 'in' : 'out';
  return {
    metrics, pair: shownPair(base, quote, price, label), base, quote, chain: chain.short, chainColor: chain.color, dex: dex || '—',
    tone, spark: spark.length > 1 ? spark : [], levels: [], candles: [], fills: [], flashLevel: null,
    price, change24h: null,
  };
}

function sumUsd(bots: BotDesk[], runningOnlyMissing: boolean): number | null {
  const rows = bots;
  if (runningOnlyMissing && rows.some((b) => b.metrics.status === 'running' && b.metrics.generatedUsd == null)) return null;
  const known = rows.map((b) => b.metrics.generatedUsd).filter((n): n is number => n != null);
  if (!known.length) return null;
  return cents(known.reduce((s, n) => s + n, 0));
}

function perDayUsd(bots: BotDesk[]): number | null {
  const running = bots.filter((b) => b.metrics.status === 'running');
  if (!running.length) return null;
  if (running.some((b) => b.metrics.est.usd.d1 == null)) return null;
  return cents(running.reduce((s, b) => s + (b.metrics.est.usd.d1 ?? 0), 0));
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
  const live = bots.filter((b) => b.metrics.mode === 'live');
  const paper = bots.filter((b) => b.metrics.mode === 'paper');
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
    botsRunning: bots.filter((b) => b.metrics.status === 'running').length,
    botsTotal: bots.length,
    madeSeries: [],
  };
}

/** Engine price is quote per 1 base. The pair text is already conventional; only the price flips. */
function tapeOf(b: BotDesk): { symbol: string; chain: string; price: number | null; change24h: null } {
  const px = b.price;
  const base = b.base.toUpperCase();
  const quote = b.quote.toUpperCase();
  const flip = px != null && px > 0 && px < 1 && STABLES.has(base) && !STABLES.has(quote);
  return { symbol: b.pair, chain: b.chain === '—' ? '' : b.chain, price: flip && px ? 1 / px : px, change24h: null };
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
      id: `a${t}-${items.length}`,
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
  const bots = [...grids.map((g) => gridBot(status, g, asOf)), ...lps.map((lp) => lpBot(status, lp, asOf))];
  const rank = (b: BotDesk) => (b.metrics.status === 'running' ? 0 : 1) + (b.metrics.mode === 'live' ? 0 : 2);
  bots.sort((a, b) => rank(a) - rank(b) || Math.abs(b.metrics.generatedUsd ?? 0) - Math.abs(a.metrics.generatedUsd ?? 0));
  return {
    source,
    portfolio: portfolio(bots, asOf),
    bots,
    prices: bots.filter((b) => b.price != null).map(tapeOf),
    activity: activityOf(events, new Map(bots.map((b) => [b.metrics.botId, { pair: b.pair, chain: b.chain }]))),
  };
}
