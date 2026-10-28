/**
 * Pair search for the pair pickers: the pools on this app's DEXes for the coins that match what was typed (DexScreener).
 *
 *  1. /latest/dex/search finds coins by symbol, name or address: 30 pools across every chain DexScreener knows.
 *  2. The best-matching coins on the app's chains (by the liquidity of their pools in that answer, at most 3) get all
 *     their pools from /token-pairs/v1/{chain}/{coin}, since a search for "DAI" is mostly Ethereum pools.
 *  3. A pool is kept when its DEX is one this app trades (DexConfig.screener, matched by factory() on-chain), and is
 *     oriented the way a market is: the quote is the chain's wrapped coin, else a stablecoin, else a coin of the app's
 *     markets. A V3 pool's fee tier is read on-chain.
 *  4. A coin the app knows keeps the app's name (bridged HEX is eHEX, though its symbol() says HEX). An unknown coin
 *     using a known coin's name is flagged: a "HEX" at another address traded on PulseX V2 on 2026-10-22.
 * Nothing is added here: picking a pool runs the safety check (MultiBot.addPoolMarket).
 */
import type { Hub } from '../chains/hub';
import { V3_POOL } from '../dex/abis';
import { sameAddr } from '../dex/types';
import type { FetchJson } from '../fetchJson';

export interface FoundCoin {
  address: string; symbol: string; name: string;
  /** Not a coin the app knows, but named like one: that coin's name */
  lookalike: string | null;
}
export interface FoundPool {
  chainId: number; dex: string; dexName: string; kind: 'v2' | 'v3'; pool: string;
  base: FoundCoin; quote: FoundCoin;
  /** V3: fee tier in hundredths of a bip (2500 = 0.25%), read on-chain. V2: the DEX's fee in bps */
  feeTier: number | null; feeBps: number | null;
  liquidityUsd: number | null; volume24hUsd: number | null;
  /** The market already trading on this pool */
  market: string | null;
  /** A liquidity bot can hold a position here (V3 on a DEX with a verified position manager) */
  lpOk: boolean;
}

interface ScreenerCoin { address: string; symbol: string; name: string }
interface ScreenerPair {
  chainId: string; dexId: string; labels?: string[]; pairAddress: string; baseToken: ScreenerCoin; quoteToken: ScreenerCoin;
  liquidity?: { usd?: number }; volume?: { h24?: number };
}

