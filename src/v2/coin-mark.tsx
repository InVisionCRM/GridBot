/** A letter mark. Stablecoins do not use a dollar glyph. */
export function CoinMark({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const letter = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="rgba(255,255,255,0.08)" />
      <text x="16" y="21" textAnchor="middle" fontSize="14" fill="currentColor" fontFamily="var(--font)">{letter}</text>
    </svg>
  );
}
