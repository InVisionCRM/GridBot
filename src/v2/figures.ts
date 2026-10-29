/**
 * A screen shows each money or token figure once per place: a card never repeats itself, and the hero never repeats
 * itself. A card's figure may equal its section total; both are labelled, so that is one fact in two places, not two facts.
 */
import type { BotMetrics, TapePrice, TokenQty } from './metrics';
import { apportion, formatAge, formatAmt, formatBag, formatFixedDecimals, formatRangePx, formatTokenLine, naturalPlaces, roundAmt, tokenLineParts } from './format';

const SUBSCRIPT_PRICE = /\$0\.0[₀₁₂₃₄₅₆₇₈₉]+\d+/g;
const FIGURE = /[+−-]?\s*\$\d[\d,]*(?:\.\d+)?|[+−-]?\s*\d[\d,]*(?:\.\d+)?[kMB]\s+[A-Z][A-Z0-9]*|[+−-]\s*\d[\d,]*(?:\.\d+)?\s+[A-Z][A-Z0-9]*|(?<![\d.])0(?:\.0+)?\s+[A-Z][A-Z0-9]*|[+−-]?\d+(?:\.\d+)?%/g;

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

/** Every generated coin stays on the card as a number. A real zero stays `0 PLS`. The section header carries the total. */
export function generatedCardLine(bot: TokenQty[]): { text: string; parts: string[] } | null {
  const shown = bot.filter((t) => Number.isFinite(t.amount));
  if (!shown.length) return null;
  return { text: formatTokenLine(shown), parts: tokenLineParts(shown) };
}

/** Invested line for one card: the bot's own bag, coin by coin. */
export function investedLine(bot: TokenQty[]): string {
  if (!bot.length) return '—';
  return bot.map((t) => formatBag([t])).join(' + ');
}

const DAY_SEC = 86_400;

export function hasGenerated(m: { generated?: TokenQty[] | null }): boolean {
  return (m.generated ?? []).some((t) => Number.isFinite(t.amount));
}

