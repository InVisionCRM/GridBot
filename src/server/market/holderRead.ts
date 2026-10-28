/**
 * Read-only holder concentration.
 *
 * Blockscout's token API is the list when it answers. Robinhood Chain's Blockscout sits behind Cloudflare and
 * returns 403 to this client, so that chain falls back to a bounded Transfer-log sample plus balanceOf and
 * totalSupply on its RPC, and to GeckoTerminal's top-10 share when the token info page has one.
 *
 * Explorer and RPC calls are paced per chain and cached. A chain with neither an API nor a log reader has no
 * holder source. Anything we still can't pin down comes back unverified; the caller decides whether that blocks.
 */
import { getAddress, id } from 'ethers';
import type { ChainConfig } from '../../live/chains';
import { V4_POOL_MANAGER } from '../../market/poolEvents';
import { DEFAULT_MIN_HOLDER_COVERAGE, HOLDER_PAGE_CAP, explainedBalance, geckoTop10Share, holderCoverage, holderShares, includedHolders, isExcludedHolder, protocolExclusions, type HolderMath, type HolderRow } from '../../market/holders';
import { ERC20, FACTORY, V3_FACTORY } from '../dex/abis';
import { isZero, readCall } from '../dex/types';
import type { FetchJson } from '../fetchJson';

export const HOLDER_PACE_MS = 500;
const VERIFIED_TTL_MS = 10 * 60_000;
const UNVERIFIED_TTL_MS = 60_000;

export interface HolderQuery {
  chainId: number;
  token: string;
  /** Shown in the skip reason. Falls back to `chain <id>` when omitted. */
  chainName?: string;
  /** Blockscout v2 base, no trailing path. null = this chain has no public holder API. */
  api: string | null;
  exclude: readonly string[];
  /** Wrapped native and stables. Used to look up every factory pool for this token. */
  spends?: readonly string[];
  /** Factories on this chain. V2 uses getPair; V3 uses getPool for each fee tier. */
  dexes?: readonly { kind: string; factory?: string; feeTiers?: readonly number[]; positionManager?: string | null }[];
  /** GeckoTerminal network slug, for the top-10 share when the explorer list is unreachable. */
  geckoSlug?: string | null;
}

export interface HolderLog {
  topics: readonly string[];
  data?: string;
  blockNumber?: number;
}

/** The chain RPC, used when the explorer list is missing or refused. */
export interface HolderChain {
  getBlockNumber(): Promise<number>;
  getLogs(f: { address: string; topics: string[]; fromBlock: number; toBlock: number }): Promise<readonly HolderLog[]>;
  call(tx: { to: string; data: string }): Promise<string>;
  /** Bytecode at a block. Used to binary-search the creation block. Missing history returns the same code for every block. */
  getCode?(address: string, blockTag: number | 'latest'): Promise<string>;
}

export interface HolderReadOpts {
  fetchJson: FetchJson;
  /** Fallback when the explorer token page has no total_supply. One eth_call. */
  totalSupply?: (chainId: number, token: string) => Promise<bigint>;
  now?: () => number;
  /** Tests pass 0. Production uses HOLDER_PACE_MS. */
  paceMs?: number;
  /** Present when this process can read the chain. Robinhood uses it after Blockscout returns 403. */
  chain?: HolderChain;
  /** Blocks per eth_getLogs. Halved when the RPC says the query matched too many logs. */
  logSpan?: number;
  /** How many spans to walk back from the head. The window stays bounded. */
  logChunks?: number;
  /** Explained balances ÷ totalSupply. Default 0.90. */
  minCoverage?: number;
}

interface HolderPage {
  items?: {
    address?: { hash?: string; address_hash?: string; name?: string | null; public_tags?: { display_name?: string | null }[] };
    value?: unknown;
  }[];
  next_page_params?: Record<string, string | number> | null;
}

const cache = new Map<string, { at: number; value: HolderMath }>();
const lanes = new Map<number, { chain: Promise<unknown>; lastAt: number }>();
const blockedHosts = new Map<string, number>();
const TRANSFER = id('Transfer(address,address,uint256)');

