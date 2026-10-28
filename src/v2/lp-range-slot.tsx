/**
 * Range and compounding controls. They are on screen so the slot stays reachable.
 * Nothing here sends a transaction.
 */
const WIDTHS = [1, 2, 5, 8, 12];

export function LpRangeSlot({ pair }: { pair: string }) {
  return (
    <section className="slot" aria-label="Range and compounding">
      <header>
        <h3>Range and compounding</h3>
      </header>
      <p className="muted small">Not wired up yet. Tapping these does nothing. Kept here for {pair}.</p>
      <div className="slot-row">
        <span>Auto-move</span>
        <div className="seg">
          <button type="button" disabled>On</button>
          <button type="button" disabled>Off</button>
        </div>
      </div>
      <div className="slot-row">
        <span>Fees</span>
        <div className="seg">
          <button type="button" disabled>Compound</button>
          <button type="button" disabled>Send</button>
        </div>
      </div>
      <div className="slot-row">
        <span>Width</span>
        <div className="seg">
          {WIDTHS.map((w) => <button key={w} type="button" disabled>±{w}%</button>)}
        </div>
      </div>
    </section>
  );
}
