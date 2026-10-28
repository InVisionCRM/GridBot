/**
 * Pool address for a bot the app's market list does not already name.
 *
 * The saved bot has the two symbols, the DEX and (on its fills) the fee tier. Token addresses come from the chain
 * registry when the coin is one the app knows, and otherwise from a DexScreener search. The pool itself is read
 * from that DEX's factory (getPool / getPair) with eth_call. Nothing here signs or sends.
 */
import { CHAINS, type DexConfig } from '../live/chains';
import { ERC20, FACTORY, V3_FACTORY } from '../server/dex/abis';
import { diskCache, type FetchLike } from './adapters';
import type { BacktestChain } from './gasModel';
import type { BotConfig, TokenRef } from './run';

interface ScreenerPair {
  chainId?: string;
  dexId?: string;
  labels?: string[];
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
}

const ZERO = /^0x0{40}$/i;

function chainOf(key: BacktestChain) {
  const c = CHAINS.find((x) => x.key === key);
  if (!c) throw new Error(`no public node for ${key}`);
  return c;
}

async function ethCall(rpcUrl: string, to: string, data: string, cacheDir: string, fetchFn: FetchLike): Promise<string> {
  const { value } = await diskCache(cacheDir, `rpc eth_call ${to} ${data}`, async () => {
    const r = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await r.json() as { result?: string; error?: { message?: string } };
    if (!r.ok || j.error || !j.result || j.result === '0x') throw new Error(j.error?.message ?? 'pool lookup failed');
    return j.result;
  });
  return value;
}

function isAddress(v: string | undefined): v is string {
  return !!v && /^0x[0-9a-fA-F]{40}$/.test(v) && !ZERO.test(v);
}

async function factoryPool(dex: DexConfig, base: string, quote: string, feeTier: number | undefined, rpc: string, cacheDir: string, fetchFn: FetchLike): Promise<string> {
  if (dex.kind === 'v3') {
    if (feeTier == null) return '';
    const data = V3_FACTORY.encodeFunctionData('getPool', [base, quote, feeTier]);
    const raw = await ethCall(rpc, dex.factory, data, cacheDir, fetchFn);
    const pool = V3_FACTORY.decodeFunctionResult('getPool', raw)[0] as string;
    return isAddress(pool) ? pool : '';
  }
  const data = FACTORY.encodeFunctionData('getPair', [base, quote]);
  const raw = await ethCall(rpc, dex.factory, data, cacheDir, fetchFn);
  const pair = FACTORY.decodeFunctionResult('getPair', raw)[0] as string;
  return isAddress(pair) ? pair : '';
}

function nativeNames(chain: BacktestChain): Set<string> {
  const c = chainOf(chain);
  return new Set([c.nativeSymbol, c.wrappedNative.symbol].map((s) => s.toLowerCase()));
}

function symMatch(chain: BacktestChain, want: string, got: string | undefined): boolean {
  if (!got) return false;
  if (want.toLowerCase() === got.toLowerCase()) return true;
  const names = nativeNames(chain);
  return names.has(want.toLowerCase()) && names.has(got.toLowerCase());
}

function dexMatches(dex: DexConfig, pair: ScreenerPair): boolean {
  const tag = dex.screener;
  if (!tag || !pair.dexId) return false;
  const [id, label] = tag.split(':');
  if (pair.dexId.toLowerCase() !== id) return false;
  if (!label) return true;
  return (pair.labels ?? []).some((l) => l.toLowerCase() === label);
}

