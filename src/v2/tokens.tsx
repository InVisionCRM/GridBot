import type { TokenQty } from './metrics';
import { formatTokenLine, formatUsd } from './format';

export function TokenLine({ tokens, usd = null, className = '' }: { tokens: TokenQty[] | null; usd?: number | null; className?: string }) {
  if (tokens == null) return <span className={className}>—</span>;
  if (!tokens.length) return <span className={className}>{usd === 0 ? '0' : '—'}</span>;
  return <span className={className}>{formatTokenLine(tokens)}</span>;
}

export function UsdLine({ value, sign = true }: { value: number | null; sign?: boolean }) {
  return <>{formatUsd(value, sign)}</>;
}
