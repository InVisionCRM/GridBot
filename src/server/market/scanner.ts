/**
 * Daily pair scan per chain (PulseChain, Ethereum, Robinhood):
 *   GeckoTerminal top pools by 24 h volume → pickTokens (real liquidity, real trades, a native/stable side)
 *   + the markets already in the app → safety check for new tokens (hub.inspect: honeypot / tax simulation)
 *   → last 7 days of hourly candles through the grid backtester with the pool's real fee, depth and gas
 *   → the 3 best setups per chain. Nothing is added or started: "Use this" adds the market and opens New bot.
 * Every tested pair also gets a grid vs liquidity position vs hold comparison over the same week (market/lp.ts),
 * with the LP fee share each DEX really pays (V2: measured constant; V3: read from the pool's slot0).
 * Runs once a day (and on demand) at the test size you last chose; results persist in data/picks.json.
 */
import type { MarketDef, MarketToken, SafetyReport } from '../../live/markets';
import { bestSetup, checkTestUsd, pickTokens, PICKS_PER_CHAIN, SCAN_CANDLES, SCAN_EVERY_MS, TEST_USD, type Setup, type Skipped, type TopPool } from '../../market/scan';
import { bestLp, lpShareFromFeeProtocol, type LpSetup } from '../../market/lp';
import { buyHold } from '../../market/backtest';
import { simBuy } from '../../market/costs';
import { closedOnly, fillGaps, type Candle, type TF } from '../../market/candles';
import type { CandleStore } from './candleStore';
import type { MarketSnapshot } from '../bot/chain';
import { costModelOf } from '../bot/econ';
import type { Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import { readCall, sameAddr } from '../dex/types';
import { V3_POOL_FEES } from '../dex/abis';
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
  /** Why the safety check gave that risk (shown with the badge) */
  riskWhy: string | null;
  /** Spot when scanned; the suggested range is centred on it */
  price: number;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  bandPct: number;
  test: Setup & { capital: number; usd: number };
  activity: { volume24Usd: number; liquidityUsd: number; tx24: number; change24Pct: number | null } | null;
}

/** Grid vs liquidity position vs hold for one tested pair, same week, same test size. */
export interface CompareRow {
  label: string;
  dex: string;
  feeBps: number;
  holdPct: number;
  /**
   * Price impact of putting the whole test amount in at once (what "hold" pays at the start). Shown so a thin pool
   * explains itself: the 2026-10-17 scan at $25k had PLS/USDT "hold −96%" in a ≈$28k pool while PLS fell ≈38%.
   */
  entryImpactPct: number;
  /** Best grid that made money (null = none did) */
  grid: { returnPct: number; bandPct: number; gridCount: number } | null;
  /** Best liquidity position (null = not tested, see lpWhy) */
  lp: LpSetup | null;
  /** Share of the pool fee liquidity providers keep on this DEX / pool */
  lpShare: number | null;
  lpWhy: string | null;
}

export interface ScanChain { chainId: number; name: string; at: number; picks: ScanPick[]; compare: CompareRow[]; tested: number; skipped: Skipped[]; error: string | null }
export interface ScanFile { version: 2; at: number | null; testUsd: number; chains: ScanChain[] }

/** `dexes` = GeckoTerminal ids of the DEXes this app trades on the chain (only their pools are read). */
export interface ScanChainInfo { id: number; name: string; slug: string | null; wrapped: string; spendable: string[]; dexes: string[] }

export interface ScanDeps {
  chains(): ScanChainInfo[];
  /** Markets already in the app, oriented to spend the native coin or a stablecoin */
  existing(chainId: number): MarketDef[];
  /** New token → draft market that passed the safety check; throws the reason otherwise */
  inspect(chainId: number, token: string, spend: string): Promise<MarketDef>;
  snapshot(def: MarketDef): Promise<MarketSnapshot>;
  /** Saved closed hourly candles of a market in the app (gap-filled, oldest first); [] for a new token */
  storedHourly(def: MarketDef): Candle[];
  /** Share of the swap fee liquidity providers keep in this market's pool; throws when it isn't verified */
  lpShare(def: MarketDef): Promise<number>;
  /** USD per unit of the market's spend coin */
  usdPerSpend(def: MarketDef): Promise<number>;
  gecko: {
    topPools(network: string, dex: string, page?: number): Promise<TopPool[]>;
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
    const f = d.store.load();
    this.file = f?.version === 2 ? f : { version: 2, at: null, testUsd: TEST_USD, chains: [] };
  }

  private now() { return (this.d.now ?? Date.now)(); }

