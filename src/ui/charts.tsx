/** Small charts. Strokes and tracks come from --chart-* so the desk palette restyles them. */
import { rangeTone } from './series';

function lineOf(points: number[], w: number, h: number) {
  const p = points.length > 1 ? points : [0, 0];
  const min = Math.min(...p), max = Math.max(...p), span = max - min || 1;
  const flat = max - min === 0;
  const xy = p.map((y, i) => {
    const x = (i / (p.length - 1)) * (w - 2) + 1;
    const yy = flat ? h / 2 : h - 4 - ((y - min) / span) * (h - 8);
    return [x, yy] as const;
  });
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { d, xy, flat };
}

export function Sparkline({ points, width = 132, height = 44 }: { points: number[]; width?: number; height?: number }) {
  const { d } = lineOf(points, width, height);
  const last = points[points.length - 1] ?? 0;
  const first = points[0] ?? 0;
  const tone = last > first ? 'var(--chart-up)' : last < first ? 'var(--chart-down)' : 'var(--chart-flat)';
  return (
    <svg className="chart sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={tone} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}



/** Price sitting in (or outside) a liquidity or grid range. Ticks mark the band; the dot glows. */
export function RangeBar({ lower, upper, price, inRange, wide }: { lower: number; upper: number; price: number | null; inRange: boolean | null; wide?: boolean }) {
  if (!(upper > lower)) return null;
  const tone = rangeTone(lower, upper, price, inRange);
  const span = upper - lower;
  const pad = span * 0.35;
  const lo = lower - pad, hi = upper + pad;
  const at = (x: number) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const px = price == null ? null : at(price);
  const ticks = [lower, lower + span / 2, upper];
  return (
    <span className={`chart rangebar ${tone}${wide ? ' wide' : ''}`} title={tone === 'out' ? 'Out of range' : tone === 'near' ? 'Near edge' : 'In range'}>
      <i className="fill" style={{ left: `${at(lower)}%`, width: `${Math.max(4, at(upper) - at(lower))}%` }} />
      {ticks.map((t) => <span key={t} className="tick" style={{ left: `${at(t)}%` }} />)}
      {px != null && <b style={{ left: `${px}%` }} />}
      {tone === 'near' && wide && <em>near edge</em>}
    </span>
  );
}

