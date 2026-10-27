/**
 * Holder concentration (pure). Circulating supply is total supply minus balances we exclude: the pool or pair
 * being traded, burn / dead addresses, and known liquidity lockers (by address or by the explorer's name tag).
 * Shares are of that circulating supply. The largest holder and the top 10 are what the token-trader gate reads.
 */

/**
 * Paper-vetting caps, used only when the holder check is turned on.
 * One wallet over 10% of circulating supply, or the top 10 over 40%.
 */
export const DEFAULT_MAX_HOLDER_SHARE = 0.1;
export const DEFAULT_MAX_TOP10_SHARE = 0.4;

/** Settings clamp: 1% through 100% of circulating supply. */
export const HOLDER_SHARE_MIN = 0.01;
export const HOLDER_SHARE_MAX = 1;

/** A share setting, forced into [1%, 100%]. A non-number keeps `fallback`. */
export function clampHolderShare(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HOLDER_SHARE_MAX, Math.max(HOLDER_SHARE_MIN, n));
}

/** How many explorer pages to read before giving up. A full top 10 from a descending page stops sooner. */
export const HOLDER_PAGE_CAP = 3;

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
]);

/**
 * Liquidity lockers that show up at the same address on many EVM chains. A locker the explorer tags by name is
 * excluded even when its address is not in this list.
 */
const LOCKERS = new Set([
  '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214', // Unicrypt
  '0xdba68f07d1b7ca219f78ae8582c213d975c25caf', // Unicrypt locker
  '0xe2fe530c047f2d85298b07d9333c05737f1435fb', // Team Finance
  '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe', // PinkLock
  '0x2d045410f002a95efcee67759a92518fa3fce677', // DxLock
]);

const EXCLUDE_NAME = /\b(burn(?:ed)?|dead|null address|black\s?hole|locker|locked liquidity|liquidity lock)\b|pinklock|unicrypt|dxlock|team\s?finance/i;

export interface HolderRow {
  address: string;
  balance: bigint;
  name?: string | null;
}

export function isExcludedHolder(address: string, name: string | null | undefined, extra: readonly string[]): boolean {
  const a = address.toLowerCase();
  if (BURN.has(a) || LOCKERS.has(a)) return true;
  if (extra.some((x) => x.toLowerCase() === a)) return true;
  return !!name && EXCLUDE_NAME.test(name);
}

export function includedHolders(holders: readonly HolderRow[], extra: readonly string[]): HolderRow[] {
  return holders.filter((h) => h.balance > 0n && !isExcludedHolder(h.address, h.name, extra));
}

export interface HolderMathInput {
  totalSupply: bigint;
  holders: readonly HolderRow[];
  /** Pool, pair, and any other addresses the caller knows are not wallets. */
  exclude: readonly string[];
  /**
   * The explorer has another page we did not read, and fewer than 10 included holders were on the pages we did.
   * The top 10 might be incomplete.
   */
  moreHolders: boolean;
}

export interface HolderMath {
  unverified: boolean;
  /** Largest included holder / circulating. null when unverified. */
  largest: number | null;
  /** Sum of the included top 10 / circulating. null when unverified. */
  top10: number | null;
  included: number;
  /** Why a read is unverified. Absent when the shares were computed. */
  unavailable?: 'no-source' | 'read-failed';
  /** Chain name for the skip reason. Set by the reader, not by the share math. */
  chainName?: string;
}

const UNVERIFIED: HolderMath = { unverified: true, largest: null, top10: null, included: 0 };

/** Share in [0, 1] at 1e-6 resolution, from raw balances, so a huge supply does not go through a float first. */
function shareOf(balance: bigint, circulating: bigint): number {
  if (!(circulating > 0n) || balance < 0n) return Number.NaN;
  return Number((balance * 1_000_000n) / circulating) / 1_000_000;
}

/**
 * Largest single holder and top-10 share of circulating supply. Unverified when supply is missing, every balance
 * we saw was excluded, the shares don't fit in the supply, or a short page might have missed a real holder.
 */
export function holderShares(i: HolderMathInput): HolderMath {
  if (!(i.totalSupply > 0n)) return UNVERIFIED;
  let excluded = 0n;
  const included: bigint[] = [];
  for (const h of i.holders) {
    if (!(h.balance > 0n)) continue;
    if (isExcludedHolder(h.address, h.name, i.exclude)) excluded += h.balance;
    else included.push(h.balance);
  }
  if (i.moreHolders && included.length < 10) return { ...UNVERIFIED, included: included.length };
  if (!included.length) return UNVERIFIED;
  const circulating = i.totalSupply - excluded;
  if (!(circulating > 0n)) return UNVERIFIED;
  included.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = included.slice(0, 10).reduce((s, b) => s + b, 0n);
  const largest = shareOf(included[0], circulating);
  const top10 = shareOf(top, circulating);
  if (!(largest >= 0) || largest > 1 || !(top10 >= 0) || top10 > 1) return UNVERIFIED;
  return { unverified: false, largest, top10, included: included.length };
}
