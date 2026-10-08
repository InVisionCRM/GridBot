/**
 * Long-only trend bot: holds either PLS or its quote token. Signals on CLOSED candles from the CandleStore
 * (same strategy code as the backtester); ATR stop / take-profit checked on every poll price; trailing stop
 * ratchets on each closed candle's high. Executes through the same Executor, TxGate and SharedNonce as the
 * grids, with the units guard, price-impact cap, slippage and deadline from SafetyLimits.
 * Inventory is the bot's own: `cash` (quote) and `position.pls` — never the wallet's other funds.
 */
import { DEFAULT_LIMITS, validateLimits, type SafetyLimits } from '../../live/limits';
import type { LiveNetwork } from '../../live/networks';
import { checkGasReserve, gasReserve, reserveCfg } from '../../live/gasReserve';
import { isLegacyKey, type MarketDef } from '../../live/markets';
import { Hub } from '../chains/hub';
import type { LiveTrade } from '../../live/ledger';
import { FEE_BPS } from '../../live/economics';
import { TF_SEC, bucketStart, closedOnly, fillGaps, isTF, type Candle, type TF } from '../../market/candles';
import { DEFAULT_COSTS, type CostModel } from '../../market/costs';
import {
  computeIndicators, costGate, expectedMovePct, htfAllows, openRisk, positionSize, priceExit, signalAt, trail,
  validateTrendConfig, warmup, DEFAULT_TREND, type ExitReason, type RiskState, type TrendConfig,
} from '../../market/strategy';
import { tradeStats, pushCapped, drawdown } from '../../market/stats';
import { ExecError, LiveExecutor, PaperExecutor, UnavailableExecutor, type ChainReader, type Executor, type Fill, type MarketSnapshot, type Quote, type TxSender } from './chain';
import type { Emit } from './activity';
import type { Logger } from './logger';
import type { Store } from './store';
import type { SharedNonce, TxGate } from './txGate';
import type { Mode, Status } from './engine';

export type TrendReason = 'entry' | ExitReason;

export interface TrendPosition {
  pls: number;
  /** Quote spent + buy gas (in quote) */
  cost: number;
  entryPrice: number;
  entryAt: number;
  risk: RiskState;
  /** Closed candles held */
  bars: number;
  txHash: string;
}

export interface TrendJob {
  id: string;
  side: 'buy' | 'sell';
  reason: TrendReason;
  /** quote for buys, PLS for sells */
  amount: number;
  triggerPrice: number;
  createdAt: number;
  atr?: number;
  manual?: boolean;
}

export interface TrendInFlight {
  job: TrendJob;
  tokenOut: string;
  decimalsOut: number;
  amountInHuman: number;
  price: number;
  quotedOutHuman: number;
  deadline: number;
  approvalTxHash?: string;
  swapTxHash?: string;
}

export interface TrendTrade extends LiveTrade {
  reason: TrendReason;
  /** sell: entry exec price and hold time */
  entryPrice?: number;
  holdMs?: number;
}

export interface TrendSignal { t: number; at: number; kind: 'enter' | 'exit' | 'blocked' | 'filtered' | 'cooldown' | 'stop_moved'; note: string }

export interface TrendState {
  kind: 'trend';
  version: 1;
  id: string;
  name: string;
  mode: Mode;
  network: string;
  quote: string;
  tf: TF;
  status: Status;
  cfg: TrendConfig;
  limits: SafetyLimits;
  /** Allocated capital (quote units) */
  capital: number;
  /** Bot's free quote balance */
  cash: number;
  position: TrendPosition | null;
  queue: TrendJob[];
  inFlight: TrendInFlight | null;
  trades: TrendTrade[];
  signals: TrendSignal[];
  /** Last closed candle evaluated (bucket start, sec) */
  lastBarT: number | null;
  /** No entries on candles starting before this (sec) */
  cooldownUntil: number;
  lastPrice: number | null;
  lastPriceAt: number | null;
  lastNote: string;
  blocked: number;
  startedAt: number | null;
  startPrice: number | null;
  /** [ms, equity in quote] */
  equity: [number, number][];
}

export interface TrendDeps {
  net: LiveNetwork;
  reader: ChainReader;
  signer: TxSender | null;
  store: Store<TrendState>;
  log: Logger;
  candles: (pair: string, tf: TF) => Candle[];
  emit?: Emit;
  txGate?: TxGate;
  sharedNonce?: SharedNonce;
  approval?: 'exact' | 'max';
  maxRetries?: number;
  retryDelayMs?: number;
  receiptTimeoutMs?: number;
  now?: () => number;
  id?: string;
  /** Override market snapshot for the cost gate (tests) */
  market?: (quote: string) => Promise<MarketSnapshot>;
  /** Expected adverse fill vs quote used by the cost gate (bps) */
  expectedSlippageBps?: number;
  /** Multi-chain hub; default = single PulseChain hub from net/reader/signer */
  hub?: Hub;
}

