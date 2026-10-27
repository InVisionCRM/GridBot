/**
 * Slot for the LP range / compounding work landing on another branch.
 * Reachable from an LP bot. Demo toggles only. Does not send a transaction.
 */
import { useState } from 'react';

const WIDTHS = [1, 2, 5, 8, 12];

export function LpRangeSlot({ pair }: { pair: string }) {
  const [autoMove, setAuto] = useState(true);
  const [compound, setCompound] = useState(true);
  const [width, setWidth] = useState(8);
  return (
    <section className="slot" aria-label="Range and compounding">
      <header>
        <h3>Range and compounding</h3>
        <span className="demo-pill">Slot</span>
      </header>
      <p className="muted small">Kept reachable for {pair}. The live actions land with the range branch. Nothing here is sent.</p>
      <div className="slot-row">
        <span>Auto-move</span>
        <div className="seg">
          <button type="button" className={autoMove ? 'on' : ''} onClick={() => setAuto(true)}>On</button>
          <button type="button" className={!autoMove ? 'on' : ''} onClick={() => setAuto(false)}>Off</button>
        </div>
      </div>
      <div className="slot-row">
        <span>Fees</span>
        <div className="seg">
          <button type="button" className={compound ? 'on' : ''} onClick={() => setCompound(true)}>Compound</button>
          <button type="button" className={!compound ? 'on' : ''} onClick={() => setCompound(false)}>Send</button>
        </div>
      </div>
      <div className="slot-row">
        <span>Width</span>
        <div className="seg">
          {WIDTHS.map((w) => <button key={w} type="button" className={width === w ? 'on' : ''} onClick={() => setWidth(w)}>±{w}%</button>)}
        </div>
      </div>
    </section>
  );
}
