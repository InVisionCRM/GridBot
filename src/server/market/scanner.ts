/**
 * Daily pair scan per chain (PulseChain, Ethereum, Robinhood):
 *   GeckoTerminal top pools by 24 h volume → pickTokens (real liquidity, real trades, a native/stable side)
 *   + the markets already in the app → safety check for new tokens (hub.inspect: honeypot / tax simulation)
 *   → last 7 days of hourly candles through the grid backtester with the pool's real fee, depth and gas
 *   → the 3 best setups per chain. Nothing is added or started: "Use this" adds the market and opens New bot.
 * Runs once a day (and on demand); results persist in data/picks.json.
 */
import type { MarketDef, MarketToken, SafetyReport } from '../../live/markets';
import { bestSetup, pickTokens, PICKS_PER_CHAIN, SCAN_CANDLES, SCAN_EVERY_MS, TEST_USD, type Setup, type Skipped, type TopPool } from '../../market/scan';
import type { Candle, TF } from '../../market/candles';
import type { MarketSnapshot } from '../bot/chain';
import { costModelOf } from '../bot/econ';
import type { Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import { sameAddr } from '../dex/types';
import { RateLimited } from './gecko';


export interface ScanPick {
  chainId: number;
  rank: number;
  /** Market key when the pair is already in the app (may be a flipped key such as 'HEX~') */
  key: string | null;
  /** How to add it otherwise (POST /api/picks/use) */
  add: { address: string; quote: string; pool: string } | null;
  label: string;
  spend: string;
  stack: string;
  dex: string;
  feeBps: number;
  risk: SafetyReport['risk'] | null;
  /** Spot when scanned; the suggested range is centred on it */
  price: number;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  bandPct: number;
  test: Setup & { capital: number; usd: number };
  activity: { volume24Usd: number; liquidityUsd: number; tx24: number; change24Pct: number | null } | null;
}

export interface ScanChain { chainId: number; name: string; at: number; picks: ScanPick[]; tested: number; skipped: Skipped[]; error: string | null }
export interface ScanFile { version: 1; at: number | null; chains: ScanChain[] }

export interface ScanChainInfo { id: number; name: string; slug: string | null; wrapped: string; spendable: string[] }

export interface ScanDeps {
  chains(): ScanChainInfo[];
  /** Markets already in the app, oriented to spend the native coin or a stablecoin */
  existing(chainId: number): MarketDef[];
  /** New token → draft market that passed the safety check; throws the reason otherwise */
  inspect(chainId: number, token: string, spend: string): Promise<MarketDef>;
  snapshot(def: MarketDef): Promise<MarketSnapshot>;
  /** USD per unit of the market's spend coin */
  usdPerSpend(def: MarketDef): Promise<number>;
  gecko: {
    topPools(network: string, page?: number): Promise<TopPool[]>;
    ohlcv(pool: string, token: string, tf: TF, beforeSec?: number, limit?: number, o?: { network?: string; feeBps?: number }): Promise<Candle[]>;
  };
  store: Store<ScanFile>;
  approval: 'exact' | 'max';
  now?: () => number;
  emit?: Emit;
}

const lc = (a: string) => a.toLowerCase();
const sig = (x: number) => +x.toPrecision(6);
const msg = (e: unknown) => (e as Error).message.slice(0, 200);

/**
 * One retry after a 429 (GeckoSource waits out the back-off before the next request) or a GeckoTerminal 5xx
 * (the real scan on 2026-10-17 lost ETH/USDC to a single HTTP 500).
 */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof RateLimited || /GeckoTerminal HTTP 5\d\d/.test((e as Error).message)) return fn();
    throw e;
  }
}

/** What a running scan is doing now (shown on Home). */
export interface ScanProgress { chain: string; chainNo: number; chains: number; phase: 'finding pools' | 'checking new tokens' | 'testing pairs'; done: number; total: number }

