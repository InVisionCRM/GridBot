/**
 * One set of money figures per bot. The server attaches it to every bot in /api/bot/status (and
 * /api/bot/:id/metrics); every UI surface reads these fields and does no P&L / ROI math of its own.
 *
 * HEADLINE (HEADLINE below): units GENERATED per token, net of the costs charged in that token.
 *  - LP: fees collected (Collect events) + fees owed (the position manager's collect() quote = tokensOwed + feeGrowth),
 *    per coin, minus gas (in the native coin's side), swap fees (in the coin swapped in) and range-move losses (in the
 *    coin the rebalance swap sells), each at the price of its event.
 *  - Grid / trend / token trader: realized round-trip profit (pool fees, gas and token taxes already netted) in the
 *    coin the bot accrues it in. Open lots are not in it; they are Unrealized.
 *  generatedUsd = Σ units × today's mid price. Rates, the 24h/7d/365d estimates and APR scale it linearly.
 *
 * Total P&L = current value + paid out − gas not already in the value − capital in. Price change = Total − Generated,
 * so Generated + Price change = Total P&L by construction; tests recompute both sides from raw inputs.
 *
 * Quote-coin figures are converted once with usdPerQuote (grid capital is in the quote coin despite its legacy name
 * `totalCapitalQuote`). No rate → the dollar fields are null, never quote-as-dollars. Estimates need the history to be at
 * least window / MAX_SCALE long (365d needs 7d, 7d ~3.2h, 24h ~28 min); until then they are null with a `needs` hint.
 */

import { isCloseOut } from '../live/ledger';

export const MIN_AGE_MS = 60_000;
export const DAY_MS = 86_400_000;
/** Never stretch the sample more than this many times: 365d needs a week of history, 7d ~3.2h, 24h ~28 min. */
export const MAX_SCALE = 365 / 7;

export type MetricsKind = 'grid' | 'trend' | 'lp' | 'token';
export type Headline = 'generated';
/** What the bot header leads with (confirmed by the lead): units generated, per token. */
export const HEADLINE: Headline = 'generated';

type Needs = { d1: string | null; d7: string | null; d30: string | null; d365: string | null };