export function clearHolderCache() {
  cache.clear();
  lanes.clear();
  blockedHosts.clear();
}

/** Blockscout v2 base for holder lists. Does not invent a tokenApi for chains that deliberately omit one. */
export function holderApiBase(cfg: Pick<ChainConfig, 'tokenApi' | 'explorer'>): string | null {
  if (cfg.tokenApi) return cfg.tokenApi.replace(/\/$/, '');
  if (!cfg.explorer) return null;
  try {
    const u = new URL(cfg.explorer);
    if (u.hostname === 'blockscout.com' || u.hostname.endsWith('.blockscout.com')) return `${u.origin}/api/v2`;
  } catch { /* not a URL */ }
  return null;
}

function asBig(v: unknown): bigint | null {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

function rowName(it: NonNullable<HolderPage['items']>[number]): string | null {
  const addr = it.address;
  if (!addr) return null;
  const tags = (addr.public_tags ?? []).map((t) => t.display_name).filter((x): x is string => !!x);
  const parts = [addr.name, ...tags].filter((x): x is string => !!x);
  return parts.length ? parts.join(' ') : null;
}

function descending(items: NonNullable<HolderPage['items']>): boolean {
  let prev: bigint | null = null;
  for (const it of items) {
    const b = asBig(it.value);
    if (b == null) return false;
    if (prev != null && b > prev) return false;
    prev = b;
  }
  return true;
}

function withParams(url: string, params: Record<string, string | number> | null): string {
  if (!params) return url;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const s = q.toString();
  return s ? `${url}?${s}` : url;
}

/** One lane per chain, so a slow Robinhood read does not hold up Ethereum. */
function paced<T>(chainId: number, gap: number, now: () => number, fn: () => Promise<T>): Promise<T> {
  let lane = lanes.get(chainId);
  if (!lane) { lane = { chain: Promise.resolve(), lastAt: 0 }; lanes.set(chainId, lane); }
  const run = lane.chain.then(async () => {
    const wait = Math.max(0, gap - (now() - lane!.lastAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lane!.lastAt = now();
    return fn();
  });
  lane.chain = run.then(() => undefined, () => undefined);
  return run;
}

function hostOf(api: string): string {
  try { return new URL(api).host; } catch { return api; }
}

function topicAddr(topic: string | undefined): string | null {
  if (!topic || topic.length < 42) return null;
  try { return getAddress(`0x${topic.slice(-40)}`); } catch { return null; }
}

function unverified(kind: 'no-source' | 'read-failed', chainName: string): HolderMath {
  return { unverified: true, largest: null, top10: null, included: 0, unavailable: kind, chainName, coverage: null };
}

const CODE_STEPS = 16;
const MINT_STEPS = 6;
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

function emptyCode(code: string | null | undefined): boolean {
  return !code || code === '0x' || code === '0x0';
}

/** Binary search eth_getCode inside the history the node still has, then the first mint from 0x0. */
async function findCreationBlock(chain: HolderChain, token: string, head: number, chainId: number, gap: number, now: () => number): Promise<number | null> {
  if (chain.getCode) {
    const codeAt = (block: number) => paced(chainId, gap, now, () => chain.getCode!(token, block));
    try {
      const latest = await codeAt(head);
      if (!emptyCode(latest)) {
        let knownCode = head;
        let knownEmpty: number | null = null;
        let step = 1_000;
        for (let i = 0; i < CODE_STEPS && knownEmpty == null; i++) {
          const block = Math.max(0, knownCode - step);
          let code: string;
          try { code = await codeAt(block); } catch { break; }
          if (emptyCode(code)) knownEmpty = block;
          else if (block === 0) return 0;
          else { knownCode = block; step = Math.min(step * 4, head); }
        }
        if (knownEmpty != null) {
          let lo = knownEmpty;
          let hi = knownCode;
          for (let i = 0; i < CODE_STEPS && lo + 1 < hi; i++) {
            const mid = Math.floor((lo + hi) / 2);
            const code = await codeAt(mid);
            if (emptyCode(code)) lo = mid;
            else hi = mid;
          }
          return hi;
        }
      }
    } catch { /* fall through to the mint log */ }
  }
  let lo = 0;
  let hi = head;
  let found: number | null = null;
  for (let i = 0; i < MINT_STEPS && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    let logs: readonly HolderLog[] = [];
    try {
      logs = await paced(chainId, gap, now, () => chain.getLogs({ address: token, topics: [TRANSFER, ZERO_TOPIC], fromBlock: lo, toBlock: mid }));
    } catch { return found; }
    const blocks = logs.map((l) => l.blockNumber).filter((n): n is number => n != null);
    if (!blocks.length) { lo = mid + 1; continue; }
    const earliest = Math.min(...blocks);
    found = found == null ? earliest : Math.min(found, earliest);
    if (earliest <= lo) return found;
    hi = earliest - 1;
  }
  return found;
}

function attachCoverage(base: HolderMath, rows: readonly HolderRow[], supply: bigint, scan: { scannedLogs: boolean; windowFrom: number | null; creationBlock: number | null }, min: number): HolderMath {
  const judged = holderCoverage({
    totalSupply: supply, explained: explainedBalance(rows), min,
    scannedLogs: scan.scannedLogs, windowFrom: scan.windowFrom, creationBlock: scan.creationBlock,
  });
  const placed = { coverage: judged.coverage, windowFrom: scan.windowFrom, creationBlock: scan.creationBlock };
  if (base.unverified || !judged.thin) return { ...base, ...placed, thin: false };
  return {
    ...base, ...placed, thin: true, holders: 'unknown, coverage thin',
    unverified: false, largest: null, top10: null, unavailable: undefined,
  };
}

async function excludeAll(q: HolderQuery, opts: HolderReadOpts, gap: number, now: () => number): Promise<string[]> {
  const out = new Set<string>([...q.exclude, ...protocolExclusions(q.dexes ?? []), V4_POOL_MANAGER]);
  const chain = opts.chain;
  const spends = (q.spends ?? []).filter((s) => s.toLowerCase() !== q.token.toLowerCase());
  if (chain && spends.length && q.dexes?.length) {
    for (const dex of q.dexes) {
      if (!dex.factory) continue;
      for (const spend of spends) {
        if (dex.kind === 'v2') {
          try {
            const [pair] = await paced(q.chainId, gap, now, () => readCall<[string]>(chain, dex.factory!, FACTORY, 'getPair', [q.token, spend]));
            if (!isZero(pair)) out.add(getAddress(pair));
          } catch { /* this factory didn't answer */ }
        } else if (dex.kind === 'v3') {
          for (const tier of dex.feeTiers ?? []) {
            try {
              const [pool] = await paced(q.chainId, gap, now, () => readCall<[string]>(chain, dex.factory!, V3_FACTORY, 'getPool', [q.token, spend, tier]));
              if (!isZero(pool)) out.add(getAddress(pool));
            } catch { /* this fee tier didn't answer */ }
          }
        }
      }
    }
  }
  return [...out];
}

/** Blockscout list. Throws when the host refuses the call (Cloudflare 403), so the caller can try the chain. */
async function readExplorer(q: HolderQuery, opts: HolderReadOpts, exclude: readonly string[], gap: number, now: () => number, chainName: string): Promise<HolderMath> {
  const api = q.api!.replace(/\/$/, '');
  const tokenUrl = `${api}/tokens/${q.token}`;
  let supply: bigint | null = null;
  try {
    const info = await paced(q.chainId, gap, now, () => opts.fetchJson(tokenUrl)) as { total_supply?: unknown };
    const s = asBig(info?.total_supply);
    if (s != null && s > 0n) supply = s;
  } catch (e) {
    if (/HTTP 403/.test((e as Error).message ?? '')) blockedHosts.set(hostOf(api), now() + VERIFIED_TTL_MS);
    /* holders may still be readable; supply can fall back to one eth_call */
  }

  const rows: HolderRow[] = [];
  let params: Record<string, string | number> | null = null;
  let more = false;
  let trustOrder = true;
  for (let page = 0; page < HOLDER_PAGE_CAP; page++) {
    const j = await paced(q.chainId, gap, now, () => opts.fetchJson(withParams(`${tokenUrl}/holders`, params))) as HolderPage;
    if (!Array.isArray(j?.items)) throw new Error('holders page');
    if (!descending(j.items)) trustOrder = false;
    for (const it of j.items) {
      const addr = it.address?.hash ?? it.address?.address_hash;
      const balance = asBig(it.value);
      if (!addr || balance == null || balance === 0n) continue;
      rows.push({ address: addr, balance, name: rowName(it) });
    }
    const next = j.next_page_params && Object.keys(j.next_page_params).length ? j.next_page_params : null;
    if (!next) { more = false; break; }
    if (trustOrder && includedHolders(rows, exclude).length >= 10) { more = false; break; }
    params = next;
    more = true;
  }
  if (!trustOrder && more) return unverified('read-failed', chainName);
  if (supply == null && opts.totalSupply) {
    try { supply = await paced(q.chainId, gap, now, () => opts.totalSupply!(q.chainId, q.token)); } catch { supply = null; }
  }
  if (supply == null || !(supply > 0n)) return unverified('read-failed', chainName);
  const math = holderShares({ totalSupply: supply, holders: rows, exclude, moreHolders: more });
  return attachCoverage({ ...math, chainName, unseen: 0, top10Exact: true }, rows, supply, { scannedLogs: false, windowFrom: null, creationBlock: null }, opts.minCoverage ?? DEFAULT_MIN_HOLDER_COVERAGE);
}

async function geckoTop10(q: HolderQuery, opts: HolderReadOpts, gap: number, now: () => number): Promise<number | null> {
  if (!q.geckoSlug) return null;
  try {
    const body = await paced(q.chainId, gap, now, () => opts.fetchJson(`https://api.geckoterminal.com/api/v2/networks/${q.geckoSlug}/tokens/${q.token}/info`));
    return geckoTop10Share(body);
  } catch { return null; }
}

/** Recent Transfer counterparties, confirmed with balanceOf. Bounded so one token cannot sweep the RPC. */
async function readLogs(q: HolderQuery, opts: HolderReadOpts, exclude: readonly string[], gap: number, now: () => number, chainName: string): Promise<HolderMath | null> {
  const chain = opts.chain;
  if (!chain) return null;
  let supply: bigint | null = null;
  if (opts.totalSupply) {
    try { supply = await paced(q.chainId, gap, now, () => opts.totalSupply!(q.chainId, q.token)); } catch { supply = null; }
  }
  if (supply == null || !(supply > 0n)) {
    try {
      const [s] = await paced(q.chainId, gap, now, () => readCall<[bigint]>(chain, q.token, ERC20, 'totalSupply'));
      supply = s;
    } catch { return null; }
  }
  if (supply == null || !(supply > 0n)) return null;

  let head = 0;
  try { head = await paced(q.chainId, gap, now, () => chain.getBlockNumber()); } catch { return null; }
  let span = Math.max(250, opts.logSpan ?? 2_000);
  const chunks = Math.max(1, opts.logChunks ?? 4);
  const weight = new Map<string, bigint>();
  const bump = (addr: string | null, amount: bigint) => {
    if (!addr || isExcludedHolder(addr, null, exclude)) return;
    weight.set(addr, (weight.get(addr) ?? 0n) + (amount > 0n ? amount : 1n));
  };
  let cursor = head;
  let windowFrom: number | null = null;
  for (let i = 0; i < chunks && cursor > 0; i++) {
    const from = Math.max(0, cursor - span);
    try {
      const logs = await paced(q.chainId, gap, now, () => chain.getLogs({ address: q.token, topics: [TRANSFER], fromBlock: from, toBlock: cursor }));
      windowFrom = windowFrom == null ? from : Math.min(windowFrom, from);
      for (const l of logs) {
        const amount = l.data && l.data !== '0x' ? BigInt(l.data) : 1n;
        bump(topicAddr(l.topics[1]), amount);
        bump(topicAddr(l.topics[2]), amount);
      }
      cursor = from - 1;
    } catch (e) {
      const msg = `${(e as Error).message ?? ''} ${JSON.stringify((e as { error?: unknown }).error ?? '')}`;
      if (span > 250 && /exceeds limit|too many|10000/i.test(msg)) { span = Math.floor(span / 2); i--; continue; }
      break;
    }
  }

  const ranked = [...weight.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)).slice(0, 40).map(([a]) => a);
  const ask = [...new Set([...ranked, ...exclude].map((a) => a.toLowerCase()))];
  const rows: HolderRow[] = [];
  for (const addr of ask) {
    try {
      const raw = await paced(q.chainId, gap, now, () => chain.call({ to: q.token, data: ERC20.encodeFunctionData('balanceOf', [addr]) }));
      const balance = asBig(raw.startsWith('0x') ? BigInt(raw).toString() : raw);
      if (balance != null && balance > 0n) rows.push({ address: addr, balance });
    } catch { /* this balance is missing; the unseen share covers it */ }
  }
  const math = holderShares({ totalSupply: supply, holders: rows, exclude, moreHolders: false });
  let excludedBal = 0n;
  let seen = 0n;
  for (const r of rows) {
    if (isExcludedHolder(r.address, r.name, exclude)) excludedBal += r.balance;
    else seen += r.balance;
  }
  const circulating = supply - excludedBal;
  const unseen = circulating > seen ? Number((circulating - seen) * 1_000_000n / circulating) / 1_000_000 : 0;
  const gecko = await geckoTop10(q, opts, gap, now);
  const creationBlock = await findCreationBlock(chain, q.token, head, q.chainId, gap, now);
  return attachCoverage({
    ...math, chainName, unseen, top10: gecko ?? math.top10, top10Exact: gecko != null,
  }, rows, supply, { scannedLogs: true, windowFrom, creationBlock }, opts.minCoverage ?? DEFAULT_MIN_HOLDER_COVERAGE);
}

/**
 * Largest holder and top 10, or unverified. Never throws. No API and no chain reader is "no holder data source".
 * An API or log read that fails is "holder read failed".
 */
export async function readHolderConcentration(q: HolderQuery, opts: HolderReadOpts): Promise<HolderMath> {
  const now = opts.now ?? Date.now;
  const gap = opts.paceMs ?? HOLDER_PACE_MS;
  const chainName = q.chainName?.trim() || `chain ${q.chainId}`;
  const key = `${q.chainId}:${q.token.toLowerCase()}:${q.api ?? ''}:${[...q.exclude].map((a) => a.toLowerCase()).sort().join(',')}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.value.unverified ? UNVERIFIED_TTL_MS : VERIFIED_TTL_MS)) return hit.value;

  const finish = (value: HolderMath): HolderMath => {
    cache.set(key, { at: now(), value });
    return value;
  };
  let exclude: string[] = [];
  try { exclude = await excludeAll(q, opts, gap, now); } catch { exclude = [...q.exclude]; }

  const host = q.api ? hostOf(q.api) : '';
  const skipExplorer = !q.api || (blockedHosts.get(host) ?? 0) > now();
  if (!skipExplorer) {
    try {
      const listed = await readExplorer(q, opts, exclude, gap, now, chainName);
      if (!listed.unverified) return finish(listed);
      if (!opts.chain) return finish(listed);
    } catch (e) {
      if (q.api && /HTTP 403/.test((e as Error).message ?? '')) blockedHosts.set(host, now() + VERIFIED_TTL_MS);
      if (!opts.chain) return finish(unverified('read-failed', chainName));
    }
  }
  if (opts.chain) {
    try {
      const sampled = await readLogs(q, opts, exclude, gap, now, chainName);
      if (sampled) return finish(sampled);
    } catch { /* the log read failed */ }
    return finish(unverified('read-failed', chainName));
  }
  if (!q.api) return finish(unverified('no-source', chainName));
  return finish(unverified('read-failed', chainName));
}
