/**
 * Orchestrator: many GridEngines + TrendEngines across every configured EVM chain. Each chain has its own
 * signer, TxGate and nonce queue (chains execute in parallel, one tx at a time per chain); one persisted
 * state file (v3; legacy PulseChain state loads unchanged as chain 369). Also owns the candle store feed, market panels, alerts, analytics and
 * the activity bus.
 */
import { gridMetrics, lpMetrics, trendMetrics, type BotMetrics } from '../../metrics/botMetrics';
import { feesToday } from '../../metrics/feesToday';
import { DEFAULT_LIMITS, type SafetyLimits } from '../../live/limits';
import type { LiveNetwork } from '../../live/networks';
import { Hub, SafetyBlocked, SafetyIncomplete, type StartAnywayInfo } from '../chains/hub';
import { isFlipKey, unflipKey, type MarketDef } from '../../live/markets';
import { checkGasReserve, reserveCfg } from '../../live/gasReserve';
import { humanAmount } from '../../live/amount';
import { totals, upgradeConfigNames, upgradeQuoteNames, type LiveTrade } from '../../live/ledger';
import { FEE_BPS } from '../../live/economics';
import { GridEngine, freshState, type BotState, type EngineDeps, type Mode, type ProfitMode, type StartParams } from './engine';
import { TrendEngine, freshTrend, type TrendStartParams, type TrendState, type TrendTrade } from './trend';
import { LpEngine, freshLp, upgradeLp, type LpStartParams, type LpState } from './lpEngine';
import type { LpCompoundPolicy, LpRangePolicy } from '../../market/lpPolicy';
import { MANUAL_CHECK, TaxWatch } from './taxWatch';
import type { Logger } from './logger';
import type { Store } from './store';
import { SharedNonce, TxGate } from './txGate';
import type { ChainReader, MarketSnapshot, Quoter, TxSender } from './chain';

/** Pool a preset leg is evaluated on (switchTo = the market will be switched to it, auto mode, on start). */
export interface PresetPool { dex: string; kind: 'v2' | 'v3'; address: string; feeBps: number; feeTier?: number; dexName: string; switchTo: boolean }
import { getPreset, legKey, listPresets, resolvePreset, type ResolvedLeg } from '../../live/presets';
import { sameAddr } from '../dex/types';
import type { ReservedBalance } from '../swap/holds';
import { costModelOf, gridEconomics, type EconCfg, type EconSummary } from './econ';
import { capGridEntry } from '../../market/poolSize';
import { ActivityBus } from './activity';
import { requestHalt, startOverride, systemHalt, type Halt, type StartOverride } from './audit';
import { CandleStore } from '../market/candleStore';
import { closedOnly, fillGaps, isTF, replayCandles, sliceRange, type Candle, type TF } from '../../market/candles';
import { atr, ema, efficiencyRatio, rsi } from '../../market/indicators';
import { simBuy, simSell, type CostModel, DEFAULT_COSTS } from '../../market/costs';
import { DEFAULT_TREND, type DrawnLine, type TrendConfig } from '../../market/strategy';
import { runGridBacktest, runTrendBacktest, sweepTrend, SWEEP_AXES, type BtResult, type SweepKey } from '../../market/backtest';
import { drawdown, pushCapped, tradeStats } from '../../market/stats';
import { rpcHost, safeRpcHealth, safeRpcStatus } from '../chains/rpcUrl';

/** A LIVE resume whose safety check was still running when Stop all / STOP chain / Stop landed: the stop won. */
export class ResumeCancelled extends Error { readonly code = 'RESUME_CANCELLED'; }

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
  /** 4: the value history is kept per mode (paper and live never mixed) */
  version: 4;
  defaults: SafetyLimits;
  grids: BotState[];
  trends: TrendState[];
  /** Liquidity-position bots */
  lps: LpState[];
  alerts: Alert[];
  /** Per mode, every ≥60 s: [t, equityUsd, realizedUsd, capitalUsd] (capital lets period changes leave out bots added or removed) */
  portfolio: Record<Mode, PortfolioSnap[]>;
}
type PortfolioSnap = [number, number, number, number];

/**
 * What must be on disk before the app acts on it (DurableJsonStore writes synchronously when this changes): every
 * bot's lifecycle (status, mode, closing, archived, config, limits, halt) and anything about a transaction (in flight,
 * its hashes, a payout in flight, a liquidity step). Prices, equity points and grid intervals are not in it: they are
 * written by the debounced write.
 */
export function multiUrgentKey(s: MultiState): string {
  const g = s.grids.map((b) => [b.id, b.status, b.mode, b.closing, b.archivedAt, b.inFlight, b.payoutInFlight, b.config, b.limits, b.halt, b.trades?.[b.trades.length - 1] ?? null]);
  const t = s.trends.map((b) => [b.id, b.status, b.mode, b.closing, b.archivedAt, b.inFlight, b.limits, b.halt, b.trades?.[b.trades.length - 1] ?? null]);
  const l = s.lps.map((b) => [b.id, b.status, b.mode, b.closing, b.archivedAt, b.step, b.position?.id ?? null, b.position?.liquidity ?? null, b.halt]);
  return JSON.stringify([g, t, l, s.alerts.length, s.defaults]);
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
  /** Set in a friend's copy (env.ts readCopy): the app shows whose copy it is and where the key is added */
  copy?: { friend: string; host: string } | null;
  /** A chain whose RPCs keep failing this long raises a banner + Activity entry (RPC_ALERT_MINUTES; default 3 min). */
  rpcAlertAfterMs?: number;
  /** Boot: how long the safety re-check of live bots that were running may take in all, per market (default 45 s). */
  bootCheckMs?: number;
}

/** Boot safety re-check of live bots that were running: all tries of one market together stop after this long. */
export const BOOT_CHECK_MS = 45_000;

export interface ChainWallet {
  chainId: number;
  address: string;
  native: number;
  /** token address (lowercase) → balance; amount null + error when that read failed (never shown as 0) */
  tokens: Record<string, { symbol: string; amount: number | null; error: string | null }>;
  at: number;
  error: string | null;
}

function migrate(raw: unknown, net: LiveNetwork): MultiState {
  const empty = (): MultiState => ({ version: 4, defaults: { ...DEFAULT_LIMITS }, grids: [], trends: [], lps: [], alerts: [], portfolio: { live: [], paper: [] } });
  if (!raw || typeof raw !== 'object') return empty();
  const o = raw as Record<string, unknown>;
  if ((o.version === 2 || o.version === 3 || o.version === 4) && Array.isArray(o.grids)) {
    return {
      version: 4,
      defaults: { ...DEFAULT_LIMITS, ...((o.defaults as SafetyLimits) ?? {}) },
      // `opening` (the coins after setup, for "vs holding") is no longer kept
      // *Usd → *Quote names (always quote-coin amounts); the state file keeps the old names until the next save
      grids: (o.grids as (BotState & { opening?: unknown })[]).map(upgradeQuoteNames).map(({ opening: _, ...g }) => ({ ...freshState(net, g.id), ...g, id: g.id || freshState(net).id })),
      trends: Array.isArray(o.trends) ? (o.trends as TrendState[]).map(upgradeQuoteNames).map((t) => ({ ...freshTrend(net, t.id), ...t })) : [],
      // config.baseAmount arrived with funding from wallet coins: earlier bots put in none
      lps: Array.isArray(o.lps) ? (o.lps as LpState[]).map((t) => upgradeLp({ ...freshLp(net, t.id), ...t, config: t.config ? { ...t.config, baseAmount: t.config.baseAmount ?? 0 } : null })) : [],
      alerts: Array.isArray(o.alerts) ? (o.alerts as Alert[]) : [],
      // Before version 4 one history summed paper and live bots; it can't be split, so both start over.
      portfolio: o.version === 4 ? (o.portfolio as MultiState['portfolio']) : { live: [], paper: [] },
    };
  }
  const g = upgradeQuoteNames(o) as unknown as BotState; // v1 single grid
  if (g && (g.config != null || g.status || g.trades)) {
    const id = g.id || 'g1';
    return { ...empty(), defaults: { ...DEFAULT_LIMITS, ...(g.limits ?? {}) }, grids: [{ ...freshState(net, id), ...g, id, version: 1 }] };
  }
  return empty();
}

/**
 * Live bots only (paper is simulated), every kind including LPs, in dollars. Feeds the "Total profit moved" push alert:
 * realized + unrealized = each live bot's Total P&L (LP: net after costs and range moves + its price side). Everything
 * comes from the bot's BotMetrics, so it matches the bot pages. A bot with no dollar rate is counted in `unpriced`.
 */
