/**
 * A screen shows each money or token figure once.
 * Cards that would restate the hero or the section total say so in words.
 */
import type { BotMetrics, RangeBlock, TapePrice, TokenQty } from './metrics';
import { estimates } from '../shared/generated';
import { formatAge, formatAmt, formatBag, formatPlaces, formatRangePx, formatTokenLine, showsNoFills, sumPlaces } from './format';

const SUBSCRIPT_PRICE = /\$0\.0[₀₁₂₃₄₅₆₇₈₉]+\d+/g;
const FIGURE = /[+−-]?\s*\$\d[\d,]*(?:\.\d+)?|[+−-]?\s*\d[\d,]*(?:\.\d+)?[kMB]\s+[A-Z][A-Z0-9]*|[+−-]\s*\d[\d,]*(?:\.\d+)?\s+[A-Z][A-Z0-9]*|[+−-]?\d+(?:\.\d+)?%/g;

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

function tokenKey(t: TokenQty, places?: ReadonlyMap<string, number> | null): string {
  const count = places?.get(t.symbol);
  const amt = count == null ? formatAmt(t.amount) : formatPlaces(t.amount, count);
  return normFigure(`${amt} ${t.symbol}`);
}

/**
 * Invested line for one card. The same amount on another bot is still shown.
 * A coin that equals that coin in this section's hero reads `All live PLS`.
 * The whole hero line, and only that, reads `All of the live total`.
 */
export function investedLine(bot: TokenQty[], total: TokenQty[], scope: 'live' | 'paper'): string | null {
  if (!bot.length) return null;
  const whole = normFigure(formatBag(bot)) === normFigure(formatBag(total));
  if (whole) return `All of the ${scope} total`;
  const all = new Map(total.map((t) => [t.symbol, normFigure(formatBag([t]))]));
  const word = scope === 'live' ? 'live' : 'paper';
  return bot.map((t) => (
    all.get(t.symbol) === normFigure(formatBag([t])) ? `All ${word} ${t.symbol}` : formatBag([t])
  )).join(' + ');
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
  places?: ReadonlyMap<string, number> | null,
  sectionPlaces?: ReadonlyMap<string, number> | null,
): CardReadout {
  if (showsNoFills(metrics)) return { kind: 'empty' };
  const line = formatTokenLine(metrics.generated, places);
  const sectionLine = formatTokenLine(sectionTokens, sectionPlaces ?? places);
  if (line !== '—' && sectionLine !== '—' && normFigure(line) === normFigure(sectionLine)) {
    return { kind: 'note', text: `All of the ${scope} total` };
  }
  const tokens = metrics.generated.filter((t) => !used.has(tokenKey(t, places)));
  if (!tokens.length) return { kind: 'note', text: rangeWords(metrics.range) };
  for (const t of tokens) used.add(tokenKey(t, places));
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
    ledgerLines(m)?.generated || formatTokenLine(m.generated, placesForBot(m)),
    formatBagSafe(m.invested),
    day ? formatTokenLine(day, placesForBot(m)) : '',
  ].join(' ');
}

function formatBagSafe(tokens: TokenQty[] | null | undefined): string {
  return (tokens ?? []).map((t) => tokenKey(t)).join(' ');
}

export interface SheetRow { label: string; value: string }

