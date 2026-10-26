/** Small charts. Strokes and tracks come from --chart-* so a later style pass can restyle them. */

export function Sparkline({ points, width = 132, height = 44 }: { points: number[]; width?: number; height?: number }) {
  const w = width, h = height;
  const p = points.length > 1 ? points : [0, 0];
  const min = Math.min(...p), max = Math.max(...p), span = max - min || 1;
  const flat = max - min === 0;
  const d = p.map((y, i) => {
    const x = (i / (p.length - 1)) * (w - 2) + 1;
    const yy = flat ? h / 2 : h - 4 - ((y - min) / span) * (h - 8);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`;
  }).join(' ');
  const last = p[p.length - 1] ?? 0;
  const tone = last > 0 ? 'var(--chart-up)' : last < 0 ? 'var(--chart-down)' : 'var(--chart-flat)';
  return (
    <svg className="chart sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={tone} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Price sitting in (or outside) a liquidity range. */
export function RangeBar({ lower, upper, price, inRange }: { lower: number; upper: number; price: number | null; inRange: boolean | null }) {
  if (!(upper > lower)) return null;
  const span = upper - lower;
  const pad = span * 0.4;
  const lo = lower - pad, hi = upper + pad;
  const at = (x: number) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const px = price == null ? null : at(price);
  return (
    <span className={`chart rangebar${inRange === false ? ' out' : ''}`} title={inRange === false ? 'Out of range' : 'In range'}>
      <i style={{ left: `${at(lower)}%`, width: `${Math.max(4, at(upper) - at(lower))}%` }} />
      {px != null && <b style={{ left: `${px}%` }} />}
    </span>
  );
}

/** A 0–1 bar. `value` is a fraction. */
export function Meter({ value }: { value: number }) {
  const w = Math.max(0, Math.min(1, value));
  return (
    <span className="chart meter" aria-hidden="true">
      <i style={{ width: `${w * 100}%` }} />
    </span>
  );
}
