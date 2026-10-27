/** Display formatting only. No money is derived here. */
import { pct, usd } from '../ui/fmt';

export { pct, usd };

const SUB = '₀₁₂₃₄₅₆₇₈₉';

function sub(n: number): string {
  return String(n).split('').map((d) => SUB[Number(d)] ?? d).join('');
}

/**
 * Prices that are far below one cent. Subscript is the count of zeros after the decimal.
 * 0.00000509 → $0.0₅509
 */
export function formatPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x < 0 ? '−' : '';
  const a = Math.abs(x);
  if (a === 0) return '$0';
  if (a >= 1000) return `${sign}$${a.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (a >= 1) return `${sign}$${a.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (a >= 0.0001) {
    const digits = a >= 0.01 ? 4 : 6;
    return `${sign}$${a.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
  }
  const exp = Math.floor(Math.log10(a));
  const zeros = -exp - 1;
  const sig = (a / 10 ** exp).toPrecision(3).replace('.', '').replace(/e.*/, '').slice(0, 3).replace(/0+$/, '');
  return `${sign}$0.0${sub(zeros)}${sig || '0'}`;
}

/** Dollars. Sub-cent amounts use the price notation instead of rounding to $0.00. */
export function formatUsd(x: number | null | undefined, sign = false): string {
  if (x == null || !Number.isFinite(x)) return '—';
  if (x !== 0 && Math.abs(x) < 0.01) {
    const body = formatPx(x);
    return sign && x > 0 ? `+${body}` : body;
  }
  return usd(x, sign);
}

export function formatAmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a >= 100) return `${sign}${a.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
  if (a >= 1) return `${sign}${a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const body = Number(a.toPrecision(3)).toString();
  return `${sign}${body}`;
}

export function formatTokenLine(tokens: { symbol: string; amount: number }[] | null | undefined): string {
  if (!tokens?.length) return '—';
  return tokens.map((t, i) => {
    const amt = formatAmt(t.amount);
    if (i === 0) return `${amt} ${t.symbol}`;
    if (t.amount < 0) return `${amt} ${t.symbol}`;
    return `+ ${amt.replace(/^\+/, '')} ${t.symbol}`;
  }).join(' ');
}

export function formatAge(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = s / 3600;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Clock time in America/Detroit, not the server's UTC. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/Detroit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}
