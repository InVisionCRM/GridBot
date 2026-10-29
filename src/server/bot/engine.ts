/**
 * Single-grid engine. Polls price, queues trades on level crosses, executes one job at a time.
 * MultiBot owns many of these and shares a TxGate + SharedNonce across them.
 */
import { PAYOUT_MIN_GAS_MULTIPLE } from '../../live/payout';
import { calculateGridLevels } from '../../engine/gridEngine';
import { DEFAULT_LIMITS, validateLimits, type SafetyLimits } from '../../live/limits';
import { applySell, legacyTradeNames, upgradeConfigNames, replay, roundTripStats, totals, upgradeQuoteNames, type LiveTrade } from '../../live/ledger';
import { buildIntervals, buyAmountPerInterval, evaluateTick, onTradeFilled, onTradeSkipped, seedIntervals, type LiveInterval, type QueuedTrade } from '../../live/liveGrid';
import type { LiveNetwork } from '../../live/networks';
import { isLegacyKey, type MarketDef } from '../../live/markets';
import type { ChainConfig } from '../../live/chains';
import { Hub } from '../chains/hub';
import { analyzeSpacing, validateGridParams } from '../../live/spacing';
import type { GridLevel } from '../../types/grid';
import { ExecError, LiveExecutor, PaperExecutor, UnavailableExecutor, type ChainReader, type Executor, type Fill, type TxSender } from './chain';
import { gridEconomics, type EconSummary } from './econ';
import { FEE_BPS } from '../../live/economics';
import type { Logger } from './logger';
import type { Store } from './store';
import type { SharedNonce, TxGate } from './txGate';
import type { Emit } from './activity';
import { pushCapped } from '../../market/stats';
import { checkGasReserve, gasReserve, reserveCfg } from '../../live/gasReserve';
import { RECENTER_AFTER_MS, shouldRecenter, type RecenterState } from '../../live/recenter';
import { noKey } from '../words';
import { isHalt, requestHalt, resolveHalt, startOverride, StartStopped, systemHalt, type Halt, type StartOverride } from './audit';
import { keySymbols, unitOf } from '../../lib/marketKey';

export type Mode = 'paper' | 'live';
export type Status = 'idle' | 'running' | 'stopped';

export interface GridConfig { lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalQuote: number }

/** What happens to a completed trade's profit: added to that level's next buy, or sent to an address. */
export type ProfitMode = { mode: 'reinvest' } | { mode: 'send'; to: string };
/** One profit transfer (paper: bookkeeping only) */
export interface Payout { at: number; amount: number; to: string; txHash: string; gasQuote: number; ok: boolean; paper: boolean }
/** After a failed transfer, wait this long before trying again. */
export const PAYOUT_RETRY_MS = 10 * 60_000;

/** A reconciled swap whose gas couldn't be converted to base units (no saved rate, none readable): booked as 0. */
export const GAS_UNKNOWN_NOTE = 'gas unknown: the base/native rate was not saved with the swap and could not be read after the restart';

export interface InFlight {
  job: QueuedTrade;
  tokenOut: string;
  decimalsOut: number;
  amountInHuman: number;
  price: number;
  quotedOutHuman?: number;
  deadline: number;
  approvalTxHash?: string;
  swapTxHash?: string;
  /** Base units per native coin when the swap was sent (gas on a receipt reconciled after a restart). Absent on old records. */
  basePerNative?: number;
  /** The least the swap could deliver (the quote's minimum): booked, flagged, when a mined swap's output log can't be read. Absent on old records. */
  minOutHuman?: number;
}

export interface BotState {
  version: 1;
  id: string;
  mode: Mode;
  network: string;
  stable: string;
  status: Status;
  config: GridConfig | null;
  limits: SafetyLimits;
  levels: GridLevel[];
  intervals: LiveInterval[];
  quotePerBuy: number;
  queue: QueuedTrade[];
  inFlight: InFlight | null;
  trades: LiveTrade[];
  paperStartStable: number;
  lastPrice: number | null;
  lastPriceAt: number | null;
  spacingWarn: string | null;
  /** Economics computed at start (fee + impact + gas per round-trip) */
  econ?: EconSummary | null;
  startedAt?: number | null;
  startPrice?: number | null;
  /** [ms, equity in quote] sampled every ≥60 s */
  equity?: [number, number][];
  /** Follow the price up: when it stays above the range, move the range up around it */
  recenter?: RecenterState;
  profits: ProfitMode;
  /** Profit waiting to be sent (send mode), in the spend coin */
  payoutPending: number;
  /** A transfer that was sent and isn't settled yet: never resend while this is set */
  /** nonce: absent on records from before it was kept. stuck: said once that it has no receipt (see TxFate). */
  payoutInFlight: { hash: string; amount: number; to: string; at: number; nonce?: number; stuck?: boolean } | null;
  payouts: Payout[];
  /**
   * Live unwind in progress. The bot stays out of new entries and sells what it holds through the normal
   * quote, price-impact cap and slippage. Absent on state saved before this field existed.
   */
  closing?: boolean;
  /** Hidden from the active list. The record (trades, PnL) stays for analytics. Absent on older state. */
  archivedAt?: number | null;
  /** A close's sales that failed to go through in a row (reverted, rejected: each paid gas), and its next try */
  closeFails?: { n: number; retryAt: number } | null;
  /** Why this bot last stopped or closed. Absent on state saved before this field existed. */
  halt?: Halt | null;
  /** This run was started LIVE with Start anyway (no completed safety check): who pressed it and why. Null otherwise. */
  startOverride?: StartOverride | null;
}



export interface EngineDeps {
  net: LiveNetwork;
  reader: ChainReader;
  signer: TxSender | null;
  store: Store<BotState>;
  log: Logger;
  approval?: 'exact' | 'max';
  maxRetries?: number;
  retryDelayMs?: number;
  receiptTimeoutMs?: number;
  now?: () => number;
  /** Prefill / force id when creating a fresh slot */
  id?: string;
  /** Global execute mutex (multi-grid) */
  txGate?: TxGate;
  /** Shared nonce across all LiveExecutors on one wallet */
  sharedNonce?: SharedNonce;
  /** Prefix log lines */
  logTag?: string;
  /** Activity feed */
  emit?: Emit;
  /** Multi-chain hub (markets, per-chain signer / TxGate / nonce). Default: single PulseChain hub from net/reader/signer. */
  hub?: Hub;
}

/** What MultiBot.tickAll already read this poll, so each grid doesn't read it again. */
export interface TickCtx {
  /** This market's price from the poll's price batch */
  price?: number;
  /** One wallet read per key per poll (cleared after a trade on the chain) */
  wallet?: <T>(key: string, read: () => Promise<T>) => Promise<T>;
}