export interface BotMetrics {
  botId: string;
  mode: 'live' | 'paper';
  kind: MetricsKind;
  status: string | null;
  startedAt: number | null;
  ageSec: number | null;
  headline: Headline;
  /** HEADLINE: net units per token symbol. */
  generated: Record<string, number> | null;
  /** Σ generated units × today's mid price. */
  generatedUsd: number | null;
  /** Units per day / week / year at the pace so far (simple); null + `needs` until the history is long enough. */
  generatedRate: { d1: Record<string, number> | null; d7: Record<string, number> | null; d30: Record<string, number> | null; d365: Record<string, number> | null; needs: Needs };
  capitalInUsd: number | null;
  currentValueUsd: number | null;
  /** Fees / profits / sale proceeds that left the bot. */
  paidOutUsd: number | null;
  realizedUsd: number | null;
  /** Open lots (grid / trend / token) or the LP's price side (pnl.price). Expander only. */
  unrealizedUsd: number | null;
  /** Total P&L − generatedUsd: unrealized IL + the inventory's market move. Expander only. */
  priceChangeUsd: number | null;
  /** Event-priced dollars: LP fees − gas − swap fees − taxes − realized rebalance loss; others realized profit. */
  dollarsMadeUsd: number | null;
  feesEarnedUsd: number | null;
  feesCollectedUsd: number | null;
  feesUncollectedUsd: number | null;
  gasUsd: number | null;
  swapCostUsd: number | null;
  /** LP: value lost at range moves vs the coins put in. Grid / trend / token: losing round trips (already in realized). */
  realizedRebalanceLossUsd: number | null;
  /** Fee-on-transfer haircut seen on fills (already in realized). Null where the bot does not record it. */
  tokenTaxesUsd: number | null;
  totalPnlUsd: number | null;
  totalPnlPct: number | null;
  /** generatedUsd / capitalInUsd, annualized simply; null until 7 days of history. */
  aprPct: number | null;
  /** generatedUsd scaled to 24h / 7d / 30d / 365d (dollars). 30d needs ~13.8h of history (30d ÷ 365/7). */
  est: { d1: number | null; d7: number | null; d30: number | null; d365: number | null; needs: Needs };
  moveCount: number | null;
  fillCount: number | null;
  range: { lower: number; upper: number; current: number | null; inRange: boolean | null } | null;
  asOf: number;
  calc: string;
  /**
   * Cross-chain moves (hook; bridging itself is not built). Bridge fees, gas on both chains and slippage of a move this
   * bot triggered, each converted at its event's price into the coin the bot generates in and already deducted from
   * `generated`. Null when the bot has no bridge events.
   */
  bridgeCosts: { events: number; units: Record<string, number>; usdAtEvents: number } | null;
  /** Funds of this bot reserved for a cross-chain move that hasn't landed (one "In transit" holdings line). Null = none. */
  inTransitUsd: number | null;
  /** Extra: the same totals in the quote coin (the "show in quote coin" toggle and detail KPIs). */
  quote: {
    symbol: string | null; usdPerQuote: number | null; capitalIn: number | null; currentValue: number | null; totalPnl: number | null; realized: number | null; unrealized: number | null; feesEarned: number | null;
    /** Generated valued in the quote coin at today's mid (generatedUsd ÷ usdPerQuote; a coin-only bot: its quote-coin units). */
    generatedValue: number | null;
    /** totalPnl − generatedValue (the quote-coin twin of priceChangeUsd). */
    priceChange: number | null;
    /** Event-priced: the quote-coin twin of dollarsMadeUsd. */
    made: number | null;
    paidOut: number | null; gas: number | null; swapCost: number | null; rebalanceLoss: number | null;
  };
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * One cost of a cross-chain move, charged to the bot that triggered it (hook for GridBot Bridge & Swap). `units` is
 * the cost already converted, at the event's price, into `coin`, the coin the bot generates in.
 */
export interface BridgeCostEvent {
  at: number;
  kind: 'bridgeFee' | 'gasSource' | 'gasDestination' | 'slippage';
  coin: string;
  units: number;
  usdAtEvent: number;
  txHash?: string;
}

/** A status payload's bridge events (`bridge.costs`) → per-coin units to deduct and their dollar total at event time. */
export function bridgeCostsOf(b: Obj): BotMetrics['bridgeCosts'] {
  const ev = (Array.isArray(b?.bridge?.costs) ? b.bridge.costs : []) as BridgeCostEvent[];
  const ok = ev.filter((e) => e && typeof e.coin === 'string' && num(e.units) != null);
  if (!ok.length) return null;
  const units: Record<string, number> = {};
  for (const e of ok) units[e.coin] = (units[e.coin] ?? 0) + e.units;
  return { events: ok.length, units, usdAtEvents: ok.reduce((a, e) => a + (num(e.usdAtEvent) ?? 0), 0) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Linear (simple, not compounded) extrapolation; null when the sample is too short for the window. */
export function extrapolate(amount: number, invested: number, age: number, windowMs: number): { amount: number; pct: number | null } | null {
  if (!(age >= MIN_AGE_MS) || !(windowMs > 0) || !Number.isFinite(amount)) return null;
  if (windowMs / age > MAX_SCALE) return null;
  const out = amount * (windowMs / age);
  if (!Number.isFinite(out)) return null;
  const pct = invested > 0 && Number.isFinite(invested) ? (amount / invested) * (windowMs / age) : null;
  return { amount: out, pct: pct != null && Number.isFinite(pct) ? pct : null };
}

/** Shortest history an estimate over `windowMs` needs: 365d → 7d, 7d → ~3.2h, 24h → ~28 min (never under a minute). */
export function estNeedMs(windowMs: number): number {
  return Math.max(MIN_AGE_MS, windowMs / MAX_SCALE);
}

function fmtNeed(ms: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (ms >= DAY_MS) return `${trim(ms / DAY_MS)}d`;
  if (ms >= 3_600_000) return `${trim(ms / 3_600_000)}h`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "needs 7d of history" while the bot is too young for the window; null once there is enough. */
export function estHint(age: number | null, windowMs: number): string | null {
  const need = estNeedMs(windowMs);
  if (age != null && age >= need) return null;
  return `needs ${fmtNeed(need)} of history`;
}

/** Milliseconds since start. Null when the start time is missing or in the future. */
export function ageMs(startedAt: number | null | undefined, now: number): number | null {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 || startedAt > now) return null;
  return now - startedAt;
}

const RATES = 'The 24h/7d/30d/365d estimates are Generated ÷ age × the days, per coin, and APR (Generated ÷ capital in, annualized) scales it the same way: linear, not compounded; they need 28 min / 3.2h / 13.8h / 7d of history.';
const GENERATED_CALC: Record<MetricsKind, string> = {
  lp: 'Generated = fees collected + fees still in the position, per coin, minus costs: gas (charged to the native coin), swap fees (in the coin swapped in) and range-move losses (in the coin the move sold, locked in at each move).',
  grid: 'Generated = profit from completed buy → sell round trips after pool fees, gas and token taxes, in the coin the grid accrues it in: the quote coin it spends. The coin it "stacks" is inventory, shown under Open positions. A close / stop cash-out sale is not a round trip; its result is in Price change.',
  trend: 'Generated = profit from closed trades after pool fees and gas, in the quote coin. An open trade is under Open positions.',
  token: 'Generated = profit from closed sells, in dollars (positions spend different coins). Open positions are not in it.',
};
const TOTAL_CALC: Record<MetricsKind, string> = {
  grid: 'Total P&L = coins held at today\'s price + profits paid out − capital in. Price change = Total P&L − Generated.',
  trend: 'Total P&L = cash + position at today\'s price − capital in. Price change = Total P&L − Generated.',
  lp: 'Total P&L = position + waiting fees + idle coins at today\'s price + fees sent out − gas − start value. Price change = Total P&L − Generated (impermanent loss not yet locked in + the coins\' market move).',
  token: 'Total P&L = open positions at what a sell would get now + sale proceeds − buys. Price change = Total P&L − Generated.',
};

interface Core {
  kind: MetricsKind; id: string; mode: 'live' | 'paper'; status: string | null; startedAt: number | null;
  /** quote-coin figures (token trader: dollars with k = 1) */
  capitalIn: number | null; currentValue: number | null; paidOut: number; extraCost: number;
  realized: number | null; unrealized: number | null;
  feesEarned: number | null; feesCollected: number | null; feesUncollected: number | null; gas: number | null; swapCost: number | null;
  moveCount: number | null; fillCount: number | null; range: BotMetrics['range']; k: number | null; symbol: string | null;
  /** units per token, and each token's dollar price now (mid) */
  generated: Record<string, number> | null; px: Record<string, number | null>;
  dollarsMade: number | null; rebalanceLoss: number | null; taxes: number | null;
  bridge?: BotMetrics['bridgeCosts']; inTransitUsd?: number | null;
}

/** Σ units × price; null if any non-zero leg has no price. */
export function unitsUsd(gen: Record<string, number> | null, px: Record<string, number | null>): number | null {
  if (!gen) return null;
  let sum = 0;
  for (const [sym, u] of Object.entries(gen)) {
    if (u === 0) continue;
    const p = px[sym];
    if (p == null) return null;
    sum += u * p;
  }
  return sum;
}

function finish(c: Core, now: number): BotMetrics {
  c = { ...c };
  const usd = (q: number | null) => (q == null || c.k == null ? null : q * c.k);
  const total = c.capitalIn == null || c.currentValue == null ? null : c.currentValue + c.paidOut - c.extraCost - c.capitalIn;
  const totalUsd = usd(total);
  const capUsd = usd(c.capitalIn);
  const pct = total != null && c.capitalIn != null && c.capitalIn > 0 ? total / c.capitalIn : null;
  const age = ageMs(c.startedAt, now);
  // Cross-chain move costs come off the coins generated (hook; empty until bridging exists).
  const bridge = c.bridge ?? null;
  const generated = c.generated && bridge
    ? Object.fromEntries([...new Set([...Object.keys(c.generated), ...Object.keys(bridge.units)])].map((k) => [k, (c.generated![k] ?? 0) - (bridge.units[k] ?? 0)]))
    : c.generated;
  c = { ...c, generated };
  const genUsd = unitsUsd(c.generated, c.px);
  // Generated in the quote coin: its dollar value ÷ the quote coin's price; with no dollar price, only a bot whose
  // Generated is all in the quote coin has one (its units).
  const genOnlyQuote = c.generated && c.symbol != null && Object.entries(c.generated).every(([s, u]) => s === c.symbol || u === 0);
  const genQuote = genUsd != null && c.k != null && c.k > 0 ? genUsd / c.k : genOnlyQuote ? (c.generated![c.symbol!] ?? 0) : null;
  const est = (w: number) => (genUsd == null || age == null ? null : extrapolate(genUsd, capUsd ?? 0, age, w));
  const need = (w: number): string | null => (genUsd == null && !c.generated ? null : estHint(age, w));
  const rateOf = (w: number) => (!c.generated || age == null || !extrapolate(1, 0, age, w) ? null
    : Object.fromEntries(Object.entries(c.generated).map(([s, u]) => [s, u * (w / age)])));
  const needs = { d1: need(DAY_MS), d7: need(7 * DAY_MS), d30: need(30 * DAY_MS), d365: need(365 * DAY_MS) };
  const y = est(365 * DAY_MS);
  return {
    botId: c.id, mode: c.mode, kind: c.kind, status: c.status, startedAt: c.startedAt, ageSec: age == null ? null : Math.floor(age / 1000),
    headline: HEADLINE,
    generated: c.generated, generatedUsd: genUsd,
    generatedRate: { d1: rateOf(DAY_MS), d7: rateOf(7 * DAY_MS), d30: rateOf(30 * DAY_MS), d365: rateOf(365 * DAY_MS), needs },
    capitalInUsd: capUsd, currentValueUsd: usd(c.currentValue), paidOutUsd: usd(c.paidOut),
    realizedUsd: usd(c.realized), unrealizedUsd: usd(c.unrealized),
    priceChangeUsd: totalUsd == null || genUsd == null ? null : totalUsd - genUsd,
    dollarsMadeUsd: usd(c.dollarsMade),
    feesEarnedUsd: usd(c.feesEarned), feesCollectedUsd: usd(c.feesCollected), feesUncollectedUsd: usd(c.feesUncollected),
    gasUsd: usd(c.gas), swapCostUsd: usd(c.swapCost),
    realizedRebalanceLossUsd: usd(c.rebalanceLoss), tokenTaxesUsd: usd(c.taxes),
    totalPnlUsd: totalUsd, totalPnlPct: totalUsd == null ? null : pct,
    aprPct: y?.pct ?? null,
    est: { d1: est(DAY_MS)?.amount ?? null, d7: est(7 * DAY_MS)?.amount ?? null, d30: est(30 * DAY_MS)?.amount ?? null, d365: y?.amount ?? null, needs },
    moveCount: c.moveCount, fillCount: c.fillCount, range: c.range, asOf: now,
    bridgeCosts: bridge, inTransitUsd: c.inTransitUsd ?? null,
    calc: `${GENERATED_CALC[c.kind]} ${RATES} ${TOTAL_CALC[c.kind]}`,
    quote: {
      symbol: c.symbol, usdPerQuote: c.k, capitalIn: c.capitalIn, currentValue: c.currentValue, totalPnl: total, realized: c.realized, unrealized: c.unrealized, feesEarned: c.feesEarned,
      generatedValue: genQuote, priceChange: total == null || genQuote == null ? null : total - genQuote,
      made: c.dollarsMade, paidOut: c.paidOut, gas: c.gas, swapCost: c.swapCost, rebalanceLoss: c.rebalanceLoss,
    },
  };
}

const rate = (b: Obj) => { const k = num(b.usdPerQuote); return k != null && k > 0 ? k : null; };
const modeOf = (b: Obj): 'live' | 'paper' => (b.mode === 'live' ? 'live' : 'paper');
const inside = (lower: number, upper: number, p: number | null) => (p == null ? null : p >= lower && p <= upper);

/** Of-which figures from a trade log (already inside realized): losing round trips and token-tax haircuts. */
function tradeCosts(trades: unknown): { rebalanceLoss: number | null; taxes: number | null } {
  if (!Array.isArray(trades)) return { rebalanceLoss: null, taxes: null };
  let loss = 0, tax = 0;
  for (const t of trades as Obj[]) {
    if (t.failed || isCloseOut(t as never)) continue;
    const rt = num(t.roundTripNet);
    if (rt != null && rt < 0) loss -= rt;
    const tp = num(t.taxPct), amt = num(t.stableAmount);
    if (tp != null && tp > 0 && amt != null) tax += amt * tp;
  }
  return { rebalanceLoss: loss, taxes: tax };
}

/** Grid status (engine.status() + usdPerQuote). All grid amounts are in the quote coin. */
export function gridMetrics(b: Obj, now = Date.now()): BotMetrics {
  const cap = num(b.config?.totalCapitalQuote);
  const realized = num(b.pnl?.realized), unrealized = num(b.pnl?.unrealized);
  const sent = num(b.payout?.sent) ?? 0;
  const equity = cap == null ? null : cap + (realized ?? 0) + (unrealized ?? 0);
  const fills = num(b.moveCount), rec = num(b.recenter?.count);
  const lo = num(b.config?.lowerPrice), hi = num(b.config?.upperPrice), price = num(b.price);
  // Round-trip profit lands in the quote coin: engine.ts applySell → realized; reinvest adds it to the level's next buy
  // and send mode pays it out, both in the quote. The base the grid "stacks" is inventory (Unrealized).
  const sym = String(b.quoteSym ?? b.stable ?? 'quote');
  // Generated = completed round trips (minus gas lost on failed / manual trades). A close / stop cash-out sale is a
  // liquidation at the day's price, so it is in Total P&L (price change) but not here. Older payloads: realized.
  const gen = num(b.stats?.generated) ?? realized;
  return finish({
    kind: 'grid', id: String(b.id), mode: modeOf(b), status: b.status ?? null, startedAt: num(b.startedAt),
    capitalIn: cap, currentValue: equity == null ? null : equity - sent, paidOut: sent, extraCost: 0,
    realized, unrealized, feesEarned: null, feesCollected: null, feesUncollected: null,
    gas: num(b.stats?.totalGas), swapCost: num(b.stats?.totalFees),
    moveCount: fills == null && rec == null ? null : (fills ?? 0) + (rec ?? 0), fillCount: fills,
    range: lo != null && hi != null && hi > lo ? { lower: lo, upper: hi, current: price, inRange: inside(lo, hi, price) } : null,
    k: rate(b), symbol: sym,
    generated: gen == null ? null : { [sym]: gen }, px: { [sym]: rate(b) },
    dollarsMade: gen, ...tradeCosts(b.trades), bridge: bridgeCostsOf(b),
  }, now);
}

export function trendMetrics(b: Obj, now = Date.now()): BotMetrics {
  const cap = num(b.capital);
  const realized = num(b.pnl?.realized), unrealized = num(b.pnl?.unrealized);
  const equity = num(b.pnl?.equity) ?? (cap == null ? null : cap + (realized ?? 0) + (unrealized ?? 0));
  const n = num(b.moveCount);
  const sym = String(b.quoteSym ?? b.quote ?? 'quote');
  return finish({
    kind: 'trend', id: String(b.id), mode: modeOf(b), status: b.status ?? null, startedAt: num(b.startedAt),
    capitalIn: cap, currentValue: equity, paidOut: 0, extraCost: 0,
    realized, unrealized, feesEarned: null, feesCollected: null, feesUncollected: null,
    gas: num(b.pnl?.gas), swapCost: num(b.pnl?.fees),
    moveCount: n, fillCount: n, range: null, k: rate(b), symbol: sym,
    generated: realized == null ? null : { [sym]: realized }, px: { [sym]: rate(b) },
    dollarsMade: realized, ...tradeCosts(b.trades), bridge: bridgeCostsOf(b),
  }, now);
}

type Coins = { base: number; quote: number };
const coinsOf = (c: unknown): Coins | null => {
  const o = c as Obj | null;
  return o && num(o.base) != null && num(o.quote) != null ? { base: o.base, quote: o.quote } : null;
};

/**
 * LP units: fee coins minus each cost in the coin it was paid in (totals.gasCoins / swapCoins / moveCoins, booked at
 * each event's price). State saved before that bookkeeping existed has only the quote-valued total; that part is
 * charged to the quote coin.
 */
export function lpGenerated(b: Obj): { generated: Record<string, number> | null; px: Record<string, number | null> } {
  const baseSym = String(b.base ?? 'base'), quoteSym = String(b.quote ?? 'quote');
  const k = rate(b), price = num(b.price);
  const px: Record<string, number | null> = { [baseSym]: price != null && k != null ? price * k : null, [quoteSym]: k };
  // A closed bot has no reading (pnl null) and nothing owed: its fees are what it collected.
  const fees = coinsOf(b.pnl?.feeCoins) ?? (lpClosed(b) ? coinsOf(b.totals?.feeCoins) : null);
  if (!fees) return { generated: null, px };
  const t = b.totals ?? {};
  const cost = (c: unknown, total: unknown): Coins => {
    const got = coinsOf(c);
    return got ?? { base: 0, quote: num(total) ?? 0 };
  };
  const g = cost(t.gasCoins, t.gas), sw = cost(t.swapCoins, t.swapCost), mv = cost(t.moveCoins, t.moveLoss);
  return {
    generated: { [baseSym]: fees.base - g.base - sw.base - mv.base, [quoteSym]: fees.quote - g.quote - sw.quote - mv.quote },
    px,
  };
}

/** Closed, nothing open: its figures come from the totals and the idle coins at the exit price. */
const lpClosed = (b: Obj) => !b.pnl && !b.position && b.status === 'closed' && !!b.totals;

/** pnl() of a closed LP (no reading any more): same formulas, value = idle coins at the exit price. */
function closedLpPnl(b: Obj): Obj | null {
  if (!lpClosed(b)) return null;
  const t = b.totals, idle = coinsOf(b.idle), price = num(b.price), start = num(b.startValue);
  if (!idle || price == null || start == null) return null;
  const fees = num(t.fees) ?? 0, gas = num(t.gas) ?? 0, swapCost = num(t.swapCost) ?? 0, moveLoss = num(t.moveLoss) ?? 0, sent = num(t.sent) ?? 0;
  const value = idle.base * price + idle.quote;
  const net = fees - gas - swapCost - moveLoss, equity = value + sent - gas;
  return { equity, value, fees, gas, swapCost, moveLoss, net, price: equity - start - net, feeCoins: t.feeCoins };
}

/** LP status (lpEngine.status()). `pnl` is LpEngine.pnl(): equity = value + sent − gas. */
export function lpMetrics(b: Obj, now = Date.now()): BotMetrics {
  const start = num(b.startValue) ?? num(b.config?.capital);
  const closed = closedLpPnl(b);
  const p = b.pnl ?? closed;
  const sent = num(b.totals?.sent) ?? 0, gas = num(b.totals?.gas) ?? num(p?.gas);
  // status() carries `value`; an older payload only has pnl.equity (= value + sent − gas), so undo that.
  const eq = num(p?.equity);
  const value = num(b.value) ?? num(closed?.value) ?? (eq == null ? null : eq - sent + (gas ?? 0));
  const price = num(b.price);
  const owed = b.owed && price != null ? (num(b.owed.base) ?? 0) * price + (num(b.owed.quote) ?? 0) : null;
  const lo = num(b.position?.lower), hi = num(b.position?.upper);
  const n = num(b.reranges);
  return finish({
    kind: 'lp', id: String(b.id), mode: modeOf(b), status: b.status ?? null, startedAt: num(b.startedAt),
    capitalIn: start, currentValue: p ? value : null, paidOut: sent, extraCost: gas ?? 0,
    realized: num(p?.net), unrealized: num(p?.price),
    feesEarned: num(p?.fees), feesCollected: num(b.totals?.fees), feesUncollected: owed,
    gas, swapCost: num(b.totals?.swapCost) ?? num(p?.swapCost),
    moveCount: n, fillCount: null,
    range: lo != null && hi != null && hi > lo ? { lower: lo, upper: hi, current: price, inRange: typeof b.inRange === 'boolean' ? b.inRange : inside(lo, hi, price) } : null,
    k: rate(b), symbol: b.quote ?? null,
    ...lpGenerated(b), dollarsMade: num(p?.net), rebalanceLoss: num(b.totals?.moveLoss) ?? num(p?.moveLoss), taxes: null,
    bridge: bridgeCostsOf(b),
  }, now);
}

/** Token trader (TokenTrader state): dollars throughout. Buys are capital in, sells are paid out. */
export function tokenMetrics(t: Obj, now = Date.now()): BotMetrics {
  const trades = (t.trades ?? []) as Obj[];
  const positions = (t.positions ?? []) as Obj[];
  const bought = trades.filter((x) => x.side === 'buy').reduce((s, x) => s + (num(x.usd) ?? 0), 0);
  const sold = trades.filter((x) => x.side === 'sell').reduce((s, x) => s + (num(x.usd) ?? 0), 0);
  const realized = trades.filter((x) => x.side === 'sell').reduce((s, x) => s + (num(x.pnlUsd) ?? 0), 0);
  const unrealized = positions.reduce((s, x) => s + (num(x.pnlUsd) ?? 0), 0);
  const openCost = positions.reduce((s, x) => s + (num(x.spentUsd) ?? 0) * ((num(x.entryTokens) ?? 0) > 0 ? (num(x.tokens) ?? 0) / x.entryTokens : 0), 0);
  const firstT = trades.reduce((m, x) => (num(x.t) != null && (m == null || x.t < m) ? x.t : m), null as number | null);
  return finish({
    kind: 'token', id: String(t.id ?? 'token-trader'), mode: t.options?.mode === 'live' ? 'live' : 'paper', status: t.on ? 'running' : 'stopped', startedAt: firstT,
    capitalIn: trades.length ? bought : null, currentValue: trades.length ? openCost + unrealized : null, paidOut: sold, extraCost: 0,
    realized, unrealized, feesEarned: null, feesCollected: null, feesUncollected: null, gas: null, swapCost: null,
    moveCount: trades.length, fillCount: trades.length, range: null, k: 1, symbol: 'USD',
    // positions spend different coins and the log is in dollars, so the units are dollars
    generated: trades.length ? { USD: realized } : null, px: { USD: 1 },
    dollarsMade: trades.length ? realized : null,
    rebalanceLoss: trades.filter((x) => x.side === 'sell' && (num(x.pnlUsd) ?? 0) < 0).reduce((a, x) => a - x.pnlUsd, 0), taxes: null,
  }, now);
}

export function botMetrics(b: Obj, now = Date.now()): BotMetrics | null {
  if (b?.kind === 'grid') return gridMetrics(b, now);
  if (b?.kind === 'trend') return trendMetrics(b, now);
  if (b?.kind === 'lp') return lpMetrics(b, now);
  if (b?.kind === 'token' || b?.kind === 'trader' || b?.kind === 'sniper') return tokenMetrics(b, now);
  return null;
}
