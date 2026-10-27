/**
 * Public market data for the harness. Candles come from GeckoTerminal or DexScreener. Pool state comes from a
 * read-only eth_call. Nothing here can move coins: the only RPC method used is eth_call (plus eth_gasPrice, a
 * read). Answers are cached as JSON under a directory the caller chooses (default data/backtest-cache, gitignored).
 *
 * Chains are the ones the app trades. The pool address selects the DEX, so a PulseChain pool can be PulseX V1,
 * PulseX V2, 9mm V2 or 9mm V3, and an Ethereum or Robinhood pool can be Uniswap V2 or V3.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAINS, type ChainConfig } from '../live/chains';
import type { Candle } from '../market/candles';
import { V3_POOL, V3_POOL_FEES, V3_POOL_LP } from '../server/dex/abis';
import type { BacktestChain } from './gasModel';

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export function chainConfig(key: BacktestChain): ChainConfig {
  const c = CHAINS.find((x) => x.key === key);
  if (!c || !c.geckoSlug) throw new Error(`no public data for ${key}`);
  return c;
}

/** GeckoTerminal hourly candles, mid price (quote per base), volume in the quote token. Newest page first is sorted here. */
export function parseGeckoOhlcv(body: unknown): Candle[] {
  const rows = (body as { data?: { attributes?: { ohlcv_list?: unknown[] } } })?.data?.attributes?.ohlcv_list ?? [];
  const out: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (t > 0 && c > 0) out.push({ t, o, h, l, c, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * DexScreener candle payload. Their documented API has no history; the chart route some clients call returns either
 * `[t, o, h, l, c, v]` rows or `{ bars: [{ t, o, h, l, c, v }] }`. Both are accepted. Prices are mid, quote per base.
 */
export function parseDexscreenerOhlcv(body: unknown): Candle[] {
  const b = body as { bars?: unknown[]; candles?: unknown[]; ohlcv?: unknown[] };
  const rows = b?.bars ?? b?.candles ?? b?.ohlcv ?? (Array.isArray(body) ? body : []);
  const out: Candle[] = [];
  for (const row of rows) {
    if (Array.isArray(row) && row.length >= 6) {
      const [t, o, h, l, c, v] = row.map(Number);
      if (t > 0 && c > 0) out.push({ t, o, h, l, c, v });
      continue;
    }
    const r = row as { t?: number; time?: number; timestamp?: number; o?: number; open?: number; h?: number; high?: number; l?: number; low?: number; c?: number; close?: number; v?: number; volume?: number };
    const t = Number(r.t ?? r.time ?? r.timestamp);
    const c = Number(r.c ?? r.close);
    if (t > 0 && c > 0) out.push({ t, o: Number(r.o ?? r.open ?? c), h: Number(r.h ?? r.high ?? c), l: Number(r.l ?? r.low ?? c), c, v: Number(r.v ?? r.volume ?? 0) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Prices quoted in the other coin, turned into prices of that other coin. A flipped market (USDC per ETH fetched
 * for an ETH-per-USDC bot) uses this. Volume was in the fetched quote, so it is divided by that price.
 */
export function invertCandles(candles: Candle[]): Candle[] {
  return candles.map((c) => ({
    t: c.t,
    o: 1 / c.o,
    h: 1 / c.l,
    l: 1 / c.h,
    c: 1 / c.c,
    v: c.c > 0 ? c.v / c.c : 0,
  }));
}

export function geckoOhlcvUrl(
  network: string, pool: string, baseToken: string, beforeSec?: number,
  bar: { unit: 'hour' | 'minute'; n: number } = { unit: 'hour', n: 1 },
): string {
  const q = new URLSearchParams({ aggregate: String(bar.n), limit: '1000', currency: 'token', token: baseToken });
  if (beforeSec) q.set('before_timestamp', String(beforeSec));
  return `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/${bar.unit}?${q}`;
}

export function dexscreenerOhlcvUrl(screenerChain: string, pool: string, from: number, to: number): string {
  return `https://api.dexscreener.com/latest/dex/ohlcv/${screenerChain}/${pool}?interval=1h&limit=1000&from=${from}&to=${to}`;
}

const fileOf = (key: string) => createHash('sha256').update(key).digest('hex') + '.json';

/** Read JSON from disk, or load it once and store it. The key is a URL or an RPC request, never a secret. */
export async function diskCache<T>(dir: string, key: string, load: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const file = join(dir, fileOf(key));
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')) as T, hit: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const value = await load();
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return { value, hit: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, fetchFn: FetchLike, cacheDir: string): Promise<unknown> {
  const host = new URL(url).host;
  const { value } = await diskCache(cacheDir, url, async () => {
    // GeckoTerminal answers 429 and asks for about a minute. A cached miss waits and tries again; other errors do not.
    let wait = 65_000;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (r.status === 429 && attempt < 3 && host.includes('geckoterminal')) {
        await sleep(wait);
        wait = Math.min(wait * 2, 180_000);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${host}`);
      return r.json();
    }
    throw new Error(`HTTP 429 from ${host}`);
  });
  return value;
}

/** Hourly candles inside [from, to), oldest first. `source` auto tries GeckoTerminal, then DexScreener. */
export async function loadCandles(o: {
  chain: BacktestChain;
  pool: string;
  baseToken: string;
  from: number;
  to: number;
  source?: 'gecko' | 'dexscreener' | 'auto';
  /** Bar size in minutes. 60 is one hour. 15 uses the minute endpoint, which a short window needs to count range moves. */
  barMinutes?: number;
  cacheDir: string;
  fetchFn?: FetchLike;
}): Promise<{ candles: Candle[]; source: 'gecko' | 'dexscreener' }> {
  const fetchFn = o.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const chain = chainConfig(o.chain);
  const want = o.source ?? 'auto';
  const errors: string[] = [];
  if (want !== 'dexscreener') {
    try {
      const candles = await geckoRange(chain.geckoSlug!, o.pool, o.baseToken, o.from, o.to, fetchFn, o.cacheDir, o.barMinutes ?? 60);
      if (candles.length) return { candles, source: 'gecko' };
      errors.push('GeckoTerminal returned no candles');
    } catch (e) { errors.push((e as Error).message); }
    if (want === 'gecko') throw new Error(errors.join('; '));
  }
  const slug = chain.screener ?? chain.key;
  const url = dexscreenerOhlcvUrl(slug, o.pool, o.from, o.to);
  const candles = parseDexscreenerOhlcv(await getJson(url, fetchFn, o.cacheDir)).filter((c) => c.t >= o.from && c.t < o.to);
  if (!candles.length) throw new Error(`no candles (${errors.join('; ') || 'DexScreener empty'})`);
  return { candles, source: 'dexscreener' };
}

async function geckoRange(network: string, pool: string, base: string, from: number, to: number, fetchFn: FetchLike, cacheDir: string, barMinutes: number): Promise<Candle[]> {
  const out: Candle[] = [];
  const bar = barMinutes >= 60 ? { unit: 'hour' as const, n: Math.max(1, Math.round(barMinutes / 60)) } : { unit: 'minute' as const, n: barMinutes };
  // A before_timestamp past "now" is rejected. Clamp so a window that ends on the latest price still loads.
  const now = Math.floor(Date.now() / 1000);
  let before = Math.min(to, now) + 1;
  for (let page = 0; page < 8; page++) {
    const rows = parseGeckoOhlcv(await getJson(geckoOhlcvUrl(network, pool, base, before, bar), fetchFn, cacheDir));
    if (!rows.length) break;
    out.push(...rows);
    if (rows[0].t <= from) break;
    const next = rows[0].t;
    if (next >= before) break;
    before = next;
  }
  const seen = new Map<number, Candle>();
  for (const c of out) if (c.t >= from && c.t < to) seen.set(c.t, c);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

export interface V3Snapshot {
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  fee: number;
  feeProtocol: number;
  tickSpacing: number;
  token0: string;
  token1: string;
  source: 'on-chain actual';
}

export interface RpcCall {
  (to: string, data: string): Promise<string>;
}

/** Decode one pool view from eth_call results. `raw` values are 0x-prefixed hex. */
export function decodeV3Snapshot(raw: { slot0: string; liquidity: string; token0: string; token1: string; fee: string; tickSpacing: string }): V3Snapshot {
  const slot = V3_POOL_FEES.decodeFunctionResult('slot0', raw.slot0);
  const liquidity = V3_POOL.decodeFunctionResult('liquidity', raw.liquidity)[0] as bigint;
  const token0 = V3_POOL.decodeFunctionResult('token0', raw.token0)[0] as string;
  const token1 = V3_POOL.decodeFunctionResult('token1', raw.token1)[0] as string;
  const fee = Number(V3_POOL.decodeFunctionResult('fee', raw.fee)[0]);
  const tickSpacing = Number(V3_POOL_LP.decodeFunctionResult('tickSpacing', raw.tickSpacing)[0]);
  return {
    sqrtPriceX96: (slot[0] as bigint).toString(),
    tick: Number(slot[1]),
    liquidity: liquidity.toString(),
    fee,
    feeProtocol: Number(slot[5]),
    tickSpacing,
    token0, token1,
    source: 'on-chain actual',
  };
}

const V3_CALLS = {
  slot0: V3_POOL_FEES.encodeFunctionData('slot0'),
  liquidity: V3_POOL.encodeFunctionData('liquidity'),
  token0: V3_POOL.encodeFunctionData('token0'),
  token1: V3_POOL.encodeFunctionData('token1'),
  fee: V3_POOL.encodeFunctionData('fee'),
  tickSpacing: V3_POOL_LP.encodeFunctionData('tickSpacing'),
} as const;

/** Pool state through eth_call only. `rpc` is one JSON-RPC URL; the caller picks a public endpoint. */
export async function readV3Pool(pool: string, rpcUrl: string, cacheDir: string, fetchFn?: FetchLike): Promise<V3Snapshot> {
  const fetchFn2 = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const call: RpcCall = async (to, data) => {
    const key = `${rpcUrl} eth_call ${to} ${data}`;
    const { value } = await diskCache(cacheDir, key, async () => {
      const r = await fetchFn2(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const j = await r.json() as { result?: string; error?: { message?: string } };
      if (!r.ok || j.error || !j.result) throw new Error(j.error?.message ?? `pool read failed (${r.status})`);
      return j.result;
    });
    return value;
  };
  const raw = {
    slot0: await call(pool, V3_CALLS.slot0),
    liquidity: await call(pool, V3_CALLS.liquidity),
    token0: await call(pool, V3_CALLS.token0),
    token1: await call(pool, V3_CALLS.token1),
    fee: await call(pool, V3_CALLS.fee),
    tickSpacing: await call(pool, V3_CALLS.tickSpacing),
  };
  return decodeV3Snapshot(raw);
}

/** Current gas price in native units per gas (wei ÷ 1e18). Read-only. */
export async function readGasPrice(rpcUrl: string, cacheDir: string, fetchFn?: FetchLike): Promise<number> {
  const fetchFn2 = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const { value } = await diskCache(cacheDir, `${rpcUrl} eth_gasPrice`, async () => {
    const r = await fetchFn2(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    });
    const j = await r.json() as { result?: string; error?: { message?: string } };
    if (!r.ok || !j.result) throw new Error(j.error?.message ?? 'gas price read failed');
    return j.result;
  });
  return Number(BigInt(value)) / 1e18;
}
