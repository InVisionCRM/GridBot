/** Small charts. Strokes and tracks come from --chart-* so the desk palette restyles them. */
import { useId } from 'react';
import { pct } from './fmt';
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

/** Filled area of a real series. Flat when every point is the same. */
export function AreaChart({ points }: { points: number[] }) {
  const w = 640, h = 220;
  const { d, xy } = lineOf(points, w, h);
  const id = useId();
  const last = points[points.length - 1] ?? 0;
  const first = points[0] ?? 0;
  const tone = last >= first ? 'var(--chart-up)' : 'var(--chart-down)';
  const end = xy[xy.length - 1]?.[0] ?? w;
  const area = `${d} L${end.toFixed(1)} ${h} L1 ${h} Z`;
  return (
    <svg className="chart area" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Portfolio value">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke">
        {[0.25, 0.5, 0.75].map((p) => <line key={`h${p}`} x1="0" x2={w} y1={h * p} y2={h * p} />)}
        {[0.25, 0.5, 0.75].map((p) => <line key={`v${p}`} y1="0" y2={h} x1={w * p} x2={w * p} />)}
      </g>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={tone} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Donut({ slices }: { slices: { key: string; label: string; usd: number; color: string }[] }) {
  const total = slices.reduce((a, s) => a + s.usd, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className="donut">
      <div className="donut-ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r={r} fill="none" stroke="var(--line)" strokeWidth="12" />
          {total > 0 && slices.map((s) => {
            const len = (s.usd / total) * c;
            const el = (
              <circle key={s.key} cx="60" cy="60" r={r} fill="none" stroke={s.color} strokeWidth="12"
                strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`} strokeDashoffset={(-off).toFixed(2)} transform="rotate(-90 60 60)" />
            );
            off += len;
            return el;
          })}
        </svg>
        {/* the total is the net worth beside it, so the middle counts the slices instead (each figure once per screen) */}
        <span className="donut-total">{slices.length === 1 ? '1 chain' : `${slices.length} chains`}</span>
      </div>
      <ul>
        {slices.map((s) => (
          <li key={s.key}><i style={{ background: s.color }} />{s.label}<b>{slices.length === 1 ? 'all of it' : pct(s.usd / total, 0)}</b></li>
        ))}
        {!slices.length && <li className="muted">No balances yet</li>}
      </ul>
    </div>
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

/** A 0–1 bar. `value` is a fraction. */
export function Meter({ value }: { value: number }) {
  const w = Math.max(0, Math.min(1, value));
  return (
    <span className="chart meter" aria-hidden="true">
      <i style={{ width: `${w * 100}%` }} />
    </span>
  );
}
