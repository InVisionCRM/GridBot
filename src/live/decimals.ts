/**
 * Token decimals + exact amount conversion. Decimals are ALWAYS read on-chain (`decimals()`), cached per
 * chain + address, and compared against whatever a market definition stored; a mismatch refuses to trade.
 *
 * Handled cases:
 *  - `decimals()` returning uint8 (standard) or uint256 (some old tokens): the 32-byte word is decoded as uint256
 *    either way, so both work; values > 255 are rejected as garbage.
 *  - missing `decimals()` (revert / empty return): rejected — the token cannot be priced safely.
 *  - 0 decimals: supported (amounts are whole tokens) with a warning.
 *  - more than 18 decimals (e.g. 24): supported — all on-chain amounts are bigint; capped at 36 (MAX_DECIMALS).
 */

export const MAX_DECIMALS = 36;

export interface DecimalsReader { call(tx: { to: string; data: string }): Promise<string> }

/** keccak256("decimals()")[0:4] */
export const DECIMALS_SELECTOR = '0x313ce567';

/** Decode the raw eth_call return of decimals(). Throws on missing / malformed / out-of-range values. */
export function parseDecimalsWord(raw: string | null | undefined, token = 'token'): number {
  if (!raw || raw === '0x' || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error(`${token}: decimals() returned nothing — not a standard ERC-20, refusing`);
  const hex = raw.slice(2);
  if (hex.length < 64) throw new Error(`${token}: decimals() returned ${hex.length / 2} bytes (need a 32-byte word) — refusing`);
  const v = BigInt('0x' + hex.slice(0, 64));
  if (v > 255n) throw new Error(`${token}: decimals() = ${v} is not a valid decimals value — refusing`);
  const n = Number(v);
  if (n > MAX_DECIMALS) throw new Error(`${token}: ${n} decimals is above the supported maximum of ${MAX_DECIMALS}`);
  return n;
}

export function decimalsWarning(d: number): string | null {
  if (d === 0) return 'Token has 0 decimals: amounts are whole tokens, so small orders round down (possibly to zero).';
  if (d > 18) return `Token has ${d} decimals (> 18): amounts are handled as exact integers; displayed values are rounded.`;
  if (![6, 8, 9, 18].includes(d)) return `Unusual decimals (${d}) — amounts are scaled by 10^${d}.`;
  return null;
}

const cache = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

/** Read decimals() on-chain once per chain + address (cached for the process lifetime; decimals never change). */
export async function readDecimals(reader: DecimalsReader, chainId: number, address: string): Promise<number> {
  const k = `${chainId}:${address.toLowerCase()}`;
  const hit = cache.get(k);
  if (hit != null) return hit;
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = (async () => {
    let raw: string;
    try { raw = await reader.call({ to: address, data: DECIMALS_SELECTOR }); } catch (e) {
      throw new Error(`${address}: decimals() reverted (${(e as Error).message.slice(0, 80)}) — refusing`);
    }
    const d = parseDecimalsWord(raw, address);
    cache.set(k, d);
    return d;
  })();
  inflight.set(k, p);
  try { return await p; } finally { inflight.delete(k); }
}

export function cachedDecimals(chainId: number, address: string): number | undefined { return cache.get(`${chainId}:${address.toLowerCase()}`); }
export function clearDecimalsCache() { cache.clear(); inflight.clear(); }

/** Plain decimal string (no exponent) of a finite non-negative number at `sig` (≤ 15) significant digits, never above x. */
export function plainDecimal(x: number, sig = 15): string {
  if (!Number.isFinite(x) || x < 0) throw new Error(`Invalid amount: ${x}`);
  if (x === 0) return '0';
  const p = Math.min(sig, 15);
  let [mant, expS] = x.toExponential(p - 1).split('e');
  // Never above the float: if rounding to p digits went up, step the last digit down (floor at p significant digits).
  if (Number(`${mant}e${expS}`) > x) {
    let ds = (BigInt(mant.replace('.', '')) - 1n).toString();
    if (ds.length < p) { ds += '9'; expS = String(Number(expS) - 1); } // 1.000…e+n − 1 digit = 9.99…e+(n−1)
    mant = `${ds.slice(0, 1)}.${ds.slice(1)}`;
  }
  const exp = Number(expS);
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  // value = 0.d1d2d3… × 10^(exp+1)
  const point = exp + 1;
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return digits.slice(0, point) + '.' + digits.slice(point);
}

/**
 * Human amount → raw units: the float's value at 15 significant digits (floored, so 1.5e-7 stays 1.5e-7 but a received
 * 9970.900580150315… never becomes …032), then TRUNCATED to the token's decimals. Exact for decimals 0…36 and any
 * magnitude (no toFixed / exponent issues). Live sells are additionally clamped to the on-chain balance.
 */
export function amountToUnits(x: number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new Error(`Unsupported decimals ${decimals}`);
  const s = plainDecimal(x);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals).padEnd(decimals, '0') || '0');
}

/** Raw units → decimal string, exact (for logs / UI where a float would lose digits at 24 decimals). */
export function unitsToString(v: bigint, decimals: number): string {
  const neg = v < 0n, a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (a % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${a / base}${frac ? '.' + frac : ''}`;
}
