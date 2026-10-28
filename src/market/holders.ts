/**
 * Holder concentration (pure). Circulating supply is total supply minus balances we exclude: every known pool
 * or pair, burn / dead addresses, the V3 position manager, the V4 pool manager, and known liquidity lockers.
 * Shares are of that circulating supply. The largest holder and the top 10 are what the token-trader gate reads.
 */
import { V4_POOL_MANAGER } from './poolEvents';

/**
 * Paper-vetting caps, used only when the holder check is turned on.
 * One wallet over 10% of circulating supply, or the top 10 over 40%.
 */
export const DEFAULT_MAX_HOLDER_SHARE = 0.1;
export const DEFAULT_MAX_TOP10_SHARE = 0.4;
/** Explained balances must cover at least this much of totalSupply, or the read is thin. */
export const DEFAULT_MIN_HOLDER_COVERAGE = 0.9;

/** Settings clamp: 1% through 100% of circulating supply. */
export const HOLDER_SHARE_MIN = 0.01;
export const HOLDER_SHARE_MAX = 1;

/** Coverage bar, forced into [50%, 100%]. A non-number keeps the 90% default. */
export function clampHolderCoverage(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MIN_HOLDER_COVERAGE;
  return Math.min(1, Math.max(0.5, n));
}

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
  /**
   * Share of circulating supply that this sample did not see. 0 for a full explorer list.
   * A log sample can miss a wallet; the gate treats that remainder as one possible holder.
   */
  unseen?: number | null;
  /** Top 10 came from a full list (explorer or GeckoTerminal), so `unseen` is not added to it. */
  top10Exact?: boolean;
  /** Explained balances ÷ totalSupply. Always set; null when supply was never read. */
  coverage: number | null;
  /** Set when the window or the explained supply is too thin to trust the shares. */
  holders?: 'unknown, coverage thin';
  thin?: boolean;
  /** Oldest block the log sample requested. null when the list did not come from logs. */
  windowFrom?: number | null;
  /** Contract creation block. null when the bounded search could not find it. */
  creationBlock?: number | null;
}

const UNVERIFIED: HolderMath = { unverified: true, largest: null, top10: null, included: 0, coverage: null };

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
  return { unverified: false, largest, top10, included: included.length, unseen: 0, top10Exact: true, coverage: null };
}

/** Sum of measured balances, including pools, the position manager, the PoolManager, and burn addresses. */
export function explainedBalance(rows: readonly { address: string; balance: bigint }[]): bigint {
  const seen = new Set<string>();
  let sum = 0n;
  for (const r of rows) {
    if (!(r.balance > 0n)) continue;
    const a = r.address.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    sum += r.balance;
  }
  return sum;
}

/**
 * Coverage is explained balances ÷ totalSupply. Excluded pools and burn addresses count, so a token that
 * sits in its pools is not thin just because few wallets were listed. A log window that starts after
 * creation, or a creation block we could not find, is thin even when the balances look complete.
 */
export function holderCoverage(p: {
  totalSupply: bigint;
  explained: bigint;
  min?: number;
  scannedLogs: boolean;
  windowFrom?: number | null;
  creationBlock?: number | null;
}): { coverage: number | null; thin: boolean } {
  if (!(p.totalSupply > 0n)) return { coverage: null, thin: true };
  const explained = p.explained > p.totalSupply ? p.totalSupply : p.explained < 0n ? 0n : p.explained;
  const coverage = Number((explained * 1_000_000n) / p.totalSupply) / 1_000_000;
  const min = p.min ?? DEFAULT_MIN_HOLDER_COVERAGE;
  const windowMissesCreation = p.scannedLogs && (p.creationBlock == null || p.windowFrom == null || p.windowFrom > p.creationBlock);
  return { coverage, thin: coverage + 1e-9 < min || windowMissesCreation };
}

/** Skip text for safe and medium. Aggressive mode shows the same sentence as a warning. */
export function thinCoverageReason(p: { coverage: number | null; windowFrom?: number | null; creationBlock?: number | null }): string {
  const pct = p.coverage == null ? 'unknown' : `${(p.coverage * 100).toFixed(1)}%`;
  const window = p.windowFrom == null ? 'n/a' : String(p.windowFrom);
  const created = p.creationBlock == null ? 'unknown' : String(p.creationBlock);
  return `holder concentration unknown: coverage thin (${pct} of supply, window from block ${window}, creation block ${created})`;
}

/** Position managers and the V4 PoolManager. Burn addresses are excluded by `isExcludedHolder`. */
export function protocolExclusions(dexes: readonly { positionManager?: string | null }[]): string[] {
  const out = [V4_POOL_MANAGER];
  for (const d of dexes) if (d.positionManager) out.push(d.positionManager);
  return out;
}

/** GeckoTerminal token info: `holders.distribution_percentage.top_10` is a percent string. null when it isn't there. */
export function geckoTop10Share(body: unknown): number | null {
  const raw = (body as { data?: { attributes?: { holders?: { distribution_percentage?: { top_10?: unknown } } } } })
    ?.data?.attributes?.holders?.distribution_percentage?.top_10;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n / 100;
}

/**
 * A partial holder sample (Transfer logs, then balanceOf). `unseen` is circulating supply we did not measure.
 * Returns 'largest' or 'top10' when the measured share is already over the cap, 'unread' when a missed wallet
 * could still be over it, and null when even that missed wallet would stay inside both caps.
 */
export function holderBound(p: {
  largest: number; top10: number; unseen: number; top10Exact?: boolean;
  maxHolder: number; maxTop10: number;
}): 'largest' | 'top10' | 'unread' | null {
  const unseen = Number.isFinite(p.unseen) && p.unseen > 0 ? p.unseen : 0;
  if (p.largest > p.maxHolder) return 'largest';
  if (p.top10 > p.maxTop10) return 'top10';
  if (Math.max(p.largest, unseen) > p.maxHolder) return 'unread';
  const topUpper = p.top10Exact ? p.top10 : Math.min(1, p.top10 + unseen);
  if (topUpper > p.maxTop10) return 'unread';
  return null;
}
