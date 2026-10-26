/**
 * Opportunity scan per chain (PulseChain, Ethereum, Robinhood), once a day and on demand:
 *   GeckoTerminal top pools of each DEX this app trades (SCAN_PAGES pages) → pickTokens (real liquidity, real trades,
 *   a native/stable side; up to SCAN_RULES.maxTokens) + the markets already in the app → the safety check for new
 *   tokens (hub.inspect: honeypot / tax simulation). Every safety level is kept: a token that fails is shown with
 *   why, and can only be paper traded (like one added under Markets).
 *   → the last 7 days of hourly candles through the grid backtester and the liquidity-position backtest, with the
 *   pool's real fee, depth, gas and the share of fees liquidity providers keep.
 * Each pool gets its best grid and its best liquidity range by what they EARNED: completed trades for a grid, fees −
 * swap and gas costs for a position, and how far its price swung. The price move is left out (shown separately): it
 * isn't the bot's doing. The page ranks them (gridRank / lpRank in market/scan.ts).
 * Nothing is added or started here: "Try it" adds the market and opens New bot. Results persist in data/picks.json.
 */
import type { MarketDef, MarketToken } from '../../live/markets';
import { bestSetup, checkTestUsd, dailySwing, pickTokens, SCAN_CANDLES, SCAN_EVERY_MS, SCAN_PAGES, TEST_USD, type Opportunity, type Skipped, type TopPool } from '../../market/scan';
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
import { RateLimited } from './gecko';

export interface ScanChain { chainId: number; name: string; at: number; items: Opportunity[]; tested: number; skipped: Skipped[]; error: string | null }
export interface ScanFile { version: 3; at: number | null; testUsd: number; chains: ScanChain[] }

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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ScanDeps) {
    const f = d.store.load();
    // version 2 (3 picks a chain, ranked with the price move) is dropped: the next scan replaces it
    this.file = f?.version === 3 ? f : { version: 3, at: null, testUsd: f?.testUsd ?? TEST_USD, chains: [] };
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
    this.d.emit?.({ type: 'info', kind: 'system', msg: `Opportunity scan started ($${usd.toLocaleString('en-US')} test size)` });
    try {
      const chains: ScanChain[] = [];
      const list = this.d.chains();
      for (const [i, c] of list.entries()) chains.push(await this.scanChain(c, i + 1, list.length, usd));
      this.file = { version: 3, at: this.now(), testUsd: usd, chains };
      this.d.store.save(this.file);
      this.d.emit?.({ type: 'info', kind: 'system', level: 'success', msg: `Opportunity scan done: ${chains.map((c) => `${c.name} ${c.items.length} pool${c.items.length === 1 ? '' : 's'}`).join(', ')}` });
      return this.file;
    } finally {
      this.running = false;
      this.progress = null;
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
    if (!c.slug) { out.error = 'No GeckoTerminal price history for this chain.'; return out; }
    try {
      // Busiest pools of each DEX this app trades. The chain-wide list is the wrong input: on 2026-10-17, 33 of
      // Robinhood's 40 busiest pools were Uniswap V4 (not tradable here, and GeckoTerminal reports most of them with
      // $0 liquidity), which crowded out the real Uniswap V3 stock pools (NVDA ~6.9k trades/day, SPCX ~12k).
      const pools: TopPool[] = [];
      for (const dex of c.dexes) pools.push(...await this.pools(c, dex));
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
      add: isNew ? { address: d.base.address, quote: d.quote.address, pool: d.pool.address } : null,
      label: `${d.base.symbol}/${d.quote.symbol}`, spend: d.quote.symbol, stack: d.base.symbol,
      dex: d.pool.dex, kind: d.pool.kind, feeBps: d.pool.feeBps,
      risk: d.safety?.risk ?? null, riskWhy: d.safety?.reasons.join(' ') || null, liveAllowed: d.safety ? d.safety.liveAllowed : true,
      price: snap.spot, movePct, swingPct: dailySwing(week),
      activity: pool ? { volume24Usd: pool.volume24Usd, liquidityUsd: pool.liquidityUsd, tx24: pool.tx24 } : null,
      capital, usd, grid: null, gridWhy: null, lp: null, lpWhy: null,
    };
    const s = bestSetup(week, costs, capital);
    if (s) o.grid = { bandPct: s.bandPct, gridCount: s.gridCount, earnedPct: s.earnedPct, roundTrips: s.roundTrips, returnPct: s.returnPct, maxDrawdownPct: s.maxDrawdownPct };
    else o.gridWhy = `no grid earned from its trades this week (price ${pct(movePct)})`;
    if (d.pool.kind !== 'v3' || !c.lpDexes.includes(d.pool.dex)) {
      o.lpWhy = d.pool.kind === 'v3' ? "A liquidity bot can't open positions on this DEX yet (no verified position manager)." : 'A liquidity bot needs a V3 pool; this one is V2.';
      return o;
    }
    try {
      const l = bestLp(week, costs, capital, 'v3', await this.d.lpShare(d));
      if (l.bandPct == null) throw new Error('a V3 position was tested as full range');
      o.lp = { bandPct: l.bandPct, earnedPct: l.earnedPct, feesPct: l.feesPct, inRangePct: l.inRangePct, poolSharePct: l.poolSharePct, returnPct: l.returnPct };
    } catch (e) { o.lpWhy = msg(e); }
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
    usdPerSpend: async (d) => {
      if (hub.isStable(d.chainId, d.quote.address)) return 1;
      if (!spends(d.chainId, d.quote)) throw new Error(`${d.quote.symbol} is not the native coin or a stablecoin`);
      const usd = await hub.nativeUsdAsync(d.chainId);
      if (!usd) throw new Error(`no USD price for ${hub.chain(d.chainId).nativeSymbol}`);
      return usd;
    },
  };
}
