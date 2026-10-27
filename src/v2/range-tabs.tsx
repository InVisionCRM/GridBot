export const RANGES = ['1H', '1D', '1W', '1M', 'ALL'] as const;
export type RangeKey = (typeof RANGES)[number];

const WINDOW_MS: Record<Exclude<RangeKey, 'ALL'>, number> = {
  '1H': 3_600_000,
  '1D': 86_400_000,
  '1W': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
};

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }) {
  return (
    <div className="seg" role="tablist" aria-label="Chart range">
      {RANGES.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={key === value ? 'on' : ''}
          onClick={() => onChange(key)}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

/** Candles carry timestamps. A plain series does not, so only ALL can draw it. */
export function candlesInRange<T extends { t: number }>(candles: T[], range: RangeKey, asOf: number): T[] {
  if (range === 'ALL') return candles;
  const start = asOf - WINDOW_MS[range];
  return candles.filter((c) => c.t >= start);
}