export interface TrendStartParams {
  mode: Mode;
  quote: string;
  tf: TF;
  cfg?: Partial<TrendConfig>;
  capital: number;
  name?: string;
  limits?: Partial<SafetyLimits>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function freshTrend(net: LiveNetwork, id?: string): TrendState {
  return {
    kind: 'trend', version: 1, id: id ?? newId(), name: '', mode: 'paper', network: net.key, quote: net.defaultQuote, tf: '1h',
    status: 'idle', cfg: { ...DEFAULT_TREND }, limits: { ...DEFAULT_LIMITS }, capital: 0, cash: 0, position: null, queue: [],
    inFlight: null, trades: [], signals: [], lastBarT: null, cooldownUntil: 0, lastPrice: null, lastPriceAt: null,
    lastNote: '', blocked: 0, startedAt: null, startPrice: null, equity: [],
  };
}

export class TrendEngine {
  state: TrendState;
  lastError: string | null = null;
  ind: Record<string, number | null> = {};
  warm = { have: 0, need: 0 };
  private executor: Executor;
  private ticking = false;
  private draining = false;
  private readonly now: () => number;
  readonly hub: Hub;

  constructor(private readonly d: TrendDeps) {
    this.now = d.now ?? Date.now;
    this.hub = d.hub ?? Hub.single(d.net, d.reader, d.signer, { gate: d.txGate, nonce: d.sharedNonce });
    const loaded = d.store.load();
    const base = freshTrend(d.net, d.id);
    const accept = loaded && (isLegacyKey(loaded.quote ?? d.net.defaultQuote) ? loaded.network === d.net.key : true);
    this.state = accept ? { ...base, ...loaded!, cfg: { ...DEFAULT_TREND, ...loaded!.cfg } } : base;
    if (this.state.mode === 'live' && !this.signer && this.state.status === 'running') {
      this.state.status = 'stopped';
      this.log('warn', 'LIVE trend bot but no PRIVATE_KEY — stopped.');
    }
    this.executor = this.makeExecutor(this.state.mode, this.state.quote);
    if (this.executor instanceof UnavailableExecutor && this.state.status === 'running') {
      this.state.status = 'stopped';
      this.log('warn', `${this.state.quote}: ${this.lastError} — stopped.`);
    }
    if (this.state.status === 'running') {
      this.log('info', `Resuming ${this.state.mode} trend ${this.label} ${this.state.tf}${this.state.position ? ` with open position ${this.state.position.pls.toPrecision(6)} ${this.baseSym}, stop ${this.state.position.risk.stop.toPrecision(6)}` : ''}.`);
    }
  }

  get id() { return this.state.id; }
  get def(): MarketDef | null { return this.hub.has(this.state.quote) ? this.hub.def(this.state.quote) : null; }
  get chainId(): number { return this.def?.chainId ?? this.d.net.chainId; }
  get label() { return this.hub.label(this.state.quote); }
  get baseSym() { return this.def?.base.symbol ?? 'PLS'; }
  get quoteSym() { return this.def?.quote.symbol ?? this.state.quote; }
  get signer(): TxSender | null { const m = this.def; return m ? this.hub.rt(m.chainId).signer : this.d.signer; }
  get hasSigner() { return !!this.signer; }
  private get gate() { const m = this.def; return m ? this.hub.rt(m.chainId).gate : this.d.txGate; }
  private get netKey() { const m = this.def; return !m || m.legacy ? this.d.net.key : this.hub.chain(m.chainId).key; }

  private log(level: 'info' | 'warn' | 'error', msg: string) { this.d.log[level](`[${this.state.id}] ${msg}`); }
  private emit(type: Parameters<Emit>[0]['type'], msg: string, extra: Partial<Parameters<Emit>[0]> = {}) {
    this.d.emit?.({ type, msg, botId: this.state.id, kind: 'trend', pair: this.state.quote, chainId: this.chainId, ...extra });
  }
  private save() { this.d.store.save(this.state); }

  private makeExecutor(mode: Mode, quote: string): Executor {
    let quoter;
    try { quoter = this.hub.quoter(quote); } catch (e) {
      this.lastError = (e as Error).message;
      return new UnavailableExecutor(mode, this.lastError);
    }
    if (mode === 'live') {
      const rt = this.hub.chainOf(quote);
      if (!rt.signer) return new PaperExecutor(quoter, () => this.paperBalances(), this.d.approval ?? 'exact'); // never sends; status is stopped
      return new LiveExecutor(quoter, rt.signer, { approval: this.d.approval ?? 'exact', receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000, sharedNonce: rt.nonce });
    }
    return new PaperExecutor(quoter, () => this.paperBalances(), this.d.approval ?? 'exact');
  }