  status() {
    return { ...this.file, running: this.running, progress: this.progress, nextAt: this.file.at == null ? null : this.file.at + SCAN_EVERY_MS };
  }

  /** Check every 30 min; scan when the last one is a day old (or there is none). */
  start(checkMs = 30 * 60_000) {
    if (this.timer) return;
    const due = () => { if (!this.running && (this.file.at == null || this.now() - this.file.at >= SCAN_EVERY_MS)) void this.run().catch(() => undefined); };
    due();
    this.timer = setInterval(due, checkMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** `testUsd` = test size in USD (kept for the daily scans after it); defaults to the last one used. */
  async run(testUsd: number = this.file.testUsd): Promise<ScanFile> {
    const usd = checkTestUsd(testUsd);
    if (this.running) throw new Error('A scan is already running.');
    this.running = true;
    this.d.emit?.({ type: 'info', kind: 'system', msg: `Daily pair scan started ($${usd.toLocaleString('en-US')} test size)` });
    try {
      const chains: ScanChain[] = [];
      const list = this.d.chains();
      for (const [i, c] of list.entries()) chains.push(await this.scanChain(c, i + 1, list.length, usd));
      this.file = { version: 2, at: this.now(), testUsd: usd, chains };
      this.d.store.save(this.file);
      this.d.emit?.({ type: 'info', kind: 'system', level: 'success', msg: `Daily pair scan done: ${chains.map((c) => `${c.name} ${c.picks.length} pick${c.picks.length === 1 ? '' : 's'}`).join(', ')}` });
      return this.file;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  private async scanChain(c: ScanChainInfo, chainNo: number, chains: number, usd: number): Promise<ScanChain> {
    const step = (phase: ScanProgress['phase'], done: number, total: number) => { this.progress = { chain: c.name, chainNo, chains, phase, done, total }; };
    step('finding pools', 0, 1);
    const out: ScanChain = { chainId: c.id, name: c.name, at: this.now(), picks: [], compare: [], tested: 0, skipped: [], error: null };
    if (!c.slug) { out.error = 'No GeckoTerminal price history for this chain.'; return out; }
    try {
      // Busiest pools of each DEX this app trades. The chain-wide list is the wrong input: on 2026-10-17, 33 of
      // Robinhood's 40 busiest pools were Uniswap V4 (not tradable here, and GeckoTerminal reports most of them with
      // $0 liquidity), which crowded out the real Uniswap V3 stock pools (NVDA ~6.9k trades/day, SPCX ~12k).
      const pools: TopPool[] = [];
      for (const dex of c.dexes) pools.push(...await retryOnce(() => this.d.gecko.topPools(c.slug!, dex)));
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
          const r = await this.test(c, m.def, m.pool, m.isNew, usd);
          out.compare.push(r.row);
          if (r.pick) picks.push(r.pick);
          else out.skipped.push({ name, why: `no range made money over the last 7 days (price ${r.movePct >= 0 ? '+' : ''}${(r.movePct * 100).toFixed(1)}% this week)` });
        } catch (e) { out.skipped.push({ name, why: msg(e) }); }
      }
      out.picks = picks.sort((a, b) => b.test.returnPct - a.test.returnPct).slice(0, PICKS_PER_CHAIN).map((p, i) => ({ ...p, rank: i + 1 }));
    } catch (e) {
      out.error = msg(e);
    }
    return out;
  }

  /**
   * Best grid setup for one market over the last 7 days, centred on today's price, plus the grid vs LP vs hold row.
   * movePct = the pair's price change over the test window (shown when nothing made money).
   */
  private async test(c: ScanChainInfo, d: MarketDef, pool: TopPool | null, isNew: boolean, usd: number): Promise<{ pick: ScanPick | null; movePct: number; row: CompareRow }> {
    const snap = await this.d.snapshot(d);
    const capital = usd / await this.d.usdPerSpend(d);
    // The candle sync keeps every market's hourly series: reuse it when it covers the week up to the last 2 hours
    // (one GeckoTerminal request saved per market in the app; the shared budget can be ~6 requests a minute).
    const saved = this.d.storedHourly(d);
    const fresh = saved.length >= SCAN_CANDLES && saved[saved.length - 1].t >= this.now() / 1000 - 2 * 3600;
    const token = d.base.native ? c.wrapped : d.base.address;
    const k = fresh ? saved : await retryOnce(() => this.d.gecko.ohlcv(d.candlePool || d.pool.address, token, '1h', undefined, SCAN_CANDLES, { network: c.slug!, feeBps: d.pool.feeBps }));
    const week = k.slice(-SCAN_CANDLES);
    const costs = costModelOf(snap, d.pool.feeBps, this.d.approval);
    const s = bestSetup(week, costs, capital);
    const movePct = week[week.length - 1].c / week[0].o - 1;
    const bh = buyHold(week, 0, capital, costs);
    const row: CompareRow = {
      label: `${d.base.symbol}/${d.quote.symbol}`, dex: d.pool.dex, feeBps: d.pool.feeBps,
      holdPct: (bh.pls * week[week.length - 1].c + bh.cashLeft) / capital - 1,
      entryImpactPct: simBuy(capital, week[0].o, costs).impactPct,
      grid: s ? { returnPct: s.returnPct, bandPct: s.bandPct, gridCount: s.gridCount } : null,
      lp: null, lpShare: null, lpWhy: null,
    };
    try {
      row.lpShare = await this.d.lpShare(d);
      row.lp = bestLp(week, costs, capital, d.pool.kind, row.lpShare);
    } catch (e) { row.lpWhy = msg(e); }
    if (!s) return { pick: null, movePct, row };
    return { movePct, row, pick: {
      chainId: c.id, rank: 0,
      // A new token's draft quote keeps the wrapped address (WPLS / WETH) even though it spends the native coin.
      key: isNew ? null : d.key,
      add: isNew ? { address: d.base.address, quote: d.quote.address, pool: d.pool.address } : null,
      label: `${d.base.symbol}/${d.quote.symbol}`, spend: d.quote.symbol, stack: d.base.symbol,
      dex: d.pool.dex, feeBps: d.pool.feeBps, risk: d.safety?.risk ?? null, riskWhy: d.safety?.reasons.join(' ') || null,
      price: snap.spot, lowerPrice: sig(snap.spot * (1 - s.bandPct)), upperPrice: sig(snap.spot * (1 + s.bandPct)), gridCount: s.gridCount, bandPct: s.bandPct,
      test: { ...s, capital, usd },
      activity: pool ? { volume24Usd: pool.volume24Usd, liquidityUsd: pool.liquidityUsd, tx24: pool.tx24, change24Pct: pool.change24Pct } : null,
    } };
  }
}

/** Scan dependencies backed by the live hub (markets, safety check, quoters, native USD price) and GeckoTerminal. */
export function scanDepsFromHub(hub: Hub, candles: CandleStore, rest: Pick<ScanDeps, 'gecko' | 'store' | 'approval' | 'now' | 'emit'>): ScanDeps {
  const spends = (chainId: number, t: MarketToken) => t.native || sameAddr(t.address, hub.chain(chainId).wrappedNative.address) || hub.isStable(chainId, t.address);
  return {
    ...rest,
    chains: () => hub.runtimes().filter((rt) => rt.tradable && rt.cfg.status === 'live').map((rt) => ({
      id: rt.cfg.id, name: rt.cfg.name, slug: rt.cfg.geckoSlug, wrapped: rt.cfg.wrappedNative.address,
      spendable: [rt.cfg.wrappedNative.address, ...rt.cfg.stables.map((s) => s.address)],
      dexes: rt.cfg.dexes.flatMap((d) => (d.gecko ? [d.gecko] : [])),
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
    storedHourly: (d) => {
      if (!hub.has(d.key)) return [];
      const nowSec = Math.floor((rest.now ?? Date.now)() / 1000);
      return fillGaps(closedOnly(candles.get(d.key, '1h'), '1h', nowSec), '1h');
    },
    lpShare: async (d) => {
      const dex = hub.chain(d.chainId).dexes.find((x) => x.id === d.pool.dex);
      if (!dex) throw new Error(`unknown DEX ${d.pool.dex}`);
      if (dex.kind === 'v2') {
        if (dex.lpShare == null) throw new Error(`${dex.name}: the share of fees paid to liquidity providers isn't verified`);
        return dex.lpShare;
      }
      if (!dex.protocolFee) throw new Error(`${dex.name}: protocol fee encoding isn't verified`);
      const r = await readCall<unknown[]>(hub.rt(d.chainId).reader, d.pool.address, V3_POOL_FEES, 'slot0');
      return lpShareFromFeeProtocol(Number(r[5]), dex.protocolFee);
    },
    usdPerSpend: async (d) => {
      if (hub.isStable(d.chainId, d.quote.address)) return 1;
      if (!spends(d.chainId, d.quote)) throw new Error(`${d.quote.symbol} is not the native coin or a stablecoin`);
      const usd = await hub.nativeUsdAsync(d.chainId);
      if (!usd) throw new Error(`no USD price for ${hub.chain(d.chainId).nativeSymbol}`);
      return usd;
    },
  };
}
