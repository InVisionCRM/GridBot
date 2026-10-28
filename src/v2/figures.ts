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

function tokenKey(t: TokenQty): string {
  return normFigure(`${formatAmt(t.amount)} ${t.symbol}`);
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
): CardReadout {
  if (showsNoFills(metrics)) return { kind: 'empty' };
  const line = formatTokenLine(metrics.generated);
  const sectionLine = formatTokenLine(sectionTokens);
  if (line !== '—' && sectionLine !== '—' && normFigure(line) === normFigure(sectionLine)) {
    return { kind: 'note', text: `All of the ${scope} total` };
  }
  const tokens = metrics.generated.filter((t) => !used.has(tokenKey(t)));
  if (!tokens.length) return { kind: 'note', text: rangeWords(metrics.range) };
  for (const t of tokens) used.add(tokenKey(t));
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
  const day = estimates(m.generated, m.ageSec).perDay;
  return [
    formatTokenLine(m.generated),
    formatBagSafe(m.invested),
    day ? formatTokenLine(day) : '',
  ].join(' ');
}

function formatBagSafe(tokens: TokenQty[]): string {
  return tokens.map((t) => tokenKey(t)).join(' ');
}

export interface SheetRow { label: string; value: string }

export interface LedgerLines {
  gross: string;
  paid: string;
  move: string;
  generated: string;
}

function amountOf(tokens: TokenQty[], symbol: string): number {
  return tokens.find((t) => t.symbol === symbol)?.amount ?? 0;
}

function ledgerLine(entries: { symbol: string; amount: number; decimals: number }[]): string {
  const shown = entries.filter((e) => formatFixedAmt(e.amount, e.decimals) !== '0');
  if (!shown.length) return '';
  return shown.map((e, i) => {
    const text = formatFixedAmt(e.amount, e.decimals);
    if (i === 0) return `${text} ${e.symbol}`;
    if (e.amount < 0) return `${text} ${e.symbol}`;
    return `+ ${text.replace(/^\+/, '')} ${e.symbol}`;
  }).join(' ');
}

/** Gross fees, costs as negatives, and the generated total, at a scale where they add up. */
export function ledgerLines(m: BotMetrics): LedgerLines | null {
  if (!m.grossFees.length && !m.feesPaid.length && !m.moveLoss.length) return null;
  const symbols = [...new Set([
    ...m.grossFees.map((t) => t.symbol),
    ...m.feesPaid.map((t) => t.symbol),
    ...m.moveLoss.map((t) => t.symbol),
    ...m.generated.map((t) => t.symbol),
  ])];
  const scale = new Map<string, number>();
  for (const symbol of symbols) {
    const gross = amountOf(m.grossFees, symbol);
    const paid = Math.abs(amountOf(m.feesPaid, symbol));
    const move = Math.abs(amountOf(m.moveLoss, symbol));
    scale.set(symbol, ledgerDecimals(gross, paid, move));
  }
  const entry = (tokens: TokenQty[], sign: 1 | -1) => symbols
    .map((symbol) => ({ symbol, amount: sign * Math.abs(amountOf(tokens, symbol)), decimals: scale.get(symbol) ?? 0 }))
    .filter((e) => amountOf(tokens, e.symbol) !== 0);
  const generated = m.generated.map((t) => ({
    symbol: t.symbol,
    amount: t.amount,
    decimals: scale.get(t.symbol) ?? ledgerDecimals(t.amount, 0, 0),
  })).filter((e) => formatFixedAmt(e.amount, e.decimals) !== '0');
  return {
    gross: ledgerLine(entry(m.grossFees, 1)),
    paid: ledgerLine(entry(m.feesPaid, -1)),
    move: ledgerLine(entry(m.moveLoss, -1)),
    generated: ledgerLine(generated),
  };
}

export function isLedgerLabel(label: string): boolean {
  return label === 'Gross fees' || label === 'Gas + swap fees' || label === 'Range-move loss' || label === 'Generated';
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
  if (ledger?.gross) add('Gross fees', ledger.gross, true);
  if (ledger?.paid) add('Gas + swap fees', ledger.paid, true);
  if (ledger?.move) add('Range-move loss', ledger.move, true);
  if (ledger?.generated) add('Generated', ledger.generated, true);
  const est = estimates(m.generated, m.ageSec);
  add('Est. 7d', est.d7 == null ? '—' : est.d7.length ? formatTokenLine(est.d7) : '—', true);
  add('Est. 365d', est.d365 == null ? '—' : est.d365.length ? formatTokenLine(est.d365) : '—', true);
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range', formatRangePx(m.range.lower, m.range.upper, pair.quote, pair.base));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}