  /** Simulated balances in paper mode = the bot's own inventory. */
  paperBalances() { return { pls: this.state.position?.pls ?? 0, stable: this.state.cash }; }

  async start(p: TrendStartParams): Promise<void> {
    if (this.state.status === 'running') throw new Error('Already running. Stop first.');
    if (this.state.inFlight) throw new Error('A transaction is still being reconciled.');
    if (this.state.position) throw new Error('Bot still holds a position — close it or resume instead of restarting.');
    const cfg: TrendConfig = { ...DEFAULT_TREND, ...this.state.cfg, ...(p.cfg ?? {}) };
    const limits = { ...this.state.limits, ...(p.limits ?? {}) };
    const errs = [...validateTrendConfig(cfg), ...validateLimits(limits)];
    if (!isTF(p.tf)) errs.push('unknown timeframe');
    if (!(p.capital > 0)) errs.push('capital must be > 0');
    const def = this.hub.def(p.quote);
    if (p.mode === 'live' && !this.hub.rt(def.chainId).signer) errs.push('Live mode needs PRIVATE_KEY in .env');
    if (errs.length) throw new Error(errs.join('; '));
    if (p.mode === 'live' && def.custom) {
      let sf = def.safety ?? null;
      try { sf = await this.hub.recheck(p.quote); } catch (e) { this.log('warn', `safety re-check failed: ${(e as Error).message}`); }
      if (!sf?.liveAllowed) throw new Error(`LIVE blocked — ${this.hub.label(p.quote)} safety ${sf?.risk ?? 'unknown'}: ${(sf?.reasons ?? ['no safety check']).join(' ')}`);
    }
    const executor = this.makeExecutor(p.mode, p.quote);
    if (p.mode === 'live' && def.quote.native) {
      // Flipped (long the token, flat in native PLS): capital + gas reserve must fit in the native balance.
      const bal = await executor.balances();
      const chk = checkGasReserve({ capital: p.capital, balance: bal.stable, cfg: reserveCfg(limits), symbol: def.quote.symbol });
      if (!chk.ok) throw new Error(`LIVE start blocked — ${chk.reason}`);
    }
    const price = await executor.getPrice();
    this.executor = executor;
    const keepTrades = this.state.trades.filter((t) => !t.paper || p.mode === 'live');
    this.state = {
      ...this.state, name: p.name || `${cfg.strategy.toUpperCase()} ${this.hub.label(p.quote)} ${p.tf}`, mode: p.mode, quote: p.quote, tf: p.tf,
      status: 'running', cfg, limits, capital: p.capital, cash: p.capital, position: null, queue: [], inFlight: null,
      trades: p.mode === 'paper' ? [] : keepTrades, signals: [], lastBarT: null, cooldownUntil: 0, lastPrice: price, lastPriceAt: this.now(),
      lastNote: 'waiting for the next closed candle', blocked: 0, startedAt: this.now(), startPrice: price, equity: [[this.now(), p.capital]],
    };
    // Don't act on the candle that closed before start: wait for the next close.
    const k = closedOnly(this.d.candles(p.quote, p.tf), p.tf, Math.floor(this.now() / 1000));
    this.state.lastBarT = k.length ? k[k.length - 1].t : null;
    this.lastError = null;
    this.save();
    this.log('info', `Started ${p.mode.toUpperCase()} trend ${this.state.name}: ${p.capital} ${p.quote}, ${cfg.sizing === 'pct' ? `${cfg.sizePct}% per entry` : `${cfg.riskPct}% risk`}, stop ${cfg.stopAtr}×ATR${cfg.tpR ? `, TP ${cfg.tpR}R` : ''}${cfg.trailAtr ? `, trail ${cfg.trailAtr}×ATR` : ''}, price ${price}`);
    this.emit('started', `Trend bot started — ${this.state.name} (${p.mode})`, { level: 'success' });
  }

  resume() {
    if (this.state.status === 'running') return;
    if (!this.state.capital) throw new Error('Nothing to resume.');
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    if (this.state.mode === 'live' && !this.signer) throw new Error('Live mode needs PRIVATE_KEY in .env');
    if (this.state.mode === 'live' && this.def?.custom && this.def.safety && !this.def.safety.liveAllowed) throw new Error(`LIVE blocked — safety ${this.def.safety.risk}`);
    this.state.status = 'running';
    this.save();
    this.log('info', 'Resumed.');
    this.emit('started', `Trend bot resumed — ${this.state.name}`);
  }