export class DailyScanner {
  private file: ScanFile;
  private running = false;
  private progress: ScanProgress | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ScanDeps) {
    this.file = d.store.load() ?? { version: 1, at: null, chains: [] };
  }

  private now() { return (this.d.now ?? Date.now)(); }

  status() {
    return { ...this.file, running: this.running, progress: this.progress, nextAt: this.file.at == null ? null : this.file.at + SCAN_EVERY_MS, testUsd: TEST_USD };
  }

  /** Check every 30 min; scan when the last one is a day old (or there is none). */
  start(checkMs = 30 * 60_000) {
    if (this.timer) return;
    const due = () => { if (!this.running && (this.file.at == null || this.now() - this.file.at >= SCAN_EVERY_MS)) void this.run().catch(() => undefined); };
    due();
    this.timer = setInterval(due, checkMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async run(): Promise<ScanFile> {
    if (this.running) throw new Error('A scan is already running.');
    this.running = true;
    this.d.emit?.({ type: 'info', kind: 'system', msg: 'Daily pair scan started' });
    try {
      const chains: ScanChain[] = [];
      const list = this.d.chains();
      for (const [i, c] of list.entries()) chains.push(await this.scanChain(c, i + 1, list.length));
      this.file = { version: 1, at: this.now(), chains };
      this.d.store.save(this.file);
      this.d.emit?.({ type: 'info', kind: 'system', level: 'success', msg: `Daily pair scan done: ${chains.map((c) => `${c.name} ${c.picks.length} pick${c.picks.length === 1 ? '' : 's'}`).join(', ')}` });
      return this.file;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  private async scanChain(c: ScanChainInfo, chainNo: number, chains: number): Promise<ScanChain> {
    const step = (phase: ScanProgress['phase'], done: number, total: number) => { this.progress = { chain: c.name, chainNo, chains, phase, done, total }; };
    step('finding pools', 0, 1);
    const out: ScanChain = { chainId: c.id, name: c.name, at: this.now(), picks: [], tested: 0, skipped: [], error: null };
    if (!c.slug) { out.error = 'No GeckoTerminal price history for this chain.'; return out; }
    try {
      const pools = [...await retryOnce(() => this.d.gecko.topPools(c.slug!, 1)), ...await retryOnce(() => this.d.gecko.topPools(c.slug!, 2))];
      const { picked, skipped } = pickTokens(pools, c.spendable, c.wrapped);
      out.skipped.push(...skipped);
      const stackOf = (m: MarketDef) => lc(m.base.native ? c.wrapped : m.base.address);
      const spendOf = (m: MarketDef) => lc(m.quote.native ? c.wrapped : m.quote.address);
      const markets: { def: MarketDef; pool: TopPool | null; isNew: boolean }[] = this.d.existing(c.id).map((def) => ({
        def, isNew: false, pool: pools.find((p) => (p.base === stackOf(def) && p.quote === spendOf(def)) || (p.quote === stackOf(def) && p.base === spendOf(def))) ?? null,
      }));
      for (const [i, t] of picked.entries()) {
        step('checking new tokens', i, picked.length);
        if (markets.some((m) => stackOf(m.def) === t.token && spendOf(m.def) === t.spend)) continue;
        try { markets.push({ def: await this.d.inspect(c.id, t.token, t.spend), pool: t.pool, isNew: true }); } catch (e) { out.skipped.push({ name: t.pool.name, why: msg(e) }); }
      }
      out.tested = markets.length;
      const picks: ScanPick[] = [];
      for (const [i, m] of markets.entries()) {
        step('testing pairs', i, markets.length);
        const name = `${m.def.base.symbol}/${m.def.quote.symbol}`;
        try {
          const p = await this.test(c, m.def, m.pool, m.isNew);
          if (p) picks.push(p); else out.skipped.push({ name, why: 'no range made money over the last 7 days' });
        } catch (e) { out.skipped.push({ name, why: msg(e) }); }
      }
      out.picks = picks.sort((a, b) => b.test.returnPct - a.test.returnPct).slice(0, PICKS_PER_CHAIN).map((p, i) => ({ ...p, rank: i + 1 }));
    } catch (e) {
      out.error = msg(e);
    }
    return out;
  }

  /** Best setup for one market over the last 7 days, centred on today's price. */
  private async test(c: ScanChainInfo, d: MarketDef, pool: TopPool | null, isNew: boolean): Promise<ScanPick | null> {
    const snap = await this.d.snapshot(d);
    const capital = TEST_USD / await this.d.usdPerSpend(d);
    const token = d.base.native ? c.wrapped : d.base.address;
    const k = await retryOnce(() => this.d.gecko.ohlcv(d.candlePool || d.pool.address, token, '1h', undefined, SCAN_CANDLES, { network: c.slug!, feeBps: d.pool.feeBps }));
    const s = bestSetup(k.slice(-SCAN_CANDLES), costModelOf(snap, d.pool.feeBps, this.d.approval), capital);
    if (!s) return null;
    return {
      chainId: c.id, rank: 0,
      // A new token's draft quote keeps the wrapped address (WPLS / WETH) even though it spends the native coin.
      key: isNew ? null : d.key,
      add: isNew ? { address: d.base.address, quote: d.quote.address, pool: d.pool.address } : null,
      label: `${d.base.symbol}/${d.quote.symbol}`, spend: d.quote.symbol, stack: d.base.symbol,
      dex: d.pool.dex, feeBps: d.pool.feeBps, risk: d.safety?.risk ?? null,
      price: snap.spot, lowerPrice: sig(snap.spot * (1 - s.bandPct)), upperPrice: sig(snap.spot * (1 + s.bandPct)), gridCount: s.gridCount, bandPct: s.bandPct,
      test: { ...s, capital, usd: TEST_USD },
      activity: pool ? { volume24Usd: pool.volume24Usd, liquidityUsd: pool.liquidityUsd, tx24: pool.tx24, change24Pct: pool.change24Pct } : null,
    };
  }
}

/** Scan dependencies backed by the live hub (markets, safety check, quoters, native USD price) and GeckoTerminal. */
export function scanDepsFromHub(hub: Hub, rest: Pick<ScanDeps, 'gecko' | 'store' | 'approval' | 'now' | 'emit'>): ScanDeps {
  const spends = (chainId: number, t: MarketToken) => t.native || sameAddr(t.address, hub.chain(chainId).wrappedNative.address) || hub.isStable(chainId, t.address);
  return {
    ...rest,
    chains: () => hub.runtimes().filter((rt) => rt.tradable && rt.cfg.status === 'live').map((rt) => ({
      id: rt.cfg.id, name: rt.cfg.name, slug: rt.cfg.geckoSlug, wrapped: rt.cfg.wrappedNative.address,
      spendable: [rt.cfg.wrappedNative.address, ...rt.cfg.stables.map((s) => s.address)],
    })),
    // PLS/DAI and ETH/USDC spend the stablecoin; PLS/HEX is turned around to HEX/PLS so it spends PLS.
    existing: (chainId) => hub.byChain(chainId).flatMap((d) => (spends(chainId, d.quote) ? [d] : spends(chainId, d.base) ? [hub.def(`${d.key}~`)] : [])),
    inspect: async (chainId, token, spend) => {
      const r = await hub.inspect({ chainId, address: token, quote: spend });
      if (!r.draft) throw new Error('no pool on a DEX this app trades');
      if (!r.safety?.liveAllowed) throw new Error(`failed the safety check (${r.safety?.risk ?? 'unknown'}): ${(r.safety?.reasons ?? []).join(' ')}`.trim());
      return r.draft;
    },
    snapshot: (d) => (hub.has(d.key) ? hub.quoter(d.key) : hub.draftQuoter(d)).market(),
    usdPerSpend: async (d) => {
      if (hub.isStable(d.chainId, d.quote.address)) return 1;
      if (!spends(d.chainId, d.quote)) throw new Error(`${d.quote.symbol} is not the native coin or a stablecoin`);
      const usd = await hub.nativeUsdAsync(d.chainId);
      if (!usd) throw new Error(`no USD price for ${hub.chain(d.chainId).nativeSymbol}`);
      return usd;
    },
  };
}
