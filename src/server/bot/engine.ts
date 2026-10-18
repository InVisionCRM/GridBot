/**
 * Single-grid engine. Polls price, queues trades on level crosses, executes one job at a time.
 * MultiBot owns many of these and shares a TxGate + SharedNonce across them.
 */
import { calculateGridLevels } from '../../engine/gridEngine';
import { DEFAULT_LIMITS, validateLimits, type SafetyLimits } from '../../live/limits';
import { applySell, replay, roundTripStats, totals, type LiveTrade } from '../../live/ledger';
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
import { RECENTER_AFTER_MS, RECENTER_COOLDOWN_MS, type RecenterState } from '../../live/recenter';

export type Mode = 'paper' | 'live';
export type Status = 'idle' | 'running' | 'stopped';

export interface GridConfig { lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalUsd: number }

/** What happens to a completed trade's profit: added to that level's next buy, or sent to an address. */
export type ProfitMode = { mode: 'reinvest' } | { mode: 'send'; to: string };
/** One profit transfer (paper: bookkeeping only) */
export interface Payout { at: number; amount: number; to: string; txHash: string; gasQuote: number; ok: boolean; paper: boolean }
/** Profits wait until they are worth this many times the transfer's gas, so fees never eat them. */
export const PAYOUT_MIN_GAS_MULTIPLE = 10;
/** After a failed transfer, wait this long before trying again. */
export const PAYOUT_RETRY_MS = 10 * 60_000;

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
  usdPerBuy: number;
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
  payoutInFlight: { hash: string; amount: number; to: string; at: number } | null;
  payouts: Payout[];
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

export interface StartParams extends GridConfig {
  mode: Mode;
  stable?: string;
  limits?: Partial<SafetyLimits>;
  /** Auto-recenter (follow the price up); omitted = keep this grid's current setting */
  recenter?: boolean;
  /** Reinvest (default) or send profits to an address; omitted = keep this grid's current setting */
  profits?: ProfitMode;
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

function newId() {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function freshState(net: LiveNetwork, id?: string): BotState {
  return {
    version: 1, id: id ?? newId(), mode: 'paper', network: net.key, stable: net.defaultQuote, status: 'idle', config: null,
    limits: { ...DEFAULT_LIMITS }, levels: [], intervals: [], usdPerBuy: 0, queue: [], inFlight: null,
    trades: [], paperStartStable: 0, lastPrice: null, lastPriceAt: null, spacingWarn: null,
    profits: { mode: 'reinvest' }, payoutPending: 0, payoutInFlight: null, payouts: [],
  };
}

export class GridEngine {
  state: BotState;
  balances: { pls: number; stable: number } | null = null;
  walletBalances: { pls: number; stable: number } | null = null;
  lastError: string | null = null;
  private executor: Executor;
  private draining = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  readonly hub: Hub;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.hub = d.hub ?? Hub.single(d.net, d.reader, d.signer, { gate: d.txGate, nonce: d.sharedNonce });
    const loaded = d.store.load();
    const base = freshState(d.net, d.id);
    // Legacy PulseChain keys must match the configured network; multi-chain keys carry their chain.
    const accept = loaded && (isLegacyKey(loaded.stable ?? d.net.defaultQuote) ? loaded.network === d.net.key : true);
    this.state = accept
      ? { ...base, ...loaded!, id: loaded!.id || d.id || base.id, spacingWarn: loaded!.spacingWarn ?? null }
      : base;
    // Saved before per-level buy sizes: every funded level spent the grid's one buy size; levels above the old start
    // price never had money (0, so a later re-range spreads only the real capital).
    this.state.intervals = this.state.intervals.map((iv) => (iv.buyAmount == null ? { ...iv, buyAmount: iv.status === 'inactive' ? 0 : this.state.usdPerBuy } : iv));
    if (this.state.mode === 'live' && !this.signer) {
      this.tag('warn', 'LIVE mode but no PRIVATE_KEY — stopped.');
      this.state.status = 'stopped';
    }
    this.executor = this.makeExecutor(this.state.mode, this.state.stable);
    if (this.executor instanceof UnavailableExecutor && this.state.status === 'running') {
      this.tag('warn', `${this.state.stable}: ${this.lastError} — stopped.`);
      this.state.status = 'stopped';
    }
    if (this.state.status === 'running') this.tag('info', `Resuming ${this.state.mode} ${this.label} from saved state.`);
  }

  /** Market definition (null when the saved market is no longer configured). */
  get def(): MarketDef | null { return this.hub.has(this.state.stable) ? this.hub.def(this.state.stable) : null; }
  get chainCfg(): ChainConfig | null { const m = this.def; return m ? this.hub.chain(m.chainId) : null; }
  get chainId(): number { return this.def?.chainId ?? this.d.net.chainId; }
  get label() { return this.hub.label(this.state.stable); }
  get baseSym() { return this.def?.base.symbol ?? 'PLS'; }
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
    this.d.emit?.({ type, msg, botId: this.state.id, kind: 'grid', pair: this.state.stable, chainId: this.chainId, ...extra });
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
      if (!rt.signer) throw new Error('Live mode needs PRIVATE_KEY in .env');
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
    if (this.state.status === 'running') throw new Error('Already running. Stop first.');
    if (this.state.inFlight) throw new Error('A transaction from the previous run is still being reconciled.');
    const limits = { ...this.state.limits, ...(p.limits ?? {}) };
    const errs = [...validateLimits(limits), ...validateGridParams(p.lowerPrice, p.upperPrice, p.gridCount, p.totalCapitalUsd)];
    const stable = p.stable ?? this.state.stable;
    if (this.state.config && stable !== this.state.stable) throw new Error(`This grid trades ${this.hub.label(this.state.stable)}; its pair can't change. Add a new grid for ${this.hub.label(stable)}.`);
    const def = this.hub.def(stable);
    if (p.mode === 'live' && !this.hub.rt(def.chainId).signer) errs.push('Live mode needs PRIVATE_KEY in .env');
    if (errs.length) throw new Error(errs.join('; '));
    if (p.mode === 'live' && def.safety) await this.requireLiveSafety(stable);

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
      const chk = checkGasReserve({ capital: p.totalCapitalUsd, balance: bal.stable, cfg: reserveCfg(limits), symbol: def.quote.symbol });
      if (!chk.ok) throw new Error(chk.reason!);
    }
    const price = await executor.getPrice();
    const levels = calculateGridLevels(p.lowerPrice, p.upperPrice, p.gridCount);
    const usdPerBuy = buyAmountPerInterval(p.gridCount, p.totalCapitalUsd);
    const intervals = buildIntervals(levels, price, usdPerBuy);
    if (!intervals.some((i) => i.status === 'waitingBuy')) throw new Error(`The price (${price}) is below the range. Start when it's inside the range, or lower the range.`);
    const profits = checkProfitMode(p.profits ?? this.state.profits);
    await this.checkPayoutTarget(profits);