/** A real earning. An explicit zero (`0 PLS`) is Generated, but it is not an estimate. */
export function hasEarnings(m: { generated?: TokenQty[] | null }): boolean {
  return (m.generated ?? []).some((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
}

/** Closed and stopped bots, and anything under a day or without a non-zero Generated, do not show Est. rows. */
export function estimatesVisible(m: BotMetrics): boolean {
  if (m.status === 'closed' || m.status === 'stopped') return false;
  if (!hasEarnings(m)) return false;
  if (m.ageSec == null || m.ageSec < DAY_SEC) return false;
  return true;
}

export type CardReadout =
  | { kind: 'empty' }
  | { kind: 'note'; text: string }
  | { kind: 'line'; text: string; parts: string[] };

/** Generated text for a card. A missing figure is a dash, never a status word. */
export function cardReadout(metrics: BotMetrics): CardReadout {
  const line = generatedCardLine(metrics.generated);
  if (!line) return { kind: 'note', text: 'Not calculated yet' };
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
  const day = estimatesVisible(m) ? m.est?.d1 : null;
  return [
    ledgerLines(m)?.generated || (hasGenerated(m) ? formatTokenLine(m.generated) : ''),
    formatBagSafe(m.invested),
    day?.length ? formatTokenLine(day) : '',
  ].join(' ');
}

function formatBagSafe(tokens: TokenQty[] | null | undefined): string {
  return (tokens ?? []).map((t) => tokenKey(t)).join(' ');
}

export interface SheetRow { label: string; value: string }

export interface LedgerLines {
  /** Generated at the parts' step, for the breakdown sheet, where the rows above it add up to it exactly. */
  sheetGenerated: string;
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

function roundedCoin(m: BotMetrics, symbol: string): { gross: number; paid: number; move: number; profit: number; generated: number; places: number } {
  const generated = amountOf(m.generated, symbol);
  const paid = Math.abs(amountOf(m.feesPaid, symbol));
  const move = Math.abs(amountOf(m.moveLoss, symbol));
  const gross = amountOf(m.grossFees, symbol);
  const { unit, places } = placesOf([generated, gross, paid, move, generated + paid]);
  const shown = roundAmt(generated, places);
  if (m.kind === 'grid' && paid !== 0) {
    if (m.fillCount === 0) return { gross: 0, paid: -paid, move: 0, profit: 0, generated: shown, places };
    const [profit, gas] = apportion([generated + paid, -paid], generated, unit);
    return { gross: 0, paid: gas, move: 0, profit, generated: shown, places };
  }
  const [g, p, mv] = apportion([gross, -paid, -move], generated, unit);
  return { gross: g, paid: p, move: mv, profit: 0, generated: shown, places };
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
  const zeroLine = costSymbols.length === 1 ? `0 ${costSymbols[0]}` : '—';
  return {
    gross: noFills ? zeroLine : grid ? row((coin) => coin.profit) : row((coin) => coin.gross),
    feeLabel: grid
      ? 'Trade profit before gas'
      : costSymbols.length === 1
        ? `${costSymbols[0]} fees earned`
        : costSymbols.length ? `${coinList(costSymbols)} fees earned` : '',
    paid: gasLine,
    move: noFills ? '' : row((coin) => coin.move),
    generated: noFills && !generated.length ? zeroLine : formatTokenLine(generated),
    sheetGenerated: noFills && !generated.length ? zeroLine : joinParts(generated.map((t) => ({ symbol: t.symbol, amount: rounded.get(t.symbol)?.generated ?? t.amount, places: costSymbols.includes(t.symbol) ? rounded.get(t.symbol)!.places : -1 }))),
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
 * One step for all of a coin's breakdown rows: the finest any of its nonzero parts needs. The compact step of a big
 * Generated (100 PLS at 12.3k) would turn 254 PLS of gas into 300, and hide it altogether at 2.5M.
 */
function placesOf(amounts: number[]): { unit: number; places: number } {
  const smallest = Math.min(...amounts.filter((a) => a !== 0).map(Math.abs));
  const places = naturalPlaces(Number.isFinite(smallest) ? smallest : 1);
  return { unit: 10 ** -places, places };
}

/** Itemized per-coin rows from botMetrics, rounded so each coin's parts equal its Generated. */
function metricsBreakdown(m: BotMetrics, details: boolean): SheetRow[] {
  const by = m.breakdownByCoin;
  const basis = m.breakdownBasis;
  if (!by || !basis) return [];
  const generatedText = m.generated.length ? formatTokenLine(m.generated) : '';
  if (!basis.itemized) {
    const rows: SheetRow[] = [];
    if (!details && generatedText) rows.push({ label: 'Generated', value: generatedText });
    if (basis.note) rows.push({ label: 'Note', value: basis.note });
    return rows;
  }
  const costEntries = Object.entries(by).filter(([, c]) => c.gasSwap !== 0 || c.rangeMoveLoss !== 0 || c.taxes !== 0 || c.bridge !== 0);
  if (!costEntries.length) {
    const rows: SheetRow[] = [];
    if (!details && generatedText) rows.push({ label: 'Generated', value: generatedText });
    return rows;
  }
  const rounded = new Map(costEntries.map(([symbol, coin]) => {
    const { unit, places } = placesOf([coin.generated, coin.earned, coin.gasSwap, coin.rangeMoveLoss, coin.taxes, coin.bridge]);
    const specs: { key: 'earned' | 'gas' | 'move' | 'tax' | 'bridge'; raw: number }[] = [
      { key: 'earned', raw: coin.earned },
    ];
    if (coin.gasSwap !== 0) specs.push({ key: 'gas', raw: -Math.abs(coin.gasSwap) });
    if (coin.rangeMoveLoss !== 0) specs.push({ key: 'move', raw: -Math.abs(coin.rangeMoveLoss) });
    if (coin.taxes !== 0) specs.push({ key: 'tax', raw: -Math.abs(coin.taxes) });
    if (coin.bridge !== 0) specs.push({ key: 'bridge', raw: -Math.abs(coin.bridge) });
    const values = apportion(specs.map((s) => s.raw), coin.generated, unit);
    const parts = { earned: 0, gas: 0, move: 0, tax: 0, bridge: 0, generated: roundAmt(coin.generated, places), places };
    specs.forEach((s, i) => { parts[s.key] = values[i]; });
    return [symbol, parts] as const;
  }));
  const line = (key: 'earned' | 'gas' | 'move' | 'tax' | 'bridge') => joinParts(
    [...rounded.entries()].map(([symbol, parts]) => ({ symbol, amount: parts[key], places: parts.places })),
  );
  const symbols = [...rounded.keys()];
  const feeLabel = basis.earned === 'tradeProfit'
    ? 'Trade profit before gas'
    : symbols.length === 1
      ? `${symbols[0]} fees earned`
      : `${coinList(symbols)} fees earned`;
  const rows: SheetRow[] = [];
  const earned = line('earned');
  const gas = line('gas');
  const move = line('move');
  const tax = line('tax');
  const bridge = line('bridge');
  if (earned) rows.push({ label: feeLabel, value: earned });
  if (gas) rows.push({ label: 'Gas + swap fees', value: gas });
  if (move) rows.push({ label: 'Range-move loss', value: move });
  if (tax) rows.push({ label: 'Taxes', value: tax });
  if (bridge) rows.push({ label: 'Bridge', value: bridge });
  // the coins with parts above print their Generated at the parts' step, so the rows visibly add up
  if (!details && generatedText) rows.push({ label: 'Generated', value: joinParts(m.generated.map((t) => ({ symbol: t.symbol, amount: rounded.get(t.symbol)?.generated ?? t.amount, places: rounded.get(t.symbol)?.places ?? -1 }))) });
  if (details && rows.length) rows.push({ label: 'Adds', value: 'These add up to the Generated above.' });
  const free = Object.keys(by).filter((symbol) => !symbols.includes(symbol) && (by[symbol].generated !== 0 || by[symbol].earned !== 0));
  if (free.length === 1) rows.push({ label: 'Note', value: `${free[0]} has no costs taken out.` });
  else if (free.length > 1) rows.push({ label: 'Note', value: `${coinList(free)} have no costs taken out.` });
  return rows;
}

/**
 * Breakdown rows in token units. Dollar rows and price change are not rendered.
 * Est. 7d and Est. 365d are included; Est. 24h is the hero line, so it is not repeated here.
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
  if (ledger?.sheetGenerated && !details) add('Generated', ledger.sheetGenerated, true);
  if (details && rows.length > beforeParts) {
    rows.push({ label: 'Adds', value: 'These add up to the Generated above.' });
  }
  const fromMetrics = metricsBreakdown(m, details);
  if (fromMetrics.length) {
    rows.push(...fromMetrics);
  } else if (!ledger && (m.kind === 'lp' || m.kind === 'grid' || m.kind === 'trend')) {
    if (!details && m.generated.length) rows.push({ label: 'Generated', value: formatTokenLine(m.generated) });
    rows.push({ label: 'Note', value: 'Breakdown coming soon' });
  }
  if (ledger?.untouched) add('Note', ledger.untouched);
  if (!hasEarnings(m) && m.status !== 'closed' && m.status !== 'stopped') {
    rows.push({ label: 'Note', value: 'No earnings yet, so no estimate.' });
  } else if (estimatesVisible(m)) {
    const pace = (tokens: TokenQty[] | null | undefined) => (tokens == null || !tokens.length ? '—' : formatTokenLine(tokens));
    rows.push({ label: 'Est. 7d', value: pace(m.est?.d7) });
    rows.push({ label: 'Est. 365d', value: pace(m.est?.d365) });
  }
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range', formatRangePx(m.range.lower, m.range.upper, pair.quote, pair.base));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}
