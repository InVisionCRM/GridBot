/**
 * Uniswap V3 liquidity is a set of position NFTs (NonfungiblePositionManager), not an ERC-20 LP token.
 * Holder lists that report "0% locked / 0% burned" for a V3 pool are describing that missing ERC-20, so they
 * cannot see a lock. This module reads the pool's in-range positions and classifies each NFT owner.
 *
 * The gate blocks safe/medium when this report is unverified, or verified but not at least 90% burned or
 * locked by an allowlisted locker. Nothing in this repo calls a GoPlus-style LP-holder API. The report is
 * attached only when `v3LpLockCheck` is on (default off). With that option off the gate input never carries
 * a report, and gateToken is unchanged. Assess leaves `lpUnlocked` null unless `lpUnlockCheck` is on.
 *
 * Only a burn address, or an allowlisted locker whose code contains getLock and getLocksLength, counts as
 * locked. A contract that merely answers an expiry probe does not.
 *
 * Reads are eth_call, eth_getCode, eth_getLogs and eth_getTransactionReceipt. No transaction is signed or sent.
 * A transport failure, a rate limit that does not clear, or in-range liquidity we could not attribute becomes
 * status `unverified` (fail closed): it never counts as locked.
 */
import { id, Interface } from 'ethers';
import { parseLiquidity, TOPIC, type RawLog } from './poolEvents';

/** Trader option. false unless a caller turns it on. */
export const V3_LP_LOCK_CHECK = 'v3LpLockCheck' as const;

/** Same bar as the V2 helper: at least 90% of in-range liquidity burned or locked. */
export const V3_LOCK_MIN_SHARE = 0.9;

/** Canonical Multicall3 (CREATE2). Used only when the chain actually has code there. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const COVERAGE_DUST_BPS = 100n;
const MAX_RECEIPTS = 60;
const MAX_LOCK_SCAN = 200;
const MULTICALL_CHUNK = 24;
const VERIFIED_TTL_MS = 10 * 60_000;
const UNVERIFIED_TTL_MS = 30_000;
const DEFAULT_GAP_MS = 250;
const DEFAULT_CHUNK = 20_000;
const DEFAULT_SPAN = 400_000;
const MIN_CHUNK = 250;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
const RANGE_TOO_WIDE = /exceeds limit|more than \d+ results|response size|block range|range (is )?too (large|wide)|query returned more than/i;
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;

/** Addresses that cannot spend an NFT. Liquidity sent here is treated as burned. */
export const BURN_ADDRESSES = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
];

/**
 * Position-NFT lockers. Sources (checked 2026-10-27):
 * UNCX latest Ethereum locker and the legacy contract that still holds old locks
 * (github.com/uncx-network/liquidity-locker-univ3-contracts), and the Robinhood locker
 * published at docs.uncx.network (Liquidity Lockers V3).
 * An address not on this list can still be a locker when its code exposes lock/unlock views.
 */
export const KNOWN_V3_LOCKERS: { chainId: number; address: string; name: string }[] = [
  { chainId: 1, address: '0xFD235968e65B0990584585763f837A5b5330e6DE', name: 'UNCX V3' },
  { chainId: 1, address: '0x7f5C649856F900d15C83741f45AE46f5C6858234', name: 'UNCX V3 legacy' },
  { chainId: 4663, address: '0xF28704c691290547924e2129D407dA36bda8ce0f', name: 'UNCX V3' },
];

const sel = (sig: string) => id(sig).slice(2, 10);

/** 4-byte selectors a locker dispatcher pushes. Bytecode search, same idea as mintInBytecode. */
export const LOCKER_SELECTOR = {
  unlock: sel('unlock(uint256)'),
  withdraw: sel('withdraw(uint256)'),
  withdrawTo: sel('withdraw(uint256,address)'),
  lock: sel('lock(uint256,uint256)'),
  unlockDate: sel('unlockDate(uint256)'),
  lockedUntil: sel('lockedUntil(uint256)'),
  unlockTime: sel('unlockTime(uint256)'),
  locks: sel('locks(uint256)'),
  getLock: sel('getLock(uint256)'),
  getLocksLength: sel('getLocksLength()'),
};