export function liveAggregate(grids: AnyBot[], trends: AnyBot[], lps: AnyBot[]) {
  const a = { mode: 'live' as const, bots: 0, realized: 0, unrealized: 0, generatedUsd: 0, lpFeesEarnedUsd: 0, gasUsd: 0, feesUsd: 0, roundTrips: 0, plsHeld: 0, unpriced: 0 };
  const add = (b: AnyBot, held: number, trips: number) => {
    if (b.mode !== 'live') return;
    a.bots++;
    a.plsHeld += held;
    a.roundTrips += trips;
    const m = b.metrics;
    if (!m || m.realizedUsd == null) { a.unpriced++; return; }
    a.realized += m.realizedUsd; a.unrealized += m.unrealizedUsd ?? 0; a.generatedUsd += m.generatedUsd ?? 0;
    a.gasUsd += m.gasUsd ?? 0; a.feesUsd += m.swapCostUsd ?? 0;
    if (m.kind === 'lp') a.lpFeesEarnedUsd += m.feesEarnedUsd ?? 0;
  };
  for (const g of grids) add(g, g.pnl?.plsHeld ?? 0, g.stats?.roundTrips ?? 0);
  for (const t of trends) add(t, t.position?.pls ?? 0, t.stats?.count ?? 0);
  for (const l of lps) add(l, 0, 0);
  return a;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBot = Record<string, any> & { mode?: string; metrics?: BotMetrics | null };

/** Store that reads/writes one bot slice inside MultiState. */
class SliceStore<T extends { id: string }> implements Store<T> {
  constructor(private readonly list: () => T[], private readonly persist: () => void, private readonly id: string) {}
  load(): T | null { return this.list().find((g) => g.id === this.id) ?? null; }
  save(state: T) {
    const arr = this.list();
    const i = arr.findIndex((g) => g.id === this.id);
    // Removed while one of its ticks was still running: that tick's save must not bring it back. (Every slice is
    // listed before its engine is attached, so a live one is always found.)
    if (i < 0) return;
    arr[i] = { ...state, id: this.id };
    this.persist();
  }
}

/** The wallet doesn't hold what a start or a swap needs (beyond what live bots and the smart trader count) */
export class FundsError extends Error {}

/** Profit a grid sent to its payout address (a transfer in flight is leaving the wallet): no longer the grid's */
const sentProfit = (s: BotState) => s.payouts.filter((p) => p.ok && p.paper === (s.mode === 'paper')).reduce((a, p) => a + p.amount, 0) + (s.payoutInFlight?.amount ?? 0);

/** Coins counted as in use besides the bots' own (the smart trader's money not in a bot): in allocations like a bot's */
export interface Holding { chainId: number; token: { address: string; native?: boolean; symbol: string }; amount: number; id: string }

export interface JournalRow {
  t: number; botId: string; kind: 'grid' | 'trend'; bot: string; pair: string; mode: Mode; side: 'buy' | 'sell';
  reason: string; pls: number; quote: number; price: number; fee: number; gas: number; pnl: number | null; pnlUsd: number | null;
  slippagePct: number | null; tx: string; failed: boolean;
}

const usdFmt = (x: number) => Math.round(x * 100) / 100;
const spikeNote = (n: number) => (n ? `${n} candle${n === 1 ? '' : 's'} had a one-off price spike clipped: a single trade in a thin pool printed a price far outside this pair's usual moves and the pool was put straight back, so no bot could have traded there.` : '');

/** A stopped liquidity bot's value refresh: every this many polls */
export const STOPPED_LP_EVERY = 12;

export class MultiBot {
  readonly hub: Hub;
  readonly candles: CandleStore;
  readonly activity: ActivityBus;
  private multi: MultiState;
  private engines = new Map<string, GridEngine>();
  private trendEngines = new Map<string, TrendEngine>();
  private lpEngines = new Map<string, LpEngine>();
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
  /** The smart trader's live coins not in a bot (set by it): counted in allocations, so no bot or Convert takes them */
  holdings: (() => Holding[]) | null = null;
  /**
   * Told of Stop all (chainId null) and STOP chain, after the bots are stopped, with the audit record: the smart trader
   * and the token trader stop opening anything new. The one stop hook system (it replaced onStop).
   */
  readonly stopHooks: ((chainId: number | null, halt: Halt) => void)[] = [];
  /**
   * ROUTER HOOK. index.ts sets this to `(halt) => router.halt(halt)`.
   * Stop all turns the capital router off. STOP chain does not call it.
   */
  routerHalt: ((halt: Halt) => void) | null = null;
  /** Stop all / STOP chain presses, numbered: a start that was under way when one landed is refused (stopWins) */
  private stopSeq = 0;
  private stopLog: { seq: number; chainId: number | null; halt: Halt }[] = [];

  constructor(private readonly d: MultiDeps) {
    this.hub = d.hub ?? Hub.single(d.net, d.reader, d.signer, { gate: new TxGate(), nonce: new SharedNonce() });
    this.candles = d.candles ?? new CandleStore(null);
    this.activity = d.activity ?? new ActivityBus();
    this.multi = migrate(d.store.load(), d.net);
    this.persist();
    for (const g of this.multi.grids) this.attach(g.id);
    for (const t of this.multi.trends) this.attachTrend(t.id);
    for (const t of this.multi.lps) this.attachLp(t.id);
    this.taxWatch = new TaxWatch({
      now: () => this.now(),
      markets: () => this.watchedSafetyKeys(),
      current: (k) => this.hub.def(k).safety,
      recheck: (k, why) => this.hub.recheck(k, { keepMeasured: why === 'scheduled' || why === MANUAL_CHECK }),
      pause: (k, why) => this.pauseMarket(k, why),
      alert: (k, level, msg, notify) => this.activity.emitEvent({ type: 'alert', kind: 'system', level, notify, pair: k, chainId: this.hub.def(k).chainId, msg }),
      label: (k) => this.hub.label(k),
    });
    this.hub.onSuspect = (k, why) => { void this.taxWatch.suspect(k, why); };
    this.hub.onSafetyStale = (k, r) => {
      this.activity.emitEvent({ type: 'alert', kind: 'system', level: 'warn', notify: false, pair: k, chainId: this.hub.def(k).chainId,
        msg: `${this.hub.label(k)}: safety report is STALE (${r.stale!.why}). Showing the last known report from ${new Date(r.at).toISOString()}; bots keep running, live starts use it until a re-check measures again.` });
      this.activity.emit('status');
    };
    this.hub.onSafetyFresh = (k, r) => {
      this.activity.emitEvent({ type: 'info', kind: 'system', level: 'info', pair: k, chainId: this.hub.def(k).chainId, msg: `${this.hub.label(k)}: safety re-checked again — ${r.risk}${r.liveAllowed ? '' : ', live trading blocked'}` });
      this.activity.emit('status');
    };
    this.resumeClosing();
    this.bootSafety = this.checkAtBoot();
  }

  /**
   * Live bots restored as running (state.json) on a market with a safety report are held until a fresh check of their
   * market answers, like a Resume. Held grid and trend bots keep ticking for exits only: stop-loss, take-profit, exit
   * signals and grid sells of what is held still fire and execute; no entry, grid buy, follow-the-price reseed or payout.
   * A held liquidity bot (no stop / take-profit exits) only settles a tx already sent; no open, re-range or send.
   * - passes → released to normal ticking;
   * - completes and fails → an exit already queued or in flight settles, nothing new fires, then the bot is stopped
   *   (safety pause) with the reasons; never resumed. Liquidity bots stop at once (a sent tx still settles);
   * - can't complete (3 tries, at most bootCheckMs in all) → released on the last passing report, which is marked stale,
   *   with a warning and an audit record on the bot (kind 'boot'); no passing report → stopped.
   * Closing bots are not held (they only unwind). A tx already sent before the restart always settles.
   */
  readonly bootSafety: Promise<void>;
  private readonly held = new Set<string>();
  private isHeld(id: string) { return this.held.has(id); }

  private async checkAtBoot(): Promise<void> {
    type Bot = {
      id: string; state: { mode: string; status: string; closing?: boolean; archivedAt?: number | null };
      hold: () => void; release: () => void; failStop: (why: Halt) => void; setStartOverride: (o: StartOverride) => void;
    };
    const byKey = new Map<string, { bot: Bot; persist: () => void; label: string }[]>();
    const add = (key: string, bot: Bot, persist: () => void, label: string) => {
      const s = bot.state;
      if (s.mode !== 'live' || s.status !== 'running' || s.closing || s.archivedAt) return;
      if (!this.hub.has(key) || !this.hub.def(key).safety) return;
      const k = unflipKey(key);
      byKey.set(k, [...(byKey.get(k) ?? []), { bot, persist, label }]);
      this.held.add(bot.id);
      bot.hold();
    };
    const exitsOnly = (e: GridEngine | TrendEngine) => ({
      id: e.state.id, state: e.state, hold: () => e.holdForSafety(), release: () => e.releaseSafetyHold(),
      failStop: (h: Halt) => e.settleThenStop(h), setStartOverride: (o: StartOverride) => e.setStartOverride(o),
    });
    for (const e of this.engines.values()) add(e.state.stable, exitsOnly(e), () => this.persist(), `Grid ${this.hub.label(e.state.stable)}`);
    for (const e of this.trendEngines.values()) add(e.state.quote, exitsOnly(e), () => this.persist(), e.state.name || this.hub.label(e.state.quote));
    // Liquidity: no stop / take-profit exits; held = not ticked except to settle a tx already sent (tickAll).
    for (const e of this.lpEngines.values()) add(e.state.market, { id: e.state.id, state: e.state, hold: () => undefined, release: () => undefined, failStop: (h) => e.stop(h), setStartOverride: (o) => e.setStartOverride(o) }, () => this.persist(), `Liquidity ${this.hub.label(e.state.market)}`);
    if (!byKey.size) return;
    await Promise.all([...byKey].map(async ([key, bots]) => {
      const label = this.hub.label(key), chainId = this.hub.def(key).chainId;
      const say = (level: 'info' | 'warn' | 'error', msg: string, notify: boolean, data?: Record<string, unknown>) =>
        this.activity.emitEvent({ type: level === 'info' ? 'info' : 'alert', kind: 'system', level, notify, pair: key, chainId, msg, data });
      try {
        let info: StartAnywayInfo | null = null;
        try {
          info = (await this.hub.liveCheck(key, { startAnyway: true, deadlineMs: this.d.bootCheckMs ?? BOOT_CHECK_MS })).override;
        } catch (e) {
          // Completed and failed, or couldn't complete with no passing report to fall back on: never resumed.
          const why = e instanceof SafetyBlocked || e instanceof SafetyIncomplete ? e.message : `safety check error: ${(e as Error).message}`;
          const halt = systemHalt('safety-pause', `safety check after restart: ${why}`.slice(0, 300), this.now());
          for (const b of bots) b.bot.failStop(halt);
          say('error', `${label}: safety check after restart — ${why}. ${bots.length} live bot(s) stopped (an exit already triggered settles first); review, then resume.`, true);
          return;
        }
        for (const b of bots) b.bot.release();
        if (!info) { say('info', `${label}: safety re-checked after restart — passes; ${bots.length} live bot(s) carry on`, false); return; }
        for (const b of bots) {
          const audit = startOverride(info, this.now(), 'boot');
          b.bot.setStartOverride(audit);
          say('warn', `${b.label}: safety check after restart couldn't complete (${info.blockedBy}); kept running on the last passing report from ${new Date(info.lastKnownAt).toISOString()} (now stale)`, true, { botId: b.bot.id, startOverride: audit });
        }
      } finally {
        for (const b of bots) this.held.delete(b.bot.id);
        this.activity.emit('status');
      }
    }));
  }

  /**
   * A LIVE resume runs the same fresh check as a start (3 tries). Completed and failing → refused with the reasons
   * (SafetyBlocked). Couldn't complete → resumes on the last passing report (stale), audited as kind 'resume', with a
   * warning; no Start anyway needed, the bot was already vetted and running. No passing report → refused.
   * Returns undefined for paper / a running bot / a market without a safety report (resume as before).
   */
  private needsResumeCheck(mode: string, status: string, key: string) {
    return mode === 'live' && status !== 'running' && this.hub.has(key) && !!this.hub.def(key).safety;
  }
  /**
   * The fresh check for a LIVE resume, then `go` (the engine's resume) — unless a stop landed while the check ran.
   * The bot is still `stopped` during the check, so Stop all / STOP chain / Stop (this bot) can't reach it through the
   * engine; the start guard (Stop all / STOP chain, same as add()) and this bot's stop epoch are read again right
   * before `go`. A stop that landed wins: the bot stays stopped, the cancelled resume is recorded (activity + log), and
   * the caller gets ResumeCancelled.
   */
  private async resumeSafety(id: string, key: string, label: string, go: (o: StartOverride | null) => void): Promise<void> {
    const guard = this.startGuard(() => this.hub.def(key).chainId);
    const epoch = this.botStops.get(id)?.seq ?? 0;
    const info = (await this.hub.liveCheck(key, { startAnyway: true })).override;
    const mine = this.botStops.get(id);
    const halt = guard() ?? (mine && mine.seq !== epoch ? mine.halt : null);
    if (halt) {
      const msg = `${label}: resume cancelled — ${halt.what === 'stop-all' ? 'Stop all' : halt.what === 'chain-stop' ? 'STOP chain' : 'Stop'} was pressed while the safety check ran; the bot stays stopped`;
      this.d.log.warn(msg);
      this.activity.emitEvent({ type: 'alert', kind: 'system', level: 'warn', notify: true, pair: key, chainId: this.hub.def(key).chainId, botId: id, msg, data: { halt, resumeCancelled: true } });
      throw new ResumeCancelled(msg);
    }
    if (!info) { go(null); return; }
    const audit = startOverride(info, this.now(), 'resume');
    go(audit);
    this.activity.emitEvent({ type: 'alert', kind: 'system', level: 'warn', notify: true, pair: key, chainId: this.hub.def(key).chainId, botId: id,
      msg: `${label}: resumed on the last passing safety report from ${new Date(info.lastKnownAt).toISOString()} (now stale) — the fresh check couldn't complete (${info.blockedBy})`, data: { startOverride: audit } });
  }
  /** Per-bot Stop presses (stop / stopTrend / stopLp / stopById), so a resume waiting on its safety check can see one landed. */
  private botStops = new Map<string, { seq: number; halt: Halt }>();
  private noteBotStop(id: string, halt: Halt) {
    this.botStops.set(id, { seq: (this.botStops.get(id)?.seq ?? 0) + 1, halt });
  }

  /** On-chain unwinds started by Close. They run beside the poll loop and don't wait for each other. */
  private unwinds: Promise<void>[] = [];
  /** Closes that arrived while a poll was already walking the bots. Run after that poll, still not one-by-one in the handler. */
  private pendingUnwind: (() => Promise<void>)[] = [];

  private trackUnwind(p: Promise<void>) {
    this.unwinds.push(p);
    void p.finally(() => { this.unwinds = this.unwinds.filter((x) => x !== p); });
  }

  /** Start one bot's unwind. Same-chain sends still take turns in that chain's TxGate. */
  kick(fn: () => Promise<void>) {
    if (this.ticking) { this.pendingUnwind.push(fn); return; }
    this.trackUnwind(fn().then(() => undefined, () => undefined));
  }

  /** Resolves when unwinds started so far have finished. Tests use this; the HTTP handler does not. */
  whenSettled(): Promise<void> {
    return Promise.all(this.unwinds).then(() => undefined);
  }

  /**
   * A live bot saved as `closing` (restart mid-unwind) starts that unwind now, not on the next poll.
   * Paper is never left closing: it finishes from memory with no chain calls.
   */
  private resumeClosing() {
    for (const e of this.engines.values()) {
      if (e.state.archivedAt) continue;
      if (e.state.mode !== 'live') { if (e.state.closing) e.requestClose(); continue; }
      if (e.state.closing) this.kick(() => e.tick());
    }
    for (const e of this.trendEngines.values()) {
      if (e.state.archivedAt) continue;
      if (e.state.mode !== 'live') { if (e.state.closing) e.requestClose(); continue; }
      if (e.state.closing) this.kick(() => e.tick(this.spots[e.state.quote]));
    }
    for (const e of this.lpEngines.values()) {
      if (e.state.archivedAt) continue;
      if (e.state.mode !== 'live') { if (e.state.closing) e.close(); continue; }
      if (e.state.closing) this.kick(() => e.tick());
    }
  }

  /** Markets with a safety report (custom tokens, verified built-ins) that have a running or in-flight bot — the tax watcher only re-checks these. */
  private watchedSafetyKeys(): string[] {
    const keys = new Set<string>();
    // Safety lives on the original market; a flipped bot (custom~) is watched through it.
    for (const e of this.engines.values()) if (e.def?.safety && (e.state.status === 'running' || e.state.inFlight)) keys.add(unflipKey(e.state.stable));
    for (const e of this.trendEngines.values()) if (e.def?.safety && (e.state.status === 'running' || e.state.inFlight)) keys.add(unflipKey(e.state.quote));
    return [...keys];
  }

  /** Pause every running bot on a market (tax rise / honeypot / paused). Returns how many were running. */
  pauseMarket(key: string, why: string): number {
    let n = 0;
    const halt = systemHalt('safety-pause', why, this.now());
    const k0 = unflipKey(key); // both orientations share the token and its tax
    for (const e of this.engines.values()) if (unflipKey(e.state.stable) === k0 && e.state.status === 'running') { e.stop(halt); n++; }
    for (const e of this.trendEngines.values()) if (unflipKey(e.state.quote) === k0 && e.state.status === 'running') { e.stop(halt); n++; }
    return n;
  }

  /** Last spot per market key (quote per base, sell-side) — shared with the hub's USD oracle */
  get spots(): Record<string, number> { return this.hub.spots; }
  /** TxGate of the legacy chain (status compatibility) */
  get gate(): TxGate { return this.hub.rt(this.hub.legacyChainId).gate; }
  get hasSigner() { return this.hub.runtimes().some((r) => !!r.signer); }
  private now() { return (this.d.now ?? Date.now)(); }
  private persist() { this.d.store.save(this.multi); }
  /** Write state.json now if a debounced write is pending (shutdown). */
  flush() { this.d.store.flush?.(); }

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

  private attachLp(id: string): LpEngine {
    let eng = this.lpEngines.get(id);
    if (eng) return eng;
    eng = new LpEngine({
      net: this.d.net, store: new SliceStore(() => this.multi.lps, () => this.persist(), id), log: this.d.log, hub: this.hub,
      emit: (e) => this.activity.emitEvent(e), approval: this.d.approval, receiptTimeoutMs: this.d.receiptTimeoutMs, now: this.d.now, id,
      candles: (market) => this.candles.get(market, '1h'),
    });
    this.lpEngines.set(id, eng);
    return eng;
  }
  private lp(id: string): LpEngine {
    if (!this.multi.lps.some((g) => g.id === id)) throw new Error(`Unknown liquidity bot ${id}`);
    return this.lpEngines.get(id) ?? this.attachLp(id);
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
    p = upgradeConfigNames(p); // `totalCapitalUsd` (old name, same quote-coin amount) still accepted
    const guard = this.startGuard(() => this.hub.def(p.stable ?? this.d.net.defaultQuote).chainId);
    if (p.mode === 'live') await this.assertCovers(p.stable ?? this.d.net.defaultQuote, p.totalCapitalQuote, p.limits);
    const slot = freshState(this.d.net);
    slot.limits = { ...this.multi.defaults, ...(p.limits ?? {}) };
    this.multi.grids.push(slot);
    this.persist();
    const eng = this.attach(slot.id);
    try { await eng.start({ ...p, limits: slot.limits, guard: p.guard ?? guard }); } catch (e) { this.remove(slot.id); throw e; }
    return slot.id;
  }
  async start(id: string, p: StartParams) {
    p = upgradeConfigNames(p);
    const eng = this.engine(id);
    const guard = p.guard ?? this.startGuard(() => this.hub.def(p.stable ?? eng.state.stable).chainId);
    p = { ...p, guard };
    // A running grid is refused by eng.start; checking coverage first would report a misleading shortfall.
    if (p.mode === 'live' && eng.state.status !== 'running') await this.assertCovers(p.stable ?? eng.state.stable, p.totalCapitalQuote, p.limits);
    await eng.start(p);
  }
  /** Paper, or no safety report: resumes at once (as before). LIVE on a market with a report: fresh check first. */
  resume(id: string): Promise<void> {
    const e = this.engine(id);
    if (!this.needsResumeCheck(e.state.mode, e.state.status, e.state.stable)) { e.resume(); return Promise.resolve(); }
    return this.resumeSafety(id, e.state.stable, `Grid ${this.hub.label(e.state.stable)}`, (o) => e.resume(o));
  }
  stop(id: string, why?: Halt) {
    const halt = why ?? requestHalt('bot-stop', 'POST /api/bot/grids/:id/stop', this.now());
    this.engine(id).stop(halt);
    this.noteBotStop(id, halt);
  }
  setLimits(id: string, l: Partial<SafetyLimits>) { this.engine(id).setLimits(l); }
  setRecenter(id: string, enabled: boolean) { this.engine(id).setRecenter(enabled); }
  setProfits(id: string, p: ProfitMode) { return this.engine(id).setProfits(p); }
  /** End a grid. Paper leaves the list immediately; a live grid that holds coins is marked closing and sold. */
  closeGrid(id: string, why?: Halt) {
    const e = this.engine(id);
    const live = e.requestClose(why ?? requestHalt('close', 'POST /api/bot/grids/:id/close', this.now()));
    if (live) this.kick(() => e.tick());
    this.activity.emit('status');
    return { ok: true, closing: !!e.state.closing, archived: e.state.archivedAt != null };
  }

  /**
   * End every bot that is still on the active list. Paper work finishes in this call.
   * Live unwinds are started together; each chain's TxGate still sends one transaction at a time.
   */
  closeAll(chainId?: number) {
    let closed = 0, closing = 0;
    const halt = requestHalt('close-all', chainId == null ? 'POST /api/bot/close-all' : `POST /api/bot/close-all chain ${chainId}`, this.now());
    const on = (cid: number) => chainId == null || cid === chainId;
    for (const e of this.engines.values()) {
      if (!on(e.chainId) || e.state.archivedAt) continue;
      if (e.requestClose(halt)) { closing++; this.kick(() => e.tick()); }
      else if (e.state.archivedAt) closed++;
    }
    for (const e of this.trendEngines.values()) {
      if (!on(e.chainId) || e.state.archivedAt) continue;
      if (e.requestClose(halt)) { closing++; this.kick(() => e.tick(this.spots[e.state.quote])); }
      else if (e.state.archivedAt) closed++;
    }
    for (const e of this.lpEngines.values()) {
      if (!on(e.chainId) || e.state.archivedAt) continue;
      if (e.close(halt)) { closing++; this.kick(() => e.tick()); }
      else if (e.state.archivedAt) closed++;
    }
    this.activity.emit('status');
    return { ok: true, closed, closing };
  }

  /**
   * Hide stopped bots from the active list. Does not sell and does not delete history.
   * A live trend or liquidity bot that still holds a position stays until Close unwinds it.
   * A stopped live grid can be hidden: the coins it bought are already in the wallet.
   */
  archiveClosed(chainId?: number) {
    let n = 0;
    const on = (cid: number) => chainId == null || cid === chainId;
    for (const e of this.engines.values()) {
      if (!on(e.chainId) || e.state.archivedAt || e.state.status === 'running' || e.state.closing) continue;
      if (e.state.mode !== 'live') e.requestClose();
      else e.archiveIfSettled();
      if (e.state.archivedAt) n++;
    }
    for (const e of this.trendEngines.values()) {
      if (!on(e.chainId) || e.state.archivedAt || e.state.status === 'running' || e.state.closing) continue;
      if (e.state.mode !== 'live') e.requestClose();
      else e.archiveIfSettled();
      if (e.state.archivedAt) n++;
    }
    for (const e of this.lpEngines.values()) {
      if (!on(e.chainId) || e.state.archivedAt || e.state.status === 'running' || e.state.closing) continue;
      if (e.state.mode !== 'live') e.close();
      else e.archiveIfSettled();
      if (e.state.archivedAt) n++;
    }
    if (n) this.activity.emit('status');
    return { ok: true, archived: n };
  }

  remove(id: string) {
    const eng = this.engines.get(id);
    if (eng && eng.state.status === 'running') eng.stop(systemHalt('remove', 'Removed', this.now()));
    if (eng?.state.inFlight) throw new Error('Cannot remove a grid with a tx in flight — wait for reconcile or STOP and wait.');
    this.engines.delete(id);
    this.multi.grids = this.multi.grids.filter((g) => g.id !== id);
    this.persist();
    this.d.log.info(`[${id}] removed`);
  }

  // ── Trend bots ─────────────────────────────────────────────────────────
  async addTrend(p: TrendStartParams): Promise<string> {
    const guard = p.guard ?? this.startGuard(() => this.hub.def(p.quote).chainId);
    if (p.mode === 'live') await this.assertCovers(p.quote, p.capital, p.limits);
    const slot = freshTrend(this.d.net);
    slot.limits = { ...this.multi.defaults, ...(p.limits ?? {}) };
    this.multi.trends.push(slot);
    this.persist();
    const eng = this.attachTrend(slot.id);
    try { await eng.start({ ...p, limits: slot.limits, guard }); } catch (e) { this.removeTrend(slot.id, true); throw e; }
    return slot.id;
  }
  /** Paper, or no safety report: resumes at once (as before). LIVE on a market with a report: fresh check first. */
  resumeTrend(id: string): Promise<void> {
    const e = this.trend(id);
    if (!this.needsResumeCheck(e.state.mode, e.state.status, e.state.quote)) { e.resume(); return Promise.resolve(); }
    return this.resumeSafety(id, e.state.quote, e.state.name || this.hub.label(e.state.quote), (o) => e.resume(o));
  }
  stopTrend(id: string, why?: Halt) {
    const halt = why ?? requestHalt('bot-stop', 'POST /api/bot/trends/:id/stop', this.now());
    this.trend(id).stop(halt);
    this.noteBotStop(id, halt);
  }
  /** Sell the open trend position and keep watching for the next signal. */
  sellTrend(id: string) {
    const e = this.trend(id);
    e.closePosition();
    this.kick(() => e.tick(this.spots[e.state.quote]));
    return { ok: true };
  }
  /** End the trend bot. Paper settles immediately; live sells through the normal cap and slippage. */
  closeTrend(id: string, why?: Halt) {
    const e = this.trend(id);
    const live = e.requestClose(why ?? requestHalt('close', 'POST /api/bot/trends/:id/close', this.now()));
    if (live) this.kick(() => e.tick(this.spots[e.state.quote]));
    this.activity.emit('status');
    return { ok: true, closing: !!e.state.closing, archived: e.state.archivedAt != null };
  }
  setTrendLimits(id: string, l: Partial<SafetyLimits>) { this.trend(id).setLimits(l); }
  setTrendLines(id: string, lines: DrawnLine[]) { this.trend(id).setLines(lines); }
  removeTrend(id: string, force = false) {
    const eng = this.trendEngines.get(id);
    if (eng && eng.state.status === 'running') eng.stop(systemHalt('remove', 'Removed', this.now()));
    if (eng?.state.inFlight) throw new Error('Cannot remove a bot with a tx in flight.');
    if (eng?.state.position && eng.state.mode === 'live' && !force) throw new Error('Live bot still holds a position — close it first (resume → Close position).');
    this.trendEngines.delete(id);
    this.multi.trends = this.multi.trends.filter((g) => g.id !== id);
    this.persist();
    this.d.log.info(`[${id}] removed`);
  }

  // ── Liquidity-position bots ─────────────────────────────────────────────
  async addLp(p: LpStartParams): Promise<string> {
    const guard = p.guard ?? this.startGuard(() => this.hub.def(p.market).chainId);
    if (p.mode === 'live') {
      await this.assertCovers(p.market, p.capital, p.limits);
      if (p.baseAmount) this.assertHolds(p.market, p.baseAmount);
    }
    const slot = freshLp(this.d.net);
    this.multi.lps.push(slot);
    this.persist();
    const eng = this.attachLp(slot.id);
    try { await eng.start({ ...p, guard }); } catch (e) { this.removeLp(slot.id, true); throw e; }
    return slot.id;
  }
  stopLp(id: string, why?: Halt) {
    const halt = why ?? requestHalt('bot-stop', 'POST /api/bot/lps/:id/stop', this.now());
    this.lp(id).stop(halt);
    this.noteBotStop(id, halt);
  }
  /** Paper, or no safety report: resumes at once (as before). LIVE on a market with a report: fresh check first. */
  resumeLp(id: string): Promise<void> {
    const e = this.lp(id);
    if (!this.needsResumeCheck(e.state.mode, e.state.status, e.state.market)) { e.resume(); return Promise.resolve(); }
    return this.resumeSafety(id, e.state.market, `Liquidity ${this.hub.label(e.state.market)}`, (o) => e.resume(o));
  }
  closeLp(id: string, why?: Halt) {
    const e = this.lp(id);
    const live = e.close(why ?? requestHalt('close', 'POST /api/bot/lps/:id/close', this.now()));
    if (live) this.kick(() => e.tick());
    this.activity.emit('status');
    return { ok: true, closing: !!e.state.closing, archived: e.state.archivedAt != null };
  }
  setLpRerange(id: string, enabled: boolean) { this.lp(id).setRerange(enabled); }
  setLpPolicy(id: string, p: { range?: Partial<LpRangePolicy>; compound?: Partial<LpCompoundPolicy>; bandPct?: number }) { this.lp(id).setPolicy(p); }
  compoundLp(id: string) { return this.lp(id).compoundNow(); }
  /** Move a liquidity bot's range to the price now, at a new width or the same one; it starts on the next tick. */
  moveLp(id: string, bandPct?: number) { return this.lp(id).move(bandPct); }
  setLpProfits(id: string, p: ProfitMode) { return this.lp(id).setProfits(p); }
  /** Only a closed bot (or one that never opened) can be removed: a live position must be closed first. */
  removeLp(id: string, force = false) {
    const eng = this.lpEngines.get(id);
    if (!force && eng && (eng.state.position || eng.state.step)) throw new Error('Close the position first: it still holds coins.');
    this.lpEngines.delete(id);
    this.multi.lps = this.multi.lps.filter((g) => g.id !== id);
    this.persist();
  }

  // ── For the smart trader (autopilot.ts) ─────────────────────────────
  /** The default safety limits (price-impact cap, slippage, deadline) */
  get limits(): SafetyLimits { return { ...this.multi.defaults }; }
  hasBot(kind: 'grid' | 'lp', id: string): boolean {
    return kind === 'grid' ? this.multi.grids.some((g) => g.id === id) : this.multi.lps.some((g) => g.id === id);
  }
  /**
   * What a bot is worth in its spend coin, gas counted: a grid's capital + realized + unrealized (at its last price), a
   * liquidity bot's equity (coins at today's price + fees sent − gas). null until it has a reading.
   */
  botValue(kind: 'grid' | 'lp', id: string): number | null {
    if (kind === 'grid') {
      const e = this.engine(id), s = e.state, c = s.config;
      if (!c || s.lastPrice == null) return null;
      const t = totals(e.modeTrades(), s.lastPrice);
      return c.totalCapitalQuote + t.realized + t.unrealized - sentProfit(s);
    }
    const e = this.lp(id), s = e.state;
    // A closed one holds only its idle coins (and is never read again, so after a restart it has no reading)
    if (s.status === 'closed') return s.lastPrice == null ? null : s.idle.quote + s.idle.base * s.lastPrice - s.totals.gas;
    const p = e.pnl();
    return p ? p.equity - s.totals.sent : null;
  }
  /** The close finished: the bot is off the active list (paper immediately, live after the unwind), or a liquidity bot an older version closed. */
  botCashedOut(kind: 'grid' | 'lp', id: string): boolean {
    if (kind === 'grid') return this.engine(id).state.archivedAt != null;
    const s = this.lp(id).state;
    return s.archivedAt != null || s.status === 'closed';
  }
  /** running / stopped (by hand, KILL ALL, a safety pause) / closed …, and whether a close is under way */
  botStatus(kind: 'grid' | 'lp', id: string): { status: string; closing: boolean } {
    if (kind === 'grid') { const s = this.engine(id).state; return { status: s.status, closing: !!s.closing }; }
    const s = this.lp(id).state;
    return { status: s.status, closing: !!s.closing || s.step?.action === 'close' };
  }
  /**
   * What a bot off the active list holds: its base coin, and its spend coin = its value (as botValue, gas counted) less
   * that base coin at its last price. null until it has a reading.
   */
  botCoins(kind: 'grid' | 'lp', id: string): { base: number; quote: number } | null {
    const v = this.botValue(kind, id);
    if (v == null) return null;
    if (kind === 'grid') {
      const e = this.engine(id), price = e.state.lastPrice!;
      const base = totals(e.modeTrades(), price).pos.plsHeld;
      return { base, quote: v - base * price };
    }
    const s = this.lp(id).state;
    if (s.position) throw new Error(`liquidity bot ${id} still has its position open`);
    return { base: s.idle.base, quote: v - s.idle.base * s.lastPrice! };
  }

  /** Mark a start: the guard it gets says which Stop all / STOP chain (for its chain) landed while it was starting. */
  private startGuard(chainOf: () => number): () => Halt | null {
    const mark = this.stopSeq;
    return () => {
      let chainId: number | null = null;
      try { chainId = chainOf(); } catch { /* unknown market: only Stop all applies */ }
      for (const s of this.stopLog) if (s.seq > mark && (s.chainId == null || s.chainId === chainId)) return s.halt;
      return null;
    };
  }
  private noteStop(chainId: number | null, halt: Halt) {
    this.stopLog.push({ seq: ++this.stopSeq, chainId, halt });
    if (this.stopLog.length > 50) this.stopLog.shift();
    for (const h of this.stopHooks) {
      try { h(chainId, halt); } catch (e) { this.d.log.error(`stop hook: ${(e as Error).message}`); }
    }
  }

  /** KILL ALL: stop every grid and trend bot; queued jobs dropped, nothing new is sent. */
  stopAll(why?: Halt) {
    const halt = why ?? requestHalt('stop-all', 'POST /api/bot/stop-all', this.now());
    let n = 0;
    for (const e of this.engines.values()) if (e.state.status === 'running') { e.stop(halt); n++; }
    for (const e of this.trendEngines.values()) if (e.state.status === 'running') { e.stop(halt); n++; }
    for (const e of this.lpEngines.values()) if (e.state.status === 'running') { e.stop(halt); n++; }
    this.d.log.warn(`KILL ALL — ${n} bot(s) stopped (grids, trend and liquidity bots).`);
    this.activity.emitEvent({ type: 'stopped', kind: 'system', level: 'error', notify: true, msg: `KILL ALL — ${n} bot(s) stopped`, data: { halt } });
    this.noteStop(null, halt);
    // ROUTER HOOK: Stop all turns the capital router off. STOP chain does not.
    // A save error inside the router must not fail the stop; the bots are already stopped.
    try { this.routerHalt?.(halt); }
    catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/gi, '[rpc]').slice(0, 180);
      this.d.log.error(`router halt failed: ${msg}`);
    }
  }

  /** Stop one bot by id, whatever its kind (POST /api/bot/stop { id }). */
  stopById(id: string): 'grid' | 'trend' | 'lp' {
    const halt = requestHalt('bot-stop', 'POST /api/bot/stop', this.now());
    if (this.multi.grids.some((g) => g.id === id)) { this.stop(id, halt); return 'grid'; }
    if (this.multi.trends.some((g) => g.id === id)) { this.stopTrend(id, halt); return 'trend'; }
    if (this.multi.lps.some((g) => g.id === id)) { this.stopLp(id, halt); return 'lp'; }
    throw new Error(`Unknown bot ${id}`);
  }

  /** Stop every bot on one chain (other chains keep running). */
  stopChain(chainId: number) {
    const c = this.hub.chain(chainId);
    const halt = requestHalt('chain-stop', `POST /api/chains/${c.id}/stop`, this.now());
    let n = 0;
    for (const e of this.engines.values()) if (e.chainId === c.id && e.state.status === 'running') { e.stop(halt); n++; }
    for (const e of this.trendEngines.values()) if (e.chainId === c.id && e.state.status === 'running') { e.stop(halt); n++; }
    for (const e of this.lpEngines.values()) if (e.chainId === c.id && e.state.status === 'running') { e.stop(halt); n++; }
    this.d.log.warn(`STOP ${c.name} — ${n} bot(s) stopped.`);
    this.activity.emitEvent({ type: 'stopped', kind: 'system', level: 'warn', notify: true, chainId: c.id, msg: `STOP ${c.name} — ${n} bot(s) stopped`, data: { halt } });
    this.noteStop(c.id, halt);
    return n;
  }

  // ── Wallet coverage ────────────────────────────────────────────────────
  /** Funds each LIVE bot relies on, per token, vs wallet balances. */
  /** Token label: plain symbol on the legacy chain ('PLS', 'DAI'), 'HOOD ETH' elsewhere. */
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
    type Kind = 'grid' | 'trend' | 'lp' | 'trader';
    type Row = { token: string; chainId: number; address: string; native: boolean; allocated: number; wallet: number | null; bots: { id: string; kind: Kind; amount: number }[] };
    const rows = new Map<string, Row>();
    const addCoin = (chainId: number, tk: Holding['token'], id: string, kind: Kind, amount: number) => {
      if (!(amount > 1e-12)) return;
      const token = this.tokLabel(chainId, tk.symbol);
      const r = rows.get(token) ?? { token, chainId, address: tk.address, native: !!tk.native, allocated: 0, wallet: null, bots: [] };
      r.allocated += amount; r.bots.push({ id, kind, amount });
      rows.set(token, r);
    };
    const add = (d: MarketDef, side: 'base' | 'quote', id: string, kind: Kind, amount: number) => addCoin(d.chainId, d[side], id, kind, amount);
    for (const h of this.holdings?.() ?? []) addCoin(h.chainId, h.token, h.id, 'trader', h.amount);
    for (const e of this.engines.values()) {
      const s = e.state, d = e.def;
      if (!d || s.mode !== 'live' || !s.config || (s.status !== 'running' && !s.inFlight)) continue;
      const t = totals(e.modeTrades(), s.lastPrice);
      add(d, 'quote', s.id, 'grid', Math.max(0, s.config.totalCapitalQuote + t.realized - t.pos.costQuote - sentProfit(s)));
      add(d, 'base', s.id, 'grid', t.pos.plsHeld);
    }
    for (const e of this.trendEngines.values()) {
      const s = e.state, d = e.def;
      if (!d || s.mode !== 'live' || (s.status !== 'running' && !s.position)) continue;
      add(d, 'quote', s.id, 'trend', s.cash);
      add(d, 'base', s.id, 'trend', s.position?.pls ?? 0);
    }
    // Liquidity bots: only their idle coins are in the wallet balance (a position's coins sit in the pool).
    for (const e of this.lpEngines.values()) {
      const s = e.state, d = e.def;
      if (!d || s.mode !== 'live' || s.status === 'closed' || s.status === 'idle') continue;
      add(d, 'quote', s.id, 'lp', s.idle.quote);
      add(d, 'base', s.id, 'lp', s.idle.base);
    }
    const out = [...rows.values()].map((r) => {
      const wallet = this.walletAmount(r.chainId, r);
      return { ...r, wallet, ok: wallet == null ? null : wallet + 1e-9 >= r.allocated };
    });
    return { rows: out, ok: out.every((r) => r.ok !== false), note: 'Each chain\'s native coin also needs headroom for gas on every swap.' };
  }

  /**
   * Input of a live swap the router has already been asked to do (grid, trend, or an LP move) and that has not
   * settled. Separate from allocations(), which is the bot's capital rather than this one in-flight transfer.
   */
  routerReservations(): ReservedBalance[] {
    const out: ReservedBalance[] = [];
    const push = (d: MarketDef, side: 'base' | 'quote', amount: number) => {
      if (!(amount > 0)) return;
      const tk = d[side];
      out.push({ chainId: d.chainId, address: tk.address, native: !!tk.native, amount, source: 'in-flight' });
    };
    for (const e of this.engines.values()) {
      const inf = e.state.inFlight, d = e.def;
      if (!inf || !d || e.state.mode !== 'live') continue;
      push(d, inf.job.side === 'buy' ? 'quote' : 'base', inf.job.amount);
    }
    for (const e of this.trendEngines.values()) {
      const inf = e.state.inFlight, d = e.def;
      if (!inf || !d || e.state.mode !== 'live') continue;
      push(d, inf.job.side === 'buy' ? 'quote' : 'base', inf.job.amount);
    }
    for (const e of this.lpEngines.values()) {
      const sw = e.state.step?.swap, d = e.def;
      if (!sw || !d || e.state.mode !== 'live') continue;
      push(d, sw.side === 'buy' ? 'quote' : 'base', sw.amountIn);
    }
    return out;
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
          try { tokens[addr] = { symbol: t.symbol, amount: Number(await rt.tokenBalance(gas.address!, addr)) / 10 ** t.decimals, error: null }; } catch (e) {
            tokens[addr] = { symbol: t.symbol, amount: null, error: (e as Error).message.slice(0, 160) };
          }
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
        if (t?.amount != null) quotes[d.key] = t.amount;
      }
      this.walletBalances = { pls: lw.native, quotes };
    } else if (!this.address) {
      this.address = [...this.wallets.values()][0]?.address ?? null;
    }
  }

  private async assertCovers(key: string, amount: number, limits?: Partial<SafetyLimits>) {
    const d = this.hub.def(key);
    if (!this.hub.rt(d.chainId).signer) return;
    await this.assertCoin(d.chainId, d.quote, amount, limits);
  }
  /**
   * Live: `amount` of a coin is in the wallet on top of what live bots and the smart trader already count; spending the
   * native coin also keeps the gas reserve. Reads the wallet first.
   */
  async assertCoin(chainId: number, token: Holding['token'], amount: number, limits?: Partial<SafetyLimits>) {
    await this.refreshWallet(true);
    const label = this.tokLabel(chainId, token.symbol);
    // A balance that couldn't be read stops a live start: it used to skip this check entirely.
    const w = this.wallets.get(chainId), tok = token.native ? null : w?.tokens[token.address.toLowerCase()];
    const unread = !w ? 'no balance read yet' : w.error ?? (token.native ? null : tok ? tok.error : `${label} isn't tracked in this wallet`);
    if (unread) throw new FundsError(`Couldn't read your ${label} balance (${unread}), so nothing was started. Try again in a minute.`);
    const have = this.walletAmount(chainId, token)!;
    const row = this.allocations().rows.find((r) => r.token === label), cur = row?.allocated ?? 0;
    const f = humanAmount, held = row?.bots.filter((b) => b.kind === 'trader').reduce((a, b) => a + b.amount, 0) ?? 0;
    const trader = held > 0 ? ` (the smart trader counts ${f(held)} ${label} of it)` : '';
    if (token.native) {
      // Spending the native coin (flipped HEX/PLS …): capital + gas reserve + other live bots' native must fit.
      const chk = checkGasReserve({ capital: amount, balance: have, allocated: cur, cfg: reserveCfg({ ...this.multi.defaults, ...(limits ?? {}) }), symbol: label });
      if (!chk.ok) throw new FundsError(chk.reason! + trader);
      return;
    }
    if (have + 1e-9 < cur + amount) {
      throw new FundsError(`Not enough ${label} in your wallet. This needs ${f(cur + amount)} ${label} (${f(amount)} for this bot${cur ? ` + ${f(cur)} already used by your other live bots${trader}` : ''}), and the wallet has ${f(have)} ${label}. Use a smaller amount, or start it in paper mode.`);
    }
  }
  /** Live: the wallet holds all that live bots and the smart trader count of a coin (checked before the trader spends some). */
  async assertBooked(chainId: number, token: Holding['token']) {
    await this.refreshWallet(true);
    const label = this.tokLabel(chainId, token.symbol), w = this.wallets.get(chainId), have = this.walletAmount(chainId, token);
    if (!w || w.error || have == null) throw new FundsError(`Couldn't read your ${label} balance (${w?.error ?? 'no balance read yet'}), so nothing was swapped. Trying again on the next check.`);
    const cur = this.allocations().rows.find((r) => r.token === label)?.allocated ?? 0;
    if (have + 1e-9 < cur) throw new FundsError(`Your wallet has ${humanAmount(have)} ${label}, less than the ${humanAmount(cur)} your live bots and the smart trader count (something else spent some), so nothing was swapped.`);
  }

  /** Base coins a bot is given from the wallet must be there (after what live bots already use). Runs after assertCovers read the wallet. */
  private assertHolds(key: string, amount: number) {
    const d = this.hub.def(key);
    const label = this.tokLabel(d.chainId, d.base.symbol);
    const have = this.walletAmount(d.chainId, d.base);
    if (have == null) throw new Error(`Couldn't read your ${label} balance, so nothing was started. Try again in a minute.`);
    const cur = this.allocations().rows.find((r) => r.token === label)?.allocated ?? 0;
    if (have + 1e-12 < cur + amount) {
      const f = humanAmount;
      throw new Error(`Not enough ${label} in your wallet. This needs ${f(cur + amount)} ${label} (${f(amount)} for this bot${cur ? ` + ${f(cur)} already used by your other live bots` : ''}), and the wallet has ${f(have)} ${label}.`);
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
      const n = this.tickN++;
      let raw: Record<string, number> = {};
      try {
        raw = await this.prices(this.watchedKeys(n % 3 === 0));
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
      // Per chain: the poll's prices and one wallet read per market, until a bot on that chain trades (the pool and
      // the wallet then moved, so the next bot reads its own).
      const traded = new Set<number>();
      const memo = new Map<number, Map<string, Promise<unknown>>>();
      const ctxFor = (cid: number, key: string) => ({
        price: traded.has(cid) ? undefined : raw[key],
        wallet: <T>(k: string, read: () => Promise<T>): Promise<T> => {
          const m = memo.get(cid) ?? new Map<string, Promise<unknown>>();
          memo.set(cid, m);
          let p = m.get(k) as Promise<T> | undefined;
          if (!p) { p = read(); m.set(k, p); p.catch(() => m.delete(k)); }
          return p;
        },
      });
      const last = (t: { trades?: unknown[] }) => t.trades?.[t.trades.length - 1];
      for (const e of this.engines.values()) {
        // A stopped grid has nothing to do. Ticking it used to re-read price and balances for every one, ahead of a close.
        if (e.state.archivedAt) continue;
        if (e.state.status === 'running' || e.state.closing || e.state.inFlight || e.state.payoutInFlight) {
          push(e.chainId, async () => {
            const before = last(e.state);
            await e.tick(ctxFor(e.chainId, e.state.stable));
            if (last(e.state) !== before || e.state.inFlight) { traded.add(e.chainId); memo.delete(e.chainId); }
          });
        }
      }
      for (const e of this.trendEngines.values()) {
        if (e.state.archivedAt) continue;
        if (e.state.status === 'running' || e.state.closing || e.state.inFlight) push(e.chainId, () => e.tick(this.spots[e.state.quote]));
      }
      // A stopped liquidity bot doesn't tick, except to settle a tx already sent. Its position keeps earning, so its
      // value and fees are refreshed every STOPPED_LP_EVERY polls (≈2 min at the default 10 s poll).
      for (const e of this.lpEngines.values()) {
        if (e.state.archivedAt || e.state.status === 'idle' || e.state.status === 'closed') continue;
        const sent = !!(e.state.step?.hash || e.state.step?.swap);
        if (this.isHeld(e.state.id) && !sent) continue; // boot safety check pending (grid / trend tick exits-only instead)
        if (e.state.status === 'running' || e.state.closing || sent || (e.state.status === 'stopped' && n % STOPPED_LP_EVERY === 0)) push(e.chainId, () => e.tick());
      }
      await Promise.all([...byChain.values()].map(async (jobs) => { for (const j of jobs) await j(); }));
      this.checkRanges();
      this.evaluateAlerts();
      this.checkRpcHealth();
      try { await this.taxWatch.tick(); } catch { /* never abort the poll loop */ }
      this.snapshotPortfolio();
      this.activity.emit('status');
    } finally {
      this.ticking = false;
      const pending = this.pendingUnwind.splice(0);
      if (pending.length) {
        await Promise.all(pending.map((fn) => {
          const p = fn().then(() => undefined, () => undefined);
          this.trackUnwind(p);
          return p;
        }));
      }
    }
  }

  /** Markets a bot or alert uses, in their original orientation (flipped series derive from it): the candle sync keeps every timeframe of these. */
  activeCandleKeys(): Set<string> {
    const s = new Set<string>();
    for (const g of this.multi.grids) if (!g.archivedAt) s.add(unflipKey(g.stable));
    for (const t of this.multi.trends) if (!t.archivedAt) s.add(unflipKey(t.quote));
    for (const t of this.multi.lps) if (!t.archivedAt) s.add(unflipKey(t.market));
    for (const a of this.multi.alerts) s.add(unflipKey(a.pair));
    return s;
  }

  /** Market keys that are priced every poll (legacy + anything a bot or alert uses); `all` adds every tradable market. */
  watchedKeys(all = true): string[] {
    const used = new Set<string>();
    for (const d of this.hub.list()) if (d.legacy) used.add(d.key);
    for (const g of this.multi.grids) if (!g.archivedAt) used.add(g.stable);
    for (const t of this.multi.trends) if (!t.archivedAt) used.add(t.quote);
    for (const t of this.multi.lps) if (!t.archivedAt) used.add(t.market);
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
  /** One mode's bots: analytics never add paper and live together. */
  private botRows(mode: Mode) {
    const rows: {
      id: string; kind: 'grid' | 'trend' | 'lp'; name: string; pair: string; chainId: number; mode: Mode; status: string; usdPerQuote: number | null;
      capital: number; equity: number; realized: number; unrealized: number; fees: number; gas: number;
      plsHeld: number; quoteFree: number; startedAt: number | null; equityHist: [number, number][];
      closed: { pnl: number; t: number; holdMs?: number }[]; trades: LiveTrade[]; inMarket: number;
    }[] = [];
    for (const e of this.engines.values()) {
      const s = e.state;
      if (!s.config || s.mode !== mode) continue;
      const tr = e.modeTrades();
      const t = totals(tr, s.lastPrice);
      const capital = s.config.totalCapitalQuote;
      const eqHist = s.equity ?? [];
      rows.push({
        id: s.id, kind: 'grid', name: `Grid ${e.label}`, pair: s.stable, chainId: e.chainId, mode: s.mode, status: s.archivedAt ? 'closed' : s.status, usdPerQuote: this.usdPerQuote(s.stable),
        capital, equity: capital + t.realized + t.unrealized, realized: t.realized, unrealized: t.unrealized,
        fees: tr.reduce((a, x) => a + (x.feeQuote ?? 0), 0), gas: t.gasQuote,
        plsHeld: t.pos.plsHeld, quoteFree: Math.max(0, capital + t.realized - t.pos.costQuote), startedAt: s.startedAt ?? tr[0]?.timestamp ?? null,
        equityHist: eqHist,
        closed: tr.filter((x) => x.side === 'sell' && !x.failed && x.roundTripNet != null).map((x) => ({ pnl: x.roundTripNet!, t: x.timestamp })),
        trades: tr,
        inMarket: t.pos.plsHeld > 0 ? 1 : 0,
      });
    }
    for (const e of this.trendEngines.values()) {
      const st = e.status();
      if (!st.capital || st.mode !== mode) continue;
      rows.push({
        id: st.id, kind: 'trend', name: st.name, pair: st.quote, chainId: e.chainId, mode: st.mode, status: e.state.archivedAt ? 'closed' : st.status, usdPerQuote: this.usdPerQuote(st.quote),
        capital: st.capital, equity: st.pnl.equity, realized: st.pnl.realized, unrealized: st.pnl.unrealized, fees: st.pnl.fees, gas: st.pnl.gas,
        plsHeld: st.position?.pls ?? 0, quoteFree: st.cash, startedAt: st.startedAt, equityHist: e.state.equity,
        closed: e.modeTrades().filter((x) => x.side === 'sell' && !x.failed).map((x) => ({ pnl: x.realizedPnlQuote, t: x.timestamp, holdMs: (x as TrendTrade).holdMs })),
        trades: e.modeTrades(), inMarket: st.stats.timeInMarket,
      });
    }
    for (const e of this.lpEngines.values()) {
      const s = e.state, pnl = e.pnl(), vw = e.view;
      if (!s.config || !pnl || !vw || s.mode !== mode) continue;
      rows.push({
        id: s.id, kind: 'lp', name: `Liquidity ${e.label}`, pair: s.market, chainId: e.chainId, mode: s.mode, status: s.archivedAt ? 'closed' : s.status, usdPerQuote: this.usdPerQuote(s.market),
        // earned after costs is the LP's "banked" side; the price side moves with the price like unsold coins
        capital: e.startValue()!, equity: pnl.equity, realized: pnl.net, unrealized: pnl.price, fees: 0, gas: pnl.gas,
        plsHeld: vw.coins.base + vw.owed.base + s.idle.base, quoteFree: vw.coins.quote + vw.owed.quote + s.idle.quote, startedAt: s.startedAt, equityHist: s.equity,
        closed: [], trades: [], inMarket: s.position ? 1 : 0,
      });
    }
    return rows;
  }

  private snapshotPortfolio() {
    let changed = false;
    for (const mode of ['live', 'paper'] as const) {
      const p = this.multi.portfolio[mode];
      if (p.length && this.now() - p[p.length - 1][0] < 60_000) continue;
      const rows = this.botRows(mode);
      if (!rows.length) continue;
      const eq = rows.reduce((a, r) => a + (r.usdPerQuote ? r.equity * r.usdPerQuote : 0), 0);
      const re = rows.reduce((a, r) => a + (r.usdPerQuote ? r.realized * r.usdPerQuote : 0), 0);
      const cap = rows.reduce((a, r) => a + (r.usdPerQuote ? r.capital * r.usdPerQuote : 0), 0);
      pushCapped(p, [this.now(), usdFmt(eq), usdFmt(re), usdFmt(cap)], 4000);
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Analytics for one mode: live is real money, paper is simulated; never added together. */
  overview(mode: Mode) {
    const rows = this.botRows(mode);
    const now = this.now();
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const periods = { today: day.getTime(), d7: now - 7 * 86_400_000, all: 0 };
    const usd = (r: (typeof rows)[number], v: number) => (r.usdPerQuote ? v * r.usdPerQuote : 0);
    const realizedSince = (from: number) => rows.reduce((a, r) => a + usd(r, r.trades.filter((t) => t.timestamp >= from).reduce((s, t) => s + t.realizedPnlQuote, 0)), 0);
    // Only snapshots that carry the allocated capital can be compared: PnL = equity − capital, so starting,
    // adding or removing a bot is not counted as a gain or loss.
    const ph = this.multi.portfolio[mode];
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
    // Per-bot return comes from the same metrics as /api/bot/status (src/metrics/botMetrics.ts).
    const stNow = this.status();
    const mOf = new Map([...stNow.grids, ...stNow.trends, ...stNow.lps].map((b) => [b.id, b.metrics] as const));
    const bots = rows.map((r) => {
      const st = tradeStats(r.closed);
      const m = mOf.get(r.id) ?? null;
      return {
        id: r.id, kind: r.kind, name: r.name, pair: r.pair, chainId: r.chainId, mode: r.mode, status: r.status, usdPerQuote: r.usdPerQuote,
        capital: r.capital, equity: r.equity, equityUsd: usd(r, r.equity), capitalUsd: usd(r, r.capital),
        realized: r.realized, unrealized: r.unrealized, realizedUsd: usd(r, r.realized), unrealizedUsd: usd(r, r.unrealized),
        feesUsd: usd(r, r.fees), gasUsd: usd(r, r.gas),
        returnPct: m?.totalPnlPct ?? (r.capital ? r.equity / r.capital - 1 : 0),
        metrics: m,
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
    // Per-chain breakdown (aggregated ≈USD); live also shows each chain's gas wallet (paper spends no real gas).
    const chains = this.hub.runtimes().map((rt) => {
      const bs = bots.filter((b) => b.chainId === rt.cfg.id);
      const w = mode === 'live' ? this.wallets.get(rt.cfg.id) : undefined;
      const native = mode === 'live' ? w?.native ?? rt.gas.native : null;
      const nat = this.hub.nativeUsd(rt.cfg.id);
      return {
        chainId: rt.cfg.id, key: rt.cfg.key, name: rt.cfg.name, short: rt.cfg.short, color: rt.cfg.color, status: rt.cfg.status,
        bots: bs.length, running: bs.filter((b) => b.status === 'running').length,
        equityUsd: bs.reduce((a, b) => a + b.equityUsd, 0), capitalUsd: bs.reduce((a, b) => a + b.capitalUsd, 0),
        realizedUsd: bs.reduce((a, b) => a + b.realizedUsd, 0), unrealizedUsd: bs.reduce((a, b) => a + b.unrealizedUsd, 0),
        gasUsd: bs.reduce((a, b) => a + b.gasUsd, 0),
        gasNative: native, gasNativeUsd: native != null && nat ? native * nat : null,
        lowGas: mode === 'live' && rt.gas.low, nativeSymbol: rt.cfg.nativeSymbol,
      };
    }).filter((c) => c.bots > 0 || c.gasNative != null);
    return {
      t: now, mode,
      totals: { equityUsd: sum('equityUsd'), capitalUsd: sum('capitalUsd'), realizedUsd: sum('realizedUsd'), unrealizedUsd: sum('unrealizedUsd'), feesUsd: sum('feesUsd'), gasUsd: sum('gasUsd') },
      periods: per,
      allocation: [...alloc.values()].filter((x) => x.usd > 0.005).sort((a, b) => b.usd - a.usd),
      chains,
      bots,
      portfolio: curve,
      portfolioDrawdown: drawdown(curve).max,
      notes: ['≈USD: each bot\'s quote token is converted at today\'s rate — stables = $1, other tokens through the chain\'s native/stable market (PulseChain: PLS/DAI); historical equity points use today\'s rate. Bots whose quote has no USD route are excluded.', 'Period change = change in PnL (equity − allocated capital) from portfolio snapshots taken every minute while the server runs, so starting or removing a bot is not counted. "partial" = history starts after the period start.', 'The portfolio curve is drawn at today\'s allocated capital (capital + PnL at each time).'],
    };
  }

  journal(f: { mode: Mode; botId?: string; kind?: string; pair?: string; side?: string; from?: number; to?: number }): JournalRow[] {
    const rows: JournalRow[] = [];
    const push = (botId: string, kind: 'grid' | 'trend', bot: string, t: LiveTrade & { reason?: string }) => {
      const k = this.usdPerQuote(t.stable);
      const pnl = t.side === 'sell' || t.failed ? (t.roundTripNet ?? t.realizedPnlQuote) : null;
      rows.push({
        t: t.timestamp, botId, kind, bot, pair: t.stable, mode: t.paper ? 'paper' : 'live', side: t.side,
        reason: t.reason ?? (t.manual ? 'manual' : t.closeSale ? 'close' : t.levelPrice != null ? `level ${t.levelPrice.toPrecision(5)}` : t.failed ? 'failed' : 'grid'),
        pls: t.plsAmount, quote: t.stableAmount, price: t.price, fee: t.feeQuote ?? 0, gas: t.gasQuote, pnl, pnlUsd: pnl != null && k ? pnl * k : null,
        slippagePct: t.slippagePct ?? null, tx: t.txHash, failed: !!t.failed,
      });
    };
    for (const g of this.multi.grids) for (const t of g.trades) push(g.id, 'grid', `Grid ${this.hub.label(g.stable)}`, t);
    for (const s of this.multi.trends) for (const t of s.trades) push(s.id, 'trend', s.name, t);
    return rows
      .filter((r) => (!f.botId || r.botId === f.botId) && (!f.kind || r.kind === f.kind) && (!f.pair || r.pair === f.pair)
        && (!f.side || r.side === f.side) && r.mode === f.mode && (!f.from || r.t >= f.from) && (!f.to || r.t <= f.to))
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
    const model = costModelOf(m, def.pool.feeBps ?? FEE_BPS, this.d.approval ?? 'exact', o);
    const b = def.base.symbol, q = def.quote.symbol, nat = this.hub.chain(def.chainId).nativeSymbol;
    const note = m
      ? `${this.hub.label(pair)}: LP fee ${(model.feeBps / 100).toFixed(2)}%, impact from CURRENT ${def.pool.kind === 'v3' ? 'active-range (virtual) ' : ''}reserves (${m.quoteReserve.toPrecision(4)} ${q} / ${m.plsReserve.toPrecision(4)} ${b}), gas ${((m.gasPriceNative ?? m.gasPricePls) * 1e9).toPrecision(3)} gwei ${nat}${m.basePerNative && m.basePerNative !== 1 ? ` (×${m.basePerNative.toPrecision(4)} ${b}/${nat})` : ''}${m.extraPlsPerSwap ? ` + L1 data fee ${m.extraPlsPerSwap.toPrecision(3)} ${b}/swap` : ''}${m.buyTaxPct || m.sellTaxPct ? `, token tax buy ${((m.buyTaxPct ?? 0) * 100).toFixed(2)}% / sell ${((m.sellTaxPct ?? 0) * 100).toFixed(2)}%` : ''}.`
      : `Pool snapshot unavailable: LP fee ${(model.feeBps / 100).toFixed(2)}% only; impact and gas excluded.`;
    return { model, note };
  }

  private btSeries(pair: string, tf: TF) {
    return replayCandles(this.candles.get(pair, tf), tf, Math.floor(this.now() / 1000));
  }

  private btCandles(pair: string, tf: TF, from?: number, to?: number) {
    const k = sliceRange(this.btSeries(pair, tf), from, to);
    return { k, meta: this.candles.getMeta(pair, tf), gaps: k.filter((x) => x.f).length, spikes: k.filter((x) => x.s).length };
  }

  /** Backtest capital in the market's spend (quote) coin. */
  private capitalQuote(pair: string, capital?: number) {
    if (!(capital! > 0)) throw new Error(`Enter an amount of ${this.hub.def(pair).quote.symbol} to backtest with.`);
    return capital!;
  }

  private thin(r: BtResult, max = 1500): BtResult {
    if (r.equity.length <= max) return r;
    const step = Math.ceil(r.equity.length / max);
    return { ...r, equity: r.equity.filter((_, i) => i % step === 0 || i === r.equity.length - 1) };
  }

  async backtest(p: { pair: string; tf: string; from?: number; to?: number; capital?: number; cfg?: Partial<TrendConfig>; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const cfg = { ...DEFAULT_TREND, ...(p.cfg ?? {}) };
    const { k, meta, gaps, spikes } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital);
    const { model, note } = await this.costModel(p.pair, p.costs);
    const htf = cfg.htfEnabled ? this.btSeries(p.pair, cfg.htfTf) : undefined;
    const r = runTrendBacktest(k, cfg, p.tf, { capital, costs: model, htf });
    return { ...this.thin(r), pair: p.pair, cfg, capital, usdPerQuote: this.usdPerQuote(p.pair), costs: model, candles: k.length, gaps, spikes, from: k[0]?.t, to: k[k.length - 1]?.t, source: meta?.source ?? null, notes: [...r.notes, note, spikeNote(spikes), gaps ? `${gaps} empty candles gap-filled flat (no trades in those periods).` : ''].filter(Boolean) };
  }

  async backtestGrid(p: { pair: string; tf: string; from?: number; to?: number; lowerPrice: number; upperPrice: number; gridCount: number; capital?: number; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const { k, meta, gaps, spikes } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital);
    const { model, note } = await this.costModel(p.pair, p.costs);
    const r = runGridBacktest(k, { lowerPrice: p.lowerPrice, upperPrice: p.upperPrice, gridCount: p.gridCount, capital }, p.tf, model);
    return { ...this.thin(r), pair: p.pair, capital, usdPerQuote: this.usdPerQuote(p.pair), costs: model, candles: k.length, gaps, spikes, from: k[0]?.t, to: k[k.length - 1]?.t, source: meta?.source ?? null, notes: [...r.notes, note, spikeNote(spikes)].filter(Boolean) };
  }

  async sweep(p: { pair: string; tf: string; from?: number; to?: number; capital?: number; cfg?: Partial<TrendConfig>; xKey?: SweepKey; xs?: number[]; yKey?: SweepKey; ys?: number[]; costs?: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } }) {
    if (!isTF(p.tf)) throw new Error('unknown timeframe');
    const cfg = { ...DEFAULT_TREND, ...(p.cfg ?? {}) };
    const [dx, dy] = SWEEP_AXES[cfg.strategy];
    const xKey = p.xKey ?? dx, yKey = p.yKey ?? dy;
    const defaults: Record<string, number[]> = {
      fast: [5, 8, 10, 13, 20, 30], slow: [20, 30, 40, 50, 80, 100], macdFast: [6, 8, 12, 16], macdSlow: [20, 26, 35, 50],
      donchianEntry: [10, 20, 30, 55], donchianExit: [5, 10, 15, 20], stopAtr: [1, 1.5, 2, 3, 4], tpR: [0, 1, 2, 3, 5], trailAtr: [0, 1.5, 2, 3, 4],
    };
    const { k } = this.btCandles(p.pair, p.tf, p.from, p.to);
    const capital = this.capitalQuote(p.pair, p.capital);
    const { model } = await this.costModel(p.pair, p.costs);
    const htf = cfg.htfEnabled ? this.btSeries(p.pair, cfg.htfTf) : undefined;
    return { ...sweepTrend(k, cfg, p.tf, xKey, p.xs ?? defaults[xKey], yKey, p.ys ?? defaults[yKey], { capital, costs: model, htf }), candles: k.length, pair: p.pair, tf: p.tf };
  }

  // ── Presets / economics (unchanged) ────────────────────────────────────
  listPresets() { return listPresets(); }

  async economics(quote: string, cfg: EconCfg): Promise<EconSummary & { usdPerQuote: number | null; feeBps: number; chainId: number; label: string; entry: { amount: number; why: string | null } }> {
    const def = this.hub.def(quote);
    const { summary } = await gridEconomics(this.hub.quoter(quote), cfg, this.d.approval ?? 'exact');
    this.hub.setSpot(quote, summary.spot);
    try { await this.hub.nativeUsdAsync(def.chainId); } catch { /* optional */ }
    const entry = capGridEntry({ capital: cfg.totalCapitalQuote, quoteReserve: summary.poolQuote, feeBps: def.pool.feeBps, maxImpact: 0.03, gridCount: cfg.gridCount });
    return { ...summary, entry: { amount: entry.amount, why: entry.why }, usdPerQuote: this.hub.usdPerQuote(quote), feeBps: def.pool.feeBps, chainId: def.chainId, label: this.hub.label(quote) };
  }

  private legacyKeys() { return this.hub.list().filter((d) => d.legacy).map((d) => d.key); }

  /** `amounts`: spend-coin amount per leg market key; legs without one get econ null. */
  async previewPreset(id: string, opts: { quote?: string; amounts?: Record<string, number> } = {}) {
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
        if (!b || b.mid == null || (b.kind !== 'v2' && b.kind !== 'v3')) continue;
        const same = b.dex === cur.pool.dex && (b.kind === 'v2' || sameAddr(b.address, cur.pool.address));
        const pool = { dex: b.dex, kind: b.kind, address: b.address, feeBps: b.feeBps, ...(b.feeTier != null ? { feeTier: b.feeTier } : {}) };
        const quoter = same ? this.hub.quoter(key) : this.hub.quoterOnPool(key, pool);
        spots[key] = await quoter.getPrice();
        best[key] = { quoter, pool: { ...pool, dexName: b.dexName, switchTo: !same } };
      } catch { /* discovery failed: current pool */ }
    }
    const resolved = resolvePreset(preset, spots, selected, opts.amounts);
    const legs: (ResolvedLeg & { econ: EconSummary | null; label: string; pool?: PresetPool })[] = [];
    for (const leg of resolved) {
      const b = best[leg.quote];
      const econ = leg.capital == null ? null
        : (await gridEconomics(b?.quoter ?? this.hub.quoter(leg.quote), { ...leg, totalCapitalQuote: leg.capital }, this.d.approval ?? 'exact')).summary;
      legs.push({ ...leg, econ, label: this.hub.label(leg.quote), ...(b ? { pool: b.pool } : {}) });
    }
    return { preset: { id: preset.id, name: preset.name, blurb: preset.blurb }, spots, legs };
  }

  async startPreset(
    id: string,
    opts: { mode: Mode; quote?: string; amounts: Record<string, number>; limits?: Parameters<GridEngine['start']>[0]['limits']; recenter?: boolean; profits?: ProfitMode; startAnyway?: boolean },
  ): Promise<{ ids: string[]; legs: ResolvedLeg[] }> {
    const { legs } = await this.previewPreset(id, opts);
    const missing = legs.filter((l) => l.capital == null).map((l) => l.label);
    if (missing.length) throw new Error(`Enter an amount for ${missing.join(', ')}.`);
    for (const leg of legs) if (leg.pool?.switchTo) await this.setMarketPool(leg.quote, { auto: true });
    const ids: string[] = [];
    try {
      for (const leg of legs) {
        ids.push(await this.add({
          mode: opts.mode, stable: leg.quote, lowerPrice: leg.lowerPrice, upperPrice: leg.upperPrice, gridCount: leg.gridCount,
          totalCapitalQuote: leg.capital!, limits: opts.limits, recenter: opts.recenter, profits: opts.profits, startAnyway: opts.startAnyway,
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
  async addMarket(req: { chainId: number; address: string; quote?: string; pool?: string }) { return this.added(await this.hub.addMarket(req)); }
  private added(d: MarketDef) {
    this.activity.emitEvent({ type: 'info', kind: 'system', level: d.safety?.liveAllowed ? 'success' : 'warn', chainId: d.chainId, pair: d.key,
      msg: `Added ${this.hub.label(d.key)} (${this.hub.dexName(d.chainId, d.pool.dex)} ${d.pool.feeTier != null ? `${d.pool.feeTier / 10000}%` : `${d.pool.feeBps / 100}%`}) — safety ${d.safety?.risk ?? 'unknown'}${d.safety?.liveAllowed ? '' : ' · paper only'}` });
    return d;
  }
  /**
   * Pair search → market key: the market already on this pool, or a new one on exactly this pool once its coin passes
   * the safety check. One that fails it (honeypot, tax over the cap, can't be verified) is not added.
   */
  async addPoolMarket(req: { chainId: number; pool: string; base: string; quote: string }): Promise<string> {
    const r = await this.hub.inspect({ chainId: req.chainId, address: req.base, quote: req.quote, pool: req.pool });
    if (!r.draft) throw new Error(`${r.token.symbol}/${r.quote.symbol}: this pool can't be priced right now`);
    const have = this.hub.marketOnPool(r.chainId, r.draft.pool.dex, r.draft.pool.address, r.draft.base.address, r.draft.quote.address);
    if (have) return have;
    const s = r.safety!;
    if (!s.liveAllowed) throw new Error(`Not added: ${r.token.symbol} failed the safety check (${s.risk} risk). ${s.reasons.join(' ')}`.trim());
    const d = this.added(this.hub.addInspected(r));
    // Priced now, not on the next all-markets poll (~30 s): New bot centres its range on this price right away.
    await this.hub.ensureSpot(d.key);
    return d.key;
  }
  /**
   * Opportunity → market key: the app's market for these two coins (on any pool: one switched to another pool since the
   * scan is still it), or a new one on this pool (safety re-checked; one that fails is paper only).
   */
  async addOpportunityMarket(req: { chainId: number; address: string; quote: string; pool: string }): Promise<string> {
    const key = this.hub.marketForCoins(req.chainId, req.address, req.quote) ?? (await this.addMarket(req)).key;
    // Priced now, not on the next all-markets poll (~30 s): New bot centres the range on this price right away.
    await this.hub.ensureSpot(key);
    return key;
  }
  removeMarket(key: string) {
    key = unflipKey(key);
    const same = (k: string) => unflipKey(k) === key; // either orientation counts as "used"
    const used = this.multi.grids.some((g) => same(g.stable)) || this.multi.trends.some((t) => same(t.quote)) || this.multi.alerts.some((a) => same(a.pair))
      || this.multi.lps.some((l) => same(this.lp(l.id).state.market));
    if (used) throw new Error('Market is used by a bot or alert — remove those first.');
    this.hub.removeMarket(key);
    this.marketCache.delete(key);
    this.marketCache.delete(key + '~');
  }
  /** Pools for a market across every DEX on its chain (PulseChain: PulseX V1, PulseX V2, 9mm V2, 9mm V3). */
  poolOptions(key: string) { return this.hub.poolOptions(key); }
  /**
   * Switch a market's trading pool (manual / auto best-quote / reset). Refused while a tx on that market is in flight,
   * and while a liquidity bot on it holds a position: the position lives in this pool, and the bot reads the market's pool.
   */
  async setMarketPool(key: string, req: { pool?: string; auto?: boolean; reset?: boolean }) {
    key = unflipKey(key);
    const busy = [...this.engines.values()].some((e) => unflipKey(e.state.stable) === key && e.state.inFlight)
      || [...this.trendEngines.values()].some((e) => unflipKey(e.state.quote) === key && e.state.inFlight);
    if (busy) throw new Error('A transaction on this market is in flight — wait for it to settle before switching pools.');
    const lp = [...this.lpEngines.values()].find((e) => unflipKey(e.state.market) === key && (e.state.position || e.state.step));
    if (lp) throw new Error(`A liquidity bot on this pair (${lp.state.id}) has its position in this pool: close it before switching pools.`);
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
    const c = await this.taxWatch.check(key, MANUAL_CHECK);
    // An RPC hiccup on this check warns, marks the market stale and returns the last known report: no pause.
    if (c?.report) return c.report;
    const r = await this.hub.recheck(key);
    this.activity.emitEvent({ type: 'info', kind: 'system', level: r.liveAllowed ? 'info' : 'warn', pair: key, chainId: this.hub.def(key).chainId, msg: `Safety re-check ${this.hub.label(key)}: ${r.risk}${r.liveAllowed ? '' : ' — live trading blocked'}` });
    return r;
  }

  // ── Status ─────────────────────────────────────────────────────────────
  /** Signing wallet per chain: native coin first, then every tracked token the wallet holds (amount > 0). */
  walletView() {
    return this.hub.runtimes().filter((rt) => rt.signer).map((rt) => {
      const w = this.wallets.get(rt.cfg.id);
      const coins = w ? [
        { symbol: rt.cfg.nativeSymbol, address: null as string | null, native: true, amount: w.native },
        ...Object.entries(w.tokens).filter(([, t]) => t.error != null || (t.amount ?? 0) > 0).map(([address, t]) => ({ symbol: t.symbol, address, native: false, amount: t.amount, error: t.error }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      ] : [];
      return { chainId: rt.cfg.id, name: rt.cfg.name, short: rt.cfg.short, address: w?.address ?? rt.gas.address, at: w?.at ?? null, error: w?.error ?? rt.gas.error ?? null, coins };
    });
  }

  /**
   * Per-chain RPC health: one Activity entry (with a notification) when a chain's RPCs have kept failing for
   * rpcAlertAfterMs, and one when it recovers. The banner reads rpcHealth.alerted from the status.
   */
  checkRpcHealth() {
    for (const rt of this.hub.runtimes()) {
      const ch = rt.reader.checkHealth?.(this.d.rpcAlertAfterMs);
      if (!ch) continue;
      const c = rt.cfg;
      if (ch.kind === 'alert') {
        this.activity.emitEvent({
          type: 'alert', kind: 'system', level: 'error', notify: true, chainId: c.id,
          msg: `${c.name}: RPC failing for ${ch.minutes} min (${ch.failures} failed reads on every endpoint)${ch.lastError ? `: ${ch.lastError}` : ''}. Bots on this chain can't read prices or send. Add another RPC with RPC_URL_${c.envSlug} in .env.`,
        });
      } else {
        this.activity.emitEvent({
          type: 'info', kind: 'system', level: 'success', notify: true, chainId: c.id,
          msg: `${c.name}: RPC recovered after ${ch.minutes} min of failures (${ch.failures} failed reads)`,
        });
      }
    }
  }

  /** Every configured chain: trading status, signer, gas wallet, RPC health, tx queue, bots. */
  chainsStatus() {
    return this.hub.runtimes().map((rt) => {
      const c = rt.cfg, w = this.wallets.get(c.id);
      const bots = [...this.engines.values(), ...this.trendEngines.values(), ...this.lpEngines.values()].filter((e) => e.chainId === c.id).length;
      return {
        id: c.id, key: c.key, name: c.name, short: c.short, color: c.color, status: c.status, stack: c.stack,
        tradable: rt.tradable, reason: rt.tradable ? null : c.trading.reason ?? 'no DEX configured',
        nativeSymbol: c.nativeSymbol, explorer: c.explorer, geckoSlug: c.geckoSlug,
        dexes: c.dexes.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
        hasSigner: !!rt.signer, address: w?.address ?? rt.gas.address, gasNative: w?.native ?? rt.gas.native, lowGas: rt.gas.low,
        lowGasNative: c.lowGasNative, nativeUsd: this.hub.nativeUsd(c.id), walletError: w?.error ?? rt.gas.error ?? null,
        // RPC URLs can hold an API key: the status shows scheme://host[:port] only (chains/rpcUrl.ts).
        txBusy: rt.gate.busy, rpc: rpcHost(rt.reader.currentUrl ?? null), rpcStatus: safeRpcStatus(rt.reader.status),
        rpcHealth: safeRpcHealth(rt.reader.health?.()), bots,
      };
    });
  }

  /** Both orientations of every market: originals plus their flipped views (flipped: true, pairKey = original). */
  marketList() {
    return this.hub.listBoth().map((d) => ({
      key: d.key, label: this.hub.label(d.key), chainId: d.chainId, base: d.base.symbol, quote: d.quote.symbol, quoteKind: d.quoteKind,
      flipped: !!d.flipped, pairKey: d.flipOf ?? d.key, spends: d.quote.symbol, stacks: d.base.symbol, quoteNative: !!d.quote.native,
      quoteAddress: d.quote.address.toLowerCase(), baseAddress: d.base.address.toLowerCase(), baseNative: !!d.base.native,
      baseDecimals: d.base.decimals, quoteDecimals: d.quote.decimals,
      dex: d.pool.dex, dexName: this.hub.dexName(d.chainId, d.pool.dex), kind: d.pool.kind, feeBps: d.pool.feeBps, feeTier: d.pool.feeTier ?? null,
      // Built-in PulseChain markets resolve their PulseX pair via getPair; candlePool is that same verified pair.
      pool: d.pool.address || (d.legacy ? d.candlePool ?? null : null),
      poolMode: d.poolMode ?? (d.custom ? 'manual' : 'default'), poolChoices: this.hub.rt(d.chainId).adapters.size,
      legacy: !!d.legacy, custom: !!d.custom, risk: d.safety?.risk ?? null, riskWhy: d.safety?.reasons.join(' ') || null, liveAllowed: d.safety ? d.safety.liveAllowed : true,
      safetyAt: d.safety?.at ?? null, safetyStale: d.safety?.stale ?? null,
      buyTaxPct: d.safety?.buyTaxPct ?? null, sellTaxPct: d.safety?.sellTaxPct ?? null, transferTaxPct: d.safety?.transferTaxPct ?? null,
      taxMode: d.safety?.taxMode ?? null, maxTxTokens: d.safety?.maxTxTokens ?? null, maxWalletTokens: d.safety?.maxWalletTokens ?? null,
      tradable: this.hub.rt(d.chainId).tradable,
      // A liquidity bot needs a V3 pool on a DEX with a verified position manager.
      lpOk: d.pool.kind === 'v3' && !!d.pool.address && !!this.hub.chain(d.chainId).dexes.find((x) => x.id === d.pool.dex)?.positionManager,
      // Flipped spot: its own poll when a bot uses it, else ≈ 1 / original (mid-ish; the LP fee makes them differ by ~2× fee).
      spot: this.spots[d.key] ?? (d.flipOf && this.spots[d.flipOf] > 0 ? 1 / this.spots[d.flipOf] : null), usdPerQuote: this.hub.usdPerQuote(d.key),
    }));
  }

  /** One bot's money figures (the same object /api/bot/status carries as `metrics`). Null for an unknown id. */
  metricsFor(id: string): BotMetrics | null {
    const st = this.status();
    const b = [...st.grids, ...st.trends, ...st.lps].find((x) => x.id === id);
    return b ? b.metrics : null;
  }

  status() {
    // The injected clock, the same one that stamps each engine's lastPriceAt (a mocked startedAt never meets a wall-clock asOf)
    const now = this.now();
    // Metrics are as of the bot's last price reading, not the wall clock: status() then only changes when a bot
    // actually ticks (the v2 stream sends no patch for a clock that moved), and a stopped bot's rates stop at its
    // last reading. A bot with no reading yet uses the current minute.
    const asOf = (b: { priceAt?: number | null }) => (typeof b.priceAt === 'number' && b.priceAt > 0 && b.priceAt <= now ? b.priceAt : Math.floor(now / 60_000) * 60_000);
    const grids = this.multi.grids.map((g) => {
      const st = (this.engines.get(g.id) ?? this.attach(g.id)).status();
      const out = { ...st, kind: 'grid' as const, usdPerQuote: this.usdPerQuote(st.stable) };
      return { ...out, metrics: gridMetrics(out, asOf(st)) };
    });
    const trends = this.multi.trends.map((t) => {
      const st = (this.trendEngines.get(t.id) ?? this.attachTrend(t.id)).status();
      const out = { ...st, usdPerQuote: this.usdPerQuote(st.quote) };
      return { ...out, metrics: trendMetrics(out, asOf(st)) };
    });
    const lps = this.multi.lps.map((t) => {
      const st = (this.lpEngines.get(t.id) ?? this.attachLp(t.id)).status();
      return { ...st, metrics: lpMetrics(st, asOf(st)) };
    });
    const aggregate = liveAggregate(grids, trends, lps);
    return {
      network: this.d.net.key, chainId: this.d.net.chainId, explorer: this.d.net.explorer,
      quotes: this.d.net.quotes.map((s) => s.symbol), stables: this.d.net.quotes.map((s) => s.symbol),
      copy: this.d.copy ?? null,
      hasSigner: this.hasSigner, address: this.address, walletBalances: this.walletBalances, wallets: this.walletView(), defaults: this.multi.defaults,
      txBusy: this.gate.busy, spots: this.spots, spotsAt: this.spotsAt,
      legacyChainId: this.hub.legacyChainId,
      chains: this.chainsStatus(),
      marketList: this.marketList(),
      /** Live bots held after a restart until their market's safety check answers (ids). The page shows "checking safety…". */
      safetyChecking: [...this.held],
      safetyStale: this.hub.list().filter((d) => d.safety?.stale).map((d) => ({ key: d.key, label: this.hub.label(d.key), at: d.safety!.at, ...d.safety!.stale! })),
      grids, trends, lps, aggregate, allocations: this.allocations(), alerts: this.multi.alerts,
      feesToday: feesToday([...grids, ...trends, ...lps], now),
      candleSync: this.candleSyncStatus?.() ?? null,
      log: this.d.log.entries.slice(-80).reverse(),
    };
  }
}
