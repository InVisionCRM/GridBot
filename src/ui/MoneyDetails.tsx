/**
 * The secondary money figures, collapsed under "Details" on every bot page: Made at event prices, Total P&L, Price
 * change, Open positions and value vs deposit, in the bot's quote coin (crypto units only, no dollars). The headline
 * is Generated (units per token); these stay out of the top strip. All from the server's metrics (`metrics.quote`); no
 * math here.
 *
 * No number twice on a screen: a page passes the figures it already shows elsewhere in `hide`, and rows whose value
 * comes out identical (a grid's price change is its open positions; with nothing generated yet, Total P&L is the price
 * change) are merged into one row with both names instead of printing the same number twice. A page can put its own
 * breakdown of Generated first (the LP's fees earned − costs = Generated).
 *
 * Per coin, first: what it made before costs − each cost charged in that coin = Generated (metrics.breakdownByCoin,
 * token units; the rows add up to the headline exactly, the server checks the identity). Collapsed here only.
 */
import type { ReactNode } from 'react';
import { echoes, metricsOf, unitsText } from './deskStats';
import { pctShown, qty } from './fmt';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
import type { AnyObj } from './model';
import type { BotMetrics } from '../metrics/botMetrics';

/** A Details row: label, value, tooltip. */
export type DetailRow = [string, ReactNode, string?];
/** Rows a page can leave out because it already shows them: 'Total P&L', 'Value now' (keeps the deposit), or a label. */
export type DetailHide = 'Made at event prices' | 'Total P&L' | 'Price change' | 'Open positions' | 'Value now';

/**
 * The per-coin lines of metrics.breakdownByCoin, in that coin's units: earned, then each non-zero cost with a minus,
 * then "= Generated" (the headline above, not printed twice). A coin with no cost is one row saying so.
 */
export function coinBreakdownRows(m: Pick<BotMetrics, 'breakdownByCoin' | 'breakdownBasis'> | null | undefined, moves?: number | null): DetailRow[] {
  const by = m?.breakdownByCoin, basis = m?.breakdownBasis;
  if (!by || !basis) return [];
  const earnedLabel = basis.earned === 'lpFees' ? 'Fees earned' : 'Trade profit before costs';
  const earnedTip = basis.earned === 'lpFees'
    ? 'Your share of the pool\'s trading fees in this coin: collected so far plus what\'s waiting in the position.'
    : `Closed trades' profit before gas, pool fees and token taxes.${basis.itemized ? '' : ' Part of the costs is not split out here, so it stays inside this figure.'}`;
  const rows: DetailRow[] = [];
  for (const [sym, c] of Object.entries(by)) {
    const costs: [string, number, string][] = ([
      ['Gas + swap fees', c.gasSwap, `Gas for every transaction and the pool fees / swap cost, charged in ${sym}.`],
      ['Range moves', c.rangeMoveLoss, `What the range moves locked in, in ${sym}${moves ? ` (${moves} range move${moves === 1 ? '' : 's'})` : ''}.`],
      ['Token taxes', c.taxes, `Fee-on-transfer tax taken on the fills, in ${sym}.`],
      ['Bridge', c.bridge, `Cross-chain move costs, in ${sym}.`],
    ] as [string, number, string][]).filter(([, v]) => v !== 0);
    if (!costs.length) {
      rows.push([`${earnedLabel}, ${sym}`, c.earned === 0 ? <>none yet</> : <>all of it is Generated (no cost is charged in {sym})</>, `${earnedTip} Nothing is charged in ${sym}, so it is all Generated.`]);
      continue;
    }
    rows.push([`${earnedLabel}, ${sym}`, <>{qty(c.earned, sym, 6)}</>, earnedTip]);
    for (const [k, v, t] of costs) rows.push([`− ${k}, ${sym}`, <>{qty(-v, sym, 6)}</>, t]);
    rows.push([`= Generated, ${sym}`, 'the headline above', `${earnedLabel} − ${costs.map(([k]) => k.toLowerCase()).join(' − ')}, in ${sym}.`]);
  }
  return rows;
}

