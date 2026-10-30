/**
 * Opportunity scan per chain, once a day and on demand:
 *   GeckoTerminal top pools of each DEX this app trades (SCAN_PAGES pages) → pickTokens (real liquidity, real trades,
 *   a native/stable side; up to SCAN_RULES.maxTokens) + the markets already in the app → the safety check for new
 *   tokens (hub.inspect: honeypot / tax simulation). Every safety level is kept: a token that fails is shown with
 *   why, and can only be paper traded (like one added under Markets).
 *   → the last 7 days of hourly candles through the grid backtester and the liquidity-position backtest, with the
 *   pool's real fee, depth, gas and the share of fees liquidity providers keep.
 * Each pool gets its best grid and its best liquidity range by what they EARNED: completed trades for a grid, fees −
 * swap and gas costs for a position, and how far its price swung. The price move is left out (shown separately): it
 * isn't the bot's doing. The page sorts them by what they are expected to earn next week (expectedGrid / expectedLp in
 * market/scan.ts). A chain with no earlier result shows its pools as they are tested; a re-scan keeps the earlier list
 * until the chain is done.
 * Nothing is added or started here: "Try it" adds the market and opens New bot. Results persist in data/picks.json.
 */
import { usdAsEth } from '../../lib/ethUnits';
import type { MarketDef, MarketToken } from '../../live/markets';
import { bestSetup, checkTestUsd, dailySwing, pickTokens, SCAN_CANDLES, SCAN_EVERY_MS, SCAN_PAGES, TEST_USD, type Opportunity, type Skipped, type TopPool } from '../../market/scan';
import { feePace } from '../../market/lpFees';
import { bestLp } from '../../market/lp';
import { fillGaps, replayCandles, trimSpikes, type Candle, type TF } from '../../market/candles';
import type { CandleStore } from './candleStore';
import type { MarketSnapshot } from '../bot/chain';
import { costModelOf } from '../bot/econ';
import type { Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import { sameAddr } from '../dex/types';
import { lpShareOf } from '../lp/lpShare';
import { onchainFeePace } from './feePace';
import { RateLimited } from './gecko';

/** partial: still being scanned (shown as its pools are tested; only when it has no earlier result) */
export interface ScanChain { chainId: number; name: string; at: number; items: Opportunity[]; tested: number; skipped: Skipped[]; error: string | null; partial?: boolean }
/** One V3 fee-growth reading. Strings because JSON has no bigint. The next scan turns two of these into a fee pace. */
export interface FeeMark { at: number; g0: string; g1: string; liquidity: string }
export interface ScanFile { version: 4; at: number | null; testUsd: number; chains: ScanChain[]; feeMarks?: Record<string, FeeMark> }

/** `dexes` = GeckoTerminal ids of the DEXes this app trades on the chain (only their pools are read); `lpDexes` = app DEX ids a liquidity bot can use. */
export interface ScanChainInfo { id: number; name: string; slug: string | null; wrapped: string; spendable: string[]; dexes: string[]; lpDexes: string[] }

export interface ScanDeps {
  chains(): ScanChainInfo[];
  /** Markets already in the app, oriented to spend the native coin or a stablecoin */
  existing(chainId: number): MarketDef[];
  /** New token → draft market with its safety report (whatever the risk); throws when it can't be priced on a DEX this app trades */
  inspect(chainId: number, token: string, spend: string): Promise<MarketDef>;
  snapshot(def: MarketDef): Promise<MarketSnapshot>;
  /** Saved closed hourly candles of a market in the app (one-off prints clipped, gap-filled, oldest first); [] for a new token */
  storedHourly(def: MarketDef): Candle[];
  /** Share of the swap fee liquidity providers keep in this market's pool; throws when it isn't verified */
  lpShare(def: MarketDef): Promise<number>;
  /**
   * Recent on-chain fee pace for a V3 pool. scale multiplies candle volume so it matches fees actually paid.
   * Missing or null: a wash-flagged pool is not ranked for liquidity (reported volume is not used).
   */
  /**
   * On-chain fee pace for a wash-flagged V3 pool. `scale` is applied to candle volume directly.
   * `feesUsd` + `windowMs` is turned into a scale from this scan's own candles (quote volume × USD per quote).
   */
  feePace?(def: MarketDef): Promise<{ scale?: number; feesUsd?: number; windowMs?: number } | null>;
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

/** Version 3 kept a pool's addresses only for coins not in the app (`add`) */
type ScanFileV3 = { version: 3; at: number | null; testUsd: number; feeMarks?: Record<string, FeeMark>; chains: (Omit<ScanChain, 'items'> & { items: (Omit<Opportunity, 'ref'> & { add: Opportunity['ref'] | null })[] })[] };
function upgradeV3(f: ScanFileV3, existing: ScanDeps['existing']): ScanFile {
  return {
    ...f, version: 4,
    chains: f.chains.map((c) => ({
      ...c,
      // A pool in the app gets its addresses from its market; one whose market was removed since is dropped.
      items: c.items.flatMap(({ add, ...o }) => {
        const d = add ? null : existing(c.chainId).find((m) => m.key === o.key);
        const ref = add ?? (d ? { address: d.base.address, quote: d.quote.address, pool: d.pool.address } : null);
        return ref ? [{ ...o, ref }] : [];
      }),
    })),
  };
}

/**
 * The scan as this app reads it: each pool's `key` is this app's market on that pool (by its addresses), or null.
 * The scan may come from another app (a friend's copy shows its host's), and keys differ between apps.
 */
export function localScan(hub: Pick<Hub, 'marketFor'>, src: { status(): unknown; run(testUsd?: number): Promise<unknown> }) {
  return {
    async status() {
      const s = (await src.status()) as ReturnType<DailyScanner['status']>;
      return { ...s, chains: s.chains.map((c) => ({ ...c, items: c.items.map((o) => ({ ...o, key: hub.marketFor(o.chainId, o.dex, o.ref) })) })) };
    },
    run: (testUsd?: number) => src.run(testUsd),
  };
}

/** Candle volume is in quote units. Scale it so the window matches fees the pool actually paid. */
function paceScale(pace: { scale?: number; feesUsd?: number; windowMs?: number }, week: Candle[], usdPerQuote: number, feeBps: number, now: number): number | null {
  if (pace.scale != null) return Number.isFinite(pace.scale) ? pace.scale : null;
  if (!(pace.feesUsd != null && pace.windowMs != null)) return null;
  const fromSec = now / 1000 - pace.windowMs / 1000;
  const quoteVol = week.reduce((s, k) => s + (k.t >= fromSec ? k.v : 0), 0);
  return feePace({ feesUsd: pace.feesUsd, windowMs: pace.windowMs, feeBps, candleVolumeUsd: quoteVol * usdPerQuote })?.scale ?? null;
}

const lc = (a: string) => a.toLowerCase();
const msg = (e: unknown) => (e as Error).message.slice(0, 200);
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

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

/** What a running scan is doing now. */
export interface ScanProgress { chain: string; chainNo: number; chains: number; phase: 'finding pools' | 'checking new tokens' | 'testing pairs'; done: number; total: number }

export class DailyScanner {
  private file: ScanFile;
  private running = false;
  private progress: ScanProgress | null = null;
  /** This run's chains: finished ones, and the one being scanned (its items grow as pools are tested) */
  private live: { done: ScanChain[]; current: ScanChain | null } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ScanDeps) {
    const f = d.store.load() as ScanFile | ScanFileV3 | { version: 2; testUsd?: number } | null;
    // version 2 (3 picks a chain, ranked with the price move) is dropped: the next scan replaces it
    this.file = f?.version === 4 ? f : f?.version === 3 ? upgradeV3(f, d.existing) : { version: 4, at: null, testUsd: f?.testUsd ?? TEST_USD, chains: [] };
  }

  private now() { return (this.d.now ?? Date.now)(); }

  status() {
    return { ...this.file, chains: this.chainsNow(), running: this.running, progress: this.progress, nextAt: this.file.at == null ? null : this.file.at + SCAN_EVERY_MS };
  }

  /**
   * What to show while a scan runs. A first scan takes about an hour (GeckoTerminal allows a few requests a minute), so
   * a chain with no earlier result shows its pools as they are tested; one with an earlier result keeps it until its
   * new result is complete. Chains finished in this run replace their earlier result.
   */
  private chainsNow(): ScanChain[] {
    if (!this.live) return this.file.chains;
    const { done, current } = this.live, old = this.file.chains;
    const fresh = current && !old.some((c) => c.chainId === current.chainId) ? [...done, { ...current, partial: true }] : done;
    return [...fresh, ...old.filter((c) => !fresh.some((f) => f.chainId === c.chainId))];
  }

  /**
   * A scan is due when there is none, the last one is a day old, or a chain the app trades has no result in it (a chain
   * just added waited up to a day, and the Smart trader said "not in the scan" for it meanwhile: 2026-10-30).
   */
  isDue(): boolean {
    if (this.running) return false;
    if (this.file.at == null || this.now() - this.file.at >= SCAN_EVERY_MS) return true;
    return this.d.chains().some((c) => !this.file.chains.some((x) => x.chainId === c.id));
  }

  /** Check every 30 min; scan when isDue. */
  start(checkMs = 30 * 60_000) {
    if (this.timer) return;
    const due = () => { if (this.isDue()) void this.run().catch(() => undefined); };
    due();
    this.timer = setInterval(due, checkMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** `testUsd` = test size in USD (kept for the daily scans after it); defaults to the last one used. */
  async run(testUsd: number = this.file.testUsd): Promise<ScanFile> {
    const usd = checkTestUsd(testUsd);
    if (this.running) throw new Error('A scan is already running.');
    this.running = true;
    // Fee readings are stored on the scan file while the scan runs. A first install has no file yet, so start one.
    if (this.d.store.load()?.version !== 4) this.d.store.save(this.file);
    this.d.emit?.({ type: 'info', kind: 'system', msg: `Opportunity scan started (${usdAsEth(usd)} test size)` });
    try {
      const chains: ScanChain[] = [];
      this.live = { done: chains, current: null };
      const list = this.d.chains();
      for (const [i, c] of list.entries()) chains.push(await this.scanChain(c, i + 1, list.length, usd));
      const feeMarks = this.d.store.load()?.feeMarks ?? this.file.feeMarks;
      this.file = { version: 4, at: this.now(), testUsd: usd, chains, ...(feeMarks ? { feeMarks } : {}) };
      this.d.store.save(this.file);
      this.d.emit?.({ type: 'info', kind: 'system', level: 'success', msg: `Opportunity scan done: ${chains.map((c) => `${c.name} ${c.items.length} pool${c.items.length === 1 ? '' : 's'}`).join(', ')}` });
      return this.file;
    } finally {
      this.running = false;
      this.progress = null;
      this.live = null;
    }
  }

  /** Busiest pools of one DEX, SCAN_PAGES pages at most (a short page is the last one). */
  private async pools(c: ScanChainInfo, dex: string): Promise<TopPool[]> {
    const out: TopPool[] = [];
    for (let page = 1; page <= SCAN_PAGES; page++) {
      const rows = await retryOnce(() => this.d.gecko.topPools(c.slug!, dex, page));
      out.push(...rows);
      if (rows.length < 20) break;
    }
    return out;
  }

  private async scanChain(c: ScanChainInfo, chainNo: number, chains: number, usd: number): Promise<ScanChain> {
    const step = (phase: ScanProgress['phase'], done: number, total: number) => { this.progress = { chain: c.name, chainNo, chains, phase, done, total }; };
    step('finding pools', 0, 1);
    const out: ScanChain = { chainId: c.id, name: c.name, at: this.now(), items: [], tested: 0, skipped: [], error: null };
    this.live!.current = out;
    if (!c.slug) { out.error = 'No GeckoTerminal price history for this chain.'; return out; }
    try {
      // Busiest pools of each DEX this app trades. The chain-wide list is the wrong input: on 2026-10-17, 33 of
      // Robinhood's 40 busiest pools were Uniswap V4 (not tradable here, and GeckoTerminal reports most of them with
      // $0 liquidity), which crowded out the real Uniswap V3 stock pools (NVDA ~6.9k trades/day, SPCX ~12k).
      const pools: TopPool[] = [];
      for (const dex of c.dexes) pools.push(...await this.pools(c, dex));
      const { picked, skipped } = pickTokens(pools, c.spendable, c.wrapped, undefined, this.now());
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
      for (const [i, m] of markets.entries()) {
        step('testing pairs', i, markets.length);
        try { out.items.push(await this.test(c, m.def, m.pool, m.isNew, usd)); } catch (e) { out.skipped.push({ name: `${m.def.base.symbol}/${m.def.quote.symbol}`, why: msg(e) }); }
      }
    } catch (e) {
      out.error = msg(e);
    }
    return out;
  }

  /** The last SCAN_CANDLES closed hours of a market: the candle sync's series when it is current, else GeckoTerminal's, gap-filled. */
  private async week(c: ScanChainInfo, d: MarketDef): Promise<Candle[]> {
    // The candle sync keeps every market's hourly series: reuse it when it covers the week up to the last 2 hours
    // (one GeckoTerminal request saved per market in the app; the shared budget can be ~6 requests a minute).
    const saved = this.d.storedHourly(d);
    const nowSec = Math.floor(this.now() / 1000);
    if (saved.length >= SCAN_CANDLES && saved[saved.length - 1].t >= nowSec - 2 * 3600) return saved.slice(-SCAN_CANDLES);
    const token = d.base.native ? c.wrapped : d.base.address;
    const raw = await retryOnce(() => this.d.gecko.ohlcv(d.candlePool || d.pool.address, token, '1h', undefined, SCAN_CANDLES, { network: c.slug!, feeBps: d.pool.feeBps }));
    if (!raw.length) throw new Error('no trades in the last 7 days');
    // GeckoTerminal leaves out hours without trades: 168 candles of a quiet pool can span weeks. Filled up to the
    // last closed hour, the slice is the last 7 days.
    const lastClosed = Math.floor(nowSec / 3600) * 3600 - 3600;
    return trimSpikes(fillGaps(raw.filter((k) => k.t <= lastClosed), '1h', lastClosed)).slice(-SCAN_CANDLES);
  }

  /** One market over the last 7 days: its best grid and its best liquidity range, by what they earned. */
  private async test(c: ScanChainInfo, d: MarketDef, pool: TopPool | null, isNew: boolean, usd: number): Promise<Opportunity> {
    const snap = await this.d.snapshot(d);
    const capital = usd / await this.d.usdPerSpend(d);
    const week = await this.week(c, d);
    const costs = costModelOf(snap, d.pool.feeBps, this.d.approval);
    const movePct = week[week.length - 1].c / week[0].o - 1;
    const o: Opportunity = {
      chainId: c.id,
      // A new token's draft quote keeps the wrapped address (WPLS / WETH) even though it spends the native coin.
      key: isNew ? null : d.key,
      ref: { address: d.base.address, quote: d.quote.address, pool: d.pool.address },
      label: `${d.base.symbol}/${d.quote.symbol}`, spend: d.quote.symbol, stack: d.base.symbol,
      dex: d.pool.dex, kind: d.pool.kind, feeBps: d.pool.feeBps,
      risk: d.safety?.risk ?? null, riskWhy: d.safety?.reasons.join(' ') || null, liveAllowed: d.safety ? d.safety.liveAllowed : true,
      price: snap.spot, movePct, swingPct: dailySwing(week),
      activity: pool ? { volume24Usd: pool.volume24Usd, liquidityUsd: pool.liquidityUsd, tx24: pool.tx24 } : null,
      capital, usd, grid: null, gridWhy: null, lp: null, lpWhy: null, wash: pool?.wash === true,
    };
    const wash = pool?.wash === true;
    if (wash) o.gridWhy = `volume is ${Math.round((pool?.volume24Usd ?? 0) / Math.max(pool?.liquidityUsd ?? 1, 1))}× its liquidity (wash trading is not a price swing, so no grid)`;
    else {
      const s = bestSetup(week, costs, capital);
      if (s) o.grid = { bandPct: s.bandPct, gridCount: s.gridCount, earnedPct: s.earnedPct, roundTrips: s.roundTrips, returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct };
      else o.gridWhy = `no grid earned from its trades this week (price ${pct(movePct)})`;
    }
    if (d.pool.kind !== 'v3' || !c.lpDexes.includes(d.pool.dex)) {
      o.lpWhy = d.pool.kind === 'v3' ? "A liquidity bot can't open positions on this DEX yet (no verified position manager)." : d.pool.kind === 'v4' ? 'A liquidity bot needs a V3 pool; this one is V4.' : 'A liquidity bot needs a V3 pool; this one is V2.';
      return o;
    }
    let candles = week;
    if (wash) {
      const pace = this.d.feePace ? await this.d.feePace(d) : null;
      const scale = pace ? paceScale(pace, week, await this.d.usdPerSpend(d), d.pool.feeBps, this.now()) : null;
      const times = Math.round((pool?.volume24Usd ?? 0) / Math.max(pool?.liquidityUsd ?? 1, 1));
      // Not measured yet (the first reading only starts the clock, or the read failed): no evidence either way
      if (scale == null) {
        o.lpWhy = `volume is ${times}× liquidity and this pool's fees weren't measured on-chain, so it isn't ranked for liquidity`;
        o.lpFailed = true;
        return o;
      }
      if (!(scale > 0)) {
        o.lpWhy = `volume is ${times}× liquidity and the pool paid no fees on-chain since the last reading`;
        return o;
      }
      o.feeScale = scale;
      candles = week.map((k) => ({ ...k, v: k.v * scale }));
    }
    try {
      const l = bestLp(candles, costs, capital, 'v3', await this.d.lpShare(d));
      if (l.bandPct == null) throw new Error('a V3 position was tested as full range');
      o.lp = { bandPct: l.bandPct, earnedPct: l.earnedPct, feesPct: l.feesPct, inRangePct: l.inRangePct, poolSharePct: l.poolSharePct, returnPct: l.returnPct };
    } catch (e) { o.lpWhy = msg(e); o.lpFailed = true; }
    return o;
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
      lpDexes: rt.cfg.dexes.flatMap((d) => (d.kind === 'v3' && d.positionManager ? [d.id] : [])),
    })),
    // PLS/DAI and ETH/USDC spend the stablecoin; PLS/HEX is turned around to HEX/PLS so it spends PLS.
    existing: (chainId) => hub.byChain(chainId).flatMap((d) => (spends(chainId, d.quote) ? [d] : spends(chainId, d.base) ? [hub.def(`${d.key}~`)] : [])),
    inspect: async (chainId, token, spend) => {
      const r = await hub.inspect({ chainId, address: token, quote: spend });
      if (!r.draft) throw new Error('no pool on a DEX this app trades');
      return r.draft;
    },
    snapshot: (d) => (hub.has(d.key) ? hub.quoter(d.key) : hub.draftQuoter(d)).market(),
    storedHourly: (d) => {
      if (!hub.has(d.key)) return [];
      const nowSec = Math.floor((rest.now ?? Date.now)() / 1000);
      return replayCandles(candles.get(d.key, '1h'), '1h', nowSec);
    },
    lpShare: (d) => lpShareOf(hub, d),
    feePace: (d) => onchainFeePace(hub, rest.store, d, (rest.now ?? Date.now)()),
    usdPerSpend: async (d) => {
      if (hub.isStable(d.chainId, d.quote.address)) return 1;
      if (!spends(d.chainId, d.quote)) throw new Error(`${d.quote.symbol} is not the native coin or a stablecoin`);
      const usd = await hub.nativeUsdAsync(d.chainId);
      if (!usd) throw new Error(`no price for ${hub.chain(d.chainId).nativeSymbol}`);
      return usd;
    },
  };
}