    this.executor = executor;
    const paperReset = p.mode === 'paper';
    this.state = {
      ...this.state, mode: p.mode, stable, limits, status: 'running',
      config: { lowerPrice: p.lowerPrice, upperPrice: p.upperPrice, gridCount: p.gridCount, totalCapitalUsd: p.totalCapitalUsd },
      levels, intervals, usdPerBuy, queue: [], inFlight: null,
      trades: paperReset ? this.state.trades.filter((t) => !t.paper) : this.state.trades,
      paperStartStable: paperReset ? p.totalCapitalUsd : this.state.paperStartStable,
      lastPrice: price, lastPriceAt: this.now(),
      spacingWarn: warn, econ,
      startedAt: this.now(), startPrice: price, equity: [[this.now(), p.totalCapitalUsd]],
      recenter: { enabled: p.recenter ?? this.state.recenter?.enabled ?? false, aboveSince: null, lastAt: this.state.recenter?.lastAt ?? null, count: this.state.recenter?.count ?? 0 },
      profits,
      ...(paperReset ? { payoutPending: 0, payoutInFlight: null, payouts: this.state.payouts.filter((x) => !x.paper) } : {}),
    };
    this.seedUpper(price);
    this.lastError = null;
    this.save();
    this.tag('info', `Started ${p.mode.toUpperCase()} ${this.label} ${p.lowerPrice}–${p.upperPrice} ×${p.gridCount}, ${usdPerBuy.toPrecision(5)} ${stable}/buy, spacing ${(econ.spacingPct * 100).toFixed(3)}%, impact ${(econ.impactPct * 100).toFixed(3)}%, gas ${econ.gasQuote.toPrecision(3)} ${stable}/RT, net ${econ.netPerRoundTrip.toPrecision(4)} ${stable} (${(econ.netPct * 100).toFixed(3)}%)/RT worst, price ${price}`);
    if (warn) this.tag('warn', warn);
    this.ev('started', `Grid started — ${this.label} ${p.lowerPrice.toPrecision(4)}–${p.upperPrice.toPrecision(4)} ×${p.gridCount} (${p.mode})`, { level: 'success' });
  }

  /** Markets with a safety report (custom tokens, verified built-ins): re-run the eth_call buy/sell simulation before going live; honeypot / tax / unknown → refuse. */
  private async requireLiveSafety(key: string) {
    let s = this.hub.def(key).safety ?? null;
    try { s = await this.hub.recheck(key); } catch (e) { this.tag('warn', `safety re-check failed: ${(e as Error).message}`); }
    if (!s?.liveAllowed) {
      throw new Error(`LIVE blocked — ${this.hub.label(key)} safety ${s?.risk ?? 'unknown'}: ${(s?.reasons ?? ['no safety check']).join(' ')}`);
    }
  }

  resume() {
    if (this.state.status === 'running') return;
    if (!this.state.config) throw new Error('No grid to resume.');
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    if (this.state.mode === 'live' && !this.signer) throw new Error('Live mode needs PRIVATE_KEY in .env');
    if (this.state.mode === 'live' && this.def?.safety && !this.def.safety.liveAllowed) throw new Error(`LIVE blocked — safety ${this.def.safety.risk}`);
    this.state.status = 'running';
    this.save();
    this.tag('info', 'Resumed.');
    this.ev('started', `Grid resumed — ${this.label}`);
  }

  stop(why?: string) {
    const dropped = this.state.queue;
    this.state.intervals = dropped.reduce((iv, q) => onTradeSkipped(iv, q), this.state.intervals);
    this.state.queue = [];
    this.state.status = 'stopped';
    this.save();
    this.ev('stopped', `Grid ${this.label} ${why ? `paused — ${why}` : 'stopped'}`, { level: why ? 'error' : 'warn', notify: true });
    this.tag('warn', `${why ? `PAUSED (${why})` : 'STOPPED'}. ${dropped.length} queued dropped.${this.state.inFlight?.swapTxHash ? ` Swap ${this.state.inFlight.swapTxHash} already broadcast; will reconcile.` : ''}`);
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
    if (price <= c.upperPrice) { r.aboveSince = null; return; }
    const now = this.now();
    r.aboveSince ??= now;
    if (now - r.aboveSince < RECENTER_AFTER_MS) return;
    if (r.lastAt != null && now - r.lastAt < RECENTER_COOLDOWN_MS) return;
    if (this.state.inFlight || this.state.queue.length || this.state.intervals.some((i) => i.status !== 'inactive' && i.status !== 'waitingBuy')) return;
    const band = (c.upperPrice - c.lowerPrice) / (c.upperPrice + c.lowerPrice);
    const next: GridConfig = { ...c, lowerPrice: +(price * (1 - band)).toPrecision(6), upperPrice: +(price * (1 + band)).toPrecision(6) };
    const { summary: econ } = await gridEconomics(this.hub.quoter(this.state.stable), next, this.d.approval ?? 'exact');
    const levels = calculateGridLevels(next.lowerPrice, next.upperPrice, next.gridCount);
    // Everything is sold at this point: the levels' buy sizes (start size + reinvested profit) carry over, spread evenly.
    const perLevel = this.state.intervals.reduce((a, i) => a + i.buyAmount, 0) / next.gridCount;
    const intervals = buildIntervals(levels, price, perLevel);
    this.state = {
      ...this.state, config: next, levels, intervals, usdPerBuy: perLevel, queue: [],
      econ, spacingWarn: econWarning(econ),
      recenter: { enabled: true, aboveSince: null, lastAt: now, count: r.count + 1 },
    };
    this.seedUpper(price);
    this.save();
    const msg = `Grid ${this.label}: price stayed above the range for ${RECENTER_AFTER_MS / 3600_000}h, so the range moved up to ${next.lowerPrice.toPrecision(5)}–${next.upperPrice.toPrecision(5)} (±${(band * 100).toFixed(0)}%, ${next.gridCount} levels)`;
    this.tag('info', msg);
    this.ev('range', msg, { level: 'success', notify: true, data: { recenter: true, lowerPrice: next.lowerPrice, upperPrice: next.upperPrice } });
  }

  /**
   * Coins for the levels at or above the price (seedIntervals): first coins this grid already holds that no level
   * owns (a live restart), then one start-up buy queued for the rest.
   */
  private seedUpper(price: number) {
    const pos = replay(this.modeTrades());
    const owned = this.state.intervals.reduce((a, i) => a + (i.status === 'holding' ? i.plsAmount : 0), 0);
    const free = Math.max(0, pos.plsHeld - owned);
    const avg = pos.plsHeld > 0 ? pos.costUsd / pos.plsHeld : 0;
    const { intervals, job } = seedIntervals(this.state.intervals, price, { pls: free, cost: free * avg }, this.now());
    const fromHeld = intervals.filter((iv, i) => iv.status === 'holding' && this.state.intervals[i].status !== 'holding').length;
    this.state.intervals = intervals;
    if (job) this.state.queue.push(job);
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
      if (!r) return;
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
      const hash = await this.executor.sendTransfer(to, amount);
      s.payoutInFlight = { hash, amount, to, at: this.now() };
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

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.state.inFlight && !this.draining) await this.reconcile();
      const price = await this.executor.getPrice();
      this.state.lastPrice = price;
      this.state.lastPriceAt = this.now();
      this.hub.setSpot(this.state.stable, price);
      try { this.balances = await this.executor.balances(); } catch { /* keep last */ }
      const signer = this.signer;
      if (signer) {
        try {
          if (this.executor.mode === 'live') this.walletBalances = this.balances;
          else {
            const q = this.hub.quoter(this.state.stable);
            const a = await signer.getAddress();
            const [b, st] = await Promise.all([
              q.base.native ? q.reader.getBalance(a) : q.tokenBalance(a, q.base.address),
              q.stable.native ? q.reader.getBalance(a) : q.tokenBalance(a, q.stable.address),
            ]);
            this.walletBalances = { pls: Number(b) / 10 ** q.base.decimals, stable: Number(st) / 10 ** q.stable.decimals };
          }
        } catch { /* keep last */ }
      }
      if (this.state.status === 'running' && !this.state.inFlight) {
        const { intervals, queued } = evaluateTick(this.state.intervals, price, this.now());
        this.state.intervals = intervals;
        if (queued.length) {
          this.state.queue.push(...queued);
          this.tag('info', `Price ${price}: triggered ${queued.map((q) => `${q.side}@${q.levelPrice}`).join(', ')}`);
          this.ev('queued', `Grid ${this.label}: queued ${queued.map((q) => `${q.side} @ ${q.levelPrice.toPrecision(5)}`).join(', ')}`);
        }
        await this.followUp(price);
      }
      if (this.state.config && this.state.status === 'running') {
        const eq = this.state.equity ??= [];
        if (!eq.length || this.now() - eq[eq.length - 1][0] >= 60_000) {
          const t = totals(this.modeTrades(), price);
          pushCapped(eq, [this.now(), this.state.config.totalCapitalUsd + t.realized + t.unrealized], 3000);
        }
      }
      this.save();
      await this.drain();
      await this.payOut(price);
      // A tick that got through means the last error (often one RPC timeout) is over; the Activity log keeps it.
      this.lastError = null;
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
        const job = this.state.queue[0];
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

  private skip(job: QueuedTrade, why: string) {
    this.state.intervals = onTradeSkipped(this.state.intervals, job);
    this.tag('warn', `Skipped ${job.side}@${job.levelPrice}: ${why}`);
    this.ev('skipped', `Grid ${this.label}: skipped ${job.side} @ ${job.levelPrice.toPrecision(5)} — ${why}`, { level: 'warn' });
  }

  private recordFailure(job: QueuedTrade, gasPls: number, price: number, hash: string | undefined, note: string) {
    if (!(gasPls > 0)) return;
    const gasUsd = gasPls * price;
    this.state.trades.push({
      id: hash ?? `fail-${this.now()}`, network: this.netKey, side: job.side, intervalIndex: job.intervalIndex,
      stable: this.state.stable, plsAmount: 0, stableAmount: 0, price: 0, gasPls, gasUsd, txHash: hash ?? '',
      timestamp: this.now(), realizedPnlUsd: -gasUsd, failed: true, paper: this.state.mode === 'paper', note,
    });
  }

  /**
   * Record a fill from actual amounts (receipt in live). All prices quote per PLS.
   * Buys store the lot cost on the interval; sells realize PnL against exactly that lot.
   */
  private recordFill(job: QueuedTrade, f: {
    plsAmount: number; stableAmount: number; gasPls: number; txHash: string; approvalTxHash?: string;
    quotedPrice: number; fromReceipt: boolean; taxPct?: number; outSource?: Fill['outSource']; expectedOut?: number;
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
    if (job.side === 'buy') {
      lotCost = stableAmount + gasQuote;
    } else {
      const pos = replay(this.modeTrades());
      lotCost = iv?.lotCost ?? (pos.plsHeld > 0 ? (pos.costUsd / pos.plsHeld) * plsAmount : undefined);
      realized = applySell(pos, plsAmount, stableAmount, gasQuote, lotCost).realized;
      roundTripNet = realized;
    }
    this.state.trades.push({
      id: f.txHash, network: this.netKey, side: job.side, intervalIndex: job.intervalIndex, stable: this.state.stable,
      plsAmount, stableAmount, price: execPrice, gasPls, gasUsd: gasQuote, txHash: f.txHash, approvalTxHash: f.approvalTxHash,
      timestamp: this.now(), realizedPnlUsd: realized, paper: this.state.mode === 'paper',
      triggerPrice: job.triggerPrice, levelPrice: job.levelPrice, quotedPrice: f.quotedPrice, execPrice, slippagePct,
      fromReceipt: f.fromReceipt, feeQuote, lotCost, roundTripNet, ...(job.seed ? { seed: job.seed } : {}),
      ...(f.taxPct ? { taxPct: f.taxPct } : {}), ...(f.outSource ? { outSource: f.outSource } : {}), ...(f.expectedOut != null ? { expectedOut: f.expectedOut } : {}),
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
      // Units guard: the router quote's effective price must be in the same units/direction as the trigger
      // (quote per PLS). A decimals or inversion bug shows up as orders-of-magnitude divergence.
      const ref = this.state.lastPrice ?? job.triggerPrice;
      // Pool price WITHOUT token taxes: a 10% tax must not trip the guard, a decimals bug (10^n off) always does.
      const qp = q.poolPrice ?? q.price;
      if (ref > 0 && (qp / ref > 1.5 || qp / ref < 1 / 1.5)) {
        return this.skip(job, `quote price ${qp.toPrecision(6)} inconsistent with spot ${ref.toPrecision(6)} ${this.def?.quote.symbol ?? this.state.stable}/${this.baseSym} — units/decimals mismatch, refusing`);
      }
      if (q.priceImpact > this.state.limits.maxPriceImpact) {
        return this.skip(job, `price impact ${(q.priceImpact * 100).toFixed(2)}% > cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%`);
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

      this.state.inFlight = { job, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, amountInHuman: q.amountInHuman, price: q.price, quotedOutHuman: q.quotedOutHuman, deadline: Number(q.call.deadline) };
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
        if (!o.retryable || attempt === maxAttempts) return this.skip(job, 'execution failed');
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
    const r = await this.executor.recover(f.swapTxHash, f.tokenOut, f.decimalsOut);
    if (r == null) {
      if (this.now() / 1000 > f.deadline + 300) {
        this.state.inFlight = null;
        this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
        this.skip(job, `swap ${f.swapTxHash} never mined before its deadline`);
        this.save();
      }
      return;
    }
    this.state.inFlight = null;
    this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
    if (r.ok && r.amountOutHuman > 0) {
      this.recordFill(job, this.fillArgs(job, {
        txHash: f.swapTxHash, approvalTxHash: f.approvalTxHash, amountInHuman: f.amountInHuman,
        amountOutHuman: r.amountOutHuman, gasPls: r.gasPls, fromReceipt: true,
      }, f.price));
    } else {
      this.recordFailure(job, r.gasPls, f.price, f.swapTxHash, 'swap reverted (reconciled)');
      this.skip(job, 'swap reverted');
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
      base: this.baseSym, quoteSym: m?.quote.symbol ?? this.state.stable, feeBps: m?.pool.feeBps ?? FEE_BPS,
      flipped: !!m?.flipped, pairKey: m?.flipOf ?? this.state.stable, spends: m?.quote.symbol ?? this.state.stable, stacks: this.baseSym,
      gasReserve: m?.quote.native && this.state.config ? gasReserve(this.state.config.totalCapitalUsd, reserveCfg(this.state.limits)) : null,
      dex: m?.pool.dex ?? null, dexName: m ? (c?.dexes.find((x) => x.id === m.pool.dex)?.name ?? m.pool.dex) : null, feeTier: m?.pool.feeTier ?? null, poolMode: m?.poolMode ?? null, custom: !!m?.custom, risk: m?.safety?.risk ?? null, available: !(this.executor instanceof UnavailableExecutor),
      quotes: this.d.net.quotes.map((s) => s.symbol), stables: this.d.net.quotes.map((s) => s.symbol), stable: this.state.stable,
      hasSigner: this.hasSigner, status: this.state.status, config: this.state.config, limits: this.state.limits,
      price: this.state.lastPrice, priceAt: this.state.lastPriceAt, balances: this.balances, walletBalances: this.walletBalances,
      intervals: this.state.intervals, usdPerBuy: this.state.usdPerBuy, queue: this.state.queue, inFlight: this.state.inFlight,
      trades: trades.slice(-100).reverse(),
      pnl: { realized: t.realized, unrealized: t.unrealized, gasUsd: t.gasUsd, plsHeld: t.pos.plsHeld, costUsd: t.pos.costUsd },
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
