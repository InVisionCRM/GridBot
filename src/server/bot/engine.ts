/**
 * Single-grid engine. Polls price, queues trades on level crosses, executes one job at a time.
 * MultiBot owns many of these and shares a TxGate + SharedNonce across them.
 */
import { calculateGridLevels } from '../../engine/gridEngine';
import { DEFAULT_LIMITS, validateLimits, type SafetyLimits } from '../../live/limits';
import { applySell, replay, roundTripStats, totals, type LiveTrade } from '../../live/ledger';
import { buildIntervals, evaluateTick, onTradeFilled, onTradeSkipped, usdPerBuyLevel, type LiveInterval, type QueuedTrade } from '../../live/liveGrid';
import type { LiveNetwork } from '../../live/networks';
import { isLegacyKey, type MarketDef } from '../../live/markets';
import type { ChainConfig } from '../../live/chains';
import { Hub } from '../chains/hub';
import { analyzeSpacing, validateGridParams } from '../../live/spacing';
import type { GridLevel } from '../../types/grid';
import { ExecError, LiveExecutor, PaperExecutor, UnavailableExecutor, type ChainReader, type Executor, type Fill, type TxSender } from './chain';
import { gridEconomics, type EconSummary } from './econ';
import { FEE_BPS, MIN_SPACING_PCT } from '../../live/economics';
import type { Logger } from './logger';
import type { Store } from './store';
import type { SharedNonce, TxGate } from './txGate';
import type { Emit } from './activity';
import { pushCapped } from '../../market/stats';
import { checkGasReserve, gasReserve, reserveCfg } from '../../live/gasReserve';

export type Mode = 'paper' | 'live';
export type Status = 'idle' | 'running' | 'stopped';

