import { useLayoutEffect, useRef, useState } from 'react';
import type { TokenQty } from './metrics';
import { formatTokenLine } from './format';

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

export function TokenLine({
  tokens, usd = null, className = '', places = null,
}: {
  tokens: TokenQty[] | null;
  usd?: number | null;
  className?: string;
  places?: ReadonlyMap<string, number> | null;
}) {
  if (tokens == null) return <span className={className}>—</span>;
  if (!tokens.length) return <span className={className}>{usd === 0 ? '0' : '—'}</span>;
  return <span className={className}>{formatTokenLine(tokens, places)}</span>;
}

function mainToken(tokens: TokenQty[]): TokenQty {
  return [...tokens].sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0) || Math.abs(b.amount) - Math.abs(a.amount))[0];
}

function measureLine(sample: HTMLElement, text: string, px: number): number {
  const cs = getComputedStyle(sample);
  const probe = document.createElement('span');
  probe.textContent = text;
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};font-size:${px}px;`;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/** Full token line on one row. Shrink once, then a small pill, only when the measured line does not fit. */
export function TokenHeadline({
  tokens, usd = null, places = null,
}: {
  tokens: TokenQty[] | null;
  usd?: number | null;
  places?: ReadonlyMap<string, number> | null;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState<number | 'fold' | null>(null);
  const [open, setOpen] = useState(false);
  const text = tokens?.length ? formatTokenLine(tokens, places) : '';
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => {
      if (open || !tokens || tokens.length < 2) {
        setPx((cur) => (cur == null ? cur : null));
        return;
      }
      const sample = el.parentElement ?? el;
      const naturalPx = parseFloat(getComputedStyle(sample).fontSize) || HEADLINE_FLOOR_PX;
      const fitted = headlinePx(naturalPx, (size) => measureLine(sample, text, size), el.clientWidth);
      const next: number | 'fold' = fitted == null ? 'fold' : fitted;
      setPx((cur) => (cur === next ? cur : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text, tokens]);
  if (!tokens?.length) return <TokenLine tokens={tokens} usd={usd} places={places} />;
  const folded = px === 'fold' && !open && tokens.length >= 2;
  return (
    <span
      ref={host}
      className={`token-headline${open ? ' is-open' : ''}${folded ? ' is-fold' : ''}`}
      style={typeof px === 'number' && !open ? { fontSize: px } : undefined}
    >
      {folded ? (
        <span className="token-fold">
          <TokenLine tokens={[mainToken(tokens)]} places={places} />
          <button type="button" className="chip more" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
            +{tokens.length - 1} more
          </button>
        </span>
      ) : (
        <TokenLine tokens={tokens} usd={usd} places={places} />
      )}
    </span>
  );
}

