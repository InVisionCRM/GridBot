/**
 * Orchestrator: many GridEngines + TrendEngines across every configured EVM chain. Each chain has its own
 * signer, TxGate and nonce queue (chains execute in parallel, one tx at a time per chain); one persisted
 * state file (v3; legacy PulseChain state loads unchanged as chain 369). Also owns the candle store feed, market panels, alerts, analytics and
 * the activity bus.
 */
import { DEFAULT_LIMITS, type SafetyLimits } from '../../live/limits';
import type { LiveNetwork } from '../../live/networks';
import { Hub } from '../chains/hub';
import { isFlipKey, unflipKey, type MarketDef } from '../../live/markets';
import { checkGasReserve, reserveCfg } from '../../live/gasReserve';
import { totals, type LiveTrade } from '../../live/ledger';
import { FEE_BPS } from '../../live/economics';
import { GridEngine, freshState, type BotState, type EngineDeps, type Mode, type StartParams } from './engine';
import { TrendEngine, freshTrend, type TrendStartParams, type TrendState, type TrendTrade } from './trend';
import { TaxWatch } from './taxWatch';
import type { Logger } from './logger';
import type { Store } from './store';
import { SharedNonce, TxGate } from './txGate';
import type { ChainReader, MarketSnapshot, Quoter, TxSender } from './chain';

/** Pool a preset leg is evaluated on (switchTo = the market will be switched to it, auto mode, on start). */
export interface PresetPool { dex: string; kind: 'v2' | 'v3'; address: string; feeBps: number; feeTier?: number; dexName: string; switchTo: boolean }
import { getPreset, legKey, listPresets, resolvePreset, type ResolvedLeg } from '../../live/presets';
import { sameAddr } from '../dex/types';
import { gridEconomics, type EconCfg, type EconSummary } from './econ';
import { ActivityBus } from './activity';
import { CandleStore } from '../market/candleStore';
import { closedOnly, fillGaps, isTF, sliceRange, type Candle, type TF } from '../../market/candles';
import { atr, ema, efficiencyRatio, rsi } from '../../market/indicators';
import { simBuy, simSell, type CostModel, DEFAULT_COSTS } from '../../market/costs';
import { DEFAULT_TREND, type TrendConfig } from '../../market/strategy';
import { runGridBacktest, runTrendBacktest, sweepTrend, SWEEP_AXES, type BtResult, type SweepKey } from '../../market/backtest';
import { drawdown, pushCapped, tradeStats } from '../../market/stats';

export type AlertType = 'price_above' | 'price_below' | 'rsi_above' | 'rsi_below' | 'grid_range';
export interface Alert {
  id: string;
  type: AlertType;
  pair: string;
  value: number;
  tf: TF;
  botId?: string;
  enabled: boolean;
  /** Re-arm after the condition clears (otherwise disable after firing once) */
  repeat: boolean;
  active: boolean;
  lastFiredAt: number | null;
  createdAt: number;
}

export interface MultiState {
  version: 3;
  defaults: SafetyLimits;
  grids: BotState[];
  trends: TrendState[];
  alerts: Alert[];
  /** [ms, total equity USD, realized USD] every ≥60 s */
  /** [t, equityUsd, realizedUsd, capitalUsd?] — capital lets period changes exclude bots added/removed */
  portfolio: [number, number, number, number?][];
}

export interface MultiDeps {
  net: LiveNetwork;
  reader: ChainReader;
  signer: TxSender | null;
  store: Store<MultiState>;
  log: Logger;
  approval?: 'exact' | 'max';
  maxRetries?: number;
  retryDelayMs?: number;
  receiptTimeoutMs?: number;
  now?: () => number;
  candles?: CandleStore;
  activity?: ActivityBus;
  /** Override pool/gas snapshot (tests) */
  market?: (quote: string) => Promise<MarketSnapshot>;
  /** Multi-chain hub. Default: single PulseChain hub built from net/reader/signer (tests, legacy wiring). */
  hub?: Hub;
}

export interface ChainWallet {
  chainId: number;
  address: string;
  native: number;
  /** token address (lowercase) → balance */
  tokens: Record<string, { symbol: string; amount: number }>;
  at: number;
  error: string | null;
}

function migrate(raw: unknown, net: LiveNetwork): MultiState {
  const empty = (): MultiState => ({ version: 3, defaults: { ...DEFAULT_LIMITS }, grids: [], trends: [], alerts: [], portfolio: [] });
  if (!raw || typeof raw !== 'object') return empty();
  const o = raw as Record<string, unknown>;
  if ((o.version === 2 || o.version === 3) && Array.isArray(o.grids)) {
    return {
      version: 3,
      defaults: { ...DEFAULT_LIMITS, ...((o.defaults as SafetyLimits) ?? {}) },
      grids: (o.grids as BotState[]).map((g) => ({ ...freshState(net, g.id), ...g, id: g.id || freshState(net).id })),
      trends: Array.isArray(o.trends) ? (o.trends as TrendState[]).map((t) => ({ ...freshTrend(net, t.id), ...t })) : [],
      alerts: Array.isArray(o.alerts) ? (o.alerts as Alert[]) : [],
      portfolio: Array.isArray(o.portfolio) ? (o.portfolio as MultiState['portfolio']) : [],
    };
  }
  const g = o as unknown as BotState; // v1 single grid
  if (g && (g.config != null || g.status || g.trades)) {
    const id = g.id || 'g1';
    return { ...empty(), defaults: { ...DEFAULT_LIMITS, ...(g.limits ?? {}) }, grids: [{ ...freshState(net, id), ...g, id, version: 1 }] };
  }
  return empty();
}

/** Store that reads/writes one bot slice inside MultiState. */
class SliceStore<T extends { id: string }> implements Store<T> {
  constructor(private readonly list: () => T[], private readonly persist: () => void, private readonly id: string) {}
  load(): T | null { return this.list().find((g) => g.id === this.id) ?? null; }
  save(state: T) {
    const arr = this.list();
    const i = arr.findIndex((g) => g.id === this.id);
    const next = { ...state, id: this.id };
    if (i >= 0) arr[i] = next; else arr.push(next);
    this.persist();
  }
}

export interface JournalRow {
  t: number; botId: string; kind: 'grid' | 'trend'; bot: string; pair: string; mode: Mode; side: 'buy' | 'sell';
  reason: string; pls: number; quote: number; price: number; fee: number; gas: number; pnl: number | null; pnlUsd: number | null;
  slippagePct: number | null; tx: string; failed: boolean;
}

const usdFmt = (x: number) => Math.round(x * 100) / 100;

export class MultiBot {
  readonly hub: Hub;
  readonly candles: CandleStore;
  readonly activity: ActivityBus;
  private multi: MultiState;
  private engines = new Map<string, GridEngine>();
  private trendEngines = new Map<string, TrendEngine>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Legacy-chain wallet (PLS + legacy quotes by symbol) — kept for the existing UI/tests */
  walletBalances: { pls: number; quotes: Record<string, number> } | null = null;
  readonly wallets = new Map<number, ChainWallet>();
  private walletAt = 0;
  private spotsAt = 0;
  private tickN = 0;
  private marketCache = new Map<string, { at: number; m: MarketSnapshot }>();
  private rangeState = new Map<string, 'in' | 'below' | 'above'>();
  address: string | null = null;
  candleSyncStatus: (() => unknown) | null = null;
  readonly taxWatch: TaxWatch;

  constructor(private readonly d: MultiDeps) {
    this.hub = d.hub ?? Hub.single(d.net, d.reader, d.signer, { gate: new TxGate(), nonce: new SharedNonce() });
    this.candles = d.candles ?? new CandleStore(null);
    this.activity = d.activity ?? new ActivityBus();
    this.multi = migrate(d.store.load(), d.net);
    this.persist();
    for (const g of this.multi.grids) this.attach(g.id);
    for (const t of this.multi.trends) this.attachTrend(t.id);
    this.taxWatch = new TaxWatch({
      now: () => this.now(),
      markets: () => this.watchedCustomKeys(),
      current: (k) => this.hub.def(k).safety,
      recheck: (k) => this.hub.recheck(k),
      pause: (k, why) => this.pauseMarket(k, why),
      alert: (k, level, msg, notify) => this.activity.emitEvent({ type: 'alert', kind: 'system', level, notify, pair: k, chainId: this.hub.def(k).chainId, msg }),
      label: (k) => this.hub.label(k),
    });
    this.hub.onSuspect = (k, why) => { void this.taxWatch.suspect(k, why); };
  }