export const V3_LP_IFACE = {
  pool: new Interface([
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
  ]),
  npm: new Interface([
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  ]),
  time: new Interface([
    'function unlockDate(uint256) view returns (uint256)',
    'function lockedUntil(uint256) view returns (uint256)',
    'function unlockTime(uint256) view returns (uint256)',
    'function locks(uint256) view returns (uint256)',
  ]),
  uncx: new Interface([
    'function getLocksLength() view returns (uint256)',
    'function ETERNAL_LOCK() view returns (uint256)',
    'function getLock(uint256 lockId) view returns (uint256 lock_id, address nftPositionManager, address pool, uint256 nft_id, address owner, address pendingOwner, address additionalCollector, address collectAddress, uint256 unlockDate, uint16 countryCode, uint256 ucf)',
  ]),
  multicall: new Interface([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  ]),
};

const INCREASE_TOPIC = V3_LP_IFACE.npm.getEvent('IncreaseLiquidity')!.topicHash.toLowerCase();

const TIME_VIEWS: { name: 'unlockDate' | 'lockedUntil' | 'unlockTime' | 'locks'; sel: string }[] = [
  { name: 'unlockDate', sel: LOCKER_SELECTOR.unlockDate },
  { name: 'lockedUntil', sel: LOCKER_SELECTOR.lockedUntil },
  { name: 'unlockTime', sel: LOCKER_SELECTOR.unlockTime },
  { name: 'locks', sel: LOCKER_SELECTOR.locks },
];

export type LpOwnerClass = 'locker' | 'burn' | 'eoa' | 'other';

export interface V3PositionLock {
  tokenId: string;
  owner: string;
  liquidity: string;
  inRange: boolean;
  class: LpOwnerClass;
  /** Unix seconds. Null when the locker does not expose it, or the lock is permanent. */
  unlockAt: number | null;
  permanent: boolean;
  expired: boolean;
}

export interface V3LpShares {
  /** Fraction of the pool's in-range liquidity, 0..1. Shares can sum to less than 1 when some liquidity was not found. */
  locker: number;
  burn: number;
  eoa: number;
  other: number;
}

export interface V3LpReport {
  /** verified: the reads finished and the positions cover the pool. unverified: fail closed. */
  status: 'verified' | 'unverified';
  pool: string;
  positionManager: string;
  poolLiquidity: string;
  foundLiquidity: string;
  shares: V3LpShares;
  /** In-range liquidity that is burned, or locked with a future (or permanent) expiry. */
  lockedOrBurnedShare: number;
  positions: V3PositionLock[];
  detail: string | null;
}

export interface V3LockLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: number;
  transactionHash?: string;
}

/**
 * Read-only RPC. `call` resolves with return data, or with `0x` when the contract reverts.
 * It throws on transport failure and on rate limits. The checker retries rate limits itself.
 */
export interface V3LockRpc {
  call(to: string, data: string): Promise<string>;
  getCode(address: string): Promise<string>;
  getLogs(f: { address: string; topics: string[]; fromBlock: number; toBlock: number }): Promise<V3LockLog[]>;
  getReceipt(hash: string): Promise<{ logs: V3LockLog[] } | null>;
  blockNumber(): Promise<number>;
}

