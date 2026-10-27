/**
 * Read-only holder concentration. Uses the chain's Blockscout token API (the same one Convert uses where it
 * exists). Robinhood Chain has no tokenApi — its explorer answers wallet-token lists with a Cloudflare
 * challenge — but the public Blockscout API is still the holder source, derived from the explorer URL and
 * not written back onto the chain config.
 *
 * One chain, one public RPC: explorer calls are paced and cached. A missing total supply is one totalSupply()
 * eth_call, never a log scan. Anything we can't read comes back unverified; the caller decides whether that
 * blocks.
 */
import type { ChainConfig } from '../../live/chains';
import { HOLDER_PAGE_CAP, holderShares, includedHolders, type HolderMath, type HolderRow } from '../../market/holders';
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
}

export interface HolderReadOpts {
  fetchJson: FetchJson;
  /** Fallback when the explorer token page has no total_supply. One eth_call. */
  totalSupply?: (chainId: number, token: string) => Promise<bigint>;
  now?: () => number;
  /** Tests pass 0. Production uses HOLDER_PACE_MS. */
  paceMs?: number;
}

interface HolderPage {
  items?: {
    address?: { hash?: string; address_hash?: string; name?: string | null; public_tags?: { display_name?: string | null }[] };
    value?: unknown;
  }[];
  next_page_params?: Record<string, string | number> | null;
}

const cache = new Map<string, { at: number; value: HolderMath }>();
let paceChain: Promise<unknown> = Promise.resolve();
let lastPaceAt = 0;

export function clearHolderCache() {
  cache.clear();
  paceChain = Promise.resolve();
  lastPaceAt = 0;
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

function paced<T>(gap: number, now: () => number, fn: () => Promise<T>): Promise<T> {
  const run = paceChain.then(async () => {
    const wait = Math.max(0, gap - (now() - lastPaceAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastPaceAt = now();
    return fn();
  });
  paceChain = run.then(() => undefined, () => undefined);
  return run;
}

function unverified(kind: 'no-source' | 'read-failed', chainName: string): HolderMath {
  return { unverified: true, largest: null, top10: null, included: 0, unavailable: kind, chainName };
}

/**
 * Largest holder and top 10, or unverified. Never throws: a failed explorer or a failed totalSupply() is unverified.
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
  if (!q.api) return finish(unverified('no-source', chainName));

  const api = q.api.replace(/\/$/, '');
  const tokenUrl = `${api}/tokens/${q.token}`;
  let supply: bigint | null = null;
  try {
    const info = await paced(gap, now, () => opts.fetchJson(tokenUrl)) as { total_supply?: unknown };
    const s = asBig(info?.total_supply);
    if (s != null && s > 0n) supply = s;
  } catch { /* holders may still be readable; supply can fall back to one eth_call */ }

  const rows: HolderRow[] = [];
  let params: Record<string, string | number> | null = null;
  let more = false;
  let trustOrder = true;
  try {
    for (let page = 0; page < HOLDER_PAGE_CAP; page++) {
      const j = await paced(gap, now, () => opts.fetchJson(withParams(`${tokenUrl}/holders`, params))) as HolderPage;
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
      if (trustOrder && includedHolders(rows, q.exclude).length >= 10) { more = false; break; }
      params = next;
      more = true;
    }
  } catch {
    return finish(unverified('read-failed', chainName));
  }

  if (!trustOrder && more) return finish(unverified('read-failed', chainName));
  if (supply == null && opts.totalSupply) {
    try { supply = await paced(gap, now, () => opts.totalSupply!(q.chainId, q.token)); } catch { supply = null; }
  }
  if (supply == null || !(supply > 0n)) return finish(unverified('read-failed', chainName));
  const math = holderShares({ totalSupply: supply, holders: rows, exclude: q.exclude, moreHolders: more });
  if (math.unverified) return finish({ ...math, unavailable: 'read-failed', chainName });
  return finish({ ...math, chainName });
}