  /** Custom markets that have a running or in-flight bot — the tax watcher only re-checks these. */
  private watchedCustomKeys(): string[] {
    const keys = new Set<string>();
    // Safety lives on the original market; a flipped bot (custom~) is watched through it.
    for (const e of this.engines.values()) if (e.def?.custom && (e.state.status === 'running' || e.state.inFlight)) keys.add(unflipKey(e.state.stable));
    for (const e of this.trendEngines.values()) if (e.def?.custom && (e.state.status === 'running' || e.state.inFlight)) keys.add(unflipKey(e.state.quote));
    return [...keys];
  }

  /** Pause every running bot on a market (tax rise / honeypot / paused). Returns how many were running. */
  pauseMarket(key: string, why: string): number {
    let n = 0;
    const k0 = unflipKey(key); // both orientations share the token and its tax
    for (const e of this.engines.values()) if (unflipKey(e.state.stable) === k0 && e.state.status === 'running') { e.stop(why); n++; }
    for (const e of this.trendEngines.values()) if (unflipKey(e.state.quote) === k0 && e.state.status === 'running') { e.stop(why); n++; }
    return n;
  }

  /** Last spot per market key (quote per base, sell-side) — shared with the hub's USD oracle */
  get spots(): Record<string, number> { return this.hub.spots; }
  /** TxGate of the legacy chain (status compatibility) */
  get gate(): TxGate { return this.hub.rt(this.hub.legacyChainId).gate; }
  get hasSigner() { return this.hub.runtimes().some((r) => !!r.signer); }
  private now() { return (this.d.now ?? Date.now)(); }
  private persist() { this.d.store.save(this.multi); }

  private attach(id: string): GridEngine {
    let eng = this.engines.get(id);
    if (eng) return eng;
    const deps: EngineDeps = {
      net: this.d.net, reader: this.d.reader, signer: this.d.signer,
      store: new SliceStore(() => this.multi.grids, () => this.persist(), id),
      log: this.d.log, approval: this.d.approval, maxRetries: this.d.maxRetries, retryDelayMs: this.d.retryDelayMs,
      receiptTimeoutMs: this.d.receiptTimeoutMs, now: this.d.now, id, hub: this.hub,
      logTag: id, emit: (e) => this.activity.emitEvent(e),
    };
    eng = new GridEngine(deps);
    this.engines.set(id, eng);
    return eng;
  }

  private attachTrend(id: string): TrendEngine {
    let eng = this.trendEngines.get(id);
    if (eng) return eng;
    eng = new TrendEngine({
      net: this.d.net, reader: this.d.reader, signer: this.d.signer,
      store: new SliceStore(() => this.multi.trends, () => this.persist(), id),
      log: this.d.log, candles: (p, tf) => this.candles.get(p, tf), emit: (e) => this.activity.emitEvent(e),
      hub: this.hub, approval: this.d.approval,
      maxRetries: this.d.maxRetries, retryDelayMs: this.d.retryDelayMs, receiptTimeoutMs: this.d.receiptTimeoutMs,
      now: this.d.now, id, market: (q) => this.market(q),
    });
    this.trendEngines.set(id, eng);
    return eng;
  }

  private engine(id: string): GridEngine {
    if (!this.multi.grids.some((g) => g.id === id)) throw new Error(`Unknown grid ${id}`);
    return this.engines.get(id) ?? this.attach(id);
  }
  private trend(id: string): TrendEngine {
    if (!this.multi.trends.some((g) => g.id === id)) throw new Error(`Unknown trend bot ${id}`);
    return this.trendEngines.get(id) ?? this.attachTrend(id);
  }

  // ── Grids ──────────────────────────────────────────────────────────────
  async add(p: StartParams): Promise<string> {
    if (p.mode === 'live') await this.assertCovers(p.stable ?? this.d.net.defaultQuote, p.totalCapitalUsd, p.limits);
    const slot = freshState(this.d.net);
    slot.limits = { ...this.multi.defaults, ...(p.limits ?? {}) };
    this.multi.grids.push(slot);
    this.persist();
    const eng = this.attach(slot.id);
    try { await eng.start({ ...p, limits: slot.limits }); } catch (e) { this.remove(slot.id); throw e; }
    return slot.id;
  }
  async start(id: string, p: StartParams) { await this.engine(id).start(p); }
  resume(id: string) { this.engine(id).resume(); }
  stop(id: string) { this.engine(id).stop(); }
  setLimits(id: string, l: Partial<SafetyLimits>) { this.engine(id).setLimits(l); }
  remove(id: string) {
    const eng = this.engines.get(id);
    if (eng && eng.state.status === 'running') eng.stop();
    if (eng?.state.inFlight) throw new Error('Cannot remove a grid with a tx in flight — wait for reconcile or STOP and wait.');
    this.engines.delete(id);
    this.multi.grids = this.multi.grids.filter((g) => g.id !== id);
    this.persist();
    this.d.log.info(`[${id}] removed`);
  }

  // ── Trend bots ─────────────────────────────────────────────────────────
  async addTrend(p: TrendStartParams): Promise<string> {
    if (p.mode === 'live') await this.assertCovers(p.quote, p.capital, p.limits);
    const slot = freshTrend(this.d.net);
    slot.limits = { ...this.multi.defaults, ...(p.limits ?? {}) };
    this.multi.trends.push(slot);
    this.persist();
    const eng = this.attachTrend(slot.id);
    try { await eng.start({ ...p, limits: slot.limits }); } catch (e) { this.removeTrend(slot.id, true); throw e; }
    return slot.id;
  }
  resumeTrend(id: string) { this.trend(id).resume(); }
  stopTrend(id: string) { this.trend(id).stop(); }
  closeTrend(id: string) { this.trend(id).closePosition(); }
  setTrendLimits(id: string, l: Partial<SafetyLimits>) { this.trend(id).setLimits(l); }
  removeTrend(id: string, force = false) {
    const eng = this.trendEngines.get(id);
    if (eng && eng.state.status === 'running') eng.stop();
    if (eng?.state.inFlight) throw new Error('Cannot remove a bot with a tx in flight.');
    if (eng?.state.position && eng.state.mode === 'live' && !force) throw new Error('Live bot still holds a position — close it first (resume → Close position).');
    this.trendEngines.delete(id);
    this.multi.trends = this.multi.trends.filter((g) => g.id !== id);
    this.persist();
    this.d.log.info(`[${id}] removed`);
  }

  /** KILL ALL: stop every grid and trend bot; queued jobs dropped, nothing new is sent. */
  stopAll() {
    let n = 0;
    for (const e of this.engines.values()) if (e.state.status === 'running') { e.stop(); n++; }
    for (const e of this.trendEngines.values()) if (e.state.status === 'running') { e.stop('KILL ALL'); n++; }
    this.d.log.warn(`KILL ALL — ${n} bot(s) stopped (grids + trend bots).`);
    this.activity.emitEvent({ type: 'stopped', kind: 'system', level: 'error', notify: true, msg: `KILL ALL — ${n} bot(s) stopped` });
  }

  /** Stop every bot on one chain (other chains keep running). */
  stopChain(chainId: number) {
    const c = this.hub.chain(chainId);
    let n = 0;
    for (const e of this.engines.values()) if (e.chainId === c.id && e.state.status === 'running') { e.stop(); n++; }
    for (const e of this.trendEngines.values()) if (e.chainId === c.id && e.state.status === 'running') { e.stop(`STOP ${c.short}`); n++; }
    this.d.log.warn(`STOP ${c.name} — ${n} bot(s) stopped.`);
    this.activity.emitEvent({ type: 'stopped', kind: 'system', level: 'warn', notify: true, chainId: c.id, msg: `STOP ${c.name} — ${n} bot(s) stopped` });
    return n;
  }

  // ── Wallet coverage ────────────────────────────────────────────────────
  /** Funds each LIVE bot relies on, per token, vs wallet balances. */
  /** Token label: plain symbol on the legacy chain ('PLS', 'DAI'), 'BASE ETH' elsewhere. */
  private tokLabel(chainId: number, sym: string) {
    return chainId === this.hub.legacyChainId ? sym : `${this.hub.chain(chainId).short} ${sym}`;
  }
  private walletAmount(chainId: number, t: { address: string; native?: boolean }): number | null {
    const w = this.wallets.get(chainId);
    if (!w) return null;
    if (t.native) return w.native;
    return w.tokens[t.address.toLowerCase()]?.amount ?? null;
  }

