/**
 * A screen shows each money or token figure once.
 * Cards that would restate the hero or the section total say so in words.
 */
import type { BotMetrics, EstimateBlock, RangeBlock, TapePrice, TokenQty } from './metrics';
import { formatAge, formatAmt, formatTokenLine, formatUsd, pct, shortenFigures, showsNoFills } from './format';

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
  const usd = metrics.generatedUsd == null ? null : formatUsd(metrics.generatedUsd, false);
  const usdOk = usd && usd !== '—' && !used.has(normFigure(usd)) ? usd : null;
  if (!tokens.length && !usdOk) return { kind: 'note', text: rangeWords(metrics.range) };
  for (const t of tokens) used.add(tokenKey(t));
  if (usdOk) used.add(normFigure(usdOk));
  return { kind: 'figures', tokens, usd: usdOk };
}

export function uniqueTape(prices: TapePrice[]): TapePrice[] {
  const seen = new Set<string>();
  const out: TapePrice[] = [];
  for (const p of prices) {
    const key = `${p.symbol}|${p.chain}|${p.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function heroFigureText(m: BotMetrics): string {
  if (showsNoFills(m)) return '';
  return [
    formatTokenLine(m.generated),
    m.est.d1 ? formatTokenLine(m.est.d1) : '',
    formatUsd(m.generatedUsd, false),
    formatUsd(m.est.usd.d1, false),
    m.aprPct == null ? '' : pct(m.aprPct, 1, true),
  ].join(' ');
}

export interface SheetRow { label: string; value: string }

/** Breakdown rows, dropping any figure the hero (or other text already on screen) already shows. */
export function sheetRows(m: BotMetrics, covered = ''): SheetRow[] {
  const used = new Set<string>();
  coverFigures(`${heroFigureText(m)} ${covered}`, used);
  const rows: SheetRow[] = [];
  const add = (label: string, value: string) => {
    let next = value;
    for (const atom of figureAtoms(value)) {
      if (!used.has(normFigure(atom))) continue;
      next = next.split(atom).join('');
    }
    next = next.replace(/\s*·\s*·\s*/g, ' · ').replace(/^\s*·\s*/, '').replace(/\s*·\s*$/, '').replace(/\s{2,}/g, ' ').trim();
    if (!next) return;
    if (figureAtoms(value).length > 0 && figureAtoms(next).length === 0) return;
    coverFigures(next, used);
    rows.push({ label, value: next });
  };
  const fee = (tokens: TokenQty[], usd: number | null) => (
    tokens.length ? `${formatTokenLine(tokens)} · ${formatUsd(usd, false)}` : formatUsd(usd, false)
  );
  add('Price change', formatUsd(m.priceChangeUsd, true));
  add('Value', formatUsd(m.currentValueUsd, false));
  add('Deposited', formatUsd(m.capitalInUsd, false));
  add('Fees collected', fee(m.feesCollected, m.feesCollectedUsd));
  add('Fees owed', fee(m.feesOwed, m.feesUncollectedUsd));
  add('Gas', formatUsd(m.gasUsd, false));
  add('Swap fees', formatUsd(m.swapCostUsd, false));
  add('Taxes', formatUsd(m.tokenTaxesUsd, false));
  add('Rebalance loss', formatUsd(m.realizedRebalanceLossUsd, false));
  if (m.kind !== 'lp') add('Realized trade profit', formatUsd(m.realizedUsd, true));
  add('Age', formatAge(m.ageSec));
  add('Moves', m.moveCount == null ? '—' : String(m.moveCount));
  add('Fills', m.fillCount == null ? '—' : String(m.fillCount));
  if (m.range) {
    add('Range lower', shortenFigures(String(m.range.lower)));
    add('Range upper', shortenFigures(String(m.range.upper)));
    add('In range', m.range.inRange ? 'yes' : 'no');
  }
  return rows;
}

export function projectedLines(est: EstimateBlock, covered: string): { label: string; tokens: TokenQty[] | null; usd: string | null }[] {
  const used = new Set<string>();
  coverFigures(covered, used);
  const take = (label: string, tokens: TokenQty[] | null, usd: number | null) => {
    const keep = (tokens ?? []).filter((t) => !used.has(tokenKey(t)));
    const usdText = usd == null ? null : formatUsd(usd, true);
    const usdOk = usdText && usdText !== '—' && !used.has(normFigure(usdText)) ? usdText : null;
    for (const t of keep) used.add(tokenKey(t));
    if (usdOk) used.add(normFigure(usdOk));
    return { label, tokens: keep.length ? keep : null, usd: usdOk };
  };
  return [
    take('Week, projected', est.d7, est.usd.d7),
    take('Year, projected', est.d365, est.usd.d365),
  ];
}
