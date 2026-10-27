/**
 * Turns an on-chain LP read into the gate's `lpUnlocked` field.
 *
 * V2 uses `lpRemovable` (90% burned counts as locked; the token owner holding more than half counts as removable).
 * V3 uses the position-NFT report from v3LpLock.ts (locked or burned share of in-range liquidity).
 * A null helper result or any RPC failure is `unverified`, which the gate fails closed for safe/medium.
 *
 * This runs only when the trader option `lpUnlockCheck` is on (default off). With it off, assess leaves
 * `lpUnlocked` null and does not set `lpUnlock`, so gateToken's output stays the same shape.
 *
 * Reads are eth_call and eth_getCode only. Nothing is signed or sent.
 */
import { Interface } from 'ethers';
import { lpRemovable } from './tokenChecks';
import { BURN_ADDRESSES, MULTICALL3, V3_LP_IFACE, v3LockSatisfies, type V3LpReport } from './v3LpLock';

/** Trader option. false unless a caller turns it on. */
export const LP_UNLOCK_CHECK = 'lpUnlockCheck' as const;

const DEFAULT_GAP_MS = 250;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const VERIFIED_TTL_MS = 10 * 60_000;
const UNVERIFIED_TTL_MS = 30_000;
const ZERO = '0x0000000000000000000000000000000000000000';
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;