/**
 * A value-change row a page adds after Price change: a quote-coin figure that sits outside Generated (the grid's
 * cash-out sale at stop/close). Label, amount in the quote coin, tooltip. Merged like any other row when it prints the
 * same as one (a stopped grid's whole Total P&L can be its stop sale).
 */
export type ValueChangeRow = [string, number | null | undefined, string];

export function MoneyDetails({ b, breakdown, changes = [], hide = [], note }: { b: AnyObj; breakdown?: DetailRow[]; changes?: readonly ValueChangeRow[]; hide?: readonly DetailHide[]; note?: string }) {
  const m = metricsOf(b);
  if (!m) return null;
  const q = m.quote, sym = q.symbol ?? '';
  const signed = (v: number | null | undefined) => (v == null ? '—' : qty(v, sym, 5));
  const plain = (v: number | null | undefined) => (v == null ? '—' : qty(v, sym, 5, false));
  const no = new Set<string>(hide);
  const raw: [string, string, string][] = [
    ['Made at event prices', signed(q.made), `Fees / round-trip profit minus gas, swap fees, taxes and range-move losses, each in ${sym} at the time it happened. Generated is the same counted in coins, valued at today's price.`],
    ['Total P&L', signed(q.totalPnl), m.calc],
    ['Price change', signed(q.priceChange), `Total P&L − Generated (in ${sym} at today's price): what the coins' own price did (impermanent loss and the inventory's market move).`],
    ...changes.map(([k, v, t]): [string, string, string] => [k, signed(v), t]),
    ['Open positions', signed(q.unrealized), 'Coins bought and not sold yet / the position\'s price side, at today\'s price minus what they cost. Not in Generated until they sell.'],
  ];
  // Made at event prices is the headline's number when everything was generated in the quote coin (prices don't matter then)
  const gen = m.generated, onlyQuote = gen && Object.entries(gen).every(([k, u]) => k === sym || u === 0);
  if (q.made != null && onlyQuote && Math.abs(q.made - (gen![sym] ?? 0)) <= 1e-9 * Math.max(1, Math.abs(q.made))) raw[0][1] = 'same as Generated';
  else if (raw[0][1] !== '—' && echoes(unitsText(gen, 9), raw[0][1])) raw[0][1] = 'same as Generated';
  // a row printing what a hidden row (shown elsewhere on the screen) prints is left out; rows printing the same
  // value as each other are merged into one row with both names (a real dash is not a value)
  const hidden = new Set(raw.filter(([k]) => no.has(k)).map(([, v]) => v));
  const rows: [string, string, string][] = [];
  for (const [k, v, t] of raw) {
    if (no.has(k) || (v !== '—' && hidden.has(v))) continue;
    const same = v !== '—' ? rows.find((r) => r[1] === v) : undefined;
    if (same) { same[0] = `${same[0]} = ${k}`; same[2] = `${same[2]}\n${k}: ${t}`; continue; }
    rows.push([k, v, t]);
  }
  const tp = rows.find((r) => r[0].startsWith('Total P&L'));
  if (tp && m.totalPnlPct != null && pctShown(m.totalPnlPct, 2) !== '—') tp[1] = `${tp[1]} · ${pctShown(m.totalPnlPct, 2, true)} of capital in`;
  const deposit = plain(q.capitalIn);
  const value: [string, string, string] = no.has('Value now')
    ? ['Deposit', `${deposit} in`, `The capital put in, in ${sym} at today's price.`]
    : ['Value vs deposit', `${plain(q.currentValue)} now · ${deposit} in`, `Current value of the bot's coins and the capital put in, in ${sym} at today's price.`];
  return (
    <details className="more money-details" data-testid="money-details">
      <summary>Details <span className="muted small">{note ?? 'made at event prices, total P&L, price change'}</span></summary>
      <table className="stat-table"><tbody>
        {[...coinBreakdownRows(m, num(b.reranges)), ...(breakdown ?? [])].map(([k, v, t]) => <tr key={k} title={t} className="breakdown"><th>{k}</th><td className="mono">{v}</td></tr>)}
        {[...rows, value].map(([k, v, t]) => <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>)}
      </tbody></table>
    </details>
  );
}
