/** Short human-readable token amounts for messages: 10749500 → "10.75M", 324533 → "324.5K", 0.012345 → "0.01235". */
export function humanAmount(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x), sign = x < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${+(a / 1e9).toPrecision(4)}B`;
  if (a >= 1e6) return `${sign}${+(a / 1e6).toPrecision(4)}M`;
  if (a >= 1e4) return `${sign}${+(a / 1e3).toPrecision(4)}K`;
  if (a >= 1) return `${sign}${+a.toFixed(2)}`;
  return `${sign}${+a.toPrecision(4)}`;
}
