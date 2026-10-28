/**
 * A screen shows each money or token figure once.
 * Cards that would restate the hero or the section total say so in words.
 */
import type { BotMetrics, RangeBlock, TapePrice, TokenQty } from './metrics';
import { estimates } from '../shared/generated';
import { formatAge, formatAmt, formatFixedAmt, formatRangePx, formatTokenLine, ledgerDecimals, showsNoFills } from './format';

const SUBSCRIPT_PRICE = /\$0\.0[₀₁₂₃₄₅₆₇₈₉]+\d+/g;
const FIGURE = /[+−-]?\s*\$\d[\d,]*(?:\.\d+)?|[+−-]\s*\d[\d,]*(?:\.\d+)?[kMB]?\s+[A-Z][A-Z0-9]*|[+−-]?\d+(?:\.\d+)?%/g;

export function figureAtoms(text: string): string[] {
  const subscripts: string[] = [];
  const rest = text.replace(SUBSCRIPT_PRICE, (m) => { subscripts.push(m); return ' '; });
  return [...subscripts, ...(rest.match(FIGURE) ?? [])];
}

/** Compare figures ignoring a display plus and the spaces formatTokenLine inserts. A leading minus stays. */
export function normFigure(raw: string): string {
  return raw.replace(/\s+/g, '').replace(/^−/, '-').replace(/^\+/, '');
}

export function repeatedFigures(text: string): string[] {
  const counts = new Map<string, number>();
  for (const atom of figureAtoms(text)) {
    const key = normFigure(atom);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([key]) => key);
}

export function coverFigures(text: string, used: Set<string>) {
  for (const atom of figureAtoms(text)) used.add(normFigure(atom));
}

function tokenKey(t: TokenQty, scale?: ReadonlyMap<string, number> | null): string {
  const decimals = scale?.get(t.symbol);
  const amt = decimals == null ? formatAmt(t.amount) : formatFixedAmt(t.amount, decimals);
  return normFigure(`${amt} ${t.symbol}`);
}

export function rangeWords(range: RangeBlock | null): string {
  if (!range) return 'No range';
  return range.inRange ? 'In range' : 'Out of range';
}

export type CardReadout =
  | { kind: 'empty' }
  | { kind: 'note'; text: string }
  | { kind: 'figures'; tokens: TokenQty[]; usd: string | null };

/**
 * What a card may say without repeating a figure already on the screen.
 * `used` is updated with whatever this card actually displays.
 */
export function cardReadout(
  metrics: BotMetrics,
  sectionTokens: TokenQty[],
  scope: 'live' | 'paper',
  used: Set<string>,
  scale?: ReadonlyMap<string, number> | null,
  sectionScale?: ReadonlyMap<string, number> | null,
): CardReadout {
  if (showsNoFills(metrics)) return { kind: 'empty' };
  const line = formatTokenLine(metrics.generated, scale);
  const sectionLine = formatTokenLine(sectionTokens, sectionScale ?? scale);
  if (line !== '—' && sectionLine !== '—' && normFigure(line) === normFigure(sectionLine)) {
    return { kind: 'note', text: `All of the ${scope} total` };
  }
  const tokens = metrics.generated.filter((t) => !used.has(tokenKey(t, scale)));
  if (!tokens.length) return { kind: 'note', text: rangeWords(metrics.range) };
  for (const t of tokens) used.add(tokenKey(t, scale));
  return { kind: 'figures', tokens, usd: null };
}

