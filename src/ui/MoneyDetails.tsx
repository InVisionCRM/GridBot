/**
 * The secondary money figures, collapsed under "Details" on every bot page: Dollars made, Total P&L, Price change,
 * Unrealized and value vs deposit. The headline is Generated (units per token); these stay out of the top strip so
 * the page doesn't lead with three near-identical dollar numbers. All from the server's metrics; no math here.
 */
import { metricsOf } from './deskStats';
import { pct, usd } from './fmt';
import type { AnyObj } from './model';

const signed = (v: number | null | undefined) => (v == null ? '—' : usd(v, true));

export function MoneyDetails({ b }: { b: AnyObj }) {
  const m = metricsOf(b);
  if (!m) return null;
  const rows: [string, string, string][] = [
    ['Dollars made', signed(m.dollarsMadeUsd), 'Fees / round-trip profit minus gas, swap fees, taxes and range-move losses, each in dollars at the time it happened. Generated is the same counted in coins, valued at today\'s price.'],
    ['Total P&L', `${signed(m.totalPnlUsd)}${m.totalPnlPct == null ? '' : ` · ${pct(m.totalPnlPct, 2, true)} of capital in`}`, m.calc],
    ['Price change', signed(m.priceChangeUsd), 'Total P&L − Generated: what the coins\' own price did (unrealized IL and the inventory\'s market move).'],
    ['Unrealized', signed(m.unrealizedUsd), 'Open lots / the position\'s price side at today\'s price. Not in Generated until it is realized.'],
    ['Value vs deposit', `${m.currentValueUsd == null ? '—' : usd(m.currentValueUsd)} now · ${m.capitalInUsd == null ? '—' : usd(m.capitalInUsd)} in`, 'Current value of the bot\'s coins and the capital put in, in dollars at today\'s price.'],
  ];
  return (
    <details className="more money-details" data-testid="money-details">
      <summary>Details <span className="muted small">dollars made, total P&amp;L, price change</span></summary>
      <table className="stat-table"><tbody>
        {rows.map(([k, v, t]) => <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>)}
      </tbody></table>
    </details>
  );
}
