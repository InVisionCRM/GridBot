import type { RangeBlock } from './metrics';

/** Places the server's current price inside the server's range. Layout only. */
export function RangeTrack({ range, tone }: { range: RangeBlock | null; tone: 'in' | 'near' | 'out' | 'idle' }) {
  if (!range || !(range.upper > range.lower)) return <span className="range-empty">No range</span>;
  const span = range.upper - range.lower;
  const pad = span * 0.28;
  const lo = range.lower - pad;
  const hi = range.upper + pad;
  const at = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const left = at(range.lower);
  const right = at(range.upper);
  return (
    <span className={`range-track tone-${tone}`} title={tone === 'out' ? 'Out of range' : tone === 'near' ? 'Near the edge' : 'In range'}>
      <i style={{ left: `${left}%`, width: `${Math.max(4, right - left)}%` }} />
      <b style={{ left: `${at(range.current)}%` }} />
    </span>
  );
}
