import { motion } from 'motion/react';
import { useId, useState } from 'react';

/** Draws a server series. Geometry only. */
export function EquityCurve({ points }: { points: number[] }) {
  const id = useId().replace(/:/g, '');
  const [drew, setDrew] = useState(false);
  const w = 760;
  const h = 168;
  const p = points.length > 1 ? points : [0, 0];
  const min = Math.min(...p);
  const max = Math.max(...p);
  const span = max - min || 1;
  const xy = p.map((y, i) => {
    const x = (i / (p.length - 1)) * (w - 12) + 6;
    const yy = h - 18 - ((y - min) / span) * (h - 36);
    return [x, yy] as const;
  });
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  const area = `${d} L${last[0].toFixed(1)} ${h} L${xy[0][0].toFixed(1)} ${h} Z`;
  const up = p[p.length - 1] >= p[0];
  const stroke = up ? '#0ECB81' : '#F6465D';
  return (
    <svg className="equity" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Generated over time">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.38" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <motion.path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={drew ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.15, ease: [0.22, 1, 0.36, 1] }}
        onAnimationComplete={() => setDrew(true)}
      />
      <motion.circle
        cx={last[0]}
        cy={last[1]}
        r="4.5"
        fill={stroke}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: drew ? 0 : 0.9 }}
      />
    </svg>
  );
}

export function Spark({ points }: { points: number[] }) {
  const p = points.length > 1 ? points : [0, 0];
  const min = Math.min(...p);
  const max = Math.max(...p);
  const span = max - min || 1;
  const w = 112;
  const h = 32;
  const d = p.map((y, i) => {
    const x = (i / (p.length - 1)) * (w - 2) + 1;
    const yy = h - 3 - ((y - min) / span) * (h - 6);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`;
  }).join(' ');
  const up = p[p.length - 1] >= p[0];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={up ? '#0ECB81' : '#F6465D'} strokeWidth="1.6" pathLength={1} />
    </svg>
  );
}
