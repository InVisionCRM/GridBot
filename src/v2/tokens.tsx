import { useState } from 'react';
import type { TokenQty } from './metrics';
import { formatTokenLine, formatUsd } from './format';
import { usePhone } from './motion';

export function TokenLine({ tokens, usd = null, className = '' }: { tokens: TokenQty[] | null; usd?: number | null; className?: string }) {
  if (tokens == null) return <span className={className}>—</span>;
  if (!tokens.length) return <span className={className}>{usd === 0 ? '0' : '—'}</span>;
  return <span className={className}>{formatTokenLine(tokens)}</span>;
}

function mainToken(tokens: TokenQty[]): TokenQty {
  return [...tokens].sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0) || Math.abs(b.amount) - Math.abs(a.amount))[0];
}

/** On a 390px phone, three or more tokens collapse to the main one plus a chip. */
export function TokenHeadline({ tokens, usd = null }: { tokens: TokenQty[] | null; usd?: number | null }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone || open || !tokens || tokens.length < 3) return <TokenLine tokens={tokens} usd={usd} />;
  return (
    <span className="token-fold">
      <TokenLine tokens={[mainToken(tokens)]} />
      <button type="button" className="chip more" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        +{tokens.length - 1} more
      </button>
    </span>
  );
}

export function UsdLine({ value, sign = true }: { value: number | null; sign?: boolean }) {
  return <>{formatUsd(value, sign)}</>;
}
