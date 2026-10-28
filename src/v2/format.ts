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

/** Round half away from zero to a fixed number of decimal places. */
export function roundAmt(n: number, places: number): number {
  const f = 10 ** places;
  const x = Math.round((Math.abs(n) + Number.EPSILON) * f) / f;
  return n < 0 ? -x : x;
}

/** Decimal places `formatAmt` starts from. Amounts of 1 or more start at 2. */
export function naturalPlaces(n: number): number {
  const a = Math.abs(n);
  if (!(a > 0) || a >= 1) return 2;
  return Math.min(6, Math.max(0, 3 - Math.floor(Math.log10(a))));
}

/** Step size of `formatAmt` for this amount. Breakdown rows for a coin share its Generated step. */
export function standardUnit(n: number): number {
  const a = Math.abs(n);
  if (!(a > 0)) return 1;
  if (a >= 1e9) return 1e7;
  if (a >= 1e6) return 1e4;
  if (a >= 1e5) return 1e3;
  if (a >= 1e4) return 1e2;
  return 10 ** -naturalPlaces(n);
}

/** The number `formatAmt` actually shows, so parts can be aimed at that figure. */
export function displayedValue(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const text = formatAmt(n).replace(/^[+−-]/, '').replace(/,/g, '');
  const suffix = text.match(/[kMB]$/)?.[0];
  const scale = suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  const mantissa = Number(text.replace(/[kMB]$/, ''));
  return (n < 0 ? -1 : 1) * mantissa * scale;
}

/**
 * Largest-remainder rounding. Each part moves by at most one `unit`,
 * and the parts then equal `target`.
 */
export function apportion(parts: number[], target: number, unit: number): number[] {
  if (!parts.length || !(unit > 0)) return parts.slice();
  const scaled = parts.map((part) => part / unit);
  const goal = roundAmt(target / unit, 0);
  const base = scaled.map((value) => {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) < 1e-6 ? nearest : Math.floor(value);
  });
  const remainders = scaled.map((value, i) => value - base[i]);
  let gap = goal - base.reduce((sum, value) => sum + value, 0);
  const order = remainders.map((remainder, index) => ({ remainder, index }));
  order.sort((a, b) => gap >= 0 ? b.remainder - a.remainder || a.index - b.index : a.remainder - b.remainder || a.index - b.index);
  const step = gap >= 0 ? 1 : -1;
  let left = Math.abs(gap);
  let pass = 0;
  while (left > 0 && pass < 4) {
    for (const item of order) {
      if (left <= 0) break;
      base[item.index] += step;
      left -= 1;
    }
    pass += 1;
  }
  return base.map((value) => value * unit);
}

/** Fixed fraction digits for a breakdown part. Amounts of 1 or more stay at 2 when `places` is 2. */
export function formatFixedDecimals(n: number, places: number): string {
  const r = roundAmt(n, Math.max(0, places));
  if (!Number.isFinite(r) || r === 0) return '0';
  const sign = r < 0 ? '−' : '+';
  const [whole, frac] = Math.abs(r).toFixed(Math.max(0, places)).split('.');
  const body = `${Number(whole).toLocaleString('en-US')}${frac != null ? `.${frac}` : ''}`;
  return `${sign}${body}`;
}

function trimFraction(text: string): string {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/**
 * One token-amount rule for every bot.
 * Under 1: at most 6 decimals, about 4 significant digits.
 * At least 1: 2 decimals, with thousands commas.
 * At least 10,000: compact k/M.
 */
export function formatAmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  if (a === 0) return '0';
  let body: string;
  if (a >= 1e9) body = `${(a / 1e9).toFixed(2)}B`;
  else if (a >= 1e6) body = `${(a / 1e6).toFixed(2)}M`;
  else if (a >= 1e4) body = `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  else if (a >= 1) body = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else {
    const places = Math.min(6, Math.max(0, 3 - Math.floor(Math.log10(a))));
    body = trimFraction(a.toFixed(places));
    if (body === '0') return '0';
  }
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

function rangeBound(n: number): string {
  const a = Math.abs(n);
  if (!(a > 0)) return '0.00';
  if (a >= 1) return a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatUnitPx(n);
}

/** `2,307.72 – 2,356.69 USDC per ETH`. Bounds of 1 or more always show 2 decimals. */
export function formatRangePx(lower: number, upper: number, quote: string, base: string): string {
  return `${rangeBound(lower)} – ${rangeBound(upper)} ${quote} per ${base}`;
}

function plainAmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return formatAmt(Math.abs(n)).replace(/^[+−]/, '');
}

function isShownZero(amount: number): boolean {
  return amount === 0 || formatAmt(amount) === '0';
}

/** Drop zero coins when another coin is non-zero. Keep `0 X` only when every part is zero. */
function coinsToShow<T extends { amount: number }>(tokens: T[]): T[] {
  const finite = tokens.filter((t) => Number.isFinite(t.amount));
  const nonzero = finite.filter((t) => !isShownZero(t.amount));
  return nonzero.length ? nonzero : finite;
}

/** Deposited coins, without a gain sign. `3.50 ETH + 1,000 USDC`. */
export function formatBag(tokens: { symbol: string; amount: number }[] | null | undefined): string {
  if (!tokens?.length) return '—';
  return coinsToShow(tokens).map((t) => `${plainAmt(t.amount)} ${t.symbol}`).join(' + ');
}

/** Pieces of a generated line. The first keeps its sign; later positives read `+ 1.00 ETH`. */
export function tokenLineParts(tokens: { symbol: string; amount: number }[]): string[] {
  return coinsToShow(tokens).map((t, i) => {
    const amt = formatAmt(t.amount);
    if (i === 0) return `${amt} ${t.symbol}`;
    if (t.amount < 0 || isShownZero(t.amount)) return `${amt} ${t.symbol}`;
    return `+ ${amt.replace(/^\+/, '')} ${t.symbol}`;
  });
}

/** One line of signed token amounts, always in the standard format. `+65.04 USDG + 0.01531 ETH`. */
export function formatTokenLine(tokens: { symbol: string; amount: number }[] | null | undefined): string {
  if (!tokens?.length) return '—';
  const parts = tokenLineParts(tokens);
  return parts.length ? parts.join(' ') : '—';
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
