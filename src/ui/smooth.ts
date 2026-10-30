/** Canvas line shapes shared by the home's Banked chart and the Wallet's dollar chart. */
/**
 * A smooth line through the points, never overshooting them (monotone cubic, as d3's curveMonotoneX): the curve only
 * rises where the total rose, and stays flat where it stayed flat. Points on the same x keep the later one.
 */
export function smoothPath(raw: [number, number][]): Path2D {
  const p: [number, number][] = [];
  for (const q of raw) { if (p.length && q[0] - p[p.length - 1][0] < 0.5) p[p.length - 1] = [p[p.length - 1][0], q[1]]; else p.push(q); }
  const path = new Path2D();
  path.moveTo(p[0][0], p[0][1]);
  if (p.length < 3) { for (const q of p.slice(1)) path.lineTo(q[0], q[1]); return path; }
  const n = p.length, s: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) s.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  m.push(s[0]);
  for (let i = 1; i < n - 1; i++) {
    const h0 = p[i][0] - p[i - 1][0], h1 = p[i + 1][0] - p[i][0], c = (s[i - 1] * h1 + s[i] * h0) / (h0 + h1);
    m.push(s[i - 1] * s[i] <= 0 ? 0 : (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(c)));
  }
  m.push(s[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const d = (p[i + 1][0] - p[i][0]) / 3;
    path.bezierCurveTo(p[i][0] + d, p[i][1] + d * m[i], p[i + 1][0] - d, p[i + 1][1] - d * m[i + 1], p[i + 1][0], p[i + 1][1]);
  }
  return path;
}