export interface V3LockRequest {
  chainId: number;
  pool: string;
  positionManager: string;
  /** Unix seconds used to decide whether a lock has expired. */
  nowSec: number;
  blockNumber?: number;
  chunkBlocks?: number;
  maxBlockSpan?: number;
  gapMs?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface LockExpiry { at: number | null; permanent: boolean }

const zeroShares = (): V3LpShares => ({ locker: 0, burn: 0, eoa: 0, other: 0 });

export function unverifiedV3Lp(pool: string, positionManager: string, detail: string): V3LpReport {
  return {
    status: 'unverified', pool: pool.toLowerCase(), positionManager: positionManager.toLowerCase(),
    poolLiquidity: '0', foundLiquidity: '0', shares: zeroShares(), lockedOrBurnedShare: 0, positions: [], detail,
  };
}

/** True when a verified report shows at least {@link V3_LOCK_MIN_SHARE} of in-range liquidity burned or still locked. */
export function v3LockSatisfies(report: V3LpReport | null | undefined): boolean {
  if (!report || report.status !== 'verified') return false;
  return report.lockedOrBurnedShare + 1e-12 >= V3_LOCK_MIN_SHARE;
}

export function isBurnAddress(address: string): boolean {
  return BURN_ADDRESSES.includes(address.toLowerCase());
}

export function knownV3Locker(chainId: number, address: string): { name: string } | null {
  const a = address.toLowerCase();
  return KNOWN_V3_LOCKERS.find((k) => k.chainId === chainId && k.address.toLowerCase() === a) ?? null;
}

/**
 * Allowlisted locker bytecode: the UNCX views this check actually calls.
 * An allowlisted address with empty or unrelated code is not a verified locker.
 */
export function hasVerifiedLockerCode(code: string | null | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  const c = code.toLowerCase();
  return c.includes(LOCKER_SELECTOR.getLock) && c.includes(LOCKER_SELECTOR.getLocksLength);
}

/** True when runtime code exposes both an unlock-style entrypoint and a lock or expiry view. */
export function exposesLockSemantics(code: string | null | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  const c = code.toLowerCase();
  const has = (s: string) => c.includes(s);
  const unlocks = has(LOCKER_SELECTOR.unlock) || has(LOCKER_SELECTOR.withdraw) || has(LOCKER_SELECTOR.withdrawTo);
  const locks = has(LOCKER_SELECTOR.lock) || has(LOCKER_SELECTOR.unlockDate) || has(LOCKER_SELECTOR.lockedUntil)
    || has(LOCKER_SELECTOR.unlockTime) || has(LOCKER_SELECTOR.locks) || has(LOCKER_SELECTOR.getLock);
  return unlocks && locks;
}

/** EIP-1167 implementation address, when `code` is a minimal proxy. */
export function minimalProxyImplementation(code: string | null | undefined): string | null {
  const m = (code ?? '').match(MINIMAL_PROXY);
  return m ? `0x${m[1]}`.toLowerCase() : null;
}

/**
 * A word that is a unix second between 2017 and 2286, or a uint256-max style permanent sentinel.
 * Liquidity amounts and addresses are ignored.
 */
export function interpretLockTime(word: bigint): LockExpiry | null {
  if (word === 0n) return null;
  if (word > 2n ** 200n) return { at: null, permanent: true };
  if (word >= 1_500_000_000n && word <= 10_000_000_000n) return { at: Number(word), permanent: false };
  return null;
}

/** Latest plausible timestamp in an ABI blob, or a permanent sentinel if one of the words is one. */
export function expiryFromReturnData(data: string | null | undefined): LockExpiry | null {
  if (!data || data === '0x' || data.length < 66) return null;
  const hex = data.slice(2);
  let best: LockExpiry | null = null;
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const hit = interpretLockTime(BigInt(`0x${hex.slice(i, i + 64)}`));
    if (!hit) continue;
    if (hit.permanent) return hit;
    if (!best || (hit.at != null && (best.at == null || hit.at > best.at))) best = hit;
  }
  return best;
}

export function encodeIncreaseLiquidity(tokenId: bigint, liquidity: bigint): { topics: string[]; data: string } {
  const ev = V3_LP_IFACE.npm.getEvent('IncreaseLiquidity')!;
  const encoded = V3_LP_IFACE.npm.encodeEventLog(ev, [tokenId, liquidity, 0n, 0n]);
  return { topics: [...encoded.topics], data: encoded.data };
}

