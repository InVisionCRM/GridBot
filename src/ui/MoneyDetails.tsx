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
 */
import type { ReactNode } from 'react';
import { echoes, metricsOf, unitsText } from './deskStats';
import { pct, qty } from './fmt';
import type { AnyObj } from './model';

/** A Details row: label, value, tooltip. */
export type DetailRow = [string, ReactNode, string?];
/** Rows a page can leave out because it already shows them: 'Total P&L', 'Value now' (keeps the deposit), or a label. */
export type DetailHide = 'Made at event prices' | 'Total P&L' | 'Price change' | 'Open positions' | 'Value now';

export function MoneyDetails({ b, breakdown, hide = [], note }: { b: AnyObj; breakdown?: DetailRow[]; hide?: readonly DetailHide[]; note?: string }) {
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
  if (tp && m.totalPnlPct != null) tp[1] = `${tp[1]} · ${pct(m.totalPnlPct, 2, true)} of capital in`;
  const deposit = plain(q.capitalIn);
  const value: [string, string, string] = no.has('Value now')
    ? ['Deposit', `${deposit} in`, `The capital put in, in ${sym} at today's price.`]
    : ['Value vs deposit', `${plain(q.currentValue)} now · ${deposit} in`, `Current value of the bot's coins and the capital put in, in ${sym} at today's price.`];
  return (
    <details className="more money-details" data-testid="money-details">
      <summary>Details <span className="muted small">{note ?? 'made at event prices, total P&L, price change'}</span></summary>
      <table className="stat-table"><tbody>
        {(breakdown ?? []).map(([k, v, t]) => <tr key={k} title={t} className="breakdown"><th>{k}</th><td className="mono">{v}</td></tr>)}
        {[...rows, value].map(([k, v, t]) => <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>)}
      </tbody></table>
    </details>
  );
}