const API = 'https://api.dexscreener.com';
/** DexScreener's answers carry max-age=60 */
const CACHE_MS = 60_000;
/** Coins whose pools are all listed */
const COINS = 3;
const MAX_POOLS = 25;
/** A 429 waits this long before the next try (seen on the first request after a pause, 2026-10-22) */
const RETRY_MS = [1000, 2000];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class PoolSearch {
  private cache = new Map<string, { at: number; v: unknown }>();
  constructor(
    private readonly hub: Hub,
    private readonly fetchJson: FetchJson,
    private readonly o: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}
  private now() { return (this.o.now ?? Date.now)(); }

  private async get(url: string): Promise<unknown> {
    const now = this.now();
    for (const [k, c] of this.cache) if (now - c.at >= CACHE_MS) this.cache.delete(k);
    const hit = this.cache.get(url);
    if (hit) return hit.v;
    for (let i = 0; ; i++) {
      try {
        const v = await this.fetchJson(url);
        this.cache.set(url, { at: now, v });
        return v;
      } catch (e) {
        if (!/HTTP 429/.test(String((e as Error)?.message)) || i >= RETRY_MS.length) throw e;
        await (this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(RETRY_MS[i]);
      }
    }
  }

  /** Pools for `q` (a symbol, name, coin or pool address) on `chainIds`, deepest first. */
  async search(q: string, chainIds: number[]): Promise<FoundPool[]> {
    q = q.trim();
    if (q.length < 2) throw new Error('Type at least 2 letters, or a coin or pool address.');
    const chains = chainIds.map((id) => this.hub.chain(id)).filter((c) => c.screener && this.hub.rt(c.id).tradable);
    if (!chains.length) throw new Error('Pair search covers PulseChain, Robinhood Chain and Ethereum: pick one of them.');
    const bySlug = new Map(chains.map((c) => [c.screener!, c]));

    const answer = (await this.get(`${API}/latest/dex/search?q=${encodeURIComponent(q)}`)) as { pairs?: ScreenerPair[] };
    if (!Array.isArray(answer?.pairs)) throw new Error('DexScreener: unexpected answer to a search');
    const lq = q.toLowerCase(), isAddr = ADDRESS.test(q);
    const matches = (t: ScreenerCoin) => (isAddr ? t.address.toLowerCase() === lq : t.symbol.toLowerCase().includes(lq) || t.name.toLowerCase().includes(lq));
    const hits = answer.pairs.filter((p) => bySlug.has(p.chainId) && (matches(p.baseToken) || matches(p.quoteToken) || (isAddr && p.pairAddress.toLowerCase() === lq)));

    // every pool of the best-matching coins on these chains
    const coins = new Map<string, { slug: string; address: string; liq: number }>();
    for (const p of hits) {
      for (const t of [p.baseToken, p.quoteToken]) {
        if (!matches(t)) continue;
        const k = `${p.chainId}:${t.address.toLowerCase()}`;
        const c = coins.get(k) ?? { slug: p.chainId, address: t.address, liq: 0 };
        c.liq += p.liquidity?.usd ?? 0;
        coins.set(k, c);
      }
    }
    const top = [...coins.values()].sort((a, b) => b.liq - a.liq).slice(0, COINS);
    const lists = await Promise.all(top.map(async (c) => {
      const l = await this.get(`${API}/token-pairs/v1/${c.slug}/${c.address}`);
      if (!Array.isArray(l)) throw new Error('DexScreener: unexpected answer for a coin\'s pools');
      return l as ScreenerPair[];
    }));
    const pairs = new Map<string, ScreenerPair>();
    for (const p of [...hits, ...lists.flat()]) if (bySlug.has(p.chainId)) pairs.set(`${p.chainId}:${p.pairAddress.toLowerCase()}`, p);

    const known = new Map(chains.map((c) => [c.id, this.known(c.id)]));
    const out: FoundPool[] = [];
    for (const p of pairs.values()) {
      const cfg = bySlug.get(p.chainId)!;
      const dex = cfg.dexes.find((d) => d.screener === `${p.dexId}:${(p.labels?.[0] ?? '').toLowerCase()}`);
      if (!dex || (dex.kind !== 'v2' && dex.kind !== 'v3')) continue;
      const side = this.orient(cfg.id, p.baseToken, p.quoteToken, known.get(cfg.id)!);
      if (!side) continue;
      out.push({
        chainId: cfg.id, dex: dex.id, dexName: dex.name, kind: dex.kind, pool: p.pairAddress, ...side, feeTier: null, feeBps: dex.kind === 'v2' ? dex.feeBps ?? null : null,
        liquidityUsd: p.liquidity?.usd ?? null, volume24hUsd: p.volume?.h24 ?? null,
        market: this.hub.marketOnPool(cfg.id, dex.id, p.pairAddress, side.base.address, side.quote.address),
        lpOk: dex.kind === 'v3' && !!dex.positionManager,
      });
    }
    const list = out.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, MAX_POOLS);
    await Promise.all(list.filter((x) => x.kind === 'v3').map(async (x) => {
      const raw = await this.hub.rt(x.chainId).reader.call({ to: x.pool, data: V3_POOL.encodeFunctionData('fee') });
      x.feeTier = Number(V3_POOL.decodeFunctionResult('fee', raw)[0]);
    }));
    return list;
  }

  /** Base and quote the way a market has them; null when neither coin can be a quote here. */
  private orient(chainId: number, a: ScreenerCoin, b: ScreenerCoin, known: Map<string, string>): { base: FoundCoin; quote: FoundCoin } | null {
    const opts = this.hub.quoteOptions(chainId);
    const rank = (t: ScreenerCoin) => opts.findIndex((o) => sameAddr(o.address, t.address));
    const ra = rank(a), rb = rank(b);
    if (ra < 0 && rb < 0) return null;
    const [base, quote] = rb >= 0 && (ra < 0 || rb < ra) ? [a, b] : [b, a];
    const names = [...known.values(), this.hub.chain(chainId).wrappedNative.symbol];
    const coin = (t: ScreenerCoin): FoundCoin => {
      const app = known.get(t.address.toLowerCase());
      if (app) return { address: t.address, symbol: app, name: t.name, lookalike: null };
      const sym = t.symbol.trim().toLowerCase();
      return { address: t.address, symbol: t.symbol, name: t.name, lookalike: names.find((n) => n.toLowerCase() === sym) ?? null };
    };
    return { base: coin(base), quote: coin(quote) };
  }

  /**
   * The coins of a chain the app knows, by address, named as its markets name them: the wrapped coin as the chain's own
   * (markets trade WPLS as PLS), stablecoins, and the markets' coins.
   */
  private known(chainId: number): Map<string, string> {
    const cfg = this.hub.chain(chainId), k = new Map<string, string>([[cfg.wrappedNative.address.toLowerCase(), cfg.nativeSymbol]]);
    for (const t of cfg.stables) k.set(t.address.toLowerCase(), t.symbol);
    for (const m of this.hub.byChain(chainId)) for (const t of [m.base, m.quote]) if (!t.native) k.set(t.address.toLowerCase(), t.symbol);
    return k;
  }
}