export interface GridConfig { lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalUsd: number }

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
  /**
   * PAPER ONLY: simulate a grid whose round-trip economics are not net-positive (recorded as warning).
   * Ignored in live mode: live starts are hard-blocked unless every round-trip clears fee + impact + gas.
   */
  allowTightSpacing?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newId() {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function freshState(net: LiveNetwork, id?: string): BotState {
  return {
    version: 1, id: id ?? newId(), mode: 'paper', network: net.key, stable: net.defaultQuote, status: 'idle', config: null,
    limits: { ...DEFAULT_LIMITS }, levels: [], intervals: [], usdPerBuy: 0, queue: [], inFlight: null,
    trades: [], paperStartStable: 0, lastPrice: null, lastPriceAt: null, spacingWarn: null,
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
    if (this.state.mode === 'live' && !this.signer) {
      this.tag('warn', 'LIVE mode but no PRIVATE_KEY — stopped.');
      this.state.status = 'stopped';
    }
    const legacy = this.liveSpacingBlock();
    if (legacy && this.state.status === 'running') {
      this.tag('warn', `${legacy} — not resuming; STOP/remove and start a net-positive grid.`);
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
    const def = this.hub.def(stable);
    if (p.mode === 'live' && !this.hub.rt(def.chainId).signer) errs.push('Live mode needs PRIVATE_KEY in .env');
    if (errs.length) throw new Error(errs.join('; '));
    if (p.mode === 'live' && def.custom) await this.requireLiveSafety(stable);

    // Economics gate: worst interval must clear the pool's round-trip fee + impact at level size + gas (+ L2 L1 fee).
    const quoter = this.hub.quoter(stable);
    const { summary: econ } = await gridEconomics(quoter, p, this.d.approval ?? 'exact');
    let warn: string | null = null;
    if (!econ.ok) {
      const why = econ.reasons.join(' ');
      if (p.mode === 'live') throw new Error(`LIVE start blocked — not net-positive per round-trip: ${why}`);
      if (!p.allowTightSpacing) throw new Error(`${why} (paper only: pass allowTightSpacing to simulate anyway)`);
      warn = `PAPER ONLY — would be blocked live: ${why}`;
    }

    const executor = this.makeExecutor(p.mode, stable);
    // Native-spending grid (flipped HEX/PLS …): capital + gas reserve must fit in the native balance; the reserve
    // pays gas and is never traded.
    if (p.mode === 'live' && def.quote.native) {
      const bal = await executor.balances();
      const chk = checkGasReserve({ capital: p.totalCapitalUsd, balance: bal.stable, cfg: reserveCfg(limits), symbol: def.quote.symbol });
      if (!chk.ok) throw new Error(`LIVE start blocked — ${chk.reason}`);
    }
    const price = await executor.getPrice();
    const levels = calculateGridLevels(p.lowerPrice, p.upperPrice, p.gridCount);
    const intervals = buildIntervals(levels, price);
    const usdPerBuy = usdPerBuyLevel(intervals, p.totalCapitalUsd);
    if (usdPerBuy === 0) throw new Error(`No grid levels below the current price (${price}).`);

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
    };
    this.lastError = null;
    this.save();
    this.tag('info', `Started ${p.mode.toUpperCase()} ${this.label} ${p.lowerPrice}–${p.upperPrice} ×${p.gridCount}, ${usdPerBuy.toPrecision(5)} ${stable}/buy, spacing ${(econ.spacingPct * 100).toFixed(3)}%, impact ${(econ.impactPct * 100).toFixed(3)}%, gas ${econ.gasQuote.toPrecision(3)} ${stable}/RT, net ${econ.netPerRoundTrip.toPrecision(4)} ${stable} (${(econ.netPct * 100).toFixed(3)}%)/RT worst, price ${price}`);
    if (warn) this.tag('warn', warn);
    this.ev('started', `Grid started — ${this.label} ${p.lowerPrice.toPrecision(4)}–${p.upperPrice.toPrecision(4)} ×${p.gridCount} (${p.mode})`, { level: 'success' });
  }

  /** Custom tokens: re-run the eth_call buy/sell simulation before going live; honeypot / tax / unknown → refuse. */
  private async requireLiveSafety(key: string) {
    let s = this.hub.def(key).safety ?? null;
    try { s = await this.hub.recheck(key); } catch (e) { this.tag('warn', `safety re-check failed: ${(e as Error).message}`); }
    if (!s?.liveAllowed) {
      throw new Error(`LIVE blocked — ${this.hub.label(key)} safety ${s?.risk ?? 'unknown'}: ${(s?.reasons ?? ['no safety check']).join(' ')}`);
    }
  }

  /** Live grids saved before the economics gate (e.g. old ±2.5%×36 tight scalp) must not auto-resume. */
  private liveSpacingBlock(): string | null {
    const c = this.state.config;
    if (this.state.mode !== 'live' || !c) return null;
    if (this.state.econ && !this.state.econ.ok) return 'LIVE grid is not net-positive per round-trip';
    const sp = analyzeSpacing(c.lowerPrice, c.upperPrice, c.gridCount);
    return sp.worstSpacingFrac < MIN_SPACING_PCT
      ? `LIVE grid spacing ${(sp.worstSpacingFrac * 100).toFixed(3)}% < ${(MIN_SPACING_PCT * 100).toFixed(1)}% floor (round-trip fee ${(sp.roundTripFee * 100).toFixed(3)}%)`
      : null;
  }

  resume() {
    if (this.state.status === 'running') return;
    if (!this.state.config) throw new Error('No grid to resume.');
    const block = this.liveSpacingBlock();
    if (block) throw new Error(`${block}. Start a new grid instead.`);
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    if (this.state.mode === 'live' && !this.signer) throw new Error('Live mode needs PRIVATE_KEY in .env');
    if (this.state.mode === 'live' && this.def?.custom && this.def.safety && !this.def.safety.liveAllowed) throw new Error(`LIVE blocked — safety ${this.def.safety.risk}`);
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
        const { intervals, queued } = evaluateTick(this.state.intervals, price, this.state.usdPerBuy, this.now());
        this.state.intervals = intervals;
        if (queued.length) {
          this.state.queue.push(...queued);
          this.tag('info', `Price ${price}: triggered ${queued.map((q) => `${q.side}@${q.levelPrice}`).join(', ')}`);
          this.ev('queued', `Grid ${this.label}: queued ${queued.map((q) => `${q.side} @ ${q.levelPrice.toPrecision(5)}`).join(', ')}`);
        }
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
      fromReceipt: f.fromReceipt, feeQuote, lotCost, roundTripNet,
      ...(f.taxPct ? { taxPct: f.taxPct } : {}), ...(f.outSource ? { outSource: f.outSource } : {}), ...(f.expectedOut != null ? { expectedOut: f.expectedOut } : {}),
      ...(this.def ? { dex: this.def.pool.dex, feeBps: this.def.pool.feeBps, ...(this.def.pool.feeTier != null ? { feeTier: this.def.pool.feeTier } : {}) } : {}),
    });
    this.state.intervals = onTradeFilled(this.state.intervals, job, job.side === 'buy' ? plsAmount : 0, job.side === 'buy' ? lotCost : undefined);
    const sym = this.def?.quote.symbol ?? this.state.stable, bs = this.baseSym;
    this.ev('filled', `Grid ${this.label}: ${job.side === 'buy' ? 'BOUGHT' : 'SOLD'} ${plsAmount.toPrecision(6)} ${bs} @ ${execPrice.toPrecision(6)}${roundTripNet != null ? ` — RT net ${roundTripNet >= 0 ? '+' : ''}${roundTripNet.toPrecision(4)} ${sym}` : ''}`, {
      level: job.side === 'sell' ? (realized >= 0 ? 'success' : 'warn') : 'success', notify: true,
      data: { side: job.side, price: execPrice, pls: plsAmount, level: job.levelPrice, pnl: roundTripNet },
    });
    this.tag('info', `FILLED ${job.side} ${plsAmount.toPrecision(6)} ${bs} ↔ ${stableAmount.toPrecision(6)} ${sym} | trig ${job.triggerPrice.toPrecision(6)} lvl ${job.levelPrice.toPrecision(6)} quote ${f.quotedPrice.toPrecision(6)} exec ${execPrice.toPrecision(6)} slip ${(slippagePct * 100).toFixed(3)}%${f.fromReceipt ? '' : ' (no receipt log)'} | gas ${gasQuote.toPrecision(3)} ${sym} | tx ${f.txHash}${roundTripNet != null ? ` | RT net ${roundTripNet.toPrecision(4)} ${sym}` : ''}`);
  }

  private async runJob(job: QueuedTrade): Promise<void> {
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
    if (!this.def?.custom || f.shortfallPct == null) return;
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
      stats: roundTripStats(trades),
      econ: this.state.econ ?? null,
      lastError: this.lastError,
      spacing,
      spacingWarn: this.state.spacingWarn,
      equityHist: (this.state.equity ?? []).slice(-600),
      startedAt: this.state.startedAt ?? trades[0]?.timestamp ?? null,
      startPrice: this.state.startPrice ?? trades[0]?.price ?? null,
    };
  }
}
