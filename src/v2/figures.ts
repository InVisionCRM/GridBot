/**
 * A screen shows each money or token figure once.
 * Cards that would restate the hero or the section total say so in words.
 */
import type { BotMetrics, RangeBlock, TapePrice, TokenQty } from './metrics';
import { apportion, displayedValue, formatAge, formatAmt, formatBag, formatFixedDecimals, formatRangePx, formatTokenLine, naturalPlaces, showsNoFills, standardUnit, tokenLineParts } from './format';

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

function tokenKey(t: TokenQty): string {
  return normFigure(`${formatAmt(t.amount)} ${t.symbol}`);
}

/** Every generated coin stays on the card: a number, or `All paper BUN` when it is that coin's section total. */
export function generatedCardLine(bot: TokenQty[], section: TokenQty[], scope: 'live' | 'paper'): { text: string; parts: string[] } | null {
  const shown = bot.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
  if (!shown.length) return null;
  const sectionShown = section.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
  const line = formatTokenLine(shown);
  if (line !== '—' && normFigure(line) === normFigure(formatTokenLine(sectionShown))) {
    const text = `All of the ${scope} total`;
    return { text, parts: [text] };
  }
  const totals = new Map(sectionShown.map((t) => [t.symbol, normFigure(formatTokenLine([t]))]));
  const word = scope === 'live' ? 'live' : 'paper';
  const replaced = shown.some((t) => totals.get(t.symbol) === normFigure(formatTokenLine([t])));
  if (!replaced) return { text: line, parts: tokenLineParts(shown) };
  const parts = shown.map((t, i) => {
    if (totals.get(t.symbol) === normFigure(formatTokenLine([t]))) return `All ${word} ${t.symbol}`;
    return tokenLineParts(shown.slice(0, i + 1)).at(-1) ?? formatTokenLine([t]);
  });
  return { text: parts.join(' '), parts };
}

/**
 * Invested line for one card. The same amount on another bot is still shown.
 * A coin that equals that coin in this section's hero reads `All live PLS`.
 * The whole hero line, and only that, reads `All of the live total`.
 */