  allocations() {
    type Row = { token: string; chainId: number; address: string; native: boolean; allocated: number; wallet: number | null; bots: { id: string; kind: 'grid' | 'trend'; amount: number }[] };
    const rows = new Map<string, Row>();
    const add = (d: MarketDef, side: 'base' | 'quote', id: string, kind: 'grid' | 'trend', amount: number) => {
      if (!(amount > 1e-12)) return;
      const tk = d[side];
      const token = this.tokLabel(d.chainId, tk.symbol);
      const r = rows.get(token) ?? { token, chainId: d.chainId, address: tk.address, native: !!tk.native, allocated: 0, wallet: null, bots: [] };
      r.allocated += amount; r.bots.push({ id, kind, amount });
      rows.set(token, r);
    };
    for (const e of this.engines.values()) {
      const s = e.state, d = e.def;
      if (!d || s.mode !== 'live' || !s.config || (s.status !== 'running' && !s.inFlight)) continue;
      const t = totals(e.modeTrades(), s.lastPrice);
      add(d, 'quote', s.id, 'grid', Math.max(0, s.config.totalCapitalUsd + t.realized - t.pos.costUsd));
      add(d, 'base', s.id, 'grid', t.pos.plsHeld);
    }
    for (const e of this.trendEngines.values()) {
      const s = e.state, d = e.def;
      if (!d || s.mode !== 'live' || (s.status !== 'running' && !s.position)) continue;
      add(d, 'quote', s.id, 'trend', s.cash);
      add(d, 'base', s.id, 'trend', s.position?.pls ?? 0);
    }
    const out = [...rows.values()].map((r) => {
      const wallet = this.walletAmount(r.chainId, r);
      return { ...r, wallet, ok: wallet == null ? null : wallet + 1e-9 >= r.allocated };
    });
    return { rows: out, ok: out.every((r) => r.ok !== false), note: 'Each chain\'s native coin also needs headroom for gas on every swap.' };
  }

  /** Markets whose tokens are tracked in wallets: legacy + chain defaults + custom + anything a bot/alert uses. */
  private walletTokens(chainId: number) {
    const m = new Map<string, { symbol: string; decimals: number }>();
    for (const d of this.hub.byChain(chainId)) {
      for (const t of [d.base, d.quote]) if (!t.native) m.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    }
    return m;
  }

  /** Per-chain wallet + gas balances (parallel across chains; one chain failing never blocks the rest). */
  async refreshWallet(force = false) {
    if (!force && this.now() - this.walletAt < 60_000) return;
    this.walletAt = this.now();
    await Promise.all(this.hub.runtimes().filter((r) => r.signer).map(async (rt) => {
      try {
        const wasLow = rt.gas.low;
        const gas = await rt.refreshGas();
        if (gas.native == null || !gas.address) throw new Error(gas.error ?? 'balance unavailable');
        const tokens: ChainWallet['tokens'] = {};
        await Promise.all([...this.walletTokens(rt.cfg.id)].map(async ([addr, t]) => {
          try { tokens[addr] = { symbol: t.symbol, amount: Number(await rt.tokenBalance(gas.address!, addr)) / 10 ** t.decimals }; } catch { /* skip */ }
        }));
        this.wallets.set(rt.cfg.id, { chainId: rt.cfg.id, address: gas.address, native: gas.native, tokens, at: this.now(), error: null });
        if (gas.low && !wasLow) this.activity.emitEvent({ type: 'info', kind: 'system', level: 'warn', notify: true, chainId: rt.cfg.id, msg: `${rt.cfg.name}: low gas — ${gas.native.toPrecision(4)} ${rt.cfg.nativeSymbol} < ${rt.cfg.lowGasNative} ${rt.cfg.nativeSymbol}` });
      } catch (e) {
        const w = this.wallets.get(rt.cfg.id);
        if (w) w.error = (e as Error).message.slice(0, 160);
      }
    }));
    const lw = this.wallets.get(this.hub.legacyChainId);
    if (lw) {
      this.address = lw.address;
      const quotes: Record<string, number> = {};
      for (const d of this.hub.byChain(this.hub.legacyChainId)) if (d.legacy) {
        const t = lw.tokens[d.quote.address.toLowerCase()];
        if (t) quotes[d.key] = t.amount;
      }
      this.walletBalances = { pls: lw.native, quotes };
    } else if (!this.address) {
      this.address = [...this.wallets.values()][0]?.address ?? null;
    }
  }

  private async assertCovers(key: string, amount: number, limits?: Partial<SafetyLimits>) {
    const d = this.hub.def(key);
    if (!this.hub.rt(d.chainId).signer) return;
    await this.refreshWallet(true);
    const have = this.walletAmount(d.chainId, d.quote);
    if (have == null) return;
    const label = this.tokLabel(d.chainId, d.quote.symbol);
    const cur = this.allocations().rows.find((r) => r.token === label)?.allocated ?? 0;
    if (d.quote.native) {
      // Spending the native coin (flipped HEX/PLS …): capital + gas reserve + other live bots' native must fit.
      const chk = checkGasReserve({ capital: amount, balance: have, allocated: cur, cfg: reserveCfg({ ...this.multi.defaults, ...(limits ?? {}) }), symbol: label });
      if (!chk.ok) throw new Error(`Wallet does not cover allocations: ${chk.reason}`);
      return;
    }
    if (have + 1e-9 < cur + amount) {
      throw new Error(`Wallet does not cover allocations: ${label} ${have.toPrecision(6)} < already allocated ${cur.toPrecision(6)} + new ${amount.toPrecision(6)}`);
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────
  startLoop(pollMs: number) {
    if (this.timer) return;
    void this.tickAll();
    this.timer = setInterval(() => void this.tickAll(), pollMs);
  }
  stopLoop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tickAll(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshWallet();
      const now = this.now();
      // One price batch per poll feeds candles, trend bots, alerts and the ticker. Markets nothing uses are
      // polled every 3rd tick to spare public RPCs.
      try {
        const raw = await this.prices(this.watchedKeys(this.tickN++ % 3 === 0));
        const px: Record<string, number> = {};
        for (const [pair, p] of Object.entries(raw)) {
          if (this.candles.tick(pair, p, Math.floor(now / 1000))) { px[pair] = p; this.hub.setSpot(pair, p); }
          else this.activity.emitEvent({ type: 'info', kind: 'system', level: 'warn', pair, chainId: this.hub.has(pair) ? this.hub.def(pair).chainId : undefined, msg: `${this.hub.label(pair)} poll price ${p.toPrecision(6)} is >${CandleStore.OUTLIER * 100}% from the last candle; ignored until ${CandleStore.CONFIRM} polls confirm it (trend stops keep the previous price)` });
        }
        this.spotsAt = now;
        this.activity.emit('ticks', { t: now, prices: px });
      } catch { /* keep last */ }
      // Chains in parallel; bots on one chain run sequentially (their TxGate serializes sends anyway).
      const byChain = new Map<number, (() => Promise<void>)[]>();
      const push = (cid: number, f: () => Promise<void>) => { const a = byChain.get(cid) ?? []; a.push(f); byChain.set(cid, a); };
      for (const e of this.engines.values()) {
        if (e.state.status === 'running' || e.state.inFlight || e.state.config) push(e.chainId, () => e.tick());
      }
      for (const e of this.trendEngines.values()) {
        if (e.state.status === 'running' || e.state.inFlight) push(e.chainId, () => e.tick(this.spots[e.state.quote]));
      }
      await Promise.all([...byChain.values()].map(async (jobs) => { for (const j of jobs) await j(); }));
      this.checkRanges();
      this.evaluateAlerts();
      try { await this.taxWatch.tick(); } catch { /* never abort the poll loop */ }
      this.snapshotPortfolio();
      this.activity.emit('status');
    } finally {
      this.ticking = false;
    }
  }

  /** Market keys that are priced every poll (legacy + anything a bot or alert uses); `all` adds every tradable market. */
  watchedKeys(all = true): string[] {
    const used = new Set<string>();
    for (const d of this.hub.list()) if (d.legacy) used.add(d.key);
    for (const g of this.multi.grids) used.add(g.stable);
    for (const t of this.multi.trends) used.add(t.quote);
    for (const a of this.multi.alerts) used.add(a.pair);
    if (all) for (const d of this.hub.list()) used.add(d.key);
    // A flipped market's candles are derived from its original: always price the original too.
    for (const k of [...used]) if (isFlipKey(k)) used.add(unflipKey(k));
    return [...used].filter((k) => this.hub.has(k) && this.hub.chainOf(k).tradable);
  }

  async prices(keys: string[] = this.watchedKeys()): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(keys.map(async (k) => {
      try { out[k] = await this.hub.quoter(k).getPrice(); } catch (e) {
        this.d.log.warn(`price ${this.hub.label(k)}: ${(e as Error).message.slice(0, 200)}`);
      }
    }));
    return out;
  }

  /** Pool depth + gas (+ L1 fee) snapshot, cached 60 s. */
  async market(quote: string): Promise<MarketSnapshot> {
    const c = this.marketCache.get(quote);
    if (c && this.now() - c.at < 60_000) return c.m;
    const m = this.d.market ? await this.d.market(quote) : await this.hub.quoter(quote).market();
    this.marketCache.set(quote, { at: this.now(), m });
    return m;
  }

  /** USD per quote token (stables 1; others through the chain's native/USD market and cached spots). */
  usdPerQuote(quote: string): number | null { return this.hub.usdPerQuote(quote); }