async function searchPairs(symbol: string, cacheDir: string, fetchFn: FetchLike): Promise<ScreenerPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`;
  const { value } = await diskCache(cacheDir, url, async () => {
    const r = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`pool search failed (${r.status})`);
    return r.json();
  });
  const pairs = (value as { pairs?: ScreenerPair[] })?.pairs;
  return Array.isArray(pairs) ? pairs : [];
}

/** A DexScreener pair on this chain whose two coins are the bot's, preferring the bot's DEX and the deepest pool. */
async function findPair(cfg: BotConfig, cacheDir: string, fetchFn: FetchLike): Promise<ScreenerPair | null> {
  const chain = chainOf(cfg.chain);
  const slug = chain.screener;
  if (!slug) return null;
  const dex = chain.dexes.find((d) => d.id === cfg.dex);
  let pairs: ScreenerPair[] = [];
  try { pairs = await searchPairs(cfg.base.symbol, cacheDir, fetchFn); } catch { pairs = []; }
  if (!pairs.length) {
    try { pairs = await searchPairs(cfg.quote.symbol, cacheDir, fetchFn); } catch { pairs = []; }
  }
  const hits = pairs.filter((p) => p.chainId === slug && p.pairAddress && (
    (symMatch(cfg.chain, cfg.base.symbol, p.baseToken?.symbol) && symMatch(cfg.chain, cfg.quote.symbol, p.quoteToken?.symbol))
    || (symMatch(cfg.chain, cfg.base.symbol, p.quoteToken?.symbol) && symMatch(cfg.chain, cfg.quote.symbol, p.baseToken?.symbol))
  ));
  if (!hits.length) return null;
  const ranked = [...hits].sort((a, b) => {
    const da = dex && dexMatches(dex, a) ? 1 : 0;
    const db = dex && dexMatches(dex, b) ? 1 : 0;
    return db - da || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
  });
  return ranked[0];
}

function tokenOnPair(cfg: BotConfig, pair: ScreenerPair, side: 'base' | 'quote'): { address: string; symbol: string } | null {
  const want = side === 'base' ? cfg.base.symbol : cfg.quote.symbol;
  for (const t of [pair.baseToken, pair.quoteToken]) {
    if (!t) continue;
    const symbol = t.symbol;
    const address = t.address;
    if (symbol && symMatch(cfg.chain, want, symbol) && isAddress(address)) return { address, symbol };
  }
  return null;
}

async function readDecimals(token: string, rpc: string, cacheDir: string, fetchFn: FetchLike): Promise<number | null> {
  try {
    const data = ERC20.encodeFunctionData('decimals');
    const raw = await ethCall(rpc, token, data, cacheDir, fetchFn);
    const n = Number(ERC20.decodeFunctionResult('decimals', raw)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readToken0(pool: string, rpc: string, cacheDir: string, fetchFn: FetchLike): Promise<string> {
  try {
    const data = '0x0dfe1681';
    const raw = await ethCall(rpc, pool, data, cacheDir, fetchFn);
    const addr = '0x' + raw.replace(/^0x/, '').slice(-40);
    return isAddress(addr) ? addr : '';
  } catch {
    return '';
  }
}

function withAddress(token: TokenRef, address: string, decimals: number | null): TokenRef {
  return { ...token, address, ...(decimals != null ? { decimals } : {}) };
}

/**
 * Fill in a missing pool address and token addresses. Returns null when the coins cannot be found.
 * The caller keeps every other field of the config.
 */
export async function discoverPool(cfg: BotConfig, rpcUrl: string, cacheDir: string, fetchFn: FetchLike): Promise<Pick<BotConfig, 'pool' | 'base' | 'quote' | 'dex' | 'feeBps' | 'feeTier' | 'baseIs0'> | null> {
  const chain = chainOf(cfg.chain);
  const dex = chain.dexes.find((d) => d.id === cfg.dex) ?? null;
  let base = cfg.base.address ?? '';
  let quote = cfg.quote.address ?? '';
  let pool = cfg.pool ?? '';
  const pair = (!base || !quote || !pool) ? await findPair(cfg, cacheDir, fetchFn) : null;
  if (pair) {
    const b = tokenOnPair(cfg, pair, 'base');
    const q = tokenOnPair(cfg, pair, 'quote');
    if (b && !base) base = b.address;
    if (q && !quote) quote = q.address;
    if (!pool && pair.pairAddress && isAddress(pair.pairAddress)) pool = pair.pairAddress;
  }
  if (dex && isAddress(base) && isAddress(quote)) {
    try {
      const found = await factoryPool(dex, base, quote, cfg.feeTier, rpcUrl, cacheDir, fetchFn);
      if (found) pool = found;
    } catch { /* the search address stands when the factory read fails */ }
  }
  if (!isAddress(pool) || !isAddress(base)) return null;
  const [baseDec, quoteDec, token0] = await Promise.all([
    cfg.base.address ? Promise.resolve(null) : readDecimals(base, rpcUrl, cacheDir, fetchFn),
    cfg.quote.address ? Promise.resolve(null) : readDecimals(quote, rpcUrl, cacheDir, fetchFn),
    readToken0(pool, rpcUrl, cacheDir, fetchFn),
  ]);
  return {
    pool,
    dex: cfg.dex,
    feeBps: cfg.feeBps,
    feeTier: cfg.feeTier,
    base: withAddress(cfg.base, base, baseDec),
    quote: withAddress(cfg.quote, quote, quoteDec),
    baseIs0: token0 ? token0.toLowerCase() === base.toLowerCase() : cfg.baseIs0,
  };
}