const cache = new Map<string, { at: number; ttl: number; report: V3LpReport }>();

export function clearV3LpLockCache(): void { cache.clear(); }

function clip(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const capped = part > whole ? whole : part;
  return Number((capped * 1_000_000n) / whole) / 1_000_000;
}

function meetsMin(part: bigint, whole: bigint): boolean {
  if (whole <= 0n) return false;
  return part * 1000n >= whole * 900n;
}

function covered(found: bigint, pool: bigint): boolean {
  if (pool <= 0n) return true;
  if (found >= pool) return true;
  return (pool - found) * 10_000n <= pool * COVERAGE_DUST_BPS;
}

function pace(inner: V3LockRpc, req: V3LockRequest): V3LockRpc {
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
    getLogs: (f) => run(() => inner.getLogs(f)),
    getReceipt: (h) => run(() => inner.getReceipt(h)),
    blockNumber: () => run(() => inner.blockNumber()),
  };
}

interface Call { to: string; data: string }
interface ScanCtx {
  rpc: V3LockRpc;
  multicall: boolean | null;
  code: Map<string, string>;
  /** locker address → nft id → expiry, filled by one getLocksLength / getLock scan */
  uncx: Map<string, Map<string, LockExpiry>>;
}

async function hasMulticall(ctx: ScanCtx): Promise<boolean> {
  if (ctx.multicall != null) return ctx.multicall;
  const code = await ctx.rpc.getCode(MULTICALL3);
  ctx.multicall = !!code && code !== '0x' && code !== '0x0';
  ctx.code.set(MULTICALL3.toLowerCase(), code);
  return ctx.multicall;
}

function rowOf(row: { success?: boolean; returnData?: string } | [boolean, string]): { ok: boolean; data: string } {
  if (Array.isArray(row)) return { ok: row[0], data: row[1] ?? '0x' };
  return { ok: !!row.success, data: row.returnData ?? '0x' };
}

/** Pack eth_calls through Multicall3 when it is deployed; otherwise one paced call each. Reverts become null. */
async function many(ctx: ScanCtx, calls: Call[]): Promise<(string | null)[]> {
  if (!calls.length) return [];
  if (!(await hasMulticall(ctx)) || calls.length === 1) {
    const out: (string | null)[] = [];
    for (const c of calls) {
      const raw = await ctx.rpc.call(c.to, c.data);
      out.push(!raw || raw === '0x' ? null : raw);
    }
    return out;
  }
  const out: (string | null)[] = [];
  const mc = V3_LP_IFACE.multicall;
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const part = calls.slice(i, i + MULTICALL_CHUNK);
    const data = mc.encodeFunctionData('aggregate3', [part.map((c) => [c.to, true, c.data])]);
    const raw = await ctx.rpc.call(MULTICALL3, data);
    if (!raw || raw === '0x') throw new Error('multicall returned no data');
    const decoded = mc.decodeFunctionResult('aggregate3', raw);
    const rows = decoded[0] as readonly ({ success?: boolean; returnData?: string } | [boolean, string])[];
    for (const row of rows) {
      const r = rowOf(row);
      out.push(r.ok && r.data !== '0x' ? r.data : null);
    }
  }
  return out;
}

async function one(ctx: ScanCtx, to: string, data: string): Promise<string | null> {
  const [raw] = await many(ctx, [{ to, data }]);
  return raw ?? null;
}

function decode<T>(iface: Interface, fn: string, data: string | null): T | null {
  if (!data) return null;
  try { return iface.decodeFunctionResult(fn, data) as T; } catch { return null; }
}

async function cachedCode(ctx: ScanCtx, address: string): Promise<string> {
  const key = address.toLowerCase();
  const hit = ctx.code.get(key);
  if (hit != null) return hit;
  const code = await ctx.rpc.getCode(address);
  ctx.code.set(key, code);
  return code;
}