  stop(why = 'STOPPED') {
    const dropped = this.state.queue.length;
    this.state.queue = [];
    if (this.state.status === 'running') this.state.status = 'stopped';
    this.save();
    this.log('warn', `${why}. ${dropped} queued dropped.${this.state.position ? ' Position stays open; stops are NOT monitored while stopped.' : ''}`);
    this.emit('stopped', `${this.state.name}: ${why.toLowerCase()}${this.state.position ? ' (position open, stops paused)' : ''}`, { level: 'warn', notify: true });
  }

  /** Queue a market sell of the whole position (works while running; resumes nothing else). */
  closePosition() {
    if (!this.state.position) throw new Error('No open position.');
    if (this.state.status !== 'running') throw new Error('Resume the bot first (closing needs the executor loop), or it will close on the next run.');
    this.enqueue({ side: 'sell', reason: 'manual', amount: this.state.position.pls, triggerPrice: this.state.lastPrice ?? 0, manual: true });
  }

  setLimits(l: Partial<SafetyLimits>) {
    const next = { ...this.state.limits, ...l };
    const errs = validateLimits(next);
    if (errs.length) throw new Error(errs.join('; '));
    this.state.limits = next;
    this.save();
  }

  private enqueue(j: Omit<TrendJob, 'id' | 'createdAt'>) {
    if (this.state.queue.some((q) => q.side === j.side)) return;
    const job: TrendJob = { ...j, id: `${this.state.id}-${this.now().toString(36)}-${j.side}`, createdAt: this.now() };
    this.state.queue.push(job);
    const amt = j.side === 'buy' ? `${j.amount.toPrecision(5)} ${this.quoteSym}` : `${j.amount.toPrecision(6)} ${this.baseSym}`;
    this.log('info', `Queued ${j.side} ${amt} (${j.reason}) @ ${j.triggerPrice.toPrecision(6)}`);
    this.emit('queued', `${this.state.name}: queued ${j.side} ${amt} — ${j.reason}`, { data: { side: j.side, reason: j.reason } });
  }

  private signal(kind: TrendSignal['kind'], t: number, note: string) {
    this.state.signals.push({ t, at: this.now(), kind, note });
    if (this.state.signals.length > 100) this.state.signals.splice(0, this.state.signals.length - 100);
  }

  equityNow(price = this.state.lastPrice ?? 0) {
    return this.state.cash + (this.state.position ? this.state.position.pls * price : 0);
  }