export interface StartParams extends GridConfig {
  mode: Mode;
  stable?: string;
  limits?: Partial<SafetyLimits>;
  /** Auto-recenter (follow the price up); omitted = keep this grid's current setting */
  recenter?: boolean;
  /** Reinvest (default) or send profits to an address; omitted = keep this grid's current setting */
  profits?: ProfitMode;
  /** Set by MultiBot: a Stop all / STOP chain that landed while this start was under way (it then isn't started) */
  guard?: () => Halt | null;
  /** LIVE only: go ahead when the safety check couldn't complete (never when it completed and failed). Audited. */
  startAnyway?: boolean;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** A payout address must be a real 20-byte address and not the zero address. */
export function checkProfitMode(p: ProfitMode): ProfitMode {
  if (p.mode === 'reinvest') return { mode: 'reinvest' };
  if (p.mode !== 'send') throw new Error('Profits must be reinvested or sent to an address.');
  if (!ADDRESS_RE.test(p.to ?? '')) throw new Error('The payout address must be a 0x… address (42 characters).');
  if (/^0x0{40}$/i.test(p.to)) throw new Error('The payout address can\'t be the zero address.');
  return { mode: 'send', to: p.to };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Grid page warning from the start-time economics: "loses money" only when the net per round trip really is ≤ 0. */
function econWarning(e: EconSummary): string | null {
  if (e.ok) return null;
  return `${e.netPerRoundTrip <= 0 ? 'Each completed trade is expected to lose money at this size' : 'Each completed trade is expected to make very little at this size'}: ${e.reasons.join(' ')}`;
}

/** Job id prefix of a close's sells */
const CLOSE_JOB = 'close-';
/** A close whose sales failed this many times in a row (10, 20, 40, 80 min apart) stops for a look: each try pays gas */
const CLOSE_MAX_FAILS = 5;
const CLOSE_RETRY_MS = 10 * 60_000;

function newId() {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function freshState(net: LiveNetwork, id?: string): BotState {
  return {
    version: 1, id: id ?? newId(), mode: 'paper', network: net.key, stable: net.defaultQuote, status: 'idle', config: null,
    limits: { ...DEFAULT_LIMITS }, levels: [], intervals: [], quotePerBuy: 0, queue: [], inFlight: null,
    trades: [], paperStartStable: 0, lastPrice: null, lastPriceAt: null, spacingWarn: null,
    profits: { mode: 'reinvest' }, payoutPending: 0, payoutInFlight: null, payouts: [],
    closing: false, archivedAt: null, halt: null,
  };
}

/**
 * Boot safety hold: buys that triggered go back to waiting, armed, so they trigger again once the hold ends (not
 * skipped: a skip needs the price to move back first). A start-up seed buy is dropped like a skip.
 */
function untrigger(intervals: LiveInterval[], buys: QueuedTrade[]): LiveInterval[] {
  let out = intervals;
  for (const q of buys) {
    out = q.seed ? onTradeSkipped(out, q) : out.map((iv) => (iv.index === q.intervalIndex && iv.status === 'pendingBuy' ? { ...iv, status: 'waitingBuy' as const } : iv));
  }
  return out;
}

export class GridEngine {
  state: BotState;
  balances: { pls: number; stable: number } | null = null;
  walletBalances: { pls: number; stable: number } | null = null;
  lastError: string | null = null;
  private executor: Executor;
  private draining = false;
  private ticking = false;
  /** Why the last close sell was skipped (price impact, slippage quote, …). Shown while closing. */
  private closeNote: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  readonly hub: Hub;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.hub = d.hub ?? Hub.single(d.net, d.reader, d.signer, { gate: d.txGate, nonce: d.sharedNonce });
    // Saved before the *Usd → *Quote rename (they always held quote-coin amounts): read the old names too.
    const loaded = upgradeQuoteNames(d.store.load());
    const base = freshState(d.net, d.id);
    // Legacy PulseChain keys must match the configured network; multi-chain keys carry their chain.
    const accept = loaded && (isLegacyKey(loaded.stable ?? d.net.defaultQuote) ? loaded.network === d.net.key : true);
    this.state = accept
      ? { ...base, ...loaded!, id: loaded!.id || d.id || base.id, spacingWarn: loaded!.spacingWarn ?? null }
      : base;
    // Saved before per-level buy sizes: every funded level spent the grid's one buy size; levels above the old start
    // price never had money (0, so a later re-range spreads only the real capital).
    this.state.intervals = this.state.intervals.map((iv) => (iv.buyAmount == null ? { ...iv, buyAmount: iv.status === 'inactive' ? 0 : this.state.quotePerBuy } : iv));
    if (this.state.mode === 'live' && !this.signer) {
      this.tag('warn', 'LIVE mode but no PRIVATE_KEY — stopped.');
      if (this.state.status === 'running') this.state.halt = systemHalt('startup', 'No signing key — stopped.', this.now());
      this.state.status = 'stopped';
    }
    // A saved live grid with no key for its chain (key removed, .env not found from this folder) must not take the whole
    // app down: makeExecutor throws for live without a signer. It loads stopped and sends nothing until a key is back.
    if (this.state.mode === 'live' && !this.signer) {
      this.lastError = noKey();
      this.executor = new UnavailableExecutor('live', this.lastError);
    } else this.executor = this.makeExecutor(this.state.mode, this.state.stable);
    if (this.executor instanceof UnavailableExecutor && this.state.status === 'running') {
      this.tag('warn', `${this.state.stable}: ${this.lastError} — stopped.`);
      this.state.halt = systemHalt('startup', `${this.state.stable}: ${this.lastError ?? 'market unavailable'} — stopped.`, this.now());
      this.state.status = 'stopped';
    }
    if (this.state.status === 'running') this.tag('info', `Resuming ${this.state.mode} ${this.label} from saved state.`);
  }

  /** Market definition (null when the saved market is no longer configured). */
  get def(): MarketDef | null { return this.hub.has(this.state.stable) ? this.hub.def(this.state.stable) : null; }
  get chainCfg(): ChainConfig | null { const m = this.def; return m ? this.hub.chain(m.chainId) : null; }
  get chainId(): number { return this.def?.chainId ?? this.d.net.chainId; }
  get label() { return this.hub.label(this.state.stable); }
  // market not loaded: the symbols in its key, never the key itself (src/lib/marketKey.ts)
  get baseSym() { return this.def?.base.symbol ?? keySymbols(this.state.stable)?.base ?? 'PLS'; }
  get quoteSym() { return this.def?.quote.symbol ?? unitOf(this.state.stable) ?? this.state.stable; }
  /** Per-chain signer (PRIVATE_KEY_<SLUG> or the shared key). */
  get signer(): TxSender | null {
    const m = this.def;
    return m ? this.hub.rt(m.chainId).signer : this.d.signer;
  }
  private get gate() { const m = this.def; return m ? this.hub.rt(m.chainId).gate : this.d.txGate; }
  private get netKey() { const m = this.def; return !m || m.legacy ? this.d.net.key : this.hub.chain(m.chainId).key; }

  get hasSigner() { return !!this.signer; }
  get mode() { return this.state.mode; }
  get id() { return this.state.id; }

  private ev(type: Parameters<Emit>[0]['type'], msg: string, extra: Partial<Parameters<Emit>[0]> = {}) {
    this.d.emit?.({ type, msg, botId: this.state.id, kind: 'grid', pair: this.state.stable, chainId: this.chainId, ...extra, mode: this.state.mode });
  }

  private tag(level: 'info' | 'warn' | 'error', msg: string) {
    const m = this.d.logTag ? `[${this.d.logTag}] ${msg}` : msg;
    this.d.log[level](m);
  }

  private makeExecutor(mode: Mode, key: string): Executor {
    let quoter;
    try { quoter = this.hub.quoter(key); } catch (e) {
      this.lastError = (e as Error).message;
      return new UnavailableExecutor(mode, this.lastError);
    }
    if (mode === 'live') {
      const rt = this.hub.chainOf(key);
      if (!rt.signer) throw new Error(noKey());
      return new LiveExecutor(quoter, rt.signer, {
        approval: this.d.approval ?? 'exact',
        receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000,
        sharedNonce: rt.nonce,
      });
    }
    return new PaperExecutor(quoter, () => this.paperBalances(), this.d.approval ?? 'exact');
  }

  private save() { this.d.store.save(this.state); }

  modeTrades(): LiveTrade[] {
    return this.state.trades.filter((t) => !!t.paper === (this.state.mode === 'paper'));
  }

  paperBalances() {
    let stable = this.state.paperStartStable;
    let pls = 0;
    for (const t of this.state.trades) {
      if (!t.paper || t.failed) continue;
      if (t.side === 'buy') { stable -= t.stableAmount; pls += t.plsAmount; } else { stable += t.stableAmount; pls -= t.plsAmount; }
    }
    for (const p of this.state.payouts) if (p.paper && p.ok) stable -= p.amount;
    return { pls, stable };
  }

  async walletAddress(): Promise<string | null> {
    return this.executor.mode === 'live' ? this.executor.address() : this.signer ? this.signer.getAddress() : null;
  }

  async start(p: StartParams): Promise<void> {
    p = upgradeConfigNames(p); // old name `totalCapitalUsd` (same quote-coin amount) still accepted
    if (this.state.status === 'running') throw new Error('Already running. Stop first.');
    if (this.state.inFlight) throw new Error('A transaction from the previous run is still being reconciled.');
    const limits = { ...this.state.limits, ...(p.limits ?? {}) };
    const errs = [...validateLimits(limits), ...validateGridParams(p.lowerPrice, p.upperPrice, p.gridCount, p.totalCapitalQuote)];
    const stable = p.stable ?? this.state.stable;
    if (this.state.config && stable !== this.state.stable) throw new Error(`This grid trades ${this.hub.label(this.state.stable)}; its pair can't change. Add a new grid for ${this.hub.label(stable)}.`);
    const def = this.hub.def(stable);
    if (p.mode === 'live' && !this.hub.rt(def.chainId).signer) errs.push(noKey());
    if (errs.length) throw new Error(errs.join('; '));
    const override = p.mode === 'live' && def.safety ? await this.requireLiveSafety(stable, !!p.startAnyway) : null;

    // Economics (worst interval: the pool's round-trip fee + impact at level size + gas (+ L2 L1 fee)). Never blocks
    // a start: a grid that doesn't clear its costs starts with a warning saying so.
    const quoter = this.hub.quoter(stable);
    const { summary: econ } = await gridEconomics(quoter, p, this.d.approval ?? 'exact');
    const warn = econWarning(econ);

    const executor = this.makeExecutor(p.mode, stable);
    // Native-spending grid (flipped HEX/PLS …): capital + gas reserve must fit in the native balance; the reserve
    // pays gas and is never traded.
    if (p.mode === 'live' && def.quote.native) {
      const bal = await executor.balances();
      const chk = checkGasReserve({ capital: p.totalCapitalQuote, balance: bal.stable, cfg: reserveCfg(limits), symbol: def.quote.symbol });
      if (!chk.ok) throw new Error(chk.reason!);
    }
    const price = await executor.getPrice();
    const levels = calculateGridLevels(p.lowerPrice, p.upperPrice, p.gridCount);
    const quotePerBuy = buyAmountPerInterval(p.gridCount, p.totalCapitalQuote);
    const intervals = buildIntervals(levels, price, quotePerBuy);
    if (!intervals.some((i) => i.status === 'waitingBuy')) throw new Error(`The price (${price}) is below the range. Start when it's inside the range, or lower the range.`);
    const profits = checkProfitMode(p.profits ?? this.state.profits);
    await this.checkPayoutTarget(profits);
    this.refuseIfStopped(p.guard);

    this.executor = executor;
    const paperReset = p.mode === 'paper';
    this.state = {
      ...this.state, mode: p.mode, stable, limits, status: 'running',
      config: { lowerPrice: p.lowerPrice, upperPrice: p.upperPrice, gridCount: p.gridCount, totalCapitalQuote: p.totalCapitalQuote },
      levels, intervals, quotePerBuy, queue: [], inFlight: null,
      trades: paperReset ? this.state.trades.filter((t) => !t.paper) : this.state.trades,
      paperStartStable: paperReset ? p.totalCapitalQuote : this.state.paperStartStable,
      lastPrice: price, lastPriceAt: this.now(),
      spacingWarn: warn, econ,
      // a live restart (Change range, start again) continues the same bot: its trades stay, so its age and its equity
      // history stay too, or every rate and the APR would restart from zero time on a lifetime of profit
      startedAt: paperReset ? this.now() : this.state.startedAt ?? this.now(),
      startPrice: price,
      equity: paperReset ? [[this.now(), p.totalCapitalQuote]] : [...(this.state.equity ?? []), [this.now(), p.totalCapitalQuote]],
      recenter: { enabled: p.recenter ?? this.state.recenter?.enabled ?? false, aboveSince: null, lastAt: this.state.recenter?.lastAt ?? null, count: this.state.recenter?.count ?? 0 },
      profits, closing: false, archivedAt: null, halt: null, startOverride: override,
      ...(paperReset ? { payoutPending: 0, payoutInFlight: null, payouts: this.state.payouts.filter((x) => !x.paper) } : {}),
    };
    this.seedUpper(price);
    this.lastError = null;
    this.save();
    this.tag('info', `Started ${p.mode.toUpperCase()} ${this.label} ${p.lowerPrice}–${p.upperPrice} ×${p.gridCount}, ${quotePerBuy.toPrecision(5)} ${this.quoteSym}/buy, spacing ${(econ.spacingPct * 100).toFixed(3)}%, impact ${(econ.impactPct * 100).toFixed(3)}%, gas ${econ.gasQuote.toPrecision(3)} ${this.quoteSym}/RT, net ${econ.netPerRoundTrip.toPrecision(4)} ${this.quoteSym} (${(econ.netPct * 100).toFixed(3)}%)/RT worst, price ${price}`);
    if (warn) this.tag('warn', warn);
    this.ev('started', `Grid started — ${this.label} ${p.lowerPrice.toPrecision(4)}–${p.upperPrice.toPrecision(4)} ×${p.gridCount} (${p.mode})`, { level: 'success' });
  }

  /** Stop all / STOP chain pressed while this start awaited quotes and balances: it wins, and the grid stays off. */
  private refuseIfStopped(guard?: () => Halt | null) {
    const h = guard?.();
    if (!h) return;
    this.state.halt = { ...h, at: this.now() };
    this.save();
    this.ev('stopped', `Grid ${this.label}: not started — ${h.detail} was pressed while it was starting`, { level: 'warn', notify: true, data: { halt: this.state.halt } });
    throw new StartStopped(h);
  }

  /**
   * Markets with a safety report (custom tokens, verified built-ins): a LIVE start needs a fresh, completed check
   * (Hub.liveCheck: 3 tries). A completed fail is refused; a check that couldn't complete is refused unless Start anyway
   * was pressed, which is then audited (returned, stored on the grid, and in the activity log).
   */
  private async requireLiveSafety(key: string, startAnyway: boolean): Promise<StartOverride | null> {
    const { override } = await this.hub.liveCheck(key, { startAnyway });
    if (!override) return null;
    const audit = startOverride(override, this.now());
    this.tag('warn', `Start anyway: starting LIVE without a completed safety check (${override.blockedBy}), on the report from ${new Date(override.lastKnownAt).toISOString()}`);
    this.ev('info', `Grid ${this.label}: Start anyway — LIVE without a completed safety check (${override.blockedBy})`, { level: 'warn', notify: true, data: { startOverride: audit } });
    return audit;
  }

  /** Record that this live run goes on without a completed safety check (MultiBot's boot check). Saved. */
  setStartOverride(o: StartOverride) {
    this.state.startOverride = o;
    this.save();
  }

  /**
   * `override`: MultiBot ran the fresh safety check (Hub.liveCheck) for a LIVE resume. A Halt-like record when it
   * couldn't complete and the bot resumes on the last passing report (audited); null when it passed; undefined when
   * called directly (no check: tests, paper).
   */
  resume(override?: StartOverride | null) {
    if (this.state.status === 'running') return;
    if (!this.state.config) throw new Error('No grid to resume.');
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    if (this.state.mode === 'live' && !this.signer) throw new Error(noKey());
    if (this.state.mode === 'live' && this.def?.safety && !this.def.safety.liveAllowed) throw new Error(`LIVE blocked — safety ${this.def.safety.risk}`);
    this.state.status = 'running';
    this.state.closing = false;
    this.state.archivedAt = null;
    this.state.halt = null;
    if (override !== undefined) this.state.startOverride = override;
    this.closeNote = null;
    this.save();
    this.tag('info', 'Resumed.');
    this.ev('started', `Grid resumed — ${this.label}`);
  }

  stop(why?: string | Halt) {
    this.safetyHold = null;
    const halt = resolveHalt(why, this.now());
    const dropped = this.state.queue;
    this.state.intervals = dropped.reduce((iv, q) => onTradeSkipped(iv, q), this.state.intervals);
    this.state.queue = [];
    this.state.status = 'stopped';
    this.state.closing = false;
    this.state.halt = halt;
    this.closeNote = null;
    this.save();
    const note = typeof why === 'string' ? why : halt.detail;
    this.ev('stopped', `Grid ${this.label} ${typeof why === 'string' ? `paused — ${why}` : `stopped — ${note}`}`, { level: typeof why === 'string' ? 'error' : 'warn', notify: true, data: { halt } });
    this.tag('warn', `${typeof why === 'string' ? `PAUSED (${why})` : `STOPPED (${note})`}. ${dropped.length} queued dropped.${this.state.inFlight?.swapTxHash ? ` Swap ${this.state.inFlight.swapTxHash} already broadcast; will reconcile.` : ''}`);
  }

  /** Coins this bot's own fills still hold (quote-side inventory is not an on-chain position). */
  private held() { return replay(this.modeTrades()).plsHeld; }
  /**
   * Below this the bot holds only rounding: sells go out in exact token units (15 significant digits), so a float lot
   * of tens of millions sells a hair less than booked. A millionth of its biggest fill (at least 1e-8).
   */
  private dust() {
    const big = this.modeTrades().reduce((m, t) => (t.failed ? m : Math.max(m, t.plsAmount)), 0);
    return Math.max(1e-8, big * 1e-6);
  }
  private flat() { return !this.state.inFlight && this.state.queue.length === 0 && this.held() <= this.dust(); }

  /**
   * End the bot. Paper (and a live grid with nothing held and nothing in flight) leaves the active list now,
   * with no chain calls. A live grid that holds coins, or has a tx in flight, is marked closing: the sells go
   * through the same quote, price-impact cap and slippage as any other trade, one tx at a time on this chain.
   * @returns true when an on-chain unwind still has to run.
   */
  requestClose(why?: Halt): boolean {
    if (this.state.archivedAt) return false;
    // Paper never waits on a quote or a poll. A paper bot left `closing` by an old process finishes here too.
    if (this.state.mode !== 'live') {
      this.noteClose(why);
      this.state.inFlight = null;
      this.finishClose();
      return false;
    }
    if (this.state.closing) return false;
    const liveWork = this.state.inFlight != null || this.held() > this.dust();
    if (!liveWork || this.executor instanceof UnavailableExecutor) {
      this.noteClose(why);
      if (this.executor instanceof UnavailableExecutor && liveWork) {
        this.lastError = this.lastError ?? 'market unavailable';
        this.state.status = 'stopped';
        this.state.closing = false;
        this.save();
        const halt = this.state.halt ?? null;
        this.ev('stopped', `Grid ${this.label} stopped — can't close: ${this.lastError}. Its coins stay in the wallet.`, { level: 'warn', notify: true, data: { halt } });
        this.tag('warn', `STOPPED (close requested, market unavailable: ${this.lastError}).`);
        return false;
      }
      this.finishClose();
      return false;
    }
    this.noteClose(why);
    this.state.closing = true;
    this.state.status = 'running';
    this.state.closeFails = null;
    this.closeNote = null;
    this.lastError = null;
    // Drop queued buys. A swap already broadcast is reconciled, never resent.
    this.state.queue = [];
    if (!this.state.inFlight) this.queueUnwindSells();
    this.save();
    this.ev('info', `Grid ${this.label}: closing…`, { level: 'warn' });
    return true;
  }

  /** Sell each held lot (and any coins not on a level) through the normal executor. Idempotent. */
  private queueUnwindSells() {
    if (this.state.inFlight || this.held() <= this.dust()) return;
    const price = this.state.lastPrice ?? 0;
    const queued = new Set(this.state.queue.map((q) => q.intervalIndex));
    for (const iv of this.state.intervals) {
      if (iv.status !== 'holding' || !(iv.plsAmount > 1e-12) || queued.has(iv.index)) continue;
      this.state.queue.push({
        id: `${CLOSE_JOB}${this.state.id}-${iv.index}-${this.now().toString(36)}`,
        intervalIndex: iv.index, side: 'sell', triggerPrice: price, levelPrice: iv.sellPrice,
        amount: iv.plsAmount, createdAt: this.now(), manual: true,
      });
      queued.add(iv.index);
    }
    const onLevels = this.state.intervals.reduce((a, iv) => a + (iv.status === 'holding' ? iv.plsAmount : 0), 0);
    const free = this.held() - onLevels;
    if (free > this.dust() && !queued.has(-1)) {
      this.state.queue.push({
        id: `${CLOSE_JOB}free-${this.state.id}-${this.now().toString(36)}`,
        intervalIndex: -1, side: 'sell', triggerPrice: price, levelPrice: price,
        amount: free, createdAt: this.now(), manual: true,
      });
    }
  }

  private noteClose(why?: Halt) {
    if (why) this.state.halt = { ...why, at: this.now() };
    else if (!this.state.halt) this.state.halt = requestHalt('close', 'Close', this.now());
  }

  private finishClose() {
    this.state.queue = [];
    this.state.status = 'stopped';
    this.state.closing = false;
    this.state.closeFails = null;
    this.state.archivedAt = this.now();
    this.closeNote = null;
    this.save();
    this.ev('stopped', `Grid ${this.label} closed`, { level: 'success', notify: true, data: { halt: this.state.halt ?? null } });
  }

  /** Hide a stopped grid that is not mid-unwind. Coins it bought already sit in the wallet. */
  archiveIfSettled(): boolean {
    if (this.state.archivedAt || this.state.closing || this.state.status === 'running') return false;
    if (this.state.inFlight || this.state.payoutInFlight) return false;
    this.state.archivedAt = this.now();
    this.save();
    return true;
  }

  setLimits(l: Partial<SafetyLimits>) {
    const next = { ...this.state.limits, ...l };
    const errs = validateLimits(next);
    if (errs.length) throw new Error(errs.join('; '));
    this.state.limits = next;
    this.save();
  }

  setRecenter(enabled: boolean) {
    if (!this.state.config) throw new Error('Start the grid first.');
    this.state.recenter = { aboveSince: null, lastAt: null, count: 0, ...this.state.recenter, enabled };
    this.save();
  }

  /**
   * Auto-recenter (up only). Once the price has stayed above the range for RECENTER_AFTER_MS with every level sold
   * (nothing held, queued or in flight), the range moves up around the price: same ±width, same levels; the levels'
   * buy sizes (with reinvested profit) carry over and the new levels above the price get coins from a start-up buy;
   * trades and profit carry over. At most once per RECENTER_COOLDOWN_MS. A fall below the range never moves it:
   * the grid keeps what it bought and waits for the price to come back.
   */
  private async followUp(price: number) {
    const r = this.state.recenter, c = this.state.config;
    if (!r?.enabled || !c) return;
    const now = this.now();
    const flat = !this.state.inFlight && this.state.queue.length === 0 && this.state.intervals.every((i) => i.status === 'inactive' || i.status === 'waitingBuy');
    const d = shouldRecenter(r, price, c.upperPrice, now, flat);
    r.aboveSince = d.aboveSince;
    if (!d.move) return;
    const band = (c.upperPrice - c.lowerPrice) / (c.upperPrice + c.lowerPrice);
    const next: GridConfig = { ...c, lowerPrice: +(price * (1 - band)).toPrecision(6), upperPrice: +(price * (1 + band)).toPrecision(6) };
    const { summary: econ } = await gridEconomics(this.hub.quoter(this.state.stable), next, this.d.approval ?? 'exact');
    // Anything that changed while the costs were read (a close, a stop, a trade) wins over the move
    if (this.state.closing || this.state.status !== 'running' || this.state.config !== c || this.state.inFlight || this.state.queue.length) return;
    const levels = calculateGridLevels(next.lowerPrice, next.upperPrice, next.gridCount);
    // Everything is sold at this point: the levels' buy sizes (start size + reinvested profit) carry over, spread evenly.
    const perLevel = this.state.intervals.reduce((a, i) => a + i.buyAmount, 0) / next.gridCount;
    const intervals = buildIntervals(levels, price, perLevel);
    this.state = {
      ...this.state, config: next, levels, intervals, quotePerBuy: perLevel, queue: [],
      econ, spacingWarn: econWarning(econ),
      recenter: { enabled: true, aboveSince: null, lastAt: now, count: r.count + 1 },
    };
    this.seedUpper(price, true);
    this.save();
    const msg = `Grid ${this.label}: price stayed above the range for ${RECENTER_AFTER_MS / 3600_000}h, so the range moved up to ${next.lowerPrice.toPrecision(5)}–${next.upperPrice.toPrecision(5)} (±${(band * 100).toFixed(0)}%, ${next.gridCount} levels)`;
    this.tag('info', msg);
    this.ev('range', msg, { level: 'success', notify: true, data: { recenter: true, lowerPrice: next.lowerPrice, upperPrice: next.upperPrice } });
  }

  /**
   * Coins for the levels at or above the price (seedIntervals): first coins this grid already holds that no level
   * owns (a live restart), then one start-up buy queued for the rest.
   */
  private seedUpper(price: number, recenter = false) {
    const pos = replay(this.modeTrades());
    const owned = this.state.intervals.reduce((a, i) => a + (i.status === 'holding' ? i.plsAmount : 0), 0);
    const free = Math.max(0, pos.plsHeld - owned);
    const avg = pos.plsHeld > 0 ? pos.costQuote / pos.plsHeld : 0;
    const { intervals, job } = seedIntervals(this.state.intervals, price, { pls: free, cost: free * avg }, this.now());
    const fromHeld = intervals.filter((iv, i) => iv.status === 'holding' && this.state.intervals[i].status !== 'holding').length;
    this.state.intervals = intervals;
    if (job) this.state.queue.push(recenter ? { ...job, recenter: true } : job);
    if (fromHeld || job) {
      const sym = this.def?.quote.symbol ?? this.state.stable;
      this.tag('info', `Levels above the price: ${fromHeld} use ${this.baseSym} the grid already holds${job ? `; buying ${this.baseSym} for ${job.seed!.length} with ${job.amount.toPrecision(5)} ${sym}` : ''}`);
    }
  }

  /** Payouts to the bot's own wallet would do nothing but burn gas. */
  private async checkPayoutTarget(p: ProfitMode) {
    const me = p.mode === 'send' && this.signer ? await this.signer.getAddress() : null;
    if (me && p.mode === 'send' && me.toLowerCase() === p.to.toLowerCase()) throw new Error('That is the bot\'s own wallet: profits already stay there when reinvested.');
  }

  /** Change what happens to profits from now on (switching to reinvest leaves any unsent profit in the wallet). */
  async setProfits(p: ProfitMode) {
    if (!this.state.config) throw new Error('Start the grid first.');
    if (this.state.payoutInFlight) throw new Error('A profit transfer is still being confirmed. Try again in a minute.');
    const next = checkProfitMode(p);
    await this.checkPayoutTarget(next);
    this.state.profits = next;
    if (next.mode === 'reinvest') this.state.payoutPending = 0;
    this.save();
    this.ev('info', `Grid ${this.label}: profits ${next.mode === 'reinvest' ? 'are reinvested' : `go to ${next.to}`}`, { level: 'success' });
  }

  /**
   * Send mode: settle a transfer in flight first (never resend while one is unresolved), then send the waiting profit
   * once it is worth PAYOUT_MIN_GAS_MULTIPLE × the transfer's gas. Paper mode only books it.
   */
  private payoutRetryAt = 0;
  payoutMin: number | null = null;
  private payoutMinAt = 0;
  private async payOut(price: number) {
    const s = this.state;
    if (s.payoutInFlight) {
      const f = s.payoutInFlight;
      const r = await this.executor.transferStatus(f.hash);
      if (!r) {
        const fate = await this.executor.txFate(f.nonce, f.at, this.now());
        if (fate === 'dropped') {
          // never ran: the profit is still in payoutPending, so it goes out again with the next payout
          s.payoutInFlight = null;
          this.ev('info', `Grid ${this.label}: profit transfer ${f.hash} was dropped by the network (never ran); it is sent again`, { level: 'warn' });
          this.save();
        } else if ((fate === 'used' || fate === 'stuck') && !f.stuck) {
          f.stuck = true;
          this.save();
          const why = fate === 'used' ? 'its nonce was used by another transaction from this wallet (sped up or cancelled in a wallet app?)' : 'it is still not mined after an hour; speed it up or cancel it in your wallet app';
          this.ev('info', `Grid ${this.label}: profit transfer ${f.hash} has no receipt: ${why}. Trading goes on; no other payout is sent until it settles`, { level: 'error', notify: true });
        }
        return;
      }
      s.payoutInFlight = null;
      s.payouts.push({ at: this.now(), amount: r.ok ? f.amount : 0, to: f.to, txHash: f.hash, gasQuote: r.gasPls * price, ok: r.ok, paper: s.mode === 'paper' });
      const sym = this.def?.quote.symbol ?? s.stable;
      if (r.ok) {
        s.payoutPending = Math.max(0, s.payoutPending - f.amount);
        this.ev('info', `Grid ${this.label}: sent ${f.amount.toPrecision(5)} ${sym} profit to ${f.to}`, { level: 'success', notify: true, data: { hash: f.hash } });
      } else {
        this.payoutRetryAt = this.now() + PAYOUT_RETRY_MS;
        this.ev('info', `Grid ${this.label}: profit transfer ${f.hash} reverted; will try again in ${PAYOUT_RETRY_MS / 60_000} min`, { level: 'error', notify: true });
      }
      this.save();
      return;
    }
    if (s.profits.mode !== 'send' || s.status !== 'running' || s.inFlight || s.queue.length || !(s.payoutPending > 0) || this.now() < this.payoutRetryAt) return;
    // Gas price read at most every 10 min while profit builds up (public RPCs).
    if (this.payoutMin == null || this.now() - this.payoutMinAt > PAYOUT_RETRY_MS) {
      this.payoutMin = PAYOUT_MIN_GAS_MULTIPLE * (await this.executor.transferGasPls()) * price;
      this.payoutMinAt = this.now();
    }
    if (s.payoutPending < this.payoutMin) return;
    const to = s.profits.to, amount = s.payoutPending;
    const send = async () => {
      const { hash, nonce } = await this.executor.sendTransfer(to, amount);
      s.payoutInFlight = { hash, amount, to, at: this.now(), nonce };
      this.save();
      this.tag('info', `sent profit transfer ${hash}: ${amount} → ${to}`);
    };
    try {
      if (this.gate) await this.gate.run(send); else await send();
    } catch (e) {
      this.payoutRetryAt = this.now() + PAYOUT_RETRY_MS;
      this.ev('info', `Grid ${this.label}: couldn't send profit (${(e as Error).message.slice(0, 160)}); will try again in ${PAYOUT_RETRY_MS / 60_000} min`, { level: 'error', notify: true });
    }
  }

  startLoop(pollMs: number) {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), pollMs);
  }
  stopLoop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * MultiBot's boot safety hold (a restart, until the market's fresh check answers):
   * - 'exits': exits only. Stops, take-profits and sells of what is held still fire and execute; no new entry or buy.
   * - a Halt: the check failed. The exits already queued or in flight settle, nothing new is triggered, then the bot
   *   stops with this Halt.
   * Not persisted: a restart holds again.
   */
  safetyHold: null | 'exits' | Halt = null;

  /** Boot hold (exits only): queued buys are dropped (their levels go back to waiting), sells stay. */
  holdForSafety() {
    this.safetyHold = 'exits';
    const buys = this.state.queue.filter((q) => q.side === 'buy');
    if (!buys.length) return;
    this.state.intervals = untrigger(this.state.intervals, buys);
    this.state.queue = this.state.queue.filter((q) => q.side !== 'buy');
    this.save();
  }
  /** Boot check passed: back to normal. */
  releaseSafetyHold() { this.safetyHold = null; }
  /** Boot check failed: stop now, or once the exits already queued / in flight have settled. */
  settleThenStop(halt: Halt) {
    if (this.state.status !== 'running') { this.safetyHold = null; return; } // stopped meanwhile (by hand): leave it
    if (!this.state.inFlight && !this.state.queue.some((q) => q.side === 'sell')) { this.safetyHold = null; this.stop(halt); return; }
    this.safetyHold = halt;
    this.tag('warn', `safety check failed: settling the exit already triggered, then stopping (${halt.detail})`);
  }
  private finishSettle() {
    const h = this.safetyHold;
    if (!isHalt(h) || this.state.inFlight || this.state.queue.some((q) => q.side === 'sell')) return;
    this.safetyHold = null;
    this.stop(h);
  }

  async tick(ctx: TickCtx = {}): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.state.inFlight && !this.draining) await this.reconcile();
      // The poll's price batch already read this market's price (MultiBot.tickAll); reading it again per grid doubled
      // the RPC calls. A grid ticked on its own (or after a trade on its chain this poll) reads its own.
      const price = ctx.price != null && ctx.price > 0 && !this.state.inFlight ? ctx.price : await this.executor.getPrice();
      this.state.lastPrice = price;
      this.state.lastPriceAt = this.now();
      this.hub.setSpot(this.state.stable, price);
      try {
        // Live balances are the wallet's: grids on the same market share one read per poll (paper balances are each grid's own).
        this.balances = this.executor.mode === 'live' && ctx.wallet
          ? { ...(await ctx.wallet(`bal:${this.state.stable}`, () => this.executor.balances())) }
          : await this.executor.balances();
      } catch { /* keep last */ }
      const signer = this.signer;
      if (signer) {
        try {
          if (this.executor.mode === 'live') this.walletBalances = this.balances;
          else {
            const read = async () => {
              const q = this.hub.quoter(this.state.stable);
              const a = await signer.getAddress();
              const [b, st] = await Promise.all([
                q.base.native ? q.reader.getBalance(a) : q.tokenBalance(a, q.base.address),
                q.stable.native ? q.reader.getBalance(a) : q.tokenBalance(a, q.stable.address),
              ]);
              return { pls: Number(b) / 10 ** q.base.decimals, stable: Number(st) / 10 ** q.stable.decimals };
            };
            this.walletBalances = { ...(ctx.wallet ? await ctx.wallet(`wallet:${this.state.stable}`, read) : await read()) };
          }
        } catch { /* keep last */ }
      }
      if (this.state.closing && !this.state.inFlight && !(this.state.closeFails && this.state.closeFails.retryAt > this.now())) this.queueUnwindSells();
      // A close only sells what is already held. New buys and follow-the-price wait until it isn't closing.
      if (this.state.status === 'running' && !this.state.inFlight && !this.state.closing && !isHalt(this.safetyHold)) {
        const ev = evaluateTick(this.state.intervals, price, this.now());
        this.state.intervals = ev.intervals;
        let queued = ev.queued;
        // Boot hold: sells (exits of what is held) go ahead; buys wait (their levels go back to waiting) until it passes.
        if (this.safetyHold) {
          const buys = queued.filter((q) => q.side === 'buy');
          if (buys.length) {
            this.state.intervals = untrigger(this.state.intervals, buys);
            this.tag('info', `Price ${price}: ${buys.length} buy(s) not placed — held until the safety check after the restart passes`);
          }
          queued = queued.filter((q) => q.side !== 'buy');
        }
        if (queued.length) {
          this.state.queue.push(...queued);
          this.tag('info', `Price ${price}: triggered ${queued.map((q) => `${q.side}@${q.levelPrice}`).join(', ')}`);
          this.ev('queued', `Grid ${this.label}: queued ${queued.map((q) => `${q.side} @ ${q.levelPrice.toPrecision(5)}`).join(', ')}`);
        }
        if (!this.safetyHold) await this.followUp(price); // follow-the-price buys / reseeds wait for the check
      }
      if (this.state.config && this.state.status === 'running') {
        const eq = this.state.equity ??= [];
        if (!eq.length || this.now() - eq[eq.length - 1][0] >= 60_000) {
          const t = totals(this.modeTrades(), price);
          pushCapped(eq, [this.now(), this.state.config.totalCapitalQuote + t.realized + t.unrealized], 3000);
        }
      }
      this.save();
      await this.drain();
      this.finishSettle();
      if (this.state.closing && this.flat()) this.finishClose();
      if (!this.safetyHold) await this.payOut(price); // a payout isn't an exit: it waits for the check
      // A tick that got through means the last error (often one RPC timeout) is over; the Activity log keeps it.
      // A close that could not sell (price-impact cap, quote failed) keeps that reason on the row.
      this.lastError = this.state.closing ? this.closeNote : null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.tag('error', `tick: ${this.lastError}`);
      this.ev('error', `Grid ${this.label}: ${this.lastError}`, { level: 'error', notify: true });
    } finally {
      this.ticking = false;
    }
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.state.status === 'running' && !this.state.inFlight && this.state.queue.length) {
        // Boot hold: only sells (exits) run; a buy isn't sent until the check passes.
        const job = this.safetyHold ? this.state.queue.find((q) => q.side === 'sell') : this.state.queue[0];
        if (!job) break;
        const run = () => this.runJob(job);
        const gate = this.gate;
        if (gate) await gate.run(run);
        else await run();
        if (this.state.inFlight) break;
        this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
        this.save();
      }
    } finally {
      this.draining = false;
    }
  }

  /** A close's sale failed to go through: the next try is 10, 20, 40, 80 min later; the 5th failure in a row stops the bot */
  private closeFailed(why: string) {
    const n = (this.state.closeFails?.n ?? 0) + 1;
    if (n >= CLOSE_MAX_FAILS) {
      this.state.closeFails = null;
      this.stop(`selling to close failed ${n} times in a row (${why}); Close it again to try again`);
      return;
    }
    const wait = CLOSE_RETRY_MS * 2 ** (n - 1);
    this.state.closeFails = { n, retryAt: this.now() + wait };
    // The other sales wait too: they would most likely fail the same way, each paying gas
    this.state.queue = [];
    this.closeNote = `selling to close failed (${why}); trying again in ${wait / 60_000} min`;
    this.save();
  }

  private skip(job: QueuedTrade, why: string) {
    this.state.intervals = onTradeSkipped(this.state.intervals, job);
    if (this.state.closing) this.closeNote = why;
    this.tag('warn', `Skipped ${job.side}@${job.levelPrice}: ${why}`);
    this.ev('skipped', `Grid ${this.label}: skipped ${job.side} @ ${job.levelPrice.toPrecision(5)} — ${why}`, { level: 'warn' });
  }

  private recordFailure(job: QueuedTrade, gasPls: number, price: number, hash: string | undefined, note: string, gasUnknown = false) {
    if (!(gasPls > 0) && !gasUnknown) return;
    const gasQuote = gasPls * price;
    this.state.trades.push({
      id: hash ?? `fail-${this.now()}`, network: this.netKey, side: job.side, intervalIndex: job.intervalIndex,
      stable: this.state.stable, plsAmount: 0, stableAmount: 0, price: 0, gasPls, gasQuote, txHash: hash ?? '',
      timestamp: this.now(), realizedPnlQuote: -gasQuote, failed: true, paper: this.state.mode === 'paper', note,
      ...(gasUnknown ? { gasUnknown: true } : {}),
    });
  }

  /**
   * Record a fill from actual amounts (receipt in live). All prices quote per PLS.
   * Buys store the lot cost on the interval; sells realize PnL against exactly that lot.
   */
  private recordFill(job: QueuedTrade, f: {
    plsAmount: number; stableAmount: number; gasPls: number; txHash: string; approvalTxHash?: string;
    quotedPrice: number; fromReceipt: boolean; taxPct?: number; outSource?: Fill['outSource']; expectedOut?: number;
    gasUnknown?: boolean;
  }) {
    const { plsAmount, stableAmount, gasPls } = f;
    const fee = (this.def?.pool.feeBps ?? FEE_BPS) / 10_000;
    const execPrice = stableAmount / plsAmount;
    const gasQuote = gasPls * execPrice;
    // + = adverse: paid more per PLS on a buy, received less per PLS on a sell
    const slippagePct = f.quotedPrice > 0
      ? (job.side === 'buy' ? execPrice / f.quotedPrice - 1 : 1 - execPrice / f.quotedPrice)
      : 0;
    const feeQuote = job.side === 'buy' ? stableAmount * fee : (stableAmount * fee) / (1 - fee);
    const iv = this.state.intervals.find((i) => i.index === job.intervalIndex);
    let lotCost: number | undefined;
    let roundTripNet: number | undefined;
    let realized = 0;
    // A sale of a close: in the position and its profit, but not a grid round trip
    const cash = job.id.startsWith(CLOSE_JOB);
    if (cash) this.state.closeFails = null;
    if (job.side === 'buy') {
      lotCost = stableAmount + gasQuote;
    } else {
      const pos = replay(this.modeTrades());
      lotCost = iv?.lotCost ?? (pos.plsHeld > 0 ? (pos.costQuote / pos.plsHeld) * plsAmount : undefined);
      realized = applySell(pos, plsAmount, stableAmount, gasQuote, lotCost).realized;
      // A close / stop sale is a cash-out at market, not a buy → sell round trip: it stays in realized, not in round trips.
      roundTripNet = cash || job.manual ? undefined : realized;
    }
    this.state.trades.push({
      id: f.txHash, network: this.netKey, side: job.side, intervalIndex: job.intervalIndex, stable: this.state.stable,
      plsAmount, stableAmount, price: execPrice, gasPls, gasQuote, txHash: f.txHash, approvalTxHash: f.approvalTxHash,
      timestamp: this.now(), realizedPnlQuote: realized, paper: this.state.mode === 'paper',
      triggerPrice: job.triggerPrice, levelPrice: job.levelPrice, ...(cash ? { closeSale: true } : {}), quotedPrice: f.quotedPrice, execPrice, slippagePct,
      fromReceipt: f.fromReceipt, feeQuote, lotCost, roundTripNet, ...(job.side === 'sell' && job.manual ? { closeOut: true } : {}), ...(job.seed ? { seed: job.seed } : {}), ...(job.recenter ? { recenter: true } : {}),
      ...(f.taxPct ? { taxPct: f.taxPct } : {}), ...(f.outSource ? { outSource: f.outSource } : {}), ...(f.expectedOut != null ? { expectedOut: f.expectedOut } : {}),
      ...(f.gasUnknown ? { gasUnknown: true, note: GAS_UNKNOWN_NOTE } : {}),
      ...(this.def ? { dex: this.def.pool.dex, feeBps: this.def.pool.feeBps, ...(this.def.pool.feeTier != null ? { feeTier: this.def.pool.feeTier } : {}) } : {}),
    });
    // A completed sell's profit: added to that level's next buy (reinvest), or set aside to send (send mode).
    let nextBuy: number | undefined;
    if (job.side === 'sell' && iv && !job.manual) {
      if (this.state.profits.mode === 'reinvest') nextBuy = iv.buyAmount + realized;
      else if (realized > 0) this.state.payoutPending += realized;
    }
    this.state.intervals = onTradeFilled(this.state.intervals, job, job.side === 'buy' ? plsAmount : 0, job.side === 'buy' ? lotCost : undefined, nextBuy);
    const sym = this.def?.quote.symbol ?? this.state.stable, bs = this.baseSym;
    this.ev('filled', `Grid ${this.label}: ${job.side === 'buy' ? 'BOUGHT' : 'SOLD'} ${plsAmount.toPrecision(6)} ${bs} @ ${execPrice.toPrecision(6)}${job.seed ? ` for the ${job.seed.length} levels above the price` : ''}${roundTripNet != null ? ` — RT net ${roundTripNet >= 0 ? '+' : ''}${roundTripNet.toPrecision(4)} ${sym}` : ''}`, {
      level: job.side === 'sell' ? (realized >= 0 ? 'success' : 'warn') : 'success', notify: true,
      data: { side: job.side, price: execPrice, pls: plsAmount, level: job.levelPrice, pnl: roundTripNet },
    });
    this.tag('info', `FILLED ${job.side} ${plsAmount.toPrecision(6)} ${bs} ↔ ${stableAmount.toPrecision(6)} ${sym} | trig ${job.triggerPrice.toPrecision(6)} lvl ${job.levelPrice.toPrecision(6)} quote ${f.quotedPrice.toPrecision(6)} exec ${execPrice.toPrecision(6)} slip ${(slippagePct * 100).toFixed(3)}%${f.fromReceipt ? '' : ' (no receipt log)'} | gas ${gasQuote.toPrecision(3)} ${sym} | tx ${f.txHash}${roundTripNet != null ? ` | RT net ${roundTripNet.toPrecision(4)} ${sym}` : ''}`);
  }

  private async runJob(job: QueuedTrade): Promise<void> {
    if (job.seed) {
      // Coins bought above a level's sell price could only sell at a loss: if the price already rose past the first of
      // these levels since the start, they wait to buy on the way back down instead.
      const firstSell = Math.min(...this.state.intervals.filter((i) => job.seed!.includes(i.index)).map((i) => i.sellPrice));
      const now = this.state.lastPrice ?? job.triggerPrice;
      if (now >= firstSell) return this.skip(job, `the price rose past ${firstSell.toPrecision(5)} before the start-up buy; those levels will buy on the way back down`);
    }
    const maxAttempts = (this.d.maxRetries ?? 1) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.state.status !== 'running') return;
      let q;
      try {
        q = await this.executor.quote(job.side, job.amount, this.state.limits);
      } catch (e) {
        this.tag('warn', `quote failed (${attempt}/${maxAttempts}): ${(e as Error).message}`);
        if (attempt === maxAttempts) return this.skip(job, 'quote failed');
        await sleep(this.d.retryDelayMs ?? 5000);
        continue;
      }
      // Over the impact cap first: a big sale's quote price includes its own impact, which the units guard would
      // otherwise report as a units mismatch.
      if (q.priceImpact > this.state.limits.maxPriceImpact) {
        return this.skip(job, `price impact ${(q.priceImpact * 100).toFixed(2)}% > cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%${q.priceImpact > 0.5 ? ' (over half the price: a very thin pool for this size, or a units/decimals mismatch in the quote)' : ''}`);
      }
      // Units guard: the router quote's effective price must be in the same units/direction as the trigger
      // (quote per PLS). A decimals or inversion bug shows up as orders-of-magnitude divergence.
      const ref = this.state.lastPrice ?? job.triggerPrice;
      // Pool price WITHOUT token taxes: a 10% tax must not trip the guard, a decimals bug (10^n off) always does.
      const qp = q.poolPrice ?? q.price;
      if (ref > 0 && (qp / ref > 1.5 || qp / ref < 1 / 1.5)) {
        return this.skip(job, `quote price ${qp.toPrecision(6)} inconsistent with spot ${ref.toPrecision(6)} ${this.def?.quote.symbol ?? this.state.stable}/${this.baseSym} — units/decimals mismatch, refusing`);
      }
      if (!q.balanceOk) return this.skip(job, `insufficient balance (${q.balanceNote})`);
      if (job.side === 'sell' && q.amountInHuman > replay(this.modeTrades()).plsHeld * 1.000001 + 1e-9) {
        return this.skip(job, `sell exceeds ${this.baseSym} bought by the bot`);
      }
      if (job.side === 'sell' && !job.manual) {
        // Only sell a lot above its own buy cost: expected proceeds − sell gas must exceed the lot's cost.
        const lot = this.state.intervals.find((i) => i.index === job.intervalIndex)?.lotCost;
        if (lot != null) {
          const net = q.quotedOutHuman - q.gasPlsEstimate * q.price - lot;
          if (!(net > 0)) {
            return this.skip(job, `sell would lose vs lot cost: out ${q.quotedOutHuman.toPrecision(6)} − gas ${(q.gasPlsEstimate * q.price).toPrecision(3)} ≤ lot ${lot.toPrecision(6)} ${this.state.stable}; holding`);
          }
        }
      }

      this.state.inFlight = { job, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, amountInHuman: q.amountInHuman, price: q.price, quotedOutHuman: q.quotedOutHuman, deadline: Number(q.call.deadline), basePerNative: q.basePerNative, minOutHuman: q.minOutHuman };
      this.save();
      try {
        const f = await this.executor.execute(q, {
          canSend: () => this.state.status === 'running',
          onSent: (stage, hash) => {
            if (!this.state.inFlight) return;
            if (stage === 'approve') this.state.inFlight.approvalTxHash = hash; else this.state.inFlight.swapTxHash = hash;
            this.save();
            this.tag('info', `sent ${stage} ${hash}`);
            this.ev('sent', `Grid ${this.label}: sent ${stage} ${hash.slice(0, 12)}…`, { data: { hash, stage } });
          },
        });
        this.recordFill(job, this.fillArgs(job, f, q.price));
        this.state.inFlight = null;
        this.save();
        this.checkShortfall(f);
        return;
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        if (o.pending) {
          this.tag('warn', `${(e as Error).message} — will reconcile ${o.swapTxHash} by hash; no resend.`);
          this.save();
          return;
        }
        this.state.inFlight = null;
        this.recordFailure(job, o.gasPls ?? 0, q.price, o.swapTxHash ?? o.approvalTxHash, (e as Error).message);
        if (o.aborted) { this.skip(job, 'stopped'); this.save(); return; }
        if (/reverted/.test((e as Error).message)) this.hub.suspect(this.state.stable, `swap reverted on ${this.label}`);
        this.tag('error', `execute failed (${attempt}/${maxAttempts}): ${(e as Error).message}`);
        this.save();
        if (!o.retryable || attempt === maxAttempts) {
          this.skip(job, 'execution failed');
          if (this.state.closing && job.id.startsWith(CLOSE_JOB)) this.closeFailed((e as Error).message);
          return;
        }
        await sleep(this.d.retryDelayMs ?? 5000);
      }
    }
  }

  private fillArgs(job: QueuedTrade, f: Fill, quotedPrice: number) {
    return {
      plsAmount: job.side === 'buy' ? f.amountOutHuman : f.amountInHuman,
      stableAmount: job.side === 'buy' ? f.amountInHuman : f.amountOutHuman,
      gasPls: f.gasPls, txHash: f.txHash, approvalTxHash: f.approvalTxHash, quotedPrice, fromReceipt: f.fromReceipt,
      taxPct: f.taxPct, outSource: f.outSource, expectedOut: f.expectedOutHuman,
    };
  }

  /** Received clearly less than the post-tax quote on a custom token → ask the tax watcher to re-check now. */
  private checkShortfall(f: Fill) {
    if (!this.def?.safety || f.shortfallPct == null) return;
    const tol = Math.max(0.005, this.state.limits.slippageBps / 20_000);
    if (f.shortfallPct > tol) {
      this.tag('warn', `received ${(f.shortfallPct * 100).toFixed(2)}% less than the post-tax quote (${f.outSource}) — tax re-check requested`);
      this.hub.suspect(this.state.stable, `fill ${(f.shortfallPct * 100).toFixed(2)}% short of the post-tax quote on ${this.label}`);
    }
  }

  async reconcile(): Promise<void> {
    const f = this.state.inFlight;
    if (!f) return;
    const job = f.job;
    if (!f.swapTxHash) {
      this.state.inFlight = null;
      this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
      this.skip(job, 'interrupted before swap was sent');
      this.save();
      return;
    }
    const r = await this.executor.recover(f.swapTxHash, f.tokenOut, f.decimalsOut, f.basePerNative);
    if (r == null) {
      if (this.now() / 1000 > f.deadline + 300) {
        this.state.inFlight = null;
        this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
        this.skip(job, `swap ${f.swapTxHash} never mined before its deadline`);
        this.save();
      }
      return;
    }
    // mined OK but what arrived can't be read: the swap's guaranteed minimum is booked (flagged); an old record without
    // it stops the bot naming the hash, keeping the record (never guessed, never booked as a revert)
    const out = r.ok ? r.amountOutHuman ?? f.minOutHuman ?? null : null;
    if (r.ok && out == null) {
      this.state.status = 'stopped';
      this.state.halt = systemHalt('error', `swap ${f.swapTxHash} mined, but what it brought could not be read from its receipt; stopped. Check the tx on the explorer.`, this.now());
      this.save();
      return;
    }
    this.state.inFlight = null;
    this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
    if (r.gasUnknown) this.tag('warn', `swap ${f.swapTxHash}: gas ${r.gasNative.toPrecision(4)} ${this.chainCfg?.nativeSymbol ?? 'native'} not booked — ${GAS_UNKNOWN_NOTE}`);
    if (r.ok && out != null) {
      this.recordFill(job, {
        ...this.fillArgs(job, {
          txHash: f.swapTxHash, approvalTxHash: f.approvalTxHash, amountInHuman: f.amountInHuman,
          amountOutHuman: out, gasPls: r.gasPls, fromReceipt: r.amountOutHuman != null,
        }, f.price),
        gasUnknown: r.gasUnknown,
      });
    } else {
      this.recordFailure(job, r.gasPls, f.price, f.swapTxHash, r.gasUnknown ? `swap reverted (reconciled); ${GAS_UNKNOWN_NOTE}` : 'swap reverted (reconciled)', !!r.gasUnknown);
      this.skip(job, 'swap reverted');
      if (this.state.closing && job.id.startsWith(CLOSE_JOB)) this.closeFailed('swap reverted');
    }
    this.save();
  }

  status() {
    const trades = this.modeTrades();
    const t = totals(trades, this.state.lastPrice);
    const spacing = this.state.config
      ? analyzeSpacing(this.state.config.lowerPrice, this.state.config.upperPrice, this.state.config.gridCount)
      : null;
    const m = this.def, c = this.chainCfg;
    return {
      id: this.state.id,
      mode: this.state.mode, network: this.netKey, chainId: this.chainId, explorer: c?.explorer ?? this.d.net.explorer,
      chainKey: c?.key ?? this.d.net.key, chainShort: c?.short ?? 'PLS', label: this.label,
      base: this.baseSym, quoteSym: this.quoteSym, feeBps: m?.pool.feeBps ?? FEE_BPS,
      flipped: !!m?.flipped, pairKey: m?.flipOf ?? this.state.stable, spends: this.quoteSym, stacks: this.baseSym,
      gasReserve: m?.quote.native && this.state.config ? gasReserve(this.state.config.totalCapitalQuote, reserveCfg(this.state.limits)) : null,
      dex: m?.pool.dex ?? null, dexName: m ? (c?.dexes.find((x) => x.id === m.pool.dex)?.name ?? m.pool.dex) : null, feeTier: m?.pool.feeTier ?? null, poolMode: m?.poolMode ?? null, custom: !!m?.custom, risk: m?.safety?.risk ?? null, available: !(this.executor instanceof UnavailableExecutor),
      quotes: this.d.net.quotes.map((s) => s.symbol), stables: this.d.net.quotes.map((s) => s.symbol), stable: this.state.stable,
      hasSigner: this.hasSigner, status: this.state.status, closing: !!this.state.closing, archivedAt: this.state.archivedAt ?? null, halt: this.state.halt ?? null, startOverride: this.state.startOverride ?? null,
      // totalCapitalUsd: deprecated alias of totalCapitalQuote (quote coin, never dollars) for older API readers
      config: this.state.config ? { ...this.state.config, totalCapitalUsd: this.state.config.totalCapitalQuote } : null, limits: this.state.limits,
      price: this.state.lastPrice, priceAt: this.state.lastPriceAt, balances: this.balances, walletBalances: this.walletBalances,
      intervals: this.state.intervals, quotePerBuy: this.state.quotePerBuy, usdPerBuy: this.state.quotePerBuy, queue: this.state.queue, inFlight: this.state.inFlight,
      trades: trades.slice(-100).reverse().map(legacyTradeNames),
      // gasUsd / costUsd: deprecated aliases (quote coin) for older API readers
      pnl: { realized: t.realized, unrealized: t.unrealized, gasQuote: t.gasQuote, plsHeld: t.pos.plsHeld, costQuote: t.pos.costQuote, gasUsd: t.gasQuote, costUsd: t.pos.costQuote },
      profits: this.state.profits,
      payout: (() => {
        const mine = this.state.payouts.filter((x) => x.paper === (this.state.mode === 'paper'));
        return {
          pending: this.state.payoutPending, inFlight: this.state.payoutInFlight, min: this.payoutMin,
          sent: mine.reduce((a, x) => a + x.amount, 0), count: mine.filter((x) => x.ok).length, gasQuote: mine.reduce((a, x) => a + x.gasQuote, 0),
          last: mine[mine.length - 1] ?? null,
        };
      })(),
      stats: roundTripStats(trades),
      // fills, without a re-center's own seed buy: the re-center is one move (recenter.count, added by the desk)
      moveCount: trades.filter((t) => !t.failed && !t.manual && !t.recenter).length,
      lastMoveAt: trades.reduce((m, t) => (!t.failed && !t.manual ? Math.max(m, t.timestamp || 0) : m), 0) || null,
      econ: this.state.econ ?? null,
      lastError: this.lastError,
      spacing,
      spacingWarn: this.state.spacingWarn,
      equityHist: (this.state.equity ?? []).slice(-600),
      startedAt: this.state.startedAt ?? trades[0]?.timestamp ?? null,
      startPrice: this.state.startPrice ?? trades[0]?.price ?? null,
      recenter: this.state.recenter ?? null,
    };
  }
}