function tokenIdOfIncrease(log: V3LockLog, npm: string): bigint | null {
  if (log.address.toLowerCase() !== npm) return null;
  if ((log.topics[0] ?? '').toLowerCase() !== INCREASE_TOPIC) return null;
  if (!log.topics[1]) return null;
  try { return BigInt(log.topics[1]); } catch { return null; }
}

interface FoundPos {
  tokenId: bigint;
  liquidity: bigint;
  inRange: boolean;
  owner: string;
}

async function readPositions(ctx: ScanCtx, npm: string, ids: bigint[], pool: { token0: string; token1: string; fee: number; tick: number }): Promise<FoundPos[]> {
  if (!ids.length) return [];
  const posCalls: Call[] = [];
  const ownCalls: Call[] = [];
  for (const id of ids) {
    posCalls.push({ to: npm, data: V3_LP_IFACE.npm.encodeFunctionData('positions', [id]) });
    ownCalls.push({ to: npm, data: V3_LP_IFACE.npm.encodeFunctionData('ownerOf', [id]) });
  }
  const posRaw = await many(ctx, posCalls);
  const ownRaw = await many(ctx, ownCalls);
  const out: FoundPos[] = [];
  for (let i = 0; i < ids.length; i++) {
    const pos = decode<{ token0: string; token1: string; fee: bigint; tickLower: bigint; tickUpper: bigint; liquidity: bigint }>(V3_LP_IFACE.npm, 'positions', posRaw[i]);
    const own = decode<{ 0: string }>(V3_LP_IFACE.npm, 'ownerOf', ownRaw[i]);
    if (!pos || !own) continue;
    const token0 = String(pos.token0).toLowerCase();
    const token1 = String(pos.token1).toLowerCase();
    if (token0 !== pool.token0 || token1 !== pool.token1 || Number(pos.fee) !== pool.fee) continue;
    const liquidity = BigInt(pos.liquidity);
    if (liquidity <= 0n) continue;
    const lower = Number(pos.tickLower);
    const upper = Number(pos.tickUpper);
    const owner = String(own[0]).toLowerCase();
    out.push({ tokenId: ids[i], liquidity, inRange: lower <= pool.tick && pool.tick < upper, owner });
  }
  return out;
}

async function discover(ctx: ScanCtx, req: V3LockRequest, npm: string, pool: { token0: string; token1: string; fee: number; tick: number }, poolLiq: bigint): Promise<FoundPos[]> {
  const head = req.blockNumber ?? await ctx.rpc.blockNumber();
  let chunk = Math.max(MIN_CHUNK, req.chunkBlocks ?? DEFAULT_CHUNK);
  const span = Math.max(0, req.maxBlockSpan ?? DEFAULT_SPAN);
  const floor = Math.max(0, head - span);
  const seen = new Set<string>();
  const found: FoundPos[] = [];
  let inRange = 0n;
  let receipts = 0;
  let to = head;
  while (to >= floor) {
    const from = Math.max(floor, to - chunk + 1);
    let logs: V3LockLog[];
    try {
      logs = await ctx.rpc.getLogs({ address: req.pool, topics: [TOPIC.v3Mint], fromBlock: from, toBlock: to });
    } catch (e) {
      const width = to - from + 1;
      if (RANGE_TOO_WIDE.test(clip(e)) && width > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(width / 2));
        continue;
      }
      throw e;
    }
    const byTx = new Map<string, bigint>();
    for (const log of logs) {
      const tx = log.transactionHash;
      if (!tx) continue;
      const parsed = parseLiquidity({ address: log.address, topics: [...log.topics], data: log.data, blockNumber: log.blockNumber } satisfies RawLog);
      const add = parsed?.liquidityDelta != null && parsed.liquidityDelta > 0n ? parsed.liquidityDelta : 0n;
      const prev = byTx.get(tx);
      if (prev == null || add > prev) byTx.set(tx, add);
    }
    const txs = [...byTx.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)).map(([tx]) => tx);
    const fresh: bigint[] = [];
    for (const tx of txs) {
      if (receipts >= MAX_RECEIPTS) break;
      receipts++;
      const receipt = await ctx.rpc.getReceipt(tx);
      if (!receipt) continue;
      for (const log of receipt.logs) {
        const id = tokenIdOfIncrease(log, npm);
        if (id == null) continue;
        const key = id.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(id);
      }
    }
    if (fresh.length) {
      for (const pos of await readPositions(ctx, npm, fresh, pool)) {
        found.push(pos);
        if (pos.inRange) inRange += pos.liquidity;
      }
    }
    if (covered(inRange, poolLiq) || receipts >= MAX_RECEIPTS || from <= floor) break;
    to = from - 1;
  }
  return found;
}

