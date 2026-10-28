/**
 * The UI's reading of a bot status object for "Generated, net of costs" in token units. The definitions themselves live in
 * the shared, framework-free `src/shared/generated.ts` (byte-identical with the v2 desk's copy, #48): this file only maps
 * the status JSON onto it and adds what the classic screens need (Invested, a share of it, sums and text). No prices,
 * no dollars.
 *
 * - LP: base = pnl.feeCoins.base, quote = pnl.feeCoins.quote − (pnl.gas + pnl.swapCost + pnl.moveLoss); without
 *   feeCoins, pnl.net in the quote coin (shared lpParts).
 * - Grid and trend: pnl.realized in the quote coin, already net of the pool fee and gas (src/live/ledger.ts applySell,
 *   src/server/bot/engine.ts recordFill/recordFailure, src/server/bot/trend.ts).
 * - Token trader / sniper: no token-unit generated field yet: null.
 */
import { generatedTokens, type GeneratedBot } from '../shared/generated';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the status objects are untyped JSON from the API
type AnyObj = Record<string, any>;

export interface TokenQty { symbol: string; amount: number }
export type GeneratedBasis = 'lp-fee-coins' | 'lp-net' | 'grid-realized' | 'trend-realized';
export interface Generated { tokens: TokenQty[]; basis: GeneratedBasis }

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sym = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

/** The quote coin's symbol as the server sends it per bot kind. */
export function quoteSymbolOf(b: AnyObj): string {
  return sym(b.quoteSym ?? (b.kind === 'lp' ? b.quote : undefined) ?? b.stable ?? b.quote, 'quote');
}

/** The status object as the shared module's input. */
export function toGeneratedBot(b: AnyObj): GeneratedBot | null {
  const p = b?.pnl;
  if (!p || typeof p !== 'object') return null;
  if (b.kind === 'lp') {
    return { kind: 'lp', base: sym(b.base, 'base'), quote: quoteSymbolOf(b), feeCoins: p.feeCoins ?? null, gas: n(p.gas), swapCost: n(p.swapCost), moveLoss: n(p.moveLoss), netQuote: n(p.net) };
  }
  if (b.kind === 'grid' || b.kind === 'trend') return { kind: b.kind, quote: quoteSymbolOf(b), realized: n(p.realized) };
  return null;
}

/**
 * Generated, net of costs, in token units (shared generatedTokens). Null when the bot has no such field (token trader,
 * sniper) or no figures yet. Zero amounts are left out, so a bot that has generated nothing has an empty list.
 */
export function generatedOf(b: AnyObj): Generated | null {
  const g = toGeneratedBot(b);
  if (!g) return null;
  if (g.kind === 'lp' && !g.feeCoins && g.netQuote == null) return null;
  if (g.kind !== 'lp' && g.realized == null) return null;
  const basis: GeneratedBasis = g.kind === 'lp' ? (g.feeCoins ? 'lp-fee-coins' : 'lp-net') : g.kind === 'grid' ? 'grid-realized' : 'trend-realized';
  return { tokens: generatedTokens(g), basis };
}

/**
 * What was put in, in the quote coin: grid config.totalCapitalUsd (quote units despite the name), trend capital, LP
 * startValue or config.capital, a token trader's or sniper's `spent` (in the coin it spends).
 */
export function investedOf(b: AnyObj): TokenQty | null {
  const v = b.kind === 'grid' ? n(b.config?.totalCapitalUsd)
    : b.kind === 'trend' ? n(b.capital)
    : b.kind === 'lp' ? (n(b.startValue) ?? n(b.config?.capital))
    : b.kind === 'trader' || b.kind === 'sniper' ? n(b.spent)
    : null;
  return v == null ? null : { symbol: quoteSymbolOf(b), amount: v };
}

/** The generated amount in the quote coin when it is one coin or none (grid, trend, LP without fee coins); null otherwise. */
export function generatedInQuote(g: Generated | null): number | null {
  if (!g || g.tokens.length > 1) return null;
  return g.tokens[0]?.amount ?? 0;
}

/**
 * The Generated figure (the same tokens the Generated column and the LP headline show) as one amount in the quote coin,
 * for Gen. %, Est. APR and sorting. Grid and trend: already one quote-coin amount. LP: the quote part plus the base part
 * valued at the pool's price now (`b.price`, quote per base); without a price, null when there is a base part.
 * Never the engine's separate pnl.net, so a share can't disagree with the tokens beside it.
 */
