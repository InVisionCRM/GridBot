/**
 * The secondary money figures, collapsed under "Details" on every bot page: Dollars made, Total P&L, Price change,
 * Unrealized and value vs deposit. The headline is Generated (units per token); these stay out of the top strip so
 * the page doesn't lead with three near-identical dollar numbers. All from the server's metrics; no math here.
 *
 * No number twice on a screen: a page passes the figures it already shows elsewhere in `hide`, and rows whose value
 * comes out identical (a grid's price change is its unrealized; with nothing generated yet, Total P&L is the price
 * change) are merged into one row with both names instead of printing the same number twice. A page can put its own
 * breakdown of Generated first (the LP's fees earned − costs = Generated).
 */
import type { ReactNode } from 'react';
import { echoes, metricsOf } from './deskStats';
import { pct, usd } from './fmt';
import type { AnyObj } from './model';

const signed = (v: number | null | undefined) => (v == null ? '—' : usd(v, true));

/** A Details row: label, value, tooltip. */
export type DetailRow = [string, ReactNode, string?];
/** Rows a page can leave out because it already shows them: 'Total P&L', 'Value now' (keeps the deposit), or a label. */
export type DetailHide = 'Dollars made' | 'Total P&L' | 'Price change' | 'Unrealized' | 'Value now';

export function MoneyDetails({ b, breakdown, hide = [], note }: { b: AnyObj; breakdown?: DetailRow[]; hide?: readonly DetailHide[]; note?: string }) {
  const m = metricsOf(b);
  if (!m) return null;
  const no = new Set<string>(hide);
  const raw: [string, string, string][] = [
    ['Dollars made', signed(m.dollarsMadeUsd), 'Fees / round-trip profit minus gas, swap fees, taxes and range-move losses, each in dollars at the time it happened. Generated is the same counted in coins, valued at today\'s price.'],
    ['Total P&L', signed(m.totalPnlUsd), m.calc],
    ['Price change', signed(m.priceChangeUsd), 'Total P&L − Generated: what the coins\' own price did (unrealized IL and the inventory\'s market move).'],
    ['Unrealized', signed(m.unrealizedUsd), 'Open lots / the position\'s price side at today\'s price. Not in Generated until it is realized.'],
  ];
  // Dollars made usually prints the same as Generated's dollar value (in the headline) when the coin is a stablecoin
  if (raw[0][1] !== '—' && echoes(signed(m.generatedUsd), raw[0][1])) raw[0][1] = 'same as Generated\'s dollar value';
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
  const deposit = m.capitalInUsd == null ? '—' : usd(m.capitalInUsd);
  const value: [string, string, string] = no.has('Value now')
    ? ['Deposit', `${deposit} in`, 'The capital put in, in dollars at today\'s price.']
    : ['Value vs deposit', `${m.currentValueUsd == null ? '—' : usd(m.currentValueUsd)} now · ${deposit} in`, 'Current value of the bot\'s coins and the capital put in, in dollars at today\'s price.'];
  return (
    <details className="more money-details" data-testid="money-details">
      <summary>Details <span className="muted small">{note ?? 'dollars made, total P&L, price change'}</span></summary>
      <table className="stat-table"><tbody>
        {(breakdown ?? []).map(([k, v, t]) => <tr key={k} title={t} className="breakdown"><th>{k}</th><td className="mono">{v}</td></tr>)}
        {[...rows, value].map(([k, v, t]) => <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>)}
      </tbody></table>
    </details>
  );
}