async function uncxExpiries(ctx: ScanCtx, locker: string, npm: string): Promise<Map<string, LockExpiry>> {
  const key = `${locker.toLowerCase()}:${npm}`;
  const hit = ctx.uncx.get(key);
  if (hit) return hit;
  const map = new Map<string, LockExpiry>();
  ctx.uncx.set(key, map);
  const lenRaw = await one(ctx, locker, V3_LP_IFACE.uncx.encodeFunctionData('getLocksLength', []));
  const lenDec = decode<{ 0: bigint }>(V3_LP_IFACE.uncx, 'getLocksLength', lenRaw);
  if (!lenDec) return map;
  const len = Number(lenDec[0]);
  if (!Number.isFinite(len) || len <= 0) return map;
  const eternalRaw = await one(ctx, locker, V3_LP_IFACE.uncx.encodeFunctionData('ETERNAL_LOCK', []));
  const eternalDec = decode<{ 0: bigint }>(V3_LP_IFACE.uncx, 'ETERNAL_LOCK', eternalRaw);
  const eternal = eternalDec ? BigInt(eternalDec[0]) : null;
  const ids = len <= MAX_LOCK_SCAN
    ? Array.from({ length: len + 1 }, (_, i) => i)
    : Array.from({ length: MAX_LOCK_SCAN + 1 }, (_, i) => len - MAX_LOCK_SCAN + i);
  const raws = await many(ctx, ids.map((id) => ({ to: locker, data: V3_LP_IFACE.uncx.encodeFunctionData('getLock', [id]) })));
  for (const raw of raws) {
    const lock = decode<{ nftPositionManager: string; nft_id: bigint; unlockDate: bigint }>(V3_LP_IFACE.uncx, 'getLock', raw);
    if (!lock) continue;
    if (String(lock.nftPositionManager).toLowerCase() !== npm) continue;
    const unlock = BigInt(lock.unlockDate);
    const expiry = eternal != null && unlock === eternal ? { at: null, permanent: true } : interpretLockTime(unlock);
    if (!expiry) continue;
    const nft = BigInt(lock.nft_id).toString();
    const prev = map.get(nft);
    if (!prev || expiry.permanent || (expiry.at != null && (prev.at == null || expiry.at > prev.at))) map.set(nft, expiry);
  }
  return map;
}

async function readGenericExpiry(ctx: ScanCtx, owner: string, tokenId: bigint, code: string): Promise<LockExpiry | null> {
  const views = TIME_VIEWS.filter((v) => code.toLowerCase().includes(v.sel));
  if (!views.length) return null;
  const raws = await many(ctx, views.map((v) => ({ to: owner, data: V3_LP_IFACE.time.encodeFunctionData(v.name, [tokenId]) })));
  let best: LockExpiry | null = null;
  for (const raw of raws) {
    const hit = expiryFromReturnData(raw);
    if (!hit) continue;
    if (hit.permanent) return hit;
    if (!best || (hit.at != null && (best.at == null || hit.at > best.at))) best = hit;
  }
  return best;
}

const PROBE_VIEWS = [LOCKER_SELECTOR.unlockDate, LOCKER_SELECTOR.lockedUntil, LOCKER_SELECTOR.unlockTime].join('');