export interface LedgerLines {
  /** Fees in the coins costs come out of, or trade profit before gas for a grid. */
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

function ledgerLine(entries: { symbol: string; amount: number; places: number }[]): string {
  const shown = entries.filter((e) => e.amount !== 0 && formatPlaces(e.amount, e.places) !== '0');
  if (!shown.length) return '';
  return formatTokenLine(shown, new Map(shown.map((e) => [e.symbol, e.places])));
}

/** One decimal count per coin so that coin's parts and Generated round to the same total. */
export function placesForBot(m: BotMetrics): Map<string, number> {
  const symbols = [...new Set([
    ...m.grossFees.map((t) => t.symbol),
    ...m.feesPaid.map((t) => t.symbol),
    ...m.moveLoss.map((t) => t.symbol),
    ...m.generated.map((t) => t.symbol),
  ])];
  const out = new Map<string, number>();
  for (const symbol of symbols) {
    const generated = amountOf(m.generated, symbol);
    const paid = Math.abs(amountOf(m.feesPaid, symbol));
    const move = Math.abs(amountOf(m.moveLoss, symbol));
    const gross = amountOf(m.grossFees, symbol);
    if (!gross && !paid && !move && !generated) continue;
    const parts = m.kind === 'grid' && paid !== 0
      ? [generated + paid, -paid]
      : [gross, -paid, -move];
    out.set(symbol, sumPlaces(parts, generated));
  }
  return out;
}

/** Finest per-coin count among these bots, so a sole contributor matches that bot's string. */
export function displayPlaces(bots: BotMetrics[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of bots) {
    const places = placesForBot(m);
    for (const t of m.generated) {
      if (t.amount === 0) continue;
      const count = places.get(t.symbol);
      if (count == null) continue;
      out.set(t.symbol, Math.max(out.get(t.symbol) ?? 0, count));
    }
  }
  return out;
}

function coinList(symbols: string[]): string {
  if (symbols.length <= 1) return symbols[0] ?? '';
  if (symbols.length === 2) return `${symbols[0]} and ${symbols[1]}`;
  return `${symbols.slice(0, -1).join(', ')}, and ${symbols[symbols.length - 1]}`;
}

/** Fees in the coins that pay costs, costs as negatives, and the generated total. */
export function ledgerLines(m: BotMetrics): LedgerLines | null {
  if (!m.grossFees.length && !m.feesPaid.length && !m.moveLoss.length) return null;
  const places = placesForBot(m);
  const symbols = [...places.keys()];
  const at = (symbol: string) => places.get(symbol) ?? naturalFallback(symbol, m);
  const entry = (tokens: TokenQty[], sign: 1 | -1) => symbols
    .map((symbol) => ({ symbol, amount: sign * Math.abs(amountOf(tokens, symbol)), places: at(symbol) }))
    .filter((e) => amountOf(tokens, e.symbol) !== 0);
  const generated = m.generated
    .filter((t) => t.amount !== 0)
    .map((t) => ({ symbol: t.symbol, amount: t.amount, places: at(t.symbol) }));
  const costSymbols = symbols.filter((symbol) => amountOf(m.feesPaid, symbol) !== 0 || amountOf(m.moveLoss, symbol) !== 0);
  const freeSymbols = generated.map((e) => e.symbol).filter((symbol) => !costSymbols.includes(symbol));
  const gridProfit = m.kind === 'grid'
    ? costSymbols
      .filter((symbol) => amountOf(m.generated, symbol) !== 0 || amountOf(m.feesPaid, symbol) !== 0)
      .map((symbol) => ({
        symbol,
        amount: amountOf(m.generated, symbol) + Math.abs(amountOf(m.feesPaid, symbol)),
        places: at(symbol),
      }))
    : [];
  const earned = entry(m.grossFees, 1).filter((e) => costSymbols.includes(e.symbol));
  const untouched = freeSymbols.length === 0
    ? ''
    : freeSymbols.length === 1
      ? `${freeSymbols[0]} has no costs taken out.`
      : `${coinList(freeSymbols)} have no costs taken out.`;
  return {
    gross: gridProfit.length ? ledgerLine(gridProfit) : ledgerLine(earned),
    feeLabel: gridProfit.length
      ? 'Trade profit before gas'
      : costSymbols.length === 1
        ? `${costSymbols[0]} fees earned`
        : costSymbols.length ? `${coinList(costSymbols)} fees earned` : '',
    paid: ledgerLine(entry(m.feesPaid, -1)),
    move: ledgerLine(entry(m.moveLoss, -1)),
    generated: ledgerLine(generated),
    untouched,
  };
}

function naturalFallback(symbol: string, m: BotMetrics): number {
  return sumPlaces([amountOf(m.generated, symbol)], amountOf(m.generated, symbol));
}

export function isLedgerLabel(label: string): boolean {
  return label === 'Trade profit before gas'
    || label.endsWith(' fees earned')
    || label === 'Gas + swap fees'
    || label === 'Range-move loss'
    || label === 'Generated';
}

/**
 * Breakdown rows in token units. Dollar rows and price change are not rendered.
 * Est. 7d and Est. 365d are included; Est. 24h is the hero /day line, so it is not repeated here.
 */
export function sheetRows(m: BotMetrics, pair: { base: string; quote: string }, covered = '', details = false): SheetRow[] {
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
  const places = placesForBot(m);
  const beforeParts = rows.length;
  if (ledger?.gross) add(ledger.feeLabel, ledger.gross, !details);
  if (ledger?.paid) add('Gas + swap fees', ledger.paid, !details);
  if (ledger?.move) add('Range-move loss', ledger.move, !details);
  if (ledger?.generated && !details) add('Generated', ledger.generated, true);
  if (details && rows.length > beforeParts) {
    rows.push({ label: 'Adds', value: 'These add up to the Generated above.' });
  }
  if (ledger?.untouched) add('Note', ledger.untouched);
  const est = estimates(m.generated, m.ageSec);
  add('Est. 7d', est.d7 == null ? '—' : est.d7.length ? formatTokenLine(est.d7, places) : '—', true);
  add('Est. 365d', est.d365 == null ? '—' : est.d365.length ? formatTokenLine(est.d365, places) : '—', true);
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range', formatRangePx(m.range.lower, m.range.upper, pair.quote, pair.base));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}