export function generatedValueInQuote(b: AnyObj): number | null {
  const g = generatedOf(b);
  if (!g) return null;
  if (b.kind !== 'lp') return generatedInQuote(g);
  const base = sym(b.base, 'base');
  const price = n(b.price);
  let v = 0;
  for (const t of g.tokens) {
    if (t.symbol === base && t.symbol !== quoteSymbolOf(b)) {
      if (price == null || !(price > 0)) return null;
      v += t.amount * price;
    } else v += t.amount;
  }
  return v;
}

/** What Gen. % says about how it is worked out (a tooltip): an LP's base coin is valued at today's pool price. */
export function generatedPctNote(b: AnyObj): string {
  return b.kind === 'lp'
    ? `Generated ÷ Invested. The ${sym(b.base, 'base')} part of Generated is valued in ${quoteSymbolOf(b)} at the pool's price now.`
    : 'Generated ÷ Invested, both in the same coin.';
}

/** Generated as a share of what was put in: generatedValueInQuote ÷ invested (both in the quote coin). */
export function generatedPct(b: AnyObj): number | null {
  const inv = investedOf(b);
  if (!inv || !(inv.amount > 0)) return null;
  const v = generatedValueInQuote(b);
  return v == null ? null : v / inv.amount;
}

/**
 * Gen. % as shown (Kyle, #73): null — shown as "—" — when it rounds to 0.0%, so a near-zero share never reads as a figure
 * ("0.0%", "−0.0%"). Sorting and Est. APR keep the exact generatedPct.
 */
export function shownGeneratedPct(b: AnyObj): number | null {
  const x = generatedPct(b);
  return x == null || Math.abs(x) < 0.0005 ? null : x;
}

/** Add token amounts by symbol, keeping first-seen order. */
export function sumTokens(lists: (TokenQty[] | null | undefined)[]): TokenQty[] {
  const out = new Map<string, number>();
  for (const l of lists) for (const t of l ?? []) out.set(t.symbol, (out.get(t.symbol) ?? 0) + t.amount);
  return [...out].map(([symbol, amount]) => ({ symbol, amount }));
}

/**
 * A total across bots that never repeats one bot's figure: only coins that two or more of the lists have. A coin only one
 * bot counts in is that bot's own figure, already on its row (each figure once per screen).
 */
export function sharedTotals(lists: (TokenQty[] | null | undefined)[]): TokenQty[] {
  const seen = new Map<string, number>();
  for (const l of lists) for (const sym of new Set((l ?? []).map((t) => t.symbol))) seen.set(sym, (seen.get(sym) ?? 0) + 1);
  return sumTokens(lists).filter((t) => (seen.get(t.symbol) ?? 0) >= 2);
}

const fmtAmt = (x: number, sig: number) => Number(Math.abs(x).toPrecision(sig)).toLocaleString(undefined, { maximumFractionDigits: 10 });
/**
 * Amounts in their coins: "0.02 SPY + 26.1 USDG"; signed: "+0.02 SPY · −853.9 USDG" (a dot between, so a sign never
 * follows a plus). Empty list: "—".
 */
export function formatTokens(tokens: readonly TokenQty[] | null | undefined, sign = true, sig = 5): string {
  if (!tokens || !tokens.length) return '—';
  return tokens.map((t) => `${sign ? (t.amount >= 0 ? '+' : '−') : t.amount < 0 ? '−' : ''}${fmtAmt(t.amount, sig)} ${t.symbol}`).join(sign ? ' · ' : ' + ');
}

/**
 * A sum in words: "0.02 SPY + 26.1 USDG", "0.0001657 NVDA − 1.405 USDG" (a minus instead of "+ −"); the first amount
 * carries a sign only when it is negative. Empty list: "—".
 */
export function formatTokenSum(tokens: readonly TokenQty[] | null | undefined, sig = 4): string {
  if (!tokens || !tokens.length) return '—';
  return tokens.map((t, i) => `${i === 0 ? (t.amount < 0 ? '−' : '') : t.amount < 0 ? ' − ' : ' + '}${fmtAmt(t.amount, sig)} ${t.symbol}`).join('');
}
