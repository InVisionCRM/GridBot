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