async function verifiedLockerBytecode(ctx: ScanCtx, code: string): Promise<boolean> {
  if (hasVerifiedLockerCode(code)) return true;
  const impl = minimalProxyImplementation(code);
  if (!impl) return false;
  return hasVerifiedLockerCode(await cachedCode(ctx, impl));
}

/**
 * Locked or burned liquidity is only a burn address, or an allowlisted locker whose code exposes getLock.
 * Any other contract that answers a lock or expiry probe is untrusted: its liquidity is not counted as locked,
 * and the report fails closed.
 */
async function classifyOwner(ctx: ScanCtx, req: V3LockRequest, npm: string, owner: string, tokenId: bigint): Promise<{ class: LpOwnerClass; expiry: LockExpiry | null; untrusted: boolean }> {
  if (isBurnAddress(owner)) return { class: 'burn', expiry: null, untrusted: false };
  const code = await cachedCode(ctx, owner);
  if (knownV3Locker(req.chainId, owner)) {
    if (!(await verifiedLockerBytecode(ctx, code))) return { class: 'other', expiry: null, untrusted: true };
    const table = await uncxExpiries(ctx, owner, npm);
    return { class: 'locker', expiry: table.get(tokenId.toString()) ?? null, untrusted: false };
  }
  if (!code || code === '0x' || code === '0x0') return { class: 'eoa', expiry: null, untrusted: false };
  const impl = minimalProxyImplementation(code);
  const implCode = impl ? await cachedCode(ctx, impl) : null;
  if (exposesLockSemantics(code) || exposesLockSemantics(implCode)) return { class: 'other', expiry: null, untrusted: true };
  // A contract with no lock selectors can still return a timestamp-shaped word. That is not a lock.
  const probed = await readGenericExpiry(ctx, owner, tokenId, PROBE_VIEWS);
  if (probed) return { class: 'other', expiry: null, untrusted: true };
  return { class: 'other', expiry: null, untrusted: false };
}

function reportOf(req: V3LockRequest, poolLiq: bigint, positions: V3PositionLock[], foundInRange: bigint, countable: bigint, unreadable: bigint, untrusted: bigint, shares: V3LpShares): V3LpReport {
  const base = {
    pool: req.pool.toLowerCase(), positionManager: req.positionManager.toLowerCase(),
    poolLiquidity: poolLiq.toString(), foundLiquidity: foundInRange.toString(), shares,
    lockedOrBurnedShare: ratio(countable, poolLiq), positions,
  };
  if (!covered(foundInRange, poolLiq)) {
    return { ...base, status: 'unverified', detail: 'in-range liquidity is not fully accounted for' };
  }
  if (poolLiq > 0n && untrusted * 10_000n > poolLiq * COVERAGE_DUST_BPS) {
    return { ...base, status: 'unverified', detail: 'owner is not a verified locker or burn address' };
  }
  if (meetsMin(countable, poolLiq)) return { ...base, status: 'verified', detail: null };
  if (meetsMin(countable + unreadable, poolLiq)) {
    return { ...base, status: 'unverified', detail: 'locker expiry unreadable' };
  }
  return { ...base, status: 'verified', detail: null };
}

