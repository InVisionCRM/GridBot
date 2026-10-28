/**
 * A bot's "Value over time" chart (value line + drawdown), collapsed and closed by default (Kyle, #73): a value that moves
 * with the coin price may only show inside a collapsed Details. The chart mounts only once the section is opened (a chart
 * in a closed section would have no size), with the same data and math as before (EquityChart). The page's Value now row
 * moves with the price too, so it sits here (children) rather than in the open stat table.
 */
import { useState, type ReactNode } from 'react';
import { EquityChart } from './Chart';
import { T } from './theme';

export function ValueOverTime({ q, note, data, children, initialOpen = false }: {
  /** The quote coin the value is in. */
  q: string;
  /** What the value counts, after the coin ("after gas, …"). */
  note?: ReactNode;
  data: [number, number][];
  /** Shown with the chart when opened: the value now (it moves with the price too). */
  children?: ReactNode;
  /** Tests only: render opened. The pages always start closed. */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details className="card net-details value-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Details: value over time <span className="muted small">in {q}{note ? <>, {note}</> : null}, moves with the price</span></summary>
      {open && <>{children}<EquityChart series={[{ name: `value ${q}`, data, color: T.text }]} /></>}
    </details>
  );
}