export function uniqueTape(prices: TapePrice[]): TapePrice[] {
  const seen = new Set<string>();
  const out: TapePrice[] = [];
  for (const p of prices) {
    const key = `${p.symbol}|${p.chain}|${p.fee ?? ''}|${p.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function heroFigureText(m: BotMetrics): string {
  if (showsNoFills(m)) return '';
  const scale = coinScale(m);
  const day = estimates(m.generated, m.ageSec).perDay;
  return [
    ledgerLines(m)?.generated || formatTokenLine(m.generated, scale),
    formatBagSafe(m.invested),
    day ? formatTokenLine(day, scale) : '',
  ].join(' ');
}

function formatBagSafe(tokens: TokenQty[]): string {
  return tokens.map((t) => tokenKey(t)).join(' ');
}

export interface SheetRow { label: string; value: string }

export interface LedgerLines {
  /** Fees in the coins costs come out of. */
  gross: string;
  feeLabel: string;
  paid: string;
  move: string;
  generated: string;
  /** Plain sentence for coins that have fees and no costs. */
  untouched: string;
}

function amountOf(tokens: TokenQty[], symbol: string): number {
  return tokens.find((t) => t.symbol === symbol)?.amount ?? 0;
}

function ledgerLine(entries: { symbol: string; amount: number; decimals: number }[]): string {
  const shown = entries.filter((e) => formatFixedAmt(e.amount, e.decimals) !== '0');
  if (!shown.length) return '';
  return formatTokenLine(shown, new Map(shown.map((e) => [e.symbol, e.decimals])));
}

function coinList(symbols: string[]): string {
  if (symbols.length <= 1) return symbols[0] ?? '';
  if (symbols.length === 2) return `${symbols[0]} and ${symbols[1]}`;
  return `${symbols.slice(0, -1).join(', ')}, and ${symbols[symbols.length - 1]}`;
}

function ledgerScale(m: BotMetrics): Map<string, number> | null {
  if (!m.grossFees.length && !m.feesPaid.length && !m.moveLoss.length) return null;
  const symbols = [...new Set([
    ...m.grossFees.map((t) => t.symbol),
    ...m.feesPaid.map((t) => t.symbol),
    ...m.moveLoss.map((t) => t.symbol),
    ...m.generated.map((t) => t.symbol),
  ])];
  const scale = new Map<string, number>();
  for (const symbol of symbols) {
    scale.set(symbol, ledgerDecimals(
      amountOf(m.grossFees, symbol),
      Math.abs(amountOf(m.feesPaid, symbol)),
      Math.abs(amountOf(m.moveLoss, symbol)),
    ));
  }
  return scale;
}

/** Decimals that make an LP's fee, costs, and generated add up. Empty when the bot has no ledger. */
export function coinScale(m: BotMetrics): Map<string, number> {
  return ledgerScale(m) ?? new Map();
}

/**
 * Scale for a summed figure. A coin keeps the ledger decimals only when every bot
 * that generated it has that ledger; otherwise the compact formatter is used.
 */
export function displayScale(bots: BotMetrics[]): Map<string, number> {
  const acc = new Map<string, number | null>();
  for (const m of bots) {
    const scale = coinScale(m);
    for (const t of m.generated) {
      if (t.amount === 0) continue;
      const known = scale.has(t.symbol) ? scale.get(t.symbol) ?? null : null;
      if (!acc.has(t.symbol)) acc.set(t.symbol, known);
      else {
        const prev = acc.get(t.symbol);
        acc.set(t.symbol, prev == null || known == null ? null : Math.max(prev, known));
      }
    }
  }
  const out = new Map<string, number>();
  for (const [symbol, decimals] of acc) if (decimals != null) out.set(symbol, decimals);
  return out;
}

/** Fees in the coins that pay costs, costs as negatives, and the generated total. */
export function ledgerLines(m: BotMetrics): LedgerLines | null {
  const scale = ledgerScale(m);
  if (!scale) return null;
  const symbols = [...scale.keys()];
  const entry = (tokens: TokenQty[], sign: 1 | -1) => symbols
    .map((symbol) => ({ symbol, amount: sign * Math.abs(amountOf(tokens, symbol)), decimals: scale.get(symbol) ?? 0 }))
    .filter((e) => amountOf(tokens, e.symbol) !== 0);
  const generated = m.generated.map((t) => ({
    symbol: t.symbol,
    amount: t.amount,
    decimals: scale.get(t.symbol) ?? ledgerDecimals(t.amount, 0, 0),
  })).filter((e) => formatFixedAmt(e.amount, e.decimals) !== '0');
  const costSymbols = symbols.filter((symbol) => amountOf(m.feesPaid, symbol) !== 0 || amountOf(m.moveLoss, symbol) !== 0);
  const freeSymbols = generated.map((e) => e.symbol).filter((symbol) => !costSymbols.includes(symbol));
  const earned = entry(m.grossFees, 1).filter((e) => costSymbols.includes(e.symbol));
  const untouched = freeSymbols.length === 0
    ? ''
    : freeSymbols.length === 1
      ? `${freeSymbols[0]} has no costs taken out.`
      : `${coinList(freeSymbols)} have no costs taken out.`;
  return {
    gross: ledgerLine(earned),
    feeLabel: costSymbols.length === 1 ? `${costSymbols[0]} fees earned` : costSymbols.length ? `${coinList(costSymbols)} fees earned` : '',
    paid: ledgerLine(entry(m.feesPaid, -1)),
    move: ledgerLine(entry(m.moveLoss, -1)),
    generated: ledgerLine(generated),
    untouched,
  };
}

export function isLedgerLabel(label: string): boolean {
  return label.endsWith(' fees earned') || label === 'Gas + swap fees' || label === 'Range-move loss' || label === 'Generated';
}

/**
 * Breakdown rows in token units. Dollar rows and price change are not rendered.
 * Est. 7d and Est. 365d are included; Est. 24h is the hero /day line, so it is not repeated here.
 */
export function sheetRows(m: BotMetrics, pair: { base: string; quote: string }, covered = ''): SheetRow[] {
  const used = new Set<string>();
  coverFigures(`${heroFigureText(m)} ${covered}`, used);
  const rows: SheetRow[] = [];
  const add = (label: string, value: string, est = false) => {
    if (!value || value === '—') return;
    let next = value;
    if (!est) {
      for (const atom of figureAtoms(value)) {
        if (!used.has(normFigure(atom))) continue;
        next = next.split(atom).join('');
      }
      next = next.replace(/\s*·\s*·\s*/g, ' · ').replace(/^\s*·\s*/, '').replace(/\s*·\s*$/, '').replace(/\s{2,}/g, ' ').trim();
      if (!next) return;
      if (figureAtoms(value).length > 0 && figureAtoms(next).length === 0) return;
      coverFigures(next, used);
    }
    rows.push({ label, value: next });
  };
  const ledger = ledgerLines(m);
  const scale = coinScale(m);
  if (ledger?.gross) add(ledger.feeLabel, ledger.gross, true);
  if (ledger?.paid) add('Gas + swap fees', ledger.paid, true);
  if (ledger?.move) add('Range-move loss', ledger.move, true);
  if (ledger?.generated) add('Generated', ledger.generated, true);
  if (ledger?.untouched) add('Note', ledger.untouched);
  const est = estimates(m.generated, m.ageSec);
  add('Est. 7d', est.d7 == null ? '—' : est.d7.length ? formatTokenLine(est.d7, scale) : '—', true);
  add('Est. 365d', est.d365 == null ? '—' : est.d365.length ? formatTokenLine(est.d365, scale) : '—', true);
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range', formatRangePx(m.range.lower, m.range.upper, pair.quote, pair.base));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}
