import type { TokenQty } from './metrics';
import { formatTokenLine, tokenLineParts } from './format';

/** Smallest headline size before a line becomes a "+N more" pill. */
export const HEADLINE_FLOOR_PX = 22;

/**
 * Largest whole-pixel size at or below the natural size that fits in `available`.
 * Null means even the floor overflows, so the line should fold.
 * A missing width keeps the natural size.
 */
export function headlinePx(
  naturalPx: number,
  widthAt: (px: number) => number,
  available: number,
  floor = HEADLINE_FLOOR_PX,
): number | null {
  if (!(available > 0)) return Math.round(naturalPx);
  const natural = Math.round(naturalPx);
  if (widthAt(natural) <= available) return natural;
  const min = natural > floor ? floor : Math.max(13, natural - 2);
  for (let px = natural - 1; px >= min; px -= 1) {
    if (widthAt(px) <= available) return px;
  }
  return null;
}

export function TokenLine({ tokens, usd = null, className = '' }: { tokens: TokenQty[] | null; usd?: number | null; className?: string }) {
  if (tokens == null || !tokens.length) return <span className={className}>—</span>;
  void usd;
  return <span className={className}>{formatTokenLine(tokens)}</span>;
}

/** Every coin, wrapping between coins. A headline never hides the rest behind “+N more”. */
export function TokenHeadline({ tokens, usd = null }: { tokens: TokenQty[] | null; usd?: number | null }) {
  if (!tokens?.length) return <TokenLine tokens={tokens} usd={usd} />;
  const parts = tokenLineParts(tokens);
  return (
    <span className="token-headline is-open bag-line">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="bag-part">
          {i > 0 && ' '}
          <span className="bag-coin">{part}</span>
        </span>
      ))}
    </span>
  );
}