  /** One poll. `price` = sell-side spot (quote/PLS) from the shared price batch. */
  async tick(price?: number): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.state.inFlight && !this.draining) await this.reconcile();
      const p = price ?? await this.executor.getPrice();
      this.state.lastPrice = p;
      this.state.lastPriceAt = this.now();
      const s = this.state;
      if (s.status === 'running' && !s.inFlight && !s.queue.length) {
        if (s.position) {
          const why = priceExit(s.position.risk, p);
          if (why) {
            this.enqueue({ side: 'sell', reason: why, amount: s.position.pls, triggerPrice: p });
            this.emit('signal', `${s.name}: ${why === 'tp' ? 'take-profit' : why === 'trail' ? 'trailing stop' : 'stop'} hit at ${p.toPrecision(6)}`, { level: why === 'tp' ? 'success' : 'warn', notify: true, data: { reason: why } });
          }
        }
        if (!s.queue.length) await this.evaluateCandles(p);
      }
      if (s.startedAt && (!s.equity.length || this.now() - s.equity[s.equity.length - 1][0] >= 60_000)) pushCapped(s.equity, [this.now(), this.equityNow(p)], 3000);
      this.save();
      await this.drain();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log('error', `tick: ${this.lastError}`);
      this.emit('error', `${this.state.name}: ${this.lastError}`, { level: 'error', notify: true });
    } finally {
      this.ticking = false;
    }
  }

  private series(tf: TF) {
    const nowSec = Math.floor(this.now() / 1000);
    return fillGaps(closedOnly(this.d.candles(this.state.quote, tf), tf, nowSec), tf);
  }

  private async evaluateCandles(price: number) {
    const s = this.state, c = s.cfg, tfSec = TF_SEC[s.tf];
    const k = this.series(s.tf);
    this.warm = { have: k.length, need: warmup(c) };
    if (!k.length) { s.lastNote = `no ${s.tf} candles yet for ${this.label}`; return; }
    const last = k[k.length - 1];
    if (s.lastBarT != null && last.t <= s.lastBarT) return;
    const fresh = s.lastBarT == null ? [last] : k.filter((x) => x.t > s.lastBarT!);
    s.lastBarT = last.t;
    if (k.length < this.warm.need) { s.lastNote = `warming up: ${k.length}/${this.warm.need} closed ${s.tf} candles`; return; }
    const ind = computeIndicators(k, c);
    const i = k.length - 1;
    this.ind = { fast: ind.fast[i], slow: ind.slow[i], rsi: ind.rsi[i], macd: ind.macd[i], macdSig: ind.macdSig[i], dcHi: ind.dcHi[i], dcLo: ind.dcLo[i], atr: ind.atr[i] };
    const sig = signalAt(ind, k, i, c);
    s.lastNote = sig.note;
    this.emit('tick', `${s.name}: ${this.state.tf} candle ${new Date(last.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} closed — ${sig.note}`);
    if (s.position) {
      const pos = s.position;
      pos.bars += fresh.length;
      const before = pos.risk.stop;
      if (trail(pos.risk, Math.max(...fresh.map((x) => x.h)), c)) {
        this.signal('stop_moved', last.t, `trail ${before.toPrecision(6)} → ${pos.risk.stop.toPrecision(6)}`);
        this.emit('stop_moved', `${s.name}: trailing stop ${before.toPrecision(6)} → ${pos.risk.stop.toPrecision(6)}`, { data: { stop: pos.risk.stop } });
      }
      if (sig.exit) {
        this.signal('exit', last.t, sig.note);
        this.emit('signal', `${s.name}: EXIT signal — ${sig.note}`, { level: 'warn' });
        this.enqueue({ side: 'sell', reason: 'signal', amount: pos.pls, triggerPrice: price });
      } else if (c.maxHoldBars > 0 && pos.bars >= c.maxHoldBars) {
        this.signal('exit', last.t, `max hold ${c.maxHoldBars} bars`);
        this.enqueue({ side: 'sell', reason: 'maxhold', amount: pos.pls, triggerPrice: price });
      }
      return;
    }
    if (!sig.enter) return;
    if (last.t < s.cooldownUntil) { this.signal('cooldown', last.t, `entry signal ignored: cooldown until ${new Date(s.cooldownUntil * 1000).toISOString()}`); return; }
    const atrV = ind.atr[i];
    if (atrV == null || !(atrV > 0)) return;
    if (c.htfEnabled) {
      const h = htfAllows(this.series(c.htfTf), last.t + tfSec, c);
      if (!h.ok) {
        this.signal('filtered', last.t, `${sig.note} — ${h.note}`);
        this.emit('blocked', `${s.name}: entry filtered — ${h.note}`, { level: 'warn' });
        return;
      }
    }
    const risk = openRisk(price, atrV, c);
    const size = Math.min(s.cash, positionSize(s.cash, s.cash, risk.entry, risk.stop, c));
    const m = await (this.d.market ? this.d.market(s.quote) : this.hub.quoter(s.quote).market());
    // Real per-market costs: the pool's LP fee, chain gas units, base-converted gas price and any L2 L1-data fee.
    const model: CostModel = {
      feeBps: m.feeBps ?? this.def?.pool.feeBps ?? FEE_BPS, pool: { quoteReserve: m.quoteReserve, plsReserve: m.plsReserve }, gasPricePls: m.gasPricePls,
      buyTaxPct: m.buyTaxPct ?? 0, sellTaxPct: m.sellTaxPct ?? 0,
      gasUnits: m.gasUnits, extraPlsPerSwap: m.extraPlsPerSwap,
      approval: this.d.approval ?? 'exact', slippageBps: this.d.expectedSlippageBps ?? DEFAULT_COSTS.slippageBps,
    };
    const gate = costGate(expectedMovePct(risk, c), size, price, model, c.minEdgePct);
    if (!gate.ok) {
      s.blocked++;
      this.signal('blocked', last.t, `${sig.note} — ${gate.reason}`);
      this.emit('blocked', `${s.name}: entry blocked by cost gate — ${gate.reason}`, { level: 'warn' });
      return;
    }
    this.signal('enter', last.t, `${sig.note} · expected ${(gate.expectedPct * 100).toFixed(2)}% vs cost ${(gate.costPct * 100).toFixed(2)}%`);
    this.emit('signal', `${s.name}: ENTRY signal — ${sig.note}`, { level: 'success' });
    this.enqueue({ side: 'buy', reason: 'entry', amount: size, triggerPrice: price, atr: atrV });
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.state.status === 'running' && !this.state.inFlight && this.state.queue.length) {
        const job = this.state.queue[0];
        const run = () => this.runJob(job);
        const gate = this.gate;
        if (gate) await gate.run(run); else await run();
        if (this.state.inFlight) break;
        this.state.queue = this.state.queue.filter((q) => q.id !== job.id);
        this.save();
      }
    } finally {
      this.draining = false;
    }
  }

  private skip(job: TrendJob, why: string) {
    this.log('warn', `Skipped ${job.side} (${job.reason}): ${why}`);
    this.emit('skipped', `${this.state.name}: skipped ${job.side} — ${why}`, { level: 'warn', notify: job.side === 'sell' });
  }

  private async runJob(job: TrendJob): Promise<void> {
    const maxAttempts = (this.d.maxRetries ?? 1) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.state.status !== 'running') return;
      const s = this.state;
      // Inventory separation: never spend more quote / sell more PLS than this bot owns.
      const amount = job.side === 'buy' ? Math.min(job.amount, s.cash) : Math.min(job.amount, s.position?.pls ?? 0);
      if (!(amount > 0)) return this.skip(job, job.side === 'buy' ? 'no free cash' : 'no position');
      let q: Quote;
      try { q = await this.executor.quote(job.side, amount, s.limits); } catch (e) {
        this.log('warn', `quote failed (${attempt}/${maxAttempts}): ${(e as Error).message}`);
        if (attempt === maxAttempts) return this.skip(job, 'quote failed');
        await sleep(this.d.retryDelayMs ?? 5000);
        continue;
      }
      const ref = s.lastPrice ?? job.triggerPrice;
      const qp = q.poolPrice ?? q.price; // tax-free pool price: taxes never look like a decimals bug
      if (ref > 0 && (qp / ref > 1.5 || qp / ref < 1 / 1.5)) {
        return this.skip(job, `quote price ${qp.toPrecision(6)} inconsistent with spot ${ref.toPrecision(6)} ${this.quoteSym}/${this.baseSym} — units/decimals mismatch, refusing`);
      }
      if (q.priceImpact > s.limits.maxPriceImpact) return this.skip(job, `price impact ${(q.priceImpact * 100).toFixed(2)}% > cap ${(s.limits.maxPriceImpact * 100).toFixed(2)}%`);
      if (!q.balanceOk) return this.skip(job, `insufficient balance (${q.balanceNote})`);
      s.inFlight = { job, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, amountInHuman: q.amountInHuman, price: q.price, quotedOutHuman: q.quotedOutHuman, deadline: Number(q.call.deadline) };
      this.save();
      try {
        const f = await this.executor.execute(q, {
          canSend: () => this.state.status === 'running',
          onSent: (stage, hash) => {
            if (!this.state.inFlight) return;
            if (stage === 'approve') this.state.inFlight.approvalTxHash = hash; else this.state.inFlight.swapTxHash = hash;
            this.save();
            this.log('info', `sent ${stage} ${hash}`);
            this.emit('sent', `${this.state.name}: sent ${stage} ${hash.slice(0, 12)}…`, { data: { hash, stage } });
          },
        });
        this.recordFill(job, f, q.price);
        this.state.inFlight = null;
        this.save();
        if (this.def?.custom && f.shortfallPct != null && f.shortfallPct > Math.max(0.005, s.limits.slippageBps / 20_000)) {
          this.log('warn', `received ${(f.shortfallPct * 100).toFixed(2)}% less than the post-tax quote — tax re-check requested`);
          this.hub.suspect(s.quote, `fill ${(f.shortfallPct * 100).toFixed(2)}% short of the post-tax quote (${s.name})`);
        }
        return;
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        if (o.pending) { this.log('warn', `${(e as Error).message} — will reconcile ${o.swapTxHash} by hash; no resend.`); this.save(); return; }
        this.state.inFlight = null;
        this.recordFailure(job, o.gasPls ?? 0, q.price, o.swapTxHash ?? o.approvalTxHash, (e as Error).message);
        if (o.aborted) { this.skip(job, 'stopped'); this.save(); return; }
        if (/reverted/.test((e as Error).message)) this.hub.suspect(s.quote, `swap reverted (${s.name})`);
        this.log('error', `execute failed (${attempt}/${maxAttempts}): ${(e as Error).message}`);
        this.emit('error', `${this.state.name}: execute failed — ${(e as Error).message}`, { level: 'error', notify: true });
        this.save();
        if (!o.retryable || attempt === maxAttempts) return this.skip(job, 'execution failed');
        await sleep(this.d.retryDelayMs ?? 5000);
      }
    }
  }

  private recordFailure(job: TrendJob, gasPls: number, price: number, hash: string | undefined, note: string) {
    if (!(gasPls > 0)) return;
    const gasQuote = gasPls * price;
    this.state.trades.push({
      id: hash ?? `fail-${this.now()}`, network: this.netKey, side: job.side, intervalIndex: -1, stable: this.state.quote,
      plsAmount: 0, stableAmount: 0, price: 0, gasPls, gasUsd: gasQuote, txHash: hash ?? '', timestamp: this.now(),
      realizedPnlUsd: -gasQuote, failed: true, paper: this.state.mode === 'paper', note, reason: job.reason,
    });
  }

  private recordFill(job: TrendJob, f: Fill, quotedPrice: number) {
    const s = this.state;
    const pls = job.side === 'buy' ? f.amountOutHuman : f.amountInHuman;
    const quote = job.side === 'buy' ? f.amountInHuman : f.amountOutHuman;
    const execPrice = quote / pls;
    const gasQuote = f.gasPls * execPrice;
    const fee = (this.def?.pool.feeBps ?? FEE_BPS) / 10_000;
    const slippagePct = quotedPrice > 0 ? (job.side === 'buy' ? execPrice / quotedPrice - 1 : 1 - execPrice / quotedPrice) : 0;
    const base = {
      id: f.txHash, network: this.netKey, side: job.side, intervalIndex: -1, stable: s.quote, plsAmount: pls, stableAmount: quote,
      price: execPrice, gasPls: f.gasPls, gasUsd: gasQuote, txHash: f.txHash, approvalTxHash: f.approvalTxHash, timestamp: this.now(),
      paper: s.mode === 'paper', triggerPrice: job.triggerPrice, quotedPrice, execPrice, slippagePct, fromReceipt: f.fromReceipt, reason: job.reason,
      ...(f.taxPct ? { taxPct: f.taxPct } : {}), ...(f.outSource ? { outSource: f.outSource } : {}), ...(f.expectedOutHuman != null ? { expectedOut: f.expectedOutHuman } : {}),
      ...(this.def ? { dex: this.def.pool.dex, feeBps: this.def.pool.feeBps, ...(this.def.pool.feeTier != null ? { feeTier: this.def.pool.feeTier } : {}) } : {}),
    };
    if (job.side === 'buy') {
      s.cash -= quote;
      // Stops/TP live in the same sell-side units as the poll price and the backtester (exec price includes the fee).
      const risk = openRisk(s.lastPrice ?? execPrice, job.atr ?? 0, s.cfg);
      s.position = { pls, cost: quote + gasQuote, entryPrice: execPrice, entryAt: this.now(), risk, bars: 0, txHash: f.txHash };
      s.trades.push({ ...base, realizedPnlUsd: 0, feeQuote: quote * fee, lotCost: quote + gasQuote });
      this.log('info', `FILLED buy ${pls.toPrecision(6)} ${this.baseSym} for ${quote.toPrecision(6)} ${this.quoteSym} @ ${execPrice.toPrecision(6)} | stop ${risk.stop.toPrecision(6)}${risk.tp ? ` tp ${risk.tp.toPrecision(6)}` : ''} | gas ${gasQuote.toPrecision(3)} | tx ${f.txHash}`);
      this.emit('filled', `${s.name}: BOUGHT ${pls.toPrecision(6)} ${this.baseSym} @ ${execPrice.toPrecision(6)} — stop ${risk.stop.toPrecision(6)}`, { level: 'success', notify: true, data: { side: 'buy', price: execPrice, pls, stop: risk.stop, tp: risk.tp } });
    } else {
      const pos = s.position!;
      const realized = quote - gasQuote - pos.cost;
      s.cash += quote;
      s.trades.push({
        ...base, realizedPnlUsd: realized, feeQuote: (quote * fee) / (1 - fee), lotCost: pos.cost, roundTripNet: realized,
        entryPrice: pos.entryPrice, holdMs: this.now() - pos.entryAt,
      });
      s.position = null;
      s.cooldownUntil = bucketStart(Math.floor(this.now() / 1000), s.tf) + s.cfg.cooldownBars * TF_SEC[s.tf];
      this.log('info', `FILLED sell ${pls.toPrecision(6)} ${this.baseSym} → ${quote.toPrecision(6)} ${this.quoteSym} @ ${execPrice.toPrecision(6)} (${job.reason}) | net ${realized.toPrecision(4)} ${this.quoteSym} | tx ${f.txHash}`);
      this.emit('filled', `${s.name}: SOLD ${pls.toPrecision(6)} ${this.baseSym} @ ${execPrice.toPrecision(6)} (${job.reason}) — net ${realized >= 0 ? '+' : ''}${realized.toPrecision(4)} ${this.quoteSym}`, { level: realized >= 0 ? 'success' : 'warn', notify: true, data: { side: 'sell', price: execPrice, pnl: realized, reason: job.reason } });
    }
  }

  async reconcile(): Promise<void> {
    const f = this.state.inFlight;
    if (!f) return;
    const job = f.job;
    const drop = () => { this.state.inFlight = null; this.state.queue = this.state.queue.filter((q) => q.id !== job.id); };
    if (!f.swapTxHash) { drop(); this.skip(job, 'interrupted before swap was sent'); this.save(); return; }
    const r = await this.executor.recover(f.swapTxHash, f.tokenOut, f.decimalsOut);
    if (r == null) {
      if (this.now() / 1000 > f.deadline + 300) { drop(); this.skip(job, `swap ${f.swapTxHash} never mined before its deadline`); this.save(); }
      return;
    }
    drop();
    if (r.ok && r.amountOutHuman > 0) {
      this.recordFill(job, { txHash: f.swapTxHash, approvalTxHash: f.approvalTxHash, amountInHuman: f.amountInHuman, amountOutHuman: r.amountOutHuman, gasPls: r.gasPls, fromReceipt: true }, f.price);
    } else {
      this.recordFailure(job, r.gasPls, f.price, f.swapTxHash, 'swap reverted (reconciled)');
      this.skip(job, 'swap reverted');
    }
    this.save();
  }

  modeTrades() { return this.state.trades.filter((t) => !!t.paper === (this.state.mode === 'paper')); }

  status() {
    const s = this.state, price = s.lastPrice ?? 0;
    const trades = this.modeTrades();
    const realized = trades.reduce((a, t) => a + t.realizedPnlUsd, 0);
    const unrealized = s.position ? s.position.pls * price - s.position.cost : 0;
    const closed = trades.filter((t) => t.side === 'sell' && !t.failed).map((t) => ({ pnl: t.realizedPnlUsd, t: t.timestamp, holdMs: t.holdMs }));
    const equity = s.capital + realized + unrealized;
    const tfSec = TF_SEC[s.tf];
    const inMarketMs = trades.filter((t) => t.side === 'sell' && t.holdMs).reduce((a, t) => a + (t.holdMs ?? 0), 0) + (s.position ? this.now() - s.position.entryAt : 0);
    return {
      id: s.id, kind: 'trend' as const, name: s.name, mode: s.mode, status: s.status, quote: s.quote,
      chainId: this.chainId, chainShort: this.def ? this.hub.chain(this.def.chainId).short : 'PLS', label: this.label, base: this.baseSym, quoteSym: this.quoteSym,
      flipped: !!this.def?.flipped, pairKey: this.def?.flipOf ?? s.quote, spends: this.quoteSym, stacks: this.baseSym,
      gasReserve: this.def?.quote.native && s.capital ? gasReserve(s.capital, reserveCfg(s.limits)) : null,
      feeBps: this.def?.pool.feeBps ?? FEE_BPS, dex: this.def?.pool.dex ?? null, feeTier: this.def?.pool.feeTier ?? null,
      dexName: this.def ? (this.hub.chain(this.def.chainId).dexes.find((x) => x.id === this.def!.pool.dex)?.name ?? this.def.pool.dex) : null, custom: !!this.def?.custom, risk: this.def?.safety?.risk ?? null, available: !(this.executor instanceof UnavailableExecutor), hasSigner: this.hasSigner, stable: s.quote, tf: s.tf, cfg: s.cfg, limits: s.limits,
      capital: s.capital, cash: s.cash,
      position: s.position ? { ...s.position, value: s.position.pls * price, unrealized, unrealizedPct: unrealized / s.position.cost } : null,
      queue: s.queue, inFlight: s.inFlight, price: s.lastPrice, priceAt: s.lastPriceAt,
      signals: s.signals.slice(-30).reverse(), lastNote: s.lastNote, ind: this.ind, warm: this.warm,
      nextCloseAt: (bucketStart(Math.floor(this.now() / 1000), s.tf) + tfSec) * 1000,
      trades: trades.slice(-100).reverse(),
      pnl: { realized, unrealized, equity, returnPct: s.capital ? equity / s.capital - 1 : 0, gas: trades.reduce((a, t) => a + t.gasUsd, 0), fees: trades.reduce((a, t) => a + (t.feeQuote ?? 0), 0) },
      hodl: s.startPrice && price ? (s.capital / s.startPrice) * price : null,
      stats: { ...tradeStats(closed), maxDrawdown: drawdown(s.equity).max, timeInMarket: s.startedAt ? inMarketMs / Math.max(1, this.now() - s.startedAt) : 0 },
      equityHist: s.equity.slice(-600),
      blocked: s.blocked, startedAt: s.startedAt, startPrice: s.startPrice, lastError: this.lastError,
    };
  }
}