  private checkRanges() {
    for (const e of this.engines.values()) {
      const s = e.state;
      if (s.status !== 'running' || !s.config || s.lastPrice == null) continue;
      const where = s.lastPrice < s.config.lowerPrice ? 'below' : s.lastPrice > s.config.upperPrice ? 'above' : 'in';
      const prev = this.rangeState.get(s.id);
      this.rangeState.set(s.id, where);
      if (prev && prev !== where) {
        this.activity.emitEvent({
          type: 'range', botId: s.id, kind: 'grid', pair: s.stable, chainId: e.chainId, level: where === 'in' ? 'info' : 'warn', notify: true,
          msg: where === 'in' ? `Grid ${e.label}: price back inside range` : `Grid ${e.label}: price ${s.lastPrice.toPrecision(5)} left the range (${where} ${where === 'below' ? s.config.lowerPrice.toPrecision(5) : s.config.upperPrice.toPrecision(5)})`,
        });
      }
    }
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  listAlerts() { return this.multi.alerts; }
  addAlert(a: { type: AlertType; pair?: string; value?: number; tf?: string; botId?: string; repeat?: boolean }): Alert {
    const types: AlertType[] = ['price_above', 'price_below', 'rsi_above', 'rsi_below', 'grid_range'];
    if (!types.includes(a.type)) throw new Error('unknown alert type');
    let pair = a.pair ?? this.d.net.defaultQuote;
    if (a.type === 'grid_range') {
      const g = this.multi.grids.find((x) => x.id === a.botId);
      if (!g) throw new Error('grid_range alert needs a grid botId');
      pair = g.stable;
    } else {
      this.hub.def(pair);
      if (!(Number(a.value) > 0)) throw new Error('value must be > 0');
      if (a.type.startsWith('rsi') && !(Number(a.value) < 100)) throw new Error('RSI threshold must be 0–100');
    }
    const alert: Alert = {
      id: `a-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, type: a.type, pair, value: Number(a.value ?? 0),
      tf: isTF(a.tf) ? a.tf : '1h', botId: a.botId, enabled: true, repeat: !!a.repeat, active: false, lastFiredAt: null, createdAt: this.now(),
    };
    this.multi.alerts.push(alert);
    this.persist();
    return alert;
  }
  updateAlert(id: string, patch: { enabled?: boolean; repeat?: boolean }) {
    const a = this.multi.alerts.find((x) => x.id === id);
    if (!a) throw new Error('unknown alert');
    if (patch.enabled != null) { a.enabled = !!patch.enabled; a.active = false; }
    if (patch.repeat != null) a.repeat = !!patch.repeat;
    this.persist();
    return a;
  }
  removeAlert(id: string) { this.multi.alerts = this.multi.alerts.filter((a) => a.id !== id); this.persist(); }

  private rsiNow(pair: string, tf: TF): number | null {
    const k = fillGaps(closedOnly(this.candles.get(pair, tf), tf, Math.floor(this.now() / 1000)), tf);
    const r = rsi(k.map((x) => x.c), 14);
    return r[r.length - 1] ?? null;
  }

  evaluateAlerts() {
    let changed = false;
    for (const a of this.multi.alerts) {
      if (!a.enabled) continue;
      const spot = this.spots[a.pair];
      let cond = false, what = '';
      if (a.type === 'price_above' || a.type === 'price_below') {
        if (!(spot > 0)) continue;
        cond = a.type === 'price_above' ? spot >= a.value : spot <= a.value;
        what = `${this.hub.label(a.pair)} ${spot.toPrecision(6)} ${a.type === 'price_above' ? '≥' : '≤'} ${a.value.toPrecision(6)}`;
      } else if (a.type === 'rsi_above' || a.type === 'rsi_below') {
        const r = this.rsiNow(a.pair, a.tf);
        if (r == null) continue;
        cond = a.type === 'rsi_above' ? r >= a.value : r <= a.value;
        what = `${this.hub.label(a.pair)} RSI14 ${a.tf} ${r.toFixed(1)} ${a.type === 'rsi_above' ? '≥' : '≤'} ${a.value}`;
      } else {
        const g = this.multi.grids.find((x) => x.id === a.botId);
        if (!g?.config || g.lastPrice == null) continue;
        cond = g.lastPrice < g.config.lowerPrice || g.lastPrice > g.config.upperPrice;
        what = `grid ${g.id} ${this.hub.label(g.stable)} price ${g.lastPrice.toPrecision(5)} outside ${g.config.lowerPrice.toPrecision(5)}–${g.config.upperPrice.toPrecision(5)}`;
      }
      if (cond && !a.active) {
        a.active = true; a.lastFiredAt = this.now(); changed = true;
        if (!a.repeat) a.enabled = false;
        this.activity.emitEvent({ type: 'alert', kind: 'system', pair: a.pair, chainId: this.hub.has(a.pair) ? this.hub.def(a.pair).chainId : undefined, botId: a.botId, level: 'warn', notify: true, msg: `Alert: ${what}`, data: { alertId: a.id } });
      } else if (!cond && a.active) { a.active = false; changed = true; }
    }
    if (changed) this.persist();
  }

  // ── Portfolio / analytics ──────────────────────────────────────────────
  private botRows() {
    const rows: {
      id: string; kind: 'grid' | 'trend'; name: string; pair: string; chainId: number; mode: Mode; status: string; usdPerQuote: number | null;
      capital: number; equity: number; realized: number; unrealized: number; fees: number; gas: number; hodl: number | null;
      plsHeld: number; quoteFree: number; startedAt: number | null; equityHist: [number, number][];
      closed: { pnl: number; t: number; holdMs?: number }[]; trades: LiveTrade[]; inMarket: number;
    }[] = [];
    for (const e of this.engines.values()) {
      const s = e.state;
      if (!s.config) continue;
      const tr = e.modeTrades();
      const t = totals(tr, s.lastPrice);
      const capital = s.config.totalCapitalUsd;
      const startPrice = s.startPrice ?? tr[0]?.price ?? null;
      const eqHist = s.equity ?? [];
      rows.push({
        id: s.id, kind: 'grid', name: `Grid ${e.label}`, pair: s.stable, chainId: e.chainId, mode: s.mode, status: s.status, usdPerQuote: this.usdPerQuote(s.stable),
        capital, equity: capital + t.realized + t.unrealized, realized: t.realized, unrealized: t.unrealized,
        fees: tr.reduce((a, x) => a + (x.feeQuote ?? 0), 0), gas: t.gasUsd,
        hodl: startPrice && s.lastPrice ? (capital / startPrice) * s.lastPrice : null,
        plsHeld: t.pos.plsHeld, quoteFree: Math.max(0, capital + t.realized - t.pos.costUsd), startedAt: s.startedAt ?? tr[0]?.timestamp ?? null,
        equityHist: eqHist,
        closed: tr.filter((x) => x.side === 'sell' && !x.failed && x.roundTripNet != null).map((x) => ({ pnl: x.roundTripNet!, t: x.timestamp })),
        trades: tr,
        inMarket: t.pos.plsHeld > 0 ? 1 : 0,
      });
    }
    for (const e of this.trendEngines.values()) {
      const st = e.status();
      if (!st.capital) continue;
      rows.push({
        id: st.id, kind: 'trend', name: st.name, pair: st.quote, chainId: e.chainId, mode: st.mode, status: st.status, usdPerQuote: this.usdPerQuote(st.quote),
        capital: st.capital, equity: st.pnl.equity, realized: st.pnl.realized, unrealized: st.pnl.unrealized, fees: st.pnl.fees, gas: st.pnl.gas,
        hodl: st.hodl, plsHeld: st.position?.pls ?? 0, quoteFree: st.cash, startedAt: st.startedAt, equityHist: e.state.equity,
        closed: e.modeTrades().filter((x) => x.side === 'sell' && !x.failed).map((x) => ({ pnl: x.realizedPnlUsd, t: x.timestamp, holdMs: (x as TrendTrade).holdMs })),
        trades: e.modeTrades(), inMarket: st.stats.timeInMarket,
      });
    }
    return rows;
  }

  private snapshotPortfolio() {
    const p = this.multi.portfolio;
    if (p.length && this.now() - p[p.length - 1][0] < 60_000) return;
    const rows = this.botRows();
    if (!rows.length) return;
    const eq = rows.reduce((a, r) => a + (r.usdPerQuote ? r.equity * r.usdPerQuote : 0), 0);
    const re = rows.reduce((a, r) => a + (r.usdPerQuote ? r.realized * r.usdPerQuote : 0), 0);
    const cap = rows.reduce((a, r) => a + (r.usdPerQuote ? r.capital * r.usdPerQuote : 0), 0);
    pushCapped(p, [this.now(), usdFmt(eq), usdFmt(re), usdFmt(cap)], 4000);
    this.persist();
  }

  overview() {
    const rows = this.botRows();
    const now = this.now();
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const periods = { today: day.getTime(), d7: now - 7 * 86_400_000, all: 0 };
    const usd = (r: (typeof rows)[number], v: number) => (r.usdPerQuote ? v * r.usdPerQuote : 0);
    const realizedSince = (from: number) => rows.reduce((a, r) => a + usd(r, r.trades.filter((t) => t.timestamp >= from).reduce((s, t) => s + t.realizedPnlUsd, 0)), 0);
    // Only snapshots that carry the allocated capital can be compared: PnL = equity − capital, so starting,
    // adding or removing a bot is not counted as a gain or loss.
    const ph = this.multi.portfolio.filter((x) => x[3] != null) as [number, number, number, number][];
    const eqNow = rows.reduce((a, r) => a + usd(r, r.equity), 0);
    const capNow = rows.reduce((a, r) => a + usd(r, r.capital), 0);
    const pnlNow = eqNow - capNow;
    const pnlAt = (from: number) => {
      const p = ph.find((x) => x[0] >= from);
      return p ? { v: p[1] - p[3], partial: p[0] - from > 3_600_000 } : null;
    };
    const per = Object.fromEntries(Object.entries(periods).map(([k, from]) => {
      const e = pnlAt(from);
      return [k, { realized: realizedSince(from), equityChange: e ? pnlNow - e.v : null, partial: from > 0 ? e?.partial ?? false : false }];
    }));
    // Portfolio curve at today's capital: capNow + PnL(t) (flows removed), so drawdown reflects trading only.
    const curve = ph.map(([t, v, , c]) => [t, capNow + (v - c)] as [number, number]);
    const bots = rows.map((r) => {
      const st = tradeStats(r.closed);
      return {
        id: r.id, kind: r.kind, name: r.name, pair: r.pair, chainId: r.chainId, mode: r.mode, status: r.status, usdPerQuote: r.usdPerQuote,
        capital: r.capital, equity: r.equity, equityUsd: usd(r, r.equity), capitalUsd: usd(r, r.capital),
        realized: r.realized, unrealized: r.unrealized, realizedUsd: usd(r, r.realized), unrealizedUsd: usd(r, r.unrealized),
        feesUsd: usd(r, r.fees), gasUsd: usd(r, r.gas), hodlUsd: r.hodl != null ? usd(r, r.hodl) : null,
        returnPct: r.capital ? r.equity / r.capital - 1 : 0, vsHodlPct: r.hodl ? r.equity / r.hodl - 1 : null,
        plsHeld: r.plsHeld, quoteFree: r.quoteFree, startedAt: r.startedAt,
        stats: { ...st, profitFactor: st.profitFactor === Infinity ? null : st.profitFactor, maxDrawdown: drawdown(r.equityHist).max, timeInMarket: r.inMarket },
        equity_hist: r.equityHist.map(([t, v]) => [t, usd(r, v)] as [number, number]),
      };
    });
    const sum = (k: 'equityUsd' | 'capitalUsd' | 'realizedUsd' | 'unrealizedUsd' | 'feesUsd' | 'gasUsd') => bots.reduce((a, b) => a + b[k], 0);
    // Allocation by asset: base held (valued via the hub oracle) + free quote, labelled per chain.
    const alloc = new Map<string, { asset: string; chainId: number; usd: number; amount: number | null }>();
    const addA = (asset: string, chainId: number, v: number, amount: number | null) => {
      const x = alloc.get(asset) ?? { asset, chainId, usd: 0, amount: amount == null ? null : 0 };
      x.usd += v; if (x.amount != null && amount != null) x.amount += amount;
      alloc.set(asset, x);
    };
    for (const r of rows) {
      const d = this.hub.has(r.pair) ? this.hub.def(r.pair) : null;
      if (!d) continue;
      if (r.plsHeld > 0) addA(this.tokLabel(d.chainId, d.base.symbol), d.chainId, r.plsHeld * (this.hub.baseUsd(r.pair) ?? 0), r.plsHeld);
      addA(this.tokLabel(d.chainId, d.quote.symbol), d.chainId, usd(r, r.quoteFree), null);
    }
    // Per-chain breakdown (aggregated ≈USD) + gas wallet per chain.
    const chains = this.hub.runtimes().map((rt) => {
      const bs = bots.filter((b) => b.chainId === rt.cfg.id);
      const w = this.wallets.get(rt.cfg.id);
      const nat = this.hub.nativeUsd(rt.cfg.id);
      return {
        chainId: rt.cfg.id, key: rt.cfg.key, name: rt.cfg.name, short: rt.cfg.short, color: rt.cfg.color, status: rt.cfg.status,
        bots: bs.length, running: bs.filter((b) => b.status === 'running').length,
        equityUsd: bs.reduce((a, b) => a + b.equityUsd, 0), capitalUsd: bs.reduce((a, b) => a + b.capitalUsd, 0),
        realizedUsd: bs.reduce((a, b) => a + b.realizedUsd, 0), unrealizedUsd: bs.reduce((a, b) => a + b.unrealizedUsd, 0),
        gasUsd: bs.reduce((a, b) => a + b.gasUsd, 0),
        gasNative: w?.native ?? rt.gas.native, gasNativeUsd: (w?.native ?? rt.gas.native) != null && nat ? (w?.native ?? rt.gas.native)! * nat : null,
        lowGas: rt.gas.low, nativeSymbol: rt.cfg.nativeSymbol,
      };
    }).filter((c) => c.bots > 0 || c.gasNative != null);
    const hodl = bots.reduce((a, b) => a + (b.hodlUsd ?? b.capitalUsd), 0);
    return {
      t: now,
      totals: { equityUsd: sum('equityUsd'), capitalUsd: sum('capitalUsd'), realizedUsd: sum('realizedUsd'), unrealizedUsd: sum('unrealizedUsd'), feesUsd: sum('feesUsd'), gasUsd: sum('gasUsd'), hodlUsd: hodl, vsHodlPct: hodl ? sum('equityUsd') / hodl - 1 : null },
      periods: per,
      allocation: [...alloc.values()].filter((x) => x.usd > 0.005).sort((a, b) => b.usd - a.usd),
      chains,
      bots,
      portfolio: curve,
      portfolioDrawdown: drawdown(curve).max,
      notes: ['≈USD: each bot\'s quote token is converted at today\'s rate — stables = $1, other tokens through the chain\'s native/stable market (PulseChain: PLS/DAI); historical equity points use today\'s rate. Bots whose quote has no USD route are excluded.', 'Period change = change in PnL (equity − allocated capital) from portfolio snapshots taken every minute while the server runs, so starting or removing a bot is not counted. "partial" = history starts after the period start.', 'The portfolio curve is drawn at today\'s allocated capital (capital + PnL at each time).'],
    };
  }

  journal(f: { botId?: string; kind?: string; pair?: string; side?: string; mode?: string; from?: number; to?: number } = {}): JournalRow[] {
    const rows: JournalRow[] = [];
    const push = (botId: string, kind: 'grid' | 'trend', bot: string, t: LiveTrade & { reason?: string }) => {
      const k = this.usdPerQuote(t.stable);
      const pnl = t.side === 'sell' || t.failed ? (t.roundTripNet ?? t.realizedPnlUsd) : null;
      rows.push({
        t: t.timestamp, botId, kind, bot, pair: t.stable, mode: t.paper ? 'paper' : 'live', side: t.side,
        reason: t.reason ?? (t.manual ? 'manual' : t.levelPrice != null ? `level ${t.levelPrice.toPrecision(5)}` : t.failed ? 'failed' : 'grid'),
        pls: t.plsAmount, quote: t.stableAmount, price: t.price, fee: t.feeQuote ?? 0, gas: t.gasUsd, pnl, pnlUsd: pnl != null && k ? pnl * k : null,
        slippagePct: t.slippagePct ?? null, tx: t.txHash, failed: !!t.failed,
      });
    };
    for (const g of this.multi.grids) for (const t of g.trades) push(g.id, 'grid', `Grid ${this.hub.label(g.stable)}`, t);
    for (const s of this.multi.trends) for (const t of s.trades) push(s.id, 'trend', s.name, t);
    return rows
      .filter((r) => (!f.botId || r.botId === f.botId) && (!f.kind || r.kind === f.kind) && (!f.pair || r.pair === f.pair)
        && (!f.side || r.side === f.side) && (!f.mode || r.mode === f.mode) && (!f.from || r.t >= f.from) && (!f.to || r.t <= f.to))
      .sort((a, b) => b.t - a.t);
  }

  static journalCsv(rows: JournalRow[]): string {
    const cols: (keyof JournalRow)[] = ['t', 'botId', 'kind', 'bot', 'pair', 'mode', 'side', 'reason', 'pls', 'quote', 'price', 'fee', 'gas', 'pnl', 'pnlUsd', 'slippagePct', 'tx', 'failed'];
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [['time', ...cols.slice(1)].join(','), ...rows.map((r) => [new Date(r.t).toISOString(), ...cols.slice(1).map((c) => esc(r[c]))].join(','))].join('\n') + '\n';
  }

  // ── Market panels ──────────────────────────────────────────────────────
  async marketPanel(pair: string) {
    const def = this.hub.def(pair);
    const chain = this.hub.chain(def.chainId);
    const nowSec = Math.floor(this.now() / 1000);
    const h1 = fillGaps(closedOnly(this.candles.get(pair, '1h'), '1h', nowSec), '1h');
    const spot = this.spots[pair] ?? h1[h1.length - 1]?.c ?? null;
    const at = (sec: number) => { const k = h1.filter((x) => x.t <= nowSec - sec); return k.length ? k[k.length - 1].c : null; };
    const p24 = at(86_400), p7 = at(7 * 86_400);
    const vol24 = this.candles.get(pair, '1h').filter((x) => x.t >= nowSec - 86_400).reduce((a, x) => a + x.v, 0);
    const k = this.usdPerQuote(pair);
    let m: MarketSnapshot | null = null;
    try { m = await this.market(pair); } catch { /* offline */ }
    const model: CostModel = { ...DEFAULT_COSTS, feeBps: def.pool.feeBps, slippageBps: 0, buyTaxPct: m?.buyTaxPct ?? 0, sellTaxPct: m?.sellTaxPct ?? 0, pool: m ? { quoteReserve: m.quoteReserve, plsReserve: m.plsReserve } : null };
    const depth = k && spot && m ? [100, 500, 1000].map((usd) => {
      const b = simBuy(usd / k, spot, model), s = simSell(usd / k / spot, spot, model);
      return { usd, buyImpactPct: b.impactPct, sellImpactPct: s.impactPct };
    }) : [];
    const closes = h1.map((x) => x.c);
    const a = atr(h1, 14), e20 = ema(closes, 20), e50 = ema(closes, 50), er = efficiencyRatio(closes, 48);
    const i = h1.length - 1;
    const atrPct = i >= 0 && a[i] != null && spot ? a[i]! / spot : null;
    const ef = i >= 0 ? e20[i] : null, es = i >= 0 ? e50[i] : null, erv = i >= 0 ? er[i] : null;
    const trend = ef != null && es != null ? (ef > es * 1.002 ? 'up' : ef < es * 0.998 ? 'down' : 'flat') : null;
    const regime = erv == null ? { kind: 'unknown', hint: 'Not enough 1h candles yet (need ~50).' }
      : erv >= 0.35 && trend !== 'flat' ? { kind: 'trend', hint: trend === 'up' ? 'Trending up → trend bot (long-only) fits; grids sell out early.' : 'Trending down → stay in the quote; long-only trend bot waits, grids accumulate bags.' }
      : erv <= 0.2 ? { kind: 'chop', hint: 'Choppy / mean-reverting → grid bot fits; trend signals whipsaw.' }
      : { kind: 'mixed', hint: 'Mixed regime → smaller size or wider grids.' };
    return {
      pair, label: this.hub.label(pair), chainId: def.chainId, chainShort: chain.short, chainName: chain.name, chainColor: chain.color,
      base: def.base.symbol, quote: def.quote.symbol, dex: def.pool.dex, dexName: chain.dexes.find((x) => x.id === def.pool.dex)?.name ?? def.pool.dex,
      feeBps: def.pool.feeBps, feeTier: def.pool.feeTier ?? null, poolAddress: def.pool.address || null, explorer: chain.explorer,
      custom: !!def.custom, legacy: !!def.legacy, safety: def.safety ?? null, tradable: this.hub.rt(def.chainId).tradable,
      spot, usdPerQuote: k, change24h: p24 && spot ? spot / p24 - 1 : null, change7d: p7 && spot ? spot / p7 - 1 : null,
      // V3: TVL from the pool's token balances; V2: 2 × quote reserve.
      liquidityUsd: m && k ? (m.tvlQuote != null ? m.tvlQuote * k : 2 * m.quoteReserve * k) : null, reserves: m ? { quote: m.quoteReserve, pls: m.plsReserve } : null,
      depth, volume24h: vol24, volume24hUsd: k ? vol24 * k : null, atrPct, ema20: ef, ema50: es, trend, er: erv, regime,
      spark: h1.slice(-48).map((x) => x.c), candles: h1.length,
      volumeNote: 'Volume comes from GeckoTerminal / on-chain Swap events; live-poll candles carry no volume.',
    };
  }

  /** Market panels for every watched market (optionally one chain); parallel across markets. */
  async markets(chainId?: number) {
    const keys = this.watchedKeys(true).filter((k) => chainId == null || this.hub.def(k).chainId === chainId);
    const res = await Promise.all(keys.map((k) => this.marketPanel(k).catch(() => null)));
    return res.filter((x): x is NonNullable<typeof x> => !!x);
  }

  // ── Candles / backtests ────────────────────────────────────────────────
  candleSeries(pair: string, tf: TF, from?: number, to?: number, limit = 2000): Candle[] {
    this.hub.def(pair);
    const k = sliceRange(fillGaps(this.candles.get(pair, tf), tf), from, to);
    return k.slice(-limit);
  }

  private async costModel(pair: string, o: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } = {}): Promise<{ model: CostModel; note: string }> {
    const def = this.hub.def(pair);
    let m: MarketSnapshot | null = null;
    try { m = await this.market(pair); } catch { /* offline: no impact/gas */ }
    const useGas = o.useGas !== false && !!m;
    const model: CostModel = {
      feeBps: m?.feeBps ?? def.pool.feeBps ?? FEE_BPS, approval: this.d.approval ?? 'exact', slippageBps: o.slippageBps ?? DEFAULT_COSTS.slippageBps,
      buyTaxPct: m?.buyTaxPct ?? 0, sellTaxPct: m?.sellTaxPct ?? 0,
      pool: o.useImpact !== false && m ? { quoteReserve: m.quoteReserve, plsReserve: m.plsReserve } : null,
      gasPricePls: useGas ? m!.gasPricePls : 0,
      gasUnits: m?.gasUnits, extraPlsPerSwap: useGas ? m!.extraPlsPerSwap ?? 0 : 0,
    };
    const b = def.base.symbol, q = def.quote.symbol, nat = this.hub.chain(def.chainId).nativeSymbol;
    const note = m
      ? `${this.hub.label(pair)}: LP fee ${(model.feeBps / 100).toFixed(2)}%, impact from CURRENT ${def.pool.kind === 'v3' ? 'active-range (virtual) ' : ''}reserves (${m.quoteReserve.toPrecision(4)} ${q} / ${m.plsReserve.toPrecision(4)} ${b}), gas ${((m.gasPriceNative ?? m.gasPricePls) * 1e9).toPrecision(3)} gwei ${nat}${m.basePerNative && m.basePerNative !== 1 ? ` (×${m.basePerNative.toPrecision(4)} ${b}/${nat})` : ''}${m.extraPlsPerSwap ? ` + L1 data fee ${m.extraPlsPerSwap.toPrecision(3)} ${b}/swap` : ''}${m.buyTaxPct || m.sellTaxPct ? `, token tax buy ${((m.buyTaxPct ?? 0) * 100).toFixed(2)}% / sell ${((m.sellTaxPct ?? 0) * 100).toFixed(2)}%` : ''}.`
      : `Pool snapshot unavailable: LP fee ${(model.feeBps / 100).toFixed(2)}% only; impact and gas excluded.`;
    return { model, note };
  }

  private btCandles(pair: string, tf: TF, from?: number, to?: number) {
    const raw = this.candles.get(pair, tf);
    const k = sliceRange(fillGaps(closedOnly(raw, tf, Math.floor(this.now() / 1000)), tf), from, to);
    return { k, meta: this.candles.getMeta(pair, tf), gaps: k.filter((x) => x.f).length };
  }

  private capitalQuote(pair: string, capital?: number, capitalUsd?: number) {
    if (capital && capital > 0) return capital;
    const k = this.usdPerQuote(pair);
    if (capitalUsd && capitalUsd > 0 && k) return capitalUsd / k;
    return k ? 1000 / k : 1000;
  }

  private thin(r: BtResult, max = 1500): BtResult {
    if (r.equity.length <= max) return r;
    const step = Math.ceil(r.equity.length / max);
    return { ...r, equity: r.equity.filter((_, i) => i % step === 0 || i === r.equity.length - 1) };
  }

  async backtest(p: { pair: string; tf: string; from?: number; to?: number; capital?: number; capitalUsd?: number; cfg?: Partial<TrendConfig>; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const cfg = { ...DEFAULT_TREND, ...(p.cfg ?? {}) };
    const { k, meta, gaps } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital, p.capitalUsd);
    const { model, note } = await this.costModel(p.pair, p.costs);
    const htf = cfg.htfEnabled ? fillGaps(closedOnly(this.candles.get(p.pair, cfg.htfTf), cfg.htfTf, Math.floor(this.now() / 1000)), cfg.htfTf) : undefined;
    const r = runTrendBacktest(k, cfg, p.tf, { capital, costs: model, htf });
    return { ...this.thin(r), pair: p.pair, cfg, capital, usdPerQuote: this.usdPerQuote(p.pair), costs: model, candles: k.length, gaps, from: k[0]?.t, to: k[k.length - 1]?.t, source: meta?.source ?? null, notes: [...r.notes, note, gaps ? `${gaps} empty candles gap-filled flat (no trades in those periods).` : ''].filter(Boolean) };
  }

  async backtestGrid(p: { pair: string; tf: string; from?: number; to?: number; lowerPrice: number; upperPrice: number; gridCount: number; capital?: number; capitalUsd?: number; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const { k, meta, gaps } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital, p.capitalUsd);
    const { model, note } = await this.costModel(p.pair, p.costs);
    const r = runGridBacktest(k, { lowerPrice: p.lowerPrice, upperPrice: p.upperPrice, gridCount: p.gridCount, capital }, p.tf, model);
    return { ...this.thin(r), pair: p.pair, capital, usdPerQuote: this.usdPerQuote(p.pair), costs: model, candles: k.length, gaps, from: k[0]?.t, to: k[k.length - 1]?.t, source: meta?.source ?? null, notes: [...r.notes, note] };
  }

  async sweep(p: { pair: string; tf: string; from?: number; to?: number; capital?: number; capitalUsd?: number; cfg?: Partial<TrendConfig>; xKey?: SweepKey; xs?: number[]; yKey?: SweepKey; ys?: number[]; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const cfg = { ...DEFAULT_TREND, ...(p.cfg ?? {}) };
    const [dx, dy] = SWEEP_AXES[cfg.strategy];
    const xKey = p.xKey ?? dx, yKey = p.yKey ?? dy;
    const defaults: Record<string, number[]> = {
      fast: [5, 8, 10, 13, 20, 30], slow: [20, 30, 40, 50, 80, 100], macdFast: [6, 8, 12, 16], macdSlow: [20, 26, 35, 50],
      donchianEntry: [10, 20, 30, 55], donchianExit: [5, 10, 15, 20], stopAtr: [1, 1.5, 2, 3, 4], tpR: [0, 1, 2, 3, 5], trailAtr: [0, 1.5, 2, 3, 4],
    };
    const { k } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital, p.capitalUsd);
    const { model } = await this.costModel(p.pair, p.costs);
    const htf = cfg.htfEnabled ? fillGaps(closedOnly(this.candles.get(p.pair, cfg.htfTf), cfg.htfTf, Math.floor(this.now() / 1000)), cfg.htfTf) : undefined;
    return { ...sweepTrend(k, cfg, p.tf, xKey, p.xs ?? defaults[xKey], yKey, p.ys ?? defaults[yKey], { capital, costs: model, htf }), candles: k.length, pair: p.pair, tf: p.tf };
  }

  // ── Presets / economics (unchanged) ────────────────────────────────────
  listPresets() { return listPresets(); }

  async economics(quote: string, cfg: EconCfg): Promise<EconSummary & { usdPerQuote: number | null; feeBps: number; chainId: number; label: string }> {
    const def = this.hub.def(quote);
    const { summary } = await gridEconomics(this.hub.quoter(quote), cfg, this.d.approval ?? 'exact');
    this.hub.setSpot(quote, summary.spot);
    try { await this.hub.nativeUsdAsync(def.chainId); } catch { /* optional */ }
    return { ...summary, usdPerQuote: this.hub.usdPerQuote(quote), feeBps: def.pool.feeBps, chainId: def.chainId, label: this.hub.label(quote) };
  }

  private legacyKeys() { return this.hub.list().filter((d) => d.legacy).map((d) => d.key); }

  async previewPreset(id: string, opts: { quote?: string; capitalUsd?: number } = {}) {
    const preset = getPreset(id);
    const selected = opts.quote ?? this.d.net.defaultQuote;
    // Presets are PulseChain-only (legacy markets, either orientation).
    const keys = new Set(this.legacyKeys());
    for (const l of preset.legs) keys.add(legKey(l, selected));
    const spots = await this.prices([...keys]);
    for (const [k, v] of Object.entries(spots)) this.hub.setSpot(k, v);
    // Flipped "Stack …" legs: evaluate on the deepest pool (best quote across every PulseChain DEX) unless the
    // market has a manual pool override; startPreset switches the market to that pool (auto) before starting.
    const best: Record<string, { quoter: Quoter; pool: PresetPool }> = {};
    for (const l of preset.legs) {
      if (!l.flip) continue;
      const key = legKey(l, selected);
      const cur = this.hub.def(key);
      if (cur.poolMode === 'manual') continue;
      try {
        const b = (await this.hub.poolOptions(key)).best;
        if (!b || b.mid == null) continue;
        const same = b.dex === cur.pool.dex && (b.kind === 'v2' || sameAddr(b.address, cur.pool.address));
        const pool = { dex: b.dex, kind: b.kind, address: b.address, feeBps: b.feeBps, ...(b.feeTier != null ? { feeTier: b.feeTier } : {}) };
        const quoter = same ? this.hub.quoter(key) : this.hub.quoterOnPool(key, pool);
        spots[key] = await quoter.getPrice();
        best[key] = { quoter, pool: { ...pool, dexName: b.dexName, switchTo: !same } };
      } catch { /* discovery failed: current pool */ }
    }
    const resolved = resolvePreset(preset, spots, selected, opts);
    const legs: (ResolvedLeg & { econ: EconSummary; label: string; pool?: PresetPool })[] = [];
    for (const leg of resolved) {
      const b = best[leg.quote];
      const { summary } = await gridEconomics(b?.quoter ?? this.hub.quoter(leg.quote), leg, this.d.approval ?? 'exact');
      legs.push({ ...leg, econ: summary, label: this.hub.label(leg.quote), ...(b ? { pool: b.pool } : {}) });
    }
    return { preset: { id: preset.id, name: preset.name, blurb: preset.blurb }, spots, legs, ok: legs.every((l) => l.econ.ok) };
  }

  async startPreset(
    id: string,
    opts: { mode: Mode; quote?: string; capitalUsd?: number; allowTightSpacing?: boolean; limits?: Parameters<GridEngine['start']>[0]['limits'] } = { mode: 'paper' },
  ): Promise<{ ids: string[]; legs: ResolvedLeg[] }> {
    const { legs, ok } = await this.previewPreset(id, opts);
    const paperOverride = opts.mode === 'paper' && !!opts.allowTightSpacing;
    if (!ok && !paperOverride) {
      const bad = legs.filter((l) => !l.econ.ok).map((l) => `${l.label}: ${l.econ.reasons.join(' ')}`).join('; ');
      throw new Error(`${opts.mode === 'live' ? 'LIVE start blocked' : 'Blocked'} — not net-positive per round-trip: ${bad}`);
    }
    for (const leg of legs) if (leg.pool?.switchTo) await this.setMarketPool(leg.quote, { auto: true });
    const ids: string[] = [];
    try {
      for (const leg of legs) {
        ids.push(await this.add({
          mode: opts.mode, stable: leg.quote, lowerPrice: leg.lowerPrice, upperPrice: leg.upperPrice, gridCount: leg.gridCount,
          totalCapitalUsd: leg.totalCapitalUsd, allowTightSpacing: paperOverride, limits: opts.limits,
        }));
      }
    } catch (e) {
      for (const gid of ids) { try { this.stop(gid); this.remove(gid); } catch { /* best-effort rollback */ } }
      throw e;
    }
    this.d.log.info(`Preset ${id}: started ${ids.length} grid(s) ${ids.join(', ')}`);
    return { ids, legs };
  }

  // ── Custom markets ─────────────────────────────────────────────────────
  async addMarket(req: { chainId: number; address: string; quote?: string; pool?: string }) {
    const d = await this.hub.addMarket(req);
    this.activity.emitEvent({ type: 'info', kind: 'system', level: d.safety?.liveAllowed ? 'success' : 'warn', chainId: d.chainId, pair: d.key,
      msg: `Added ${this.hub.label(d.key)} (${this.hub.dexName(d.chainId, d.pool.dex)} ${d.pool.feeTier != null ? `${d.pool.feeTier / 10000}%` : `${d.pool.feeBps / 100}%`}) — safety ${d.safety?.risk ?? 'unknown'}${d.safety?.liveAllowed ? '' : ' · paper only'}` });
    return d;
  }
  removeMarket(key: string) {
    key = unflipKey(key);
    const same = (k: string) => unflipKey(k) === key; // either orientation counts as "used"
    const used = this.multi.grids.some((g) => same(g.stable)) || this.multi.trends.some((t) => same(t.quote)) || this.multi.alerts.some((a) => same(a.pair));
    if (used) throw new Error('Market is used by a bot or alert — remove those first.');
    this.hub.removeMarket(key);
    this.marketCache.delete(key);
    this.marketCache.delete(key + '~');
  }
  /** Pools for a market across every DEX on its chain (PulseChain: PulseX V1, PulseX V2, 9mm V2, 9mm V3). */
  poolOptions(key: string) { return this.hub.poolOptions(key); }
  /** Switch a market's trading pool (manual / auto best-quote / reset). Refused while a tx on that market is in flight. */
  async setMarketPool(key: string, req: { pool?: string; auto?: boolean; reset?: boolean }) {
    key = unflipKey(key);
    const busy = [...this.engines.values()].some((e) => unflipKey(e.state.stable) === key && e.state.inFlight)
      || [...this.trendEngines.values()].some((e) => unflipKey(e.state.quote) === key && e.state.inFlight);
    if (busy) throw new Error('A transaction on this market is in flight — wait for it to settle before switching pools.');
    const before = this.hub.def(key).pool;
    const { def: d } = await this.hub.setPool(key, req);
    this.marketCache.delete(key);
    this.marketCache.delete(key + '~');
    const name = (p: typeof before) => `${this.hub.dexName(d.chainId, p.dex)} ${p.feeTier != null ? `${p.feeTier / 10000}%` : `${p.feeBps / 100}%`}`;
    this.activity.emitEvent({ type: 'info', kind: 'system', level: 'info', pair: key, chainId: d.chainId,
      msg: `${this.hub.label(key)} pool: ${name(before)} → ${name(d.pool)} (${d.poolMode})${d.pool.address ? ` ${d.pool.address.slice(0, 10)}…` : ''}` });
    this.activity.emit('status');
    return d;
  }
  async recheckMarket(key: string) {
    // Route through TaxWatch so a rising tax / honeypot on a live market pauses bots the same way a scheduled check would.
    const c = await this.taxWatch.check(key, 'manual');
    if (c?.report) return c.report;
    const r = await this.hub.recheck(key);
    this.activity.emitEvent({ type: 'info', kind: 'system', level: r.liveAllowed ? 'info' : 'warn', pair: key, chainId: this.hub.def(key).chainId, msg: `Safety re-check ${this.hub.label(key)}: ${r.risk}${r.liveAllowed ? '' : ' — live trading blocked'}` });
    return r;
  }

  // ── Status ─────────────────────────────────────────────────────────────
  /** Every configured chain: trading status, signer, gas wallet, RPC health, tx queue, bots. */
  chainsStatus() {
    return this.hub.runtimes().map((rt) => {
      const c = rt.cfg, w = this.wallets.get(c.id);
      const bots = [...this.engines.values()].filter((e) => e.chainId === c.id).length + [...this.trendEngines.values()].filter((e) => e.chainId === c.id).length;
      return {
        id: c.id, key: c.key, name: c.name, short: c.short, color: c.color, status: c.status, stack: c.stack,
        tradable: rt.tradable, reason: rt.tradable ? null : c.trading.reason ?? 'no DEX configured',
        nativeSymbol: c.nativeSymbol, explorer: c.explorer, geckoSlug: c.geckoSlug,
        dexes: c.dexes.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
        hasSigner: !!rt.signer, address: w?.address ?? rt.gas.address, gasNative: w?.native ?? rt.gas.native, lowGas: rt.gas.low,
        lowGasNative: c.lowGasNative, nativeUsd: this.hub.nativeUsd(c.id), walletError: w?.error ?? rt.gas.error ?? null,
        txBusy: rt.gate.busy, rpc: rt.reader.currentUrl ?? null, rpcStatus: rt.reader.status ?? null, bots,
      };
    });
  }

  /** Both orientations of every market: originals plus their flipped views (flipped: true, pairKey = original). */
  marketList() {
    return this.hub.listBoth().map((d) => ({
      key: d.key, label: this.hub.label(d.key), chainId: d.chainId, base: d.base.symbol, quote: d.quote.symbol, quoteKind: d.quoteKind,
      flipped: !!d.flipped, pairKey: d.flipOf ?? d.key, spends: d.quote.symbol, stacks: d.base.symbol, quoteNative: !!d.quote.native,
      baseDecimals: d.base.decimals, quoteDecimals: d.quote.decimals,
      dex: d.pool.dex, dexName: this.hub.dexName(d.chainId, d.pool.dex), kind: d.pool.kind, feeBps: d.pool.feeBps, feeTier: d.pool.feeTier ?? null,
      // Built-in PulseChain markets resolve their PulseX V2 pair via getPair; candlePool is that same verified pair.
      pool: d.pool.address || (d.legacy && d.pool.dex === 'pulsex-v2' ? d.candlePool ?? null : null),
      poolMode: d.poolMode ?? (d.custom ? 'manual' : 'default'), poolChoices: this.hub.rt(d.chainId).adapters.size,
      legacy: !!d.legacy, custom: !!d.custom, risk: d.safety?.risk ?? null, liveAllowed: d.custom ? !!d.safety?.liveAllowed : true,
      buyTaxPct: d.safety?.buyTaxPct ?? null, sellTaxPct: d.safety?.sellTaxPct ?? null, transferTaxPct: d.safety?.transferTaxPct ?? null,
      taxMode: d.safety?.taxMode ?? null, maxTxTokens: d.safety?.maxTxTokens ?? null, maxWalletTokens: d.safety?.maxWalletTokens ?? null,
      tradable: this.hub.rt(d.chainId).tradable,
      // Flipped spot: its own poll when a bot uses it, else ≈ 1 / original (mid-ish; the LP fee makes them differ by ~2× fee).
      spot: this.spots[d.key] ?? (d.flipOf && this.spots[d.flipOf] > 0 ? 1 / this.spots[d.flipOf] : null), usdPerQuote: this.hub.usdPerQuote(d.key),
    }));
  }

  status() {
    const grids = this.multi.grids.map((g) => {
      const st = (this.engines.get(g.id) ?? this.attach(g.id)).status();
      return { ...st, kind: 'grid' as const, usdPerQuote: this.usdPerQuote(st.stable) };
    });
    const trends = this.multi.trends.map((t) => {
      const st = (this.trendEngines.get(t.id) ?? this.attachTrend(t.id)).status();
      return { ...st, usdPerQuote: this.usdPerQuote(st.quote) };
    });
    const z = { realized: 0, unrealized: 0, gasUsd: 0, feesUsd: 0, roundTrips: 0, plsHeld: 0, unpriced: 0 };
    const aggregate = grids.reduce((a, g) => {
      const k = g.usdPerQuote;
      if (k == null) return { ...a, unpriced: a.unpriced + 1, plsHeld: a.plsHeld + g.pnl.plsHeld };
      return { ...a, realized: a.realized + g.pnl.realized * k, unrealized: a.unrealized + g.pnl.unrealized * k, gasUsd: a.gasUsd + g.pnl.gasUsd * k, feesUsd: a.feesUsd + g.stats.totalFees * k, roundTrips: a.roundTrips + g.stats.roundTrips, plsHeld: a.plsHeld + g.pnl.plsHeld };
    }, z);
    for (const t of trends) {
      const k = t.usdPerQuote;
      aggregate.plsHeld += t.position?.pls ?? 0;
      if (k == null) { aggregate.unpriced++; continue; }
      aggregate.realized += t.pnl.realized * k; aggregate.unrealized += t.pnl.unrealized * k; aggregate.gasUsd += t.pnl.gas * k; aggregate.feesUsd += t.pnl.fees * k; aggregate.roundTrips += t.stats.count;
    }
    return {
      network: this.d.net.key, chainId: this.d.net.chainId, explorer: this.d.net.explorer,
      quotes: this.d.net.quotes.map((s) => s.symbol), stables: this.d.net.quotes.map((s) => s.symbol),
      hasSigner: this.hasSigner, address: this.address, walletBalances: this.walletBalances, defaults: this.multi.defaults,
      txBusy: this.gate.busy, spots: this.spots, spotsAt: this.spotsAt,
      legacyChainId: this.hub.legacyChainId,
      chains: this.chainsStatus(),
      marketList: this.marketList(),
      grids, trends, aggregate, allocations: this.allocations(), alerts: this.multi.alerts,
      candleSync: this.candleSyncStatus?.() ?? null,
      log: this.d.log.entries.slice(-80).reverse(),
    };
  }
}