async function runInspect(ctx: ScanCtx, req: V3LockRequest): Promise<V3LpReport> {
  const pool = req.pool.toLowerCase();
  const npm = req.positionManager.toLowerCase();
  const iface = V3_LP_IFACE.pool;
  const [slotRaw, liqRaw, t0Raw, t1Raw, feeRaw] = await many(ctx, [
    { to: pool, data: iface.encodeFunctionData('slot0', []) },
    { to: pool, data: iface.encodeFunctionData('liquidity', []) },
    { to: pool, data: iface.encodeFunctionData('token0', []) },
    { to: pool, data: iface.encodeFunctionData('token1', []) },
    { to: pool, data: iface.encodeFunctionData('fee', []) },
  ]);
  const slot = decode<{ 1: bigint }>(iface, 'slot0', slotRaw);
  const liq = decode<{ 0: bigint }>(iface, 'liquidity', liqRaw);
  const t0 = decode<{ 0: string }>(iface, 'token0', t0Raw);
  const t1 = decode<{ 0: string }>(iface, 'token1', t1Raw);
  const fee = decode<{ 0: bigint }>(iface, 'fee', feeRaw);
  if (!slot || !liq || !t0 || !t1 || !fee) throw new Error('pool views unreadable');
  const poolLiq = BigInt(liq[0]);
  const tick = Number(slot[1]);
  const token0 = String(t0[0]).toLowerCase();
  const token1 = String(t1[0]).toLowerCase();
  if (poolLiq === 0n) {
    return {
      status: 'verified', pool, positionManager: npm, poolLiquidity: '0', foundLiquidity: '0',
      shares: zeroShares(), lockedOrBurnedShare: 0, positions: [], detail: 'no in-range liquidity',
    };
  }
  const meta = { token0, token1, fee: Number(fee[0]), tick };
  const found = await discover(ctx, { ...req, pool, positionManager: npm }, npm, meta, poolLiq);
  const positions: V3PositionLock[] = [];
  let untrusted = 0n;
  for (const pos of found) {
    const cls = await classifyOwner(ctx, req, npm, pos.owner, pos.tokenId);
    if (cls.untrusted && pos.inRange) untrusted += pos.liquidity;
    const expiry = cls.class === 'locker' ? cls.expiry : null;
    const permanent = !!expiry?.permanent;
    const unlockAt = permanent ? null : expiry?.at ?? null;
    const expired = cls.class === 'locker' && !permanent && unlockAt != null && unlockAt <= req.nowSec;
    positions.push({
      tokenId: pos.tokenId.toString(), owner: pos.owner, liquidity: pos.liquidity.toString(),
      inRange: pos.inRange, class: cls.class, unlockAt, permanent, expired,
    });
  }
  let burn = 0n, lockerLiq = 0n, eoa = 0n, other = 0n, countable = 0n, unreadable = 0n, foundInRange = 0n;
  for (const p of positions) {
    if (!p.inRange) continue;
    const liq = BigInt(p.liquidity);
    foundInRange += liq;
    if (p.class === 'burn') { burn += liq; countable += liq; }
    else if (p.class === 'eoa') eoa += liq;
    else if (p.class === 'other') other += liq;
    else {
      lockerLiq += liq;
      if (p.permanent || (p.unlockAt != null && p.unlockAt > req.nowSec)) countable += liq;
      else if (p.unlockAt == null && !p.expired) unreadable += liq;
    }
  }
  return reportOf(req, poolLiq, positions, foundInRange, countable, unreadable, untrusted, {
    locker: ratio(lockerLiq, poolLiq), burn: ratio(burn, poolLiq), eoa: ratio(eoa, poolLiq), other: ratio(other, poolLiq),
  });
}

/**
 * Read one V3 pool's position NFTs and classify the in-range liquidity.
 * Never throws: RPC trouble comes back as `status: 'unverified'`.
 * Repeated calls for the same pool reuse a short cache (verified 10 min, unverified 30 s).
 */
export async function inspectV3LpLock(rpc: V3LockRpc, req: V3LockRequest): Promise<V3LpReport> {
  const pool = req.pool.toLowerCase();
  const npm = req.positionManager.toLowerCase();
  const key = `${req.chainId}:${pool}:${npm}`;
  const clock = req.clock ?? Date.now;
  const hit = cache.get(key);
  if (hit && clock() - hit.at < hit.ttl) return hit.report;
  const ctx: ScanCtx = { rpc: pace(rpc, req), multicall: null, code: new Map(), uncx: new Map() };
  let report: V3LpReport;
  try {
    report = await runInspect(ctx, req);
  } catch (e) {
    report = unverifiedV3Lp(pool, npm, `rpc failed: ${clip(e)}`);
  }
  cache.set(key, { at: clock(), ttl: report.status === 'verified' ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS, report });
  return report;
}
