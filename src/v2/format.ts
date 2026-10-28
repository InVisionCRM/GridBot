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

/** Round half away from zero so displayed ledger lines use one scale. */
export function roundAmt(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const x = Math.round((Math.abs(n) + Number.EPSILON) * f) / f;
  return n < 0 ? -x : x;
}

function minDecimals(n: number): number {
  const a = Math.abs(n);
  if (!(a > 0)) return 0;
  if (a >= 100) return 1;
  if (a >= 1) return 2;
  return Math.max(0, Math.ceil(-Math.log10(a)) + 2);
}

/**
 * Decimal scale at which the shown gross, costs, and generated add up,
 * without collapsing a coin down to a coarser figure than its size needs.
 * Costs are passed as positive magnitudes.
 */
export function ledgerDecimals(gross: number, paid: number, move: number): number {
  const generated = gross - paid - move;
  const start = Math.max(minDecimals(gross), minDecimals(paid), minDecimals(move), minDecimals(generated));
  for (let d = start; d <= 12; d++) {
    const g = roundAmt(gross, d);
    const p = roundAmt(-Math.abs(paid), d);
    const m = roundAmt(-Math.abs(move), d);
    const gen = roundAmt(generated, d);
    if (roundAmt(g + p + m, d) === gen) return d;
  }
  return 12;
}

/** Fixed decimals, with a sign. Trailing zeros stay so the ledger still adds up. */
export function formatFixedAmt(n: number, decimals: number): string {
  const r = roundAmt(n, decimals);
  const sign = r < 0 ? '−' : r > 0 ? '+' : '';
  return `${sign}${Math.abs(r).toFixed(decimals)}`;
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

/** A price with the dollar sign removed, so the quote token can be named beside it. */
export function formatUnitPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return formatPx(Math.abs(x)).replace(/^\$/, '');
}

/** Tape and range price: `2,342.18 USDC`, never `$2,342.18`. */
export function formatQuotePx(amount: number | null | undefined, quote: string): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const unit = quote.trim();
  return unit ? `${formatUnitPx(amount)} ${unit}` : formatUnitPx(amount);
}

/** `2,307.72 – 2,356.69 USDC per ETH`. */
export function formatRangePx(lower: number, upper: number, quote: string, base: string): string {
  return `${formatUnitPx(lower)} – ${formatUnitPx(upper)} ${quote} per ${base}`;
}

function plainAmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e9) return `${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a >= 100) return a.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 1) return a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number(a.toPrecision(3)).toString();
}

/** Deposited coins, without a gain sign. `3.50 ETH + 1,000 USDC`. */
export function formatBag(tokens: { symbol: string; amount: number }[] | null | undefined): string {
  if (!tokens?.length) return '—';
  return tokens.map((t) => `${plainAmt(t.amount)} ${t.symbol}`).join(' + ');
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

/** A real zero with nothing earned yet. Unknown (null) stays a dash in the view. */
export function showsNoFills(m: { generated: { amount: number }[]; generatedUsd: number | null; fillCount: number | null }): boolean {
  if (m.generatedUsd !== 0) return false;
  if (m.generated.some((t) => t.amount !== 0)) return false;
  return m.fillCount === 0 || m.fillCount == null;
}

/** Collapse long decimals in a log line. Display only; the full line stays on the item. */
export function shortenFigures(text: string): string {
  return text.replace(/[+-]?\d[\d,]*(?:\.\d+)?/g, (raw) => {
    const body = raw.replace(/,/g, '');
    const frac = body.split('.')[1] ?? '';
    if (frac.length < 4) return raw;
    const n = Number(body);
    if (!Number.isFinite(n)) return raw;
    const sig = Math.abs(n) >= 1 ? 4 : 3;
    return String(Number(n.toPrecision(sig)));
  });
}

/** Hour and minute in America/Detroit, labeled ET. */
export function formatClockEt(ms: number): string {
  const clock = new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/Detroit',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${clock.replace(/\u202f/g, ' ')} ET`;
}

/** One header pill. Green Live only for a live source that is still connected. */
export function deskStatusPill(source: string, asOf: number, stale: boolean): { text: string; tone: 'live' | 'snap' | 'stale' } {
  if (source === 'live' && !stale) return { text: 'Live', tone: 'live' };
  if (source === 'live') return { text: 'Stale', tone: 'stale' };
  return { text: `Snapshot · ${formatClockEt(asOf)}`, tone: 'snap' };
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

/** Date and clock in America/Detroit, for a frozen snapshot label. */
export function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Detroit',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}
