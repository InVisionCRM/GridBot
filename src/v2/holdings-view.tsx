import type { HoldingLine } from './metrics';
import { formatBag } from './format';

/** Wallet and position coins. No dollar total. */
export function HoldingsView({ rows }: { rows: HoldingLine[] }) {
  const chains = [...new Set(rows.map((r) => r.chain || 'Chain'))];
  return (
    <div className="holdings">
      <h1>Holdings</h1>
      {!rows.length && <p className="muted">No token balances in this snapshot.</p>}
      {chains.map((chain) => {
        const mine = rows.filter((r) => (r.chain || 'Chain') === chain && r.amount !== 0);
        if (!mine.length) return null;
        return (
          <section key={chain}>
            <h2 className="group-title"><span className="section-name">{chain}</span></h2>
            <ul className="bot-list">
              {mine.map((row) => (
                <li key={`${chain}-${row.symbol}-${row.amount}`} className="bot-card glass">
                  <p className="card-made"><span>{row.symbol}</span> {formatBag([row])}</p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