export function investedLine(bot: TokenQty[], total: TokenQty[], scope: 'live' | 'paper'): string | null {
  if (!bot.length) return '—';
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
  | { kind: 'line'; text: string; parts: string[] };

/** Generated text for a card. Coins that match the section hero are named, not dropped. */
export function cardReadout(metrics: BotMetrics, sectionTokens: TokenQty[], scope: 'live' | 'paper'): CardReadout {
  if (showsNoFills(metrics)) return { kind: 'empty' };
  const line = generatedCardLine(metrics.generated, sectionTokens, scope);
  if (!line) return { kind: 'note', text: rangeWords(metrics.range) };
  if (line.text === `All of the ${scope} total`) return { kind: 'note', text: line.text };
  return { kind: 'line', text: line.text, parts: line.parts };
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
  const day = m.est?.d1;
  return [
    ledgerLines(m)?.generated || formatTokenLine(m.generated),
    formatBagSafe(m.invested),
    day?.length ? formatTokenLine(day) : '',
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

function partText(amount: number, places: number): string {
  if (places <= 0 || amount === 0) return formatAmt(amount);
  return formatFixedDecimals(amount, places);
}

function joinParts(entries: { symbol: string; amount: number; places: number }[]): string {
  const shown = entries.filter((e) => e.amount !== 0 && partText(e.amount, e.places) !== '0');
  if (!shown.length) return '';
  return shown.map((e, i) => {
    const text = partText(e.amount, e.places);
    if (i === 0) return `${text} ${e.symbol}`;
    if (e.amount < 0) return `${text} ${e.symbol}`;
    return `+ ${text.replace(/^\+/, '')} ${e.symbol}`;
  }).join(' ');
}

function roundedCoin(m: BotMetrics, symbol: string): { gross: number; paid: number; move: number; profit: number; places: number } {
  const generated = amountOf(m.generated, symbol);
  const paid = Math.abs(amountOf(m.feesPaid, symbol));
  const move = Math.abs(amountOf(m.moveLoss, symbol));
  const gross = amountOf(m.grossFees, symbol);
  const anchor = generated !== 0 ? generated : Math.max(gross, paid, move, Math.abs(generated + paid));
  const unit = standardUnit(anchor);
  const places = unit >= 1 ? 0 : naturalPlaces(anchor);
  if (m.kind === 'grid' && paid !== 0) {
    if (m.fillCount === 0) return { gross: 0, paid: -paid, move: 0, profit: 0, places };
    const [profit, gas] = apportion([generated + paid, -paid], displayedValue(generated), unit);
    return { gross: 0, paid: gas, move: 0, profit, places };
  }
  const [g, p, mv] = apportion([gross, -paid, -move], displayedValue(generated), unit);
  return { gross: g, paid: p, move: mv, profit: 0, places };
}

function coinList(symbols: string[]): string {
  if (symbols.length <= 1) return symbols[0] ?? '';
  if (symbols.length === 2) return `${symbols[0]} and ${symbols[1]}`;
  return `${symbols.slice(0, -1).join(', ')}, and ${symbols[symbols.length - 1]}`;
}

/** Fees in the coins that pay costs, costs as negatives, and the generated total. */
export function ledgerLines(m: BotMetrics): LedgerLines | null {
  if (!m.grossFees.length && !m.feesPaid.length && !m.moveLoss.length) return null;
  const symbols = [...new Set([
    ...m.grossFees.map((t) => t.symbol),
    ...m.feesPaid.map((t) => t.symbol),
    ...m.moveLoss.map((t) => t.symbol),
    ...m.generated.map((t) => t.symbol),
  ])];
  const rounded = new Map(symbols.map((symbol) => [symbol, roundedCoin(m, symbol)]));
  const costSymbols = symbols.filter((symbol) => amountOf(m.feesPaid, symbol) !== 0 || amountOf(m.moveLoss, symbol) !== 0);
  const generated = m.generated.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
  const freeSymbols = generated.map((t) => t.symbol).filter((symbol) => !costSymbols.includes(symbol));
  const row = (pick: (coin: ReturnType<typeof roundedCoin>) => number) => joinParts(
    costSymbols.map((symbol) => {
      const coin = rounded.get(symbol);
      return { symbol, amount: coin ? pick(coin) : 0, places: coin?.places ?? 0 };
    }),
  );
  const grid = m.kind === 'grid';
  const noFills = grid && m.fillCount === 0;
  const untouched = freeSymbols.length === 0
    ? ''
    : freeSymbols.length === 1
      ? `${freeSymbols[0]} has no costs taken out.`
      : `${coinList(freeSymbols)} have no costs taken out.`;
  const gasLine = noFills
    ? formatTokenLine(costSymbols
      .map((symbol) => ({ symbol, amount: -Math.abs(amountOf(m.feesPaid, symbol)), usd: null }))
      .filter((t) => t.amount !== 0))
    : row((coin) => coin.paid);
  return {
    gross: noFills ? '0' : grid ? row((coin) => coin.profit) : row((coin) => coin.gross),
    feeLabel: grid
      ? 'Trade profit before gas'
      : costSymbols.length === 1
        ? `${costSymbols[0]} fees earned`
        : costSymbols.length ? `${coinList(costSymbols)} fees earned` : '',
    paid: gasLine,
    move: noFills ? '' : row((coin) => coin.move),
    generated: noFills && !generated.length ? '0' : formatTokenLine(generated),
    untouched: noFills ? '' : untouched,
  };
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
  const beforeParts = rows.length;
  if (ledger?.gross) add(ledger.feeLabel, ledger.gross, !details);
  if (ledger?.paid) add('Gas + swap fees', ledger.paid, !details);
  if (ledger?.move) add('Range-move loss', ledger.move, !details);
  if (ledger?.generated && !details) add('Generated', ledger.generated, true);
  if (details && rows.length > beforeParts) {
    rows.push({ label: 'Adds', value: 'These add up to the Generated above.' });
  }
  if (!details && rows.length > beforeParts && !(m.kind === 'grid' && m.fillCount === 0)) {
    rows.push({ label: 'Round', value: 'Rows are rounded to add up exactly.' });
  }
  if (!ledger && (m.kind === 'lp' || m.kind === 'grid')) {
    const labels = m.kind === 'grid'
      ? ['Trade profit before gas', 'Gas + swap fees']
      : ['Fees earned', 'Gas + swap fees', 'Range-move loss'];
    for (const label of labels) rows.push({ label, value: '—' });
    if (!details) {
      const shown = m.generated.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
      const text = shown.length ? formatTokenLine(shown) : (m.kind === 'grid' && m.fillCount === 0 ? '0' : '');
      if (text) rows.push({ label: 'Generated', value: text });
    }
  }
  if (ledger?.untouched) add('Note', ledger.untouched);
  const pace = (tokens: TokenQty[] | null | undefined) => (tokens == null ? '—' : tokens.length ? formatTokenLine(tokens) : '0');
  rows.push({ label: 'Est. 7d', value: pace(m.est?.d7) });
  rows.push({ label: 'Est. 365d', value: pace(m.est?.d365) });
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range', formatRangePx(m.range.lower, m.range.upper, pair.quote, pair.base));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}