const ERC20 = new Interface([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const OWNABLE = new Interface([
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);

export interface LpUnlockEvidence {
  kind: 'v2' | 'v3' | 'other';
  status: 'verified' | 'unverified';
  /** Meaningful when status is verified. true = the LP can still be pulled. */
  lpUnlocked: boolean | null;
  detail: string | null;
}

/**
 * Read-only RPC. `call` resolves with return data, or with `0x` when the contract reverts.
 * It throws on transport failure and on rate limits. The reader retries rate limits itself.
 */
export interface LpUnlockRpc {
  call(to: string, data: string): Promise<string>;
  getCode(address: string): Promise<string>;
}

export interface V2LpRequest {
  chainId: number;
  /** V2 pair. The pair contract is the LP token. */
  pool: string;
  /** Token whose owner() may still hold the LP. */
  token: string;
  gapMs?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export function unverifiedLpUnlock(kind: LpUnlockEvidence['kind'], detail: string): LpUnlockEvidence {
  return { kind, status: 'unverified', lpUnlocked: null, detail };
}

/** `lpRemovable`: false = locked, true = removable, null = not clear (fail closed). */
export function lpUnlockFromRemovable(result: boolean | null): LpUnlockEvidence {
  if (result === true) return { kind: 'v2', status: 'verified', lpUnlocked: true, detail: 'owner holds more than half of the V2 LP token' };
  if (result === false) return { kind: 'v2', status: 'verified', lpUnlocked: false, detail: 'at least 90% of the V2 LP token is burned' };
  return unverifiedLpUnlock('v2', 'V2 LP lock is not clear');
}

/** Verified and at least 90% locked or burned → lpUnlocked false. Verified below that → true. Otherwise unverified. */
export function lpUnlockFromV3(report: V3LpReport): LpUnlockEvidence {
  if (report.status !== 'verified') return unverifiedLpUnlock('v3', report.detail ?? 'V3 liquidity lock unverified');
  if (v3LockSatisfies(report)) return { kind: 'v3', status: 'verified', lpUnlocked: false, detail: 'in-range V3 liquidity is locked or burned' };
  return { kind: 'v3', status: 'verified', lpUnlocked: true, detail: 'in-range V3 liquidity is not locked' };
}

/** Flag off, or no evidence: leave the gate object untouched. */
export function applyLpUnlock<T extends { lpUnlocked: boolean | null; lpUnlock?: LpUnlockEvidence }>(
  gate: T, enabled: boolean, evidence: LpUnlockEvidence | null,
): T {
  if (!enabled || !evidence) return gate;
  if (evidence.status === 'verified' && typeof evidence.lpUnlocked === 'boolean') gate.lpUnlocked = evidence.lpUnlocked;
  gate.lpUnlock = evidence;
  return gate;
}

const cache = new Map<string, { at: number; ttl: number; evidence: LpUnlockEvidence }>();

export function clearLpUnlockCache(): void { cache.clear(); }

function clip(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function pace(inner: LpUnlockRpc, req: V2LpRequest): LpUnlockRpc {
  const gap = req.gapMs ?? DEFAULT_GAP_MS;
  const backoff = req.backoffMs ?? BACKOFF_MS;
  const sleep = req.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const clock = req.clock ?? Date.now;
  let last = 0;
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      const wait = last + gap - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
      try {
        return await fn();
      } catch (e) {
        if (!RATE_LIMITED.test(clip(e)) || i >= backoff.length) throw e;
        await sleep(backoff[i]);
        last = clock();
      }
    }
  };
  return {
    call: (to, data) => run(() => inner.call(to, data)),
    getCode: (a) => run(() => inner.getCode(a)),
  };
}

interface Call { to: string; data: string }

function rowOf(row: { success?: boolean; returnData?: string } | [boolean, string]): { ok: boolean; data: string } {
  if (Array.isArray(row)) return { ok: row[0], data: row[1] ?? '0x' };
  return { ok: !!row.success, data: row.returnData ?? '0x' };
}

async function serial(rpc: LpUnlockRpc, calls: Call[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const c of calls) {
    const raw = await rpc.call(c.to, c.data);
    out.push(raw && raw !== '0x' ? raw : null);
  }
  return out;
}

/** One Multicall3 aggregate when that address has code; otherwise paced single calls. A revert is null, not a throw. */
async function many(rpc: LpUnlockRpc, calls: Call[]): Promise<(string | null)[]> {
  if (!calls.length) return [];
  if (calls.length === 1) return serial(rpc, calls);
  const code = await rpc.getCode(MULTICALL3);
  if (!code || code === '0x' || code === '0x0') return serial(rpc, calls);
  const data = V3_LP_IFACE.multicall.encodeFunctionData('aggregate3', [calls.map((c) => [c.to, true, c.data])]);
  const raw = await rpc.call(MULTICALL3, data);
  if (!raw || raw === '0x') return serial(rpc, calls);
  const decoded = V3_LP_IFACE.multicall.decodeFunctionResult('aggregate3', raw);
  const rows = decoded[0] as readonly ({ success?: boolean; returnData?: string } | [boolean, string])[];
  return rows.map((row) => {
    const r = rowOf(row);
    return r.ok && r.data && r.data !== '0x' ? r.data : null;
  });
}

function word(data: string | null): bigint | null {
  if (!data || data === '0x') return null;
  try { return BigInt(data); } catch { return null; }
}

function addressOf(data: string | null): string | null {
  if (!data || data === '0x' || data.length < 42) return null;
  const addr = `0x${data.slice(-40)}`.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(addr) ? addr : null;
}

async function runV2(rpc: LpUnlockRpc, req: V2LpRequest): Promise<LpUnlockEvidence> {
  const pool = req.pool;
  const token = req.token;
  const calls: Call[] = [
    { to: pool, data: ERC20.encodeFunctionData('totalSupply', []) },
    ...BURN_ADDRESSES.map((a) => ({ to: pool, data: ERC20.encodeFunctionData('balanceOf', [a]) })),
    { to: token, data: OWNABLE.encodeFunctionData('owner', []) },
  ];
  const raws = await many(rpc, calls);
  const supply = word(raws[0] ?? null);
  if (supply == null) return unverifiedLpUnlock('v2', 'V2 LP totalSupply unreadable');
  let burned = 0n;
  for (let i = 0; i < BURN_ADDRESSES.length; i++) {
    const bal = word(raws[1 + i] ?? null);
    if (bal == null) return unverifiedLpUnlock('v2', 'V2 LP burn balance unreadable');
    burned += bal;
  }
  let owner = addressOf(raws[1 + BURN_ADDRESSES.length] ?? null);
  if (!owner || owner === ZERO) {
    const alt = await rpc.call(token, OWNABLE.encodeFunctionData('getOwner', []));
    owner = addressOf(alt && alt !== '0x' ? alt : null);
  }
  let ownerBalance = 0n;
  if (owner && owner !== ZERO) {
    const burnAt = BURN_ADDRESSES.indexOf(owner);
    if (burnAt >= 0) ownerBalance = word(raws[1 + burnAt] ?? null) ?? 0n;
    else {
      const raw = await rpc.call(pool, ERC20.encodeFunctionData('balanceOf', [owner]));
      const bal = word(raw && raw !== '0x' ? raw : null);
      if (bal == null) return unverifiedLpUnlock('v2', 'V2 LP owner balance unreadable');
      ownerBalance = bal;
    }
  }
  return lpUnlockFromRemovable(lpRemovable(supply, burned, ownerBalance));
}

/**
 * V2 pair supply, burn balances, and the token owner's LP balance.
 * Never throws: transport failure, a rate limit that does not clear, or an unreadable view is unverified.
 * The same pool reuses a short cache (verified 10 min, unverified 30 s).
 */
export async function readV2LpUnlock(rpc: LpUnlockRpc, req: V2LpRequest): Promise<LpUnlockEvidence> {
  const key = `${req.chainId}:${req.pool.toLowerCase()}:${req.token.toLowerCase()}`;
  const clock = req.clock ?? Date.now;
  const hit = cache.get(key);
  if (hit && clock() - hit.at < hit.ttl) return hit.evidence;
  const paced = pace(rpc, req);
  let evidence: LpUnlockEvidence;
  try {
    evidence = await runV2(paced, req);
  } catch (e) {
    evidence = unverifiedLpUnlock('v2', `rpc failed: ${clip(e)}`);
  }
  cache.set(key, { at: clock(), ttl: evidence.status === 'verified' ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS, evidence });
  return evidence;
}
