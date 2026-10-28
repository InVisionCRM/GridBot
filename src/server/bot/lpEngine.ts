/**
 * Liquidity-position bot on a V3 pool (Uniswap V3 on Ethereum / Robinhood, 9mm V3 on PulseChain).
 *
 *  open     swap part of the coin into the other one (the range's mix at today's price), approve, mint the position
 *  run      fees build up inside the position (counted in its value from the pool's own counters — the same numbers
 *           collect() pays out, checked against live positions on all three chains)
 *  re-range as soon as the price is outside the range (either way, with moving on; see watchRange), or when asked
 *           (move: now, or to a new width): exit (remove all, collect, burn) → swap back to the range's mix → open around
 *           the price. Reinvested fees roll in here.
 *  send     (profits mode "send") collect the fees straight to the payout address once they're worth
 *           PAYOUT_MIN_GAS_MULTIPLE × the collect's gas
 *  close    exit; the coins go back to the wallet
 *
 * Every on-chain step is saved with its tx hash before waiting for it (state.step); a restart picks the step up by
 * hash and never sends it again. Paper mode runs the same steps on a simulated position: fees come from the pool's
 * real fee counters for that liquidity, scaled by the share of the pool it would have been.
 */
import { MaxUint256 } from 'ethers';
import { DEFAULT_LIMITS, type SafetyLimits } from '../../live/limits';
import type { LiveNetwork } from '../../live/networks';
import { isLegacyKey, type MarketDef } from '../../live/markets';
import { feesOwed } from '../../live/v3Liquidity';
import { gasInBase, LP_BAND, LP_GAS, LP_MIN_SWAP_SHARE } from '../../market/lp';
import { lpShouldMove } from '../../market/lpMove';
import { DEFAULT_MAX_POOL_SHARE } from '../../market/poolSize';
import { gasReserve, reserveCfg } from '../../live/gasReserve';
import { amountToUnits } from '../../live/decimals';
import { fromUnits } from '../../live/swapMath';
import { pushCapped } from '../../market/stats';
import { Hub } from '../chains/hub';
import { ERC20, V3_NPM } from '../dex/abis';
import { readCall, sameAddr } from '../dex/types';
import { LpPool, type Coins, type PoolView } from '../lp/lpPool';
import { collectAllData, collectData, exitData, mintTx } from '../lp/npmCalls';
import { ExecError, LiveExecutor, PaperExecutor, UnavailableExecutor, type Executor, type LogLike, type Quote, type ReceiptLike, type TxSender } from './chain';
import { checkProfitMode, type Mode, type ProfitMode } from './engine';
import { PAYOUT_MIN_GAS_MULTIPLE } from '../../live/payout';
import type { Emit } from './activity';
import { requestHalt, resolveHalt, StartStopped, systemHalt, type Halt } from './audit';
import type { Logger } from './logger';
import type { Store } from './store';
import { noKey } from '../words';

export interface LpPosition {
  /** NFT id (live) or a paper id */
  id: string;
  tickLower: number;
  tickUpper: number;
  /** Liquidity (decimal string, exact) */
  liquidity: string;
  /** Range in market prices (quote per base) */
  lower: number;
  upper: number;
  openedAt: number;
  /** The coins it went in with (null: opened before version 5, set at its next reading) */
  putIn: Coins | null;
  /** The bot's fees in each coin (collected) when this position opened: what came before it */
  feesBefore: Coins;
  /** Paper: the pool's global fee growth and whether the price was in range at the last reading; fees earned (raw, token order) */
  paper?: { g0: string; g1: string; inRange: boolean; owed0: string; owed1: string };
}

export type LpAction = 'open' | 'rerange' | 'close' | 'send';
export type LpStage = 'exit' | 'swap' | 'approve' | 'mint' | 'collect';
export interface LpStep {
  action: LpAction;
  stage: LpStage;
  /** Range chosen for the position being opened (fixed when the swap stage starts) */
  range?: { tickLower: number; tickUpper: number };
  /** Tx sent for this stage and not settled yet: never resent while set */
  hash?: string;
  sentAt?: number;
  /** A swap that was broadcast but not confirmed when the executor gave up waiting */
  swap?: { hash: string; tokenOut: string; decimalsOut: number; side: 'buy' | 'sell'; amountIn: number; price: number };
  tries: number;
  /** close: after taking the position out, sell the base coin back to the quote coin ("close to cash") */
  toCash?: boolean;
  /** close to cash: even the smallest piece of the sale was over the price-impact cap; the next try is not before this */
  waitUntil?: number;
}

export interface LpState {
  kind: 'lp';
  /** 5: fees per coin, swap costs and what moves locked in are kept (see upgradeLp) */
  version: number;
  id: string;
  mode: Mode;
  network: string;
  /** Market key */
  market: string;
  status: 'idle' | 'running' | 'stopped' | 'closed';
  /** ± range around the price at each (re-)open; capital in the spend coin, plus base coins from the wallet (may be 0) */
  config: { bandPct: number; capital: number; baseAmount: number; rerange: boolean } | null;
  limits: SafetyLimits;
  profits: ProfitMode;
  position: LpPosition | null;
  /** The bot's coins outside the position (leftovers of the mix, coins between steps) */
  idle: Coins;
  /**
   * Capital that could not enter without taking too much of the pool or crossing the price-impact cap.
   * It stays out of the next swap. Old saves omit it.
   */
  aside?: Coins;
  step: LpStep | null;
  outSince: number | null;
  lastRerangeAt: number | null;
  reranges: number;
  /** The pool's fee counters at the last reading taken (the highest seen): a lower one is a stale answer */
  seen: { g0: string; g1: string } | null;
  /**
   * Fees collected so far (quote, valued when collected; and per coin), gas paid, fees sent to the payout address, what
   * the swaps to the range's mix cost (pool fee + impact, at the mid price) and what taking positions out locked in
   * (lost to moves: see exited), all quote
   */
  totals: { fees: number; gas: number; sent: number; feeCoins: Coins; swapCost: number; moveLoss: number };
  startedAt: number | null;
  /** Price when the bot started */
  startPrice: number | null;
  lastPrice: number | null;
  lastPriceAt: number | null;
  /** [ms, value in quote] */
  equity: [number, number][];
  /** Live unwind in progress. Absent on older state. */
  closing?: boolean;
  /** Hidden from the active list; fees and PnL stay for analytics. Absent on older state. */
  archivedAt?: number | null;
  /** Why this bot last stopped or closed. Absent on state saved before this field existed. */
  halt?: Halt | null;
}

export interface LpStartParams {
  mode: Mode;
  market: string;
  bandPct: number;
  capital: number;
  /** Base coins already in the wallet to put in too (only the difference to the range's mix is swapped) */
  baseAmount?: number;
  rerange?: boolean;
  profits?: ProfitMode;
  limits?: Partial<SafetyLimits>;
  /** Set by MultiBot: a Stop all / STOP chain that landed while this start was under way (it then isn't started) */
  guard?: () => Halt | null;
}

export interface LpDeps {
  net: LiveNetwork;
  store: Store<LpState>;
  log: Logger;
  hub: Hub;
  emit?: Emit;
  approval?: 'exact' | 'max';
  receiptTimeoutMs?: number;
  now?: () => number;
  id?: string;
}

/** A tx stage that keeps reverting stops the bot after this many tries. */
const MAX_TRIES = 3;
/** A native base side keeps this many times the open's estimated gas out of the position, so the open can pay for itself. */
const OPEN_GAS_HEADROOM = 2;
/** A close to cash whose smallest sale is over the price-impact cap tries again after this long (as a grid's) */
const CASH_WAIT_MS = 10 * 60_000;
const newId = () => `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function freshLp(net: LiveNetwork, id?: string): LpState {
  return {
    kind: 'lp', version: 6, id: id ?? newId(), mode: 'paper', network: net.key, market: net.defaultQuote, status: 'idle', config: null,
    limits: { ...DEFAULT_LIMITS }, profits: { mode: 'reinvest' }, position: null, idle: { base: 0, quote: 0 }, step: null,
    outSince: null, lastRerangeAt: null, reranges: 0, seen: null, totals: { fees: 0, gas: 0, sent: 0, feeCoins: { base: 0, quote: 0 }, swapCost: 0, moveLoss: 0 },     startedAt: null, startPrice: null, lastPrice: null, lastPriceAt: null, equity: [],
    closing: false, archivedAt: null, halt: null,
  };
}

/** How long a move's cost (gas plus the swap back to the range's mix, from a live quote) is reused before it's quoted again. */
/** A move blocked by the price-impact cap is quoted again after this long */
const MOVE_BLOCK_TTL_MS = 5 * 60_000;

/** A paper position's fee checkpoint as if just opened: its next reading earns nothing and only sets the counters. */
const RESTART_PAPER = { g0: '0', g1: '0', inRange: false, owed0: '0', owed1: '0' };

/**
 * Stored LP state → this version.
 * 2: paper positions earn the pool's global fee growth (accruePaper). Before, their fees came from range-edge ticks
 *    that usually don't exist in the pool (out of range: ~2^128 × L), so a paper position earns again from its next
 *    reading and a paper bot's value history starts over.
 * 3: a stale (lower) fee-counter reading was taken as a wrap and left ~2^128 × L owed. Owed = counter change × L / 2^128,
 *    and real counters are nowhere near 2^224 (the busiest pools are ~2^141), so owed ≥ 2^96 × L can only be that wrap:
 *    such a position earns again from its next reading and its bot's value history starts over. Others are untouched.
 * 4: kept the coins it opened with, for "vs holding" (no longer shown or kept).
 * 5: fees per coin, swap costs and what moves locked in. Earlier fees stay counted in the quote coin at their worth when
 *    collected; swap costs and move losses count from the upgrade; an open position's coins are taken at its next reading.
 *    The range moves as soon as the price leaves it: the missed-fees tally and the moves-per-day list are dropped.
 */
export function upgradeLp(s: LpState): LpState {
  let t = s;
  if (t.version < 2) {
    const p = t.position;
    t = { ...t, version: 2, position: p?.paper ? { ...p, paper: { ...RESTART_PAPER } } : p, equity: t.mode === 'paper' ? [] : t.equity };
  }
  if (t.version < 3) {
    const p = t.position, pp = p?.paper, cap = p ? BigInt(p.liquidity) << 96n : 0n;
    const wrapped = !!pp && (BigInt(pp.owed0) >= cap || BigInt(pp.owed1) >= cap);
    t = { ...t, version: 3, ...(wrapped ? { position: { ...p!, paper: { ...RESTART_PAPER } }, equity: [] } : {}) };
  }
  if (t.version < 5) {
    const { opening: _o, missed: _m, moves: _v, ...rest } = t as LpState & { opening?: unknown; missed?: unknown; moves?: unknown };
    t = {
      ...rest, version: 5, totals: { ...t.totals, feeCoins: { base: 0, quote: t.totals.fees }, swapCost: 0, moveLoss: 0 },
      position: t.position ? { ...t.position, putIn: null } : null, seen: t.seen ? { g0: t.seen.g0, g1: t.seen.g1 } : null,
    };
  }
  if (t.version < 6) {
    // A position open at the upgrade: what was collected until now came before it. Exact when fees are reinvested
    // (they stay in the position until it is taken out); with Send, fees it sent before the upgrade aren't counted as its.
    t = { ...t, version: 6, position: t.position ? { ...t.position, feesBefore: { ...t.totals.feeCoins } } : null };
  }
  return t;
}

/** Logs of `name` from the position manager in a receipt. */
function events(r: ReceiptLike, npm: string, name: 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Collect') {
  const topic = V3_NPM.getEvent(name)!.topicHash;
  return r.logs.filter((l: LogLike) => sameAddr(l.address, npm) && l.topics[0] === topic).map((l) => V3_NPM.parseLog({ topics: [...l.topics], data: l.data })!);
}

export class LpEngine {
  state: LpState;
  lastError: string | null = null;
  /** Latest reading for status: pool view, position coins and fees owed */
  view: { v: PoolView; inRange: boolean; coins: Coins; owed: Coins; value: number } | null = null;
  private executor: Executor;
  private pool: LpPool | null = null;
  /** Owner of the live position's NFT (the position manager only quotes collect to its owner) */
  private npmOwner: { id: string; addr: string } | null = null;
  /** The last time a move was blocked by the price-impact cap, and why (see moveBlock) */
  private blockMemo: { at: number; block: string } | null = null;
  /** Sized-down entry, logged once per reason */
  private noted = new Set<string>();
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly d: LpDeps) {
    this.now = d.now ?? Date.now;
    const loaded = d.store.load();
    const base = freshLp(d.net, d.id);
    const accept = loaded && (isLegacyKey(loaded.market) ? loaded.network === d.net.key : true);
    this.state = accept ? { ...base, ...loaded! } : base;
    this.executor = this.makeExecutor();
    if (this.state.status === 'running' && this.executor instanceof UnavailableExecutor) {
      this.state.halt = systemHalt('startup', `${this.state.market}: ${this.lastError ?? 'market unavailable'} — stopped.`, this.now());
      this.state.status = 'stopped';
      this.log('warn', `${this.state.market}: ${this.lastError} — stopped.`);
    }
  }

  get id() { return this.state.id; }
  get hub() { return this.d.hub; }
  get def(): MarketDef | null { return this.hub.has(this.state.market) ? this.hub.def(this.state.market) : null; }
  get chainId() { return this.def?.chainId ?? this.d.net.chainId; }
  get label() { return this.hub.label(this.state.market); }
  get baseSym() { return this.def?.base.symbol ?? '?'; }
  get quoteSym() { return this.def?.quote.symbol ?? '?'; }
  get signer(): TxSender | null { const m = this.def; return m ? this.hub.rt(m.chainId).signer : null; }
  private get gate() { const m = this.def; return m ? this.hub.rt(m.chainId).gate : undefined; }
  private log(level: 'info' | 'warn' | 'error', msg: string) { this.d.log[level](`[${this.state.id}] ${msg}`); }
  private ev(type: 'started' | 'stopped' | 'filled' | 'range' | 'error' | 'info' | 'sent', msg: string, extra: { level?: 'info' | 'success' | 'warn' | 'error'; notify?: boolean; data?: Record<string, unknown> } = {}) {
    this.d.emit?.({ type, msg, botId: this.state.id, kind: 'lp', pair: this.state.market, chainId: this.chainId, ...extra, mode: this.state.mode });
  }
  private save() { this.d.store.save(this.state); }

  private makeExecutor(): Executor {
    try {
      const q = this.hub.quoter(this.state.market);
      if (this.state.mode === 'live') {
        const rt = this.hub.chainOf(this.state.market);
        if (!rt.signer) throw new Error(noKey());
        return new LiveExecutor(q, rt.signer, { approval: this.d.approval ?? 'exact', receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000, sharedNonce: rt.nonce });
      }
      return new PaperExecutor(q, () => ({ pls: this.state.idle.base, stable: this.state.idle.quote }), this.d.approval ?? 'exact');
    } catch (e) {
      this.lastError = (e as Error).message;
      return new UnavailableExecutor(this.state.mode, this.lastError);
    }
  }

  private lp(): LpPool {
    const d = this.def;
    if (!d) throw new Error(`${this.state.market} isn't available on this server`);
    if (!this.pool || this.pool.def !== d || this.pool.address !== d.pool.address) {
      const rt = this.hub.rt(d.chainId);
      const dex = rt.cfg.dexes.find((x) => x.id === d.pool.dex);
      if (!dex) throw new Error(`unknown DEX ${d.pool.dex}`);
      this.pool = new LpPool(rt.reader, d, dex, rt.cfg.wrappedNative.address);
    }
    return this.pool;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  async start(p: LpStartParams): Promise<void> {
    if (this.state.status === 'running') throw new Error('Already running.');
    if (!(p.bandPct >= LP_BAND.min && p.bandPct <= LP_BAND.max)) throw new Error(`Range must be ±${LP_BAND.min * 100}% to ±${LP_BAND.max * 100}%.`);
    const baseAmount = p.baseAmount ?? 0;
    if (!(p.capital >= 0 && baseAmount >= 0 && p.capital + baseAmount > 0)) throw new Error('Enter an amount.');
    const profits = checkProfitMode(p.profits ?? this.state.profits);
    this.state.market = p.market;
    this.state.mode = p.mode;
    this.executor = this.makeExecutor();
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    const v = await this.lp().view(); // fails fast on a pool that can't hold a position
    if (p.mode === 'live' && this.def?.safety && !(await this.hub.recheck(p.market)).liveAllowed) throw new Error(`LIVE blocked — ${this.label} failed the safety check`);
    if (profits.mode === 'send' && this.signer && sameAddr(await this.signer.getAddress(), profits.to)) throw new Error('That is the bot\'s own wallet: fees already stay there when reinvested.');
    const stoppedBy = p.guard?.();
    if (stoppedBy) {
      this.state.halt = { ...stoppedBy, at: this.now() };
      this.save();
      this.ev('stopped', `Liquidity ${this.label}: not started — ${stoppedBy.detail} was pressed while it was starting`, { level: 'warn', notify: true, data: { halt: this.state.halt } });
      throw new StartStopped(stoppedBy);
    }
    this.state = {
      ...this.state, status: 'running', config: { bandPct: p.bandPct, capital: p.capital, baseAmount, rerange: p.rerange ?? true },
      limits: { ...this.state.limits, ...(p.limits ?? {}) }, profits, position: null, idle: { base: baseAmount, quote: p.capital },
      step: { action: 'open', stage: 'swap', tries: 0 }, outSince: null, lastRerangeAt: null, reranges: 0, seen: null,
      totals: { fees: 0, gas: 0, sent: 0, feeCoins: { base: 0, quote: 0 }, swapCost: 0, moveLoss: 0 }, startedAt: this.now(), startPrice: v.price, lastPrice: v.price, lastPriceAt: this.now(), equity: [[this.now(), p.capital + baseAmount * v.price]],
      closing: false, archivedAt: null, halt: null,
    };
    this.lastError = null;
    this.save();
    this.ev('started', `Liquidity ${this.label}: opening ±${(p.bandPct * 100).toFixed(0)}% around ${v.price.toPrecision(6)} with ${p.capital} ${this.quoteSym}${baseAmount > 0 ? ` + ${baseAmount} ${this.baseSym}` : ''} (${p.mode})`, { level: 'success' });
  }

  /** Pause managing (no re-range, no sends); a position stays open and keeps earning. A tx already sent is still settled. */
  stop(why?: string | Halt) {
    if (this.state.status !== 'running') return;
    const halt = resolveHalt(why, this.now());
    this.state.status = 'stopped';
    this.state.closing = false;
    this.state.halt = halt;
    // A close that has not been sent yet is dropped. A tx already broadcast is still settled.
    if (this.state.step?.action === 'close' && !this.state.step.hash && !this.state.step.swap) this.state.step = null;
    this.save();
    const note = typeof why === 'string' ? `paused — ${why}` : `stopped — ${halt.detail}`;
    this.ev('stopped', `Liquidity ${this.label} ${note}${this.state.position ? '; the position stays open' : ''}`, { level: 'warn', notify: true, data: { halt } });
  }
  resume() {
    if (this.state.status !== 'stopped') return;
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    this.state.status = 'running';
    this.state.closing = false;
    this.state.archivedAt = null;
    this.state.halt = null;
    this.save();
    this.ev('started', `Liquidity ${this.label} resumed`);
  }
  /**
   * Take everything out and end the bot.
   * Paper settles from the last reading already in memory (no pool read, no gas quote) and leaves the list now.
   * Live only marks closing and sets the exit step. The withdrawal itself — slippage minimums included — still
   * runs on tick. @returns true when that on-chain unwind still has to run.
   */
  close(why?: Halt): boolean {
    if (this.state.archivedAt) return false;
    if (this.state.mode !== 'live') {
      this.noteClose(why);
      this.finishPaper();
      return false;
    }
    if (this.state.closing) return false;
    // A tick may be sending a step's transaction right now (its hash is set when the send returns): ending or replacing
    // the step here would lose that transaction. As for one already sent, it is settled first and the close follows.
    const busy = this.ticking || !!(this.state.step?.hash || this.state.step?.swap);
    if (!this.state.position && !busy) {
      this.noteClose(why);
      this.markArchived();
      return false;
    }
    if (!busy && this.executor instanceof UnavailableExecutor && this.state.position) {
      this.noteClose(why);
      this.lastError = this.lastError ?? 'market unavailable';
      this.state.status = 'stopped';
      this.state.closing = false;
      this.save();
      return false;
    }
    this.noteClose(why);
    this.state.closing = true;
    this.state.status = 'running';
    if (!busy) this.state.step = this.state.position ? { action: 'close', stage: 'exit', tries: 0 } : null;
    this.save();
    this.ev('info', `Liquidity ${this.label}: closing…`, { level: 'warn' });
    return true;
  }
  /** Hide a stopped liquidity bot that has nothing left in the pool and nothing in flight. */
  archiveIfSettled(): boolean {
    if (this.state.archivedAt || this.state.closing || this.state.status === 'running') return false;
    if (this.state.position || this.state.step) return false;
    this.markArchived();
    return true;
  }
  /** Paper close from the cached reading. Does not call the pool or the quoter. */
  private finishPaper() {
    const vw = this.view, p = this.state.position;
    if (p && vw) {
      const coins = vw.coins, fees = vw.owed;
      this.addIdle({ base: coins.base + fees.base, quote: coins.quote + fees.quote });
      this.addFees(fees, vw.v.price);
      if (p.putIn) this.state.totals.moveLoss += (p.putIn.base - coins.base) * vw.v.price + (p.putIn.quote - coins.quote);
    } else if (p?.putIn) this.addIdle(p.putIn);
    this.state.position = null;
    this.state.step = null;
    this.state.outSince = null;
    if (vw) {
      const price = vw.v.price;
      this.view = { ...vw, inRange: false, coins: { base: 0, quote: 0 }, owed: { base: 0, quote: 0 }, value: this.state.idle.base * price + this.state.idle.quote };
    }
    this.markArchived();
  }
  private markArchived(quiet = false) {
    const aside = this.state.aside;
    if (aside && (aside.base > 0 || aside.quote > 0)) {
      this.addIdle(aside);
      this.state.aside = { base: 0, quote: 0 };
      if (this.view) {
        const price = this.view.v.price;
        this.view = { ...this.view, value: this.state.idle.base * price + this.state.idle.quote };
      }
    }
    this.state.step = null;
    this.state.status = 'closed';
    this.state.closing = false;
    this.state.archivedAt = this.now();
    this.save();
    if (!quiet) this.ev('stopped', `Liquidity ${this.label} closed`, { level: 'success', notify: true, data: { halt: this.state.halt ?? null } });
  }
  private noteClose(why?: Halt) {
    if (why) this.state.halt = { ...why, at: this.now() };
    else if (!this.state.halt) this.state.halt = requestHalt('close', 'Close', this.now());
  }
  setRerange(enabled: boolean) {
    if (!this.state.config) throw new Error('Start it first.');
    this.state.config.rerange = enabled;
    this.save();
  }
  /**
   * Move the range to the price now, at `bandPct` (a new width) or the same width. Refused while a step runs, while
   * paused, and when the swap to the new range's mix would go over the price-impact cap (it would stop halfway).
   */
  async move(bandPct?: number) {
    const c = this.state.config;
    if (!c || !this.state.position) throw new Error('No position is open.');
    if (this.state.status !== 'running') throw new Error('Resume it first.');
    if (this.state.step) throw new Error(`It is busy ${this.state.step.action === 'rerange' ? 'moving the range' : this.state.step.action === 'send' ? 'sending fees' : 'closing'}. Try again in a minute.`);
    const band = bandPct ?? c.bandPct;
    if (!(band >= LP_BAND.min && band <= LP_BAND.max)) throw new Error(`Range must be ±${LP_BAND.min * 100}% to ±${LP_BAND.max * 100}%.`);
    const pool = this.lp(), v = await pool.view();
    this.blockMemo = null;
    const block = await this.moveBlock(pool, v, band);
    if (block) throw new Error(`Not moved: ${block}.`);
    const was = c.bandPct;
    c.bandPct = band;
    this.state.step = { action: 'rerange', stage: 'exit', tries: 0 };
    this.save();
    this.ev('range', `Liquidity ${this.label}: ${band === was ? 'moving the range to the price' : `changing the range from ±${+(was * 100).toFixed(2)}% to ±${+(band * 100).toFixed(2)}%`} around ${v.price.toPrecision(6)} (asked)`, { level: 'info', notify: true });
  }
  async setProfits(p: ProfitMode) {
    const next = checkProfitMode(p);
    if (next.mode === 'send' && this.signer && sameAddr(await this.signer.getAddress(), next.to)) throw new Error('That is the bot\'s own wallet: fees already stay there when reinvested.');
    this.state.profits = next;
    this.save();
  }

  // ── Tick ───────────────────────────────────────────────────────────────
  async tick(): Promise<void> {
    if (this.ticking || this.state.status === 'idle' || this.state.status === 'closed' || this.state.archivedAt) return;
    this.ticking = true;
    try {
      const pool = this.lp();
      const v = await pool.view();
      if (this.stale(v)) return;
      const open = this.state.position;
      if (open && !open.putIn) open.putIn = pool.coinsFor(Number(open.liquidity), open.tickLower, open.tickUpper, v);
      if (this.state.position?.paper) this.accruePaper(this.state.position, v);
      this.state.seen = { g0: v.global0.toString(), g1: v.global1.toString() };
      this.state.lastPrice = v.price;
      this.state.lastPriceAt = this.now();
      if (this.state.closing) {
        const step = this.state.step;
        const busy = !!(step?.hash || step?.swap);
        // Don't replace a tx already sent. Otherwise the next work is the exit, not a new range.
        if (!busy && this.state.position && step?.action !== 'close') this.state.step = { action: 'close', stage: 'exit', tries: 0 };
        // Out of the pool with an open or a move not sent yet: nothing of it went out, so it is dropped
        else if (!busy && !this.state.position && step && step.action !== 'close') this.state.step = null;
      }
      if (this.state.step) {
        // a sent tx is always settled, even while stopped; new work only while running
        if (this.state.status === 'running' || this.state.step.hash || this.state.step.swap) await this.advance(pool, v);
      } else if (this.state.status === 'running' && this.state.position && !this.state.closing) {
        await this.watchRange(pool, v);
        if (!this.state.step && this.state.profits.mode === 'send') await this.maybeSend(pool, v);
        if (this.state.step) await this.advance(pool, v); // a re-range or send that just became due starts now
      }
      if (this.state.closing && this.state.position && !this.state.step) {
        this.state.step = { action: 'close', stage: 'exit', tries: 0 };
        await this.advance(pool, v);
      }
      if (this.state.closing && !this.state.position && !this.state.step?.hash && !this.state.step?.swap) {
        this.state.step = null;
        this.markArchived();
      }
      await this.measure(pool, v);
      this.save();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log('error', `tick: ${this.lastError}`);
      this.ev('error', `Liquidity ${this.label}: ${this.lastError}`, { level: 'error', notify: true });
    } finally {
      this.ticking = false;
    }
  }

  /** Out of range with moving on: move to the price now, unless the swap to the new range's mix would go over the price-impact cap. */
  private async watchRange(pool: LpPool, v: PoolView) {
    const p = this.state.position!, c = this.state.config!;
    const out = v.tick < p.tickLower || v.tick >= p.tickUpper;
    const now = this.now();
    if (!out) { this.state.outSince = null; return; }
    const blocked = !c.rerange || (await this.moveBlock(pool, v, c.bandPct)) != null;
    const d = lpShouldMove({ rerange: c.rerange, outOfRange: true, blocked, now, outSince: this.state.outSince, lastMoveAt: this.state.lastRerangeAt });
    this.state.outSince = d.outSince;
    if (!d.move) return;
    this.state.step = { action: 'rerange', stage: 'exit', tries: 0 };
    this.ev('range', `Liquidity ${this.label}: price ${v.price.toPrecision(6)} is outside ${p.lower.toPrecision(6)}–${p.upper.toPrecision(6)}; moving the range to the price`, { level: 'info', notify: true });
  }

  /**
   * Why the range can't move to the price at ±`bandPct` now (null: it can): the swap from what the bot holds to the new
   * range's mix (as swap() works it out) would go over the price-impact cap, and stop halfway with the coins out of the
   * position. A block is kept for MOVE_BLOCK_TTL_MS before the swap is quoted again.
   */
  private async moveBlock(pool: LpPool, v: PoolView, bandPct: number): Promise<string | null> {
    const now = this.now();
    if (this.blockMemo && now - this.blockMemo.at < MOVE_BLOCK_TTL_MS) return this.blockMemo.block;
    const p = this.state.position!;
    const range = pool.ticksFor(v.price * (1 - bandPct), v.price * (1 + bandPct), v);
    const coins = pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v), idle = this.state.idle, owed = this.view?.owed ?? { base: 0, quote: 0 };
    const haveBase = (coins.base + idle.base + owed.base) * v.price, value = haveBase + coins.quote + idle.quote + owed.quote;
    const wantBase = pool.baseShare(range.tickLower, range.tickUpper, v) * value, gap = Math.abs(wantBase - haveBase);
    let block: string | null = null;
    if (gap > value * LP_MIN_SWAP_SHARE) {
      const side: 'buy' | 'sell' = wantBase > haveBase ? 'buy' : 'sell';
      const full = side === 'buy' ? gap : gap / v.price;
      const q = await this.executor.quote(side, full, this.state.limits);
      if (q.priceImpact > this.state.limits.maxPriceImpact) {
        const minIn = side === 'buy' ? value * LP_MIN_SWAP_SHARE : (value * LP_MIN_SWAP_SHARE) / v.price;
        const mq = minIn < full ? await this.executor.quote(side, minIn, this.state.limits) : q;
        if (mq.priceImpact > this.state.limits.maxPriceImpact) {
          block = `the swap to the new range's mix would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%)`;
        }
      }
    }
    this.blockMemo = block ? { at: now, block } : null;
    return block;
  }

  /**
   * A pool's fee counters only grow, so a reading lower than the last one is a stale answer from an RPC node behind the
   * chain: the whole tick waits for a fresh reading (no fees, no range decision, no step on old data).
   */
  private stale(v: PoolView): boolean {
    const s = this.state.seen;
    if (!s || (v.global0 >= BigInt(s.g0) && v.global1 >= BigInt(s.g1))) return false;
    this.log('warn', `Skipped a stale pool reading: its fee counters were lower than the last reading (${s.g0} → ${v.global0}, ${s.g1} → ${v.global1}).`);
    return true;
  }

  /**
   * Paper fees. A paper position isn't in the pool, so its range ticks usually don't exist there: their counters read 0
   * and never flip, and the pool's fee-inside formula wraps to ~2^128 × L once the price leaves the range. Instead it
   * earns the pool's global fee growth between two readings when the earlier one was in range, at L/(L + pool) of what
   * L alone would get (it would be part of the pool).
   */
  private accruePaper(p: LpPosition, v: PoolView) {
    const pp = p.paper!, L = BigInt(p.liquidity);
    // A pool's fee counters only grow, so a lower reading is a stale answer from an RPC node behind the chain: it earns
    // nothing and the checkpoint stays at the highest reading. Taken as a wrap it gave ~2^128 × L (a paper ETH/USDC
    // bot showed 1.6e40 USDC in fees).
    if (v.global0 < BigInt(pp.g0) || v.global1 < BigInt(pp.g1)) {
      this.log('warn', `Skipped a stale pool reading: its fee counters were lower than the last reading (${pp.g0} → ${v.global0}, ${pp.g1} → ${v.global1}).`);
      return;
    }
    const earned = (now: bigint, last: string) => (pp.inRange ? (feesOwed(now, BigInt(last), L) * v.liquidity) / (v.liquidity + L) : 0n);
    p.paper = {
      g0: v.global0.toString(), g1: v.global1.toString(), inRange: v.tick >= p.tickLower && v.tick < p.tickUpper,
      owed0: (BigInt(pp.owed0) + earned(v.global0, pp.g0)).toString(), owed1: (BigInt(pp.owed1) + earned(v.global1, pp.g1)).toString(),
    };
  }

  /** Fees owed now (raw, token order): a paper position's earned fees, or a live one's from the pool's counters. */
  private async owed(pool: LpPool, p: LpPosition): Promise<{ raw0: bigint; raw1: bigint }> {
    if (p.paper) return { raw0: BigInt(p.paper.owed0), raw1: BigInt(p.paper.owed1) };
    // Live: the position manager's own quote of what collect would pay now, in one call from the owner. Rebuilt from
    // the pool's counters it took several reads at different blocks, and a range-edge crossing between them gave wrong
    // fees (≈ +3,400 USDG on a 2,180 USDG position). At one block both agree to the wei (#1472740, Robinhood, 2026-10-20).
    const id = BigInt(p.id);
    if (this.npmOwner?.id !== p.id) this.npmOwner = { id: p.id, addr: (await readCall<[string]>(pool.reader, pool.npm, V3_NPM, 'ownerOf', [id]))[0] };
    const owner = this.npmOwner.addr;
    const raw = await pool.reader.call({ to: pool.npm, from: owner, data: collectAllData(id, owner) });
    const [raw0, raw1] = V3_NPM.decodeFunctionResult('collect', raw) as unknown as [bigint, bigint];
    return { raw0, raw1 };
  }

  private async measure(pool: LpPool, v: PoolView) {
    const p = this.state.position;
    const coins = p ? pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v) : { base: 0, quote: 0 };
    const o = p ? await this.owed(pool, p) : null;
    const owedCoins = o ? pool.coinsFromRaw(o.raw0, o.raw1, v) : { base: 0, quote: 0 };
    const val = (c: Coins) => c.base * v.price + c.quote;
    const aside = this.state.aside ?? { base: 0, quote: 0 };
    const value = val(coins) + val(owedCoins) + val(this.state.idle) + val(aside);
    this.view = { v, inRange: !!p && v.tick >= p.tickLower && v.tick < p.tickUpper, coins, owed: owedCoins, value };
    const eq = this.state.equity, pnl = this.pnl();
    if (pnl && (!eq.length || this.now() - eq[eq.length - 1][0] >= 60_000)) pushCapped(eq, [this.now(), pnl.equity], 3000);
  }

  /**
   * Where the money stands (null until the first reading), in the quote coin:
   *  feeCoins / fees = fees collected + waiting, per coin and their worth (collected: valued then; waiting: today)
   *  net = fees − gas − swap costs − lost to moves: what it earned after costs, the same measure as the replay
   *  equity = the bot's coins (position + fees waiting + idle) at today's price + fees sent out − gas paid
   *  price = equity − start value − net: what the coins' own price did
   */
  pnl(): { equity: number; feeCoins: Coins; fees: number; gas: number; swapCost: number; moveLoss: number; net: number; price: number } | null {
    const c = this.state.config, vw = this.view, start = this.startValue();
    if (!c || !vw || start == null) return null;
    const t = this.state.totals;
    const equity = vw.value + t.sent - t.gas;
    const fees = t.fees + vw.owed.base * vw.v.price + vw.owed.quote;
    const net = fees - t.gas - t.swapCost - t.moveLoss;
    return {
      equity, feeCoins: { base: t.feeCoins.base + vw.owed.base, quote: t.feeCoins.quote + vw.owed.quote }, fees,
      gas: t.gas, swapCost: t.swapCost, moveLoss: t.moveLoss, net, price: equity - start - net,
    };
  }
  /** What the open position has earned in fees since it opened (collected + waiting), per coin: its own history. */
  positionFees(): { coins: Coins; since: number } | null {
    const p = this.state.position, pnl = this.pnl();
    if (!p || !pnl) return null;
    return { coins: { base: pnl.feeCoins.base - p.feesBefore.base, quote: pnl.feeCoins.quote - p.feesBefore.quote }, since: p.openedAt };
  }
  /**
   * The position's share of the liquidity trading at the price, which is its share of each trade's fee; 0 out of range.
   * A live position is part of the pool's active liquidity; a paper one isn't, so it is added (as paper fees are).
   */
  poolShare(): number | null {
    const p = this.state.position, vw = this.view;
    if (!p || !vw) return null;
    if (!vw.inRange) return 0;
    const L = Number(p.liquidity), active = Number(vw.v.liquidity);
    return L / (this.state.mode === 'paper' ? L + active : active);
  }
  /** What the bot was given, in the quote coin at the start price (the amount + its base coins). */
  startValue(): number | null {
    const c = this.state.config, p = this.state.startPrice;
    return c && p != null && this.state.startedAt != null ? c.capital + c.baseAmount * p : null;
  }

  // ── Steps ──────────────────────────────────────────────────────────────
  /** Run steps until one is waiting on the chain (a tx sent, not mined yet) or nothing moved; paper runs straight through. */
  private async advance(pool: LpPool, v: PoolView) {
    const key = () => { const s = this.state.step; return s ? `${s.action}:${s.stage}:${s.hash ?? ''}:${s.swap?.hash ?? ''}:${s.tries}` : 'done'; };
    for (let i = 0; i < 8 && this.state.step; i++) {
      const before = key();
      await this.advanceOnce(pool, v);
      // Stopped, or closing: the tx already sent is settled, nothing new starts (but the close's own steps)
      if (this.state.status !== 'running' || (this.state.closing && this.state.step?.action !== 'close') || this.state.step?.hash || this.state.step?.swap || key() === before) return;
    }
  }
  private async advanceOnce(pool: LpPool, v: PoolView) {
    const s = this.state.step!;
    if (s.stage === 'exit') return this.exit(pool, v, s);
    if (s.stage === 'swap') return s.action === 'close' ? this.sellToCash(v, s) : this.swap(pool, v, s);
    if (s.stage === 'approve') return this.approve(pool, s);
    if (s.stage === 'mint') return this.mint(pool, v, s);
    return this.collect(pool, v, s);
  }

  private gasQuote(units: number, v: PoolView, snap: { gasPricePls: number; extraPlsPerSwap?: number }) {
    return gasInBase(units, snap) * v.price;
  }
  /**
   * Native coin kept out of the position, in native units. Spending the native coin (its amount is native): the gas
   * set-aside of that amount. Native base (ETH/USDG …: the amount is in the quote coin): room for the open's own gas.
   */
  private async nativeKeep(pool: LpPool): Promise<number> {
    if (pool.def.quote.native) return gasReserve(this.state.config!.capital, reserveCfg(this.state.limits));
    return OPEN_GAS_HEADROOM * gasInBase(LP_GAS.v3.open, await this.hub.quoter(this.state.market).market());
  }
  private async receiptGas(r: ReceiptLike, v: PoolView) {
    return fromUnits(r.gasUsed * (r.gasPrice ?? 0n), 18) * (await this.hub.quoter(this.state.market).basePerNative()) * v.price;
  }
  private addIdle(c: Coins) { this.state.idle = { base: this.state.idle.base + c.base, quote: this.state.idle.quote + c.quote }; }

  private noteOnce(msg: string) {
    if (this.noted.has(msg)) return;
    this.noted.add(msg);
    this.log('warn', msg);
    this.ev('info', `Liquidity ${this.label}: ${msg}`, { level: 'warn' });
  }

  /** Hold coins out of the next swap. They fold back into idle when the bot closes. */
  private park(c: Coins) {
    if (!(c.base > 0 || c.quote > 0)) return;
    const a = this.state.aside ?? { base: 0, quote: 0 };
    this.state.aside = { base: a.base + c.base, quote: a.quote + c.quote };
    this.state.idle = { base: Math.max(0, this.state.idle.base - c.base), quote: Math.max(0, this.state.idle.quote - c.quote) };
  }

  /**
   * A deposit bigger than 10% of the active range is cut back. Reported USD liquidity counts out-of-range
   * liquidity, so the cap uses the active liquidity the pool reports now.
   */
  private parkOversize(pool: LpPool, v: PoolView, tickLower: number, tickUpper: number) {
    const poolL = Number(v.liquidity);
    if (!(poolL > 0)) return;
    const active = pool.coinsFor(poolL, tickLower, tickUpper, v);
    const activeQuote = active.base * v.price + active.quote;
    if (!(activeQuote > 0) || !Number.isFinite(activeQuote)) return;
    const idle = this.state.idle;
    const value = idle.base * v.price + idle.quote;
    const maxValue = (DEFAULT_MAX_POOL_SHARE / (1 - DEFAULT_MAX_POOL_SHARE)) * activeQuote;
    if (!(value > maxValue * 1.02)) return;
    const keep = maxValue / value;
    const drop = { base: idle.base * (1 - keep), quote: idle.quote * (1 - keep) };
    this.park(drop);
    this.noteOnce(`set aside ${drop.quote.toPrecision(4)} ${this.quoteSym} + ${drop.base.toPrecision(4)} ${this.baseSym}: more than ${(DEFAULT_MAX_POOL_SHARE * 100).toFixed(0)}% of the pool's active liquidity`);
  }

  /** A sent tx stage: null = not mined yet; otherwise the receipt (reverted ones are counted and retried up to MAX_TRIES). */
  private async settled(s: LpStep, v: PoolView): Promise<ReceiptLike | null> {
    const r = await this.hub.rt(this.chainId).reader.getTransactionReceipt(s.hash!);
    if (!r) return null;
    this.state.totals.gas += await this.receiptGas(r, v);
    s.hash = undefined; s.sentAt = undefined;
    if (r.status === 1) return r;
    s.tries++;
    if (s.tries >= MAX_TRIES) {
      const msg = `${s.action} ${s.stage} reverted ${s.tries} times; stopped (nothing is lost: the coins are in the wallet or the position)`;
      this.state.halt = systemHalt('error', msg, this.now());
      this.state.status = 'stopped';
      throw new Error(msg);
    }
    this.ev('info', `Liquidity ${this.label}: ${s.stage} reverted; trying again`, { level: 'warn' });
    return null;
  }
  /** Send a step's tx through the chain's queue; nothing is sent while the bot isn't running (KILL ALL, paused). */
  private async send(s: LpStep, req: { to: string; data: string; value: bigint }) {
    if (this.state.status !== 'running') return;
    const run = async () => {
      if (this.state.status !== 'running') return; // stopped while it waited its turn
      s.hash = await (this.executor as LiveExecutor).sendTx(req);
      s.sentAt = this.now();
      this.save();
    };
    const g = this.gate;
    if (g) await g.run(run); else await run();
    if (s.hash) this.log('info', `sent ${s.action} ${s.stage} ${s.hash}`);
  }

  /** Remove all liquidity, collect principal + fees, burn the NFT (one multicall). */
  private async exit(pool: LpPool, v: PoolView, s: LpStep) {
    const p = this.state.position!;
    if (this.state.mode === 'paper') {
      const o = await this.owed(pool, p);
      const coins = pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v), fees = pool.coinsFromRaw(o.raw0, o.raw1, v);
      const snap = await this.hub.quoter(this.state.market).market();
      this.addIdle({ base: coins.base + fees.base, quote: coins.quote + fees.quote });
      this.addFees(fees, v.price);
      this.state.totals.gas += this.gasQuote(LP_GAS.v3.close, v, snap);
      return this.exited(s, fees, coins, v);
    }
    if (s.hash) {
      const r = await this.settled(s, v);
      if (!r) return;
      const dec = events(r, pool.npm, 'DecreaseLiquidity')[0], col = events(r, pool.npm, 'Collect')[0];
      if (!dec || !col) throw new Error(`exit ${r.logs.length ? 'receipt has no DecreaseLiquidity/Collect' : 'receipt has no logs'}`);
      const got = pool.coinsFromRaw(col.args.amount0 as bigint, col.args.amount1 as bigint, v);
      const principal = pool.coinsFromRaw(dec.args.amount0 as bigint, dec.args.amount1 as bigint, v);
      const fees = { base: got.base - principal.base, quote: got.quote - principal.quote };
      this.addIdle(got);
      this.addFees(fees, v.price);
      return this.exited(s, fees, principal, v);
    }
    const me = await (this.executor as LiveExecutor).address();
    const exp = pool.rawAmounts(pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v), v);
    const k = 1 - this.state.limits.slippageBps / 10_000;
    const data = exitData({
      tokenId: BigInt(p.id), liquidity: BigInt(p.liquidity), min0: BigInt(Math.floor(exp.a0 * k)), min1: BigInt(Math.floor(exp.a1 * k)),
      deadline: this.deadline(), to: me, nativeOther: this.nativeOther(pool),
    });
    await this.send(s, { to: pool.npm, data, value: 0n });
  }
  private deadline() { return BigInt(Math.floor(this.now() / 1000) + this.state.limits.deadlineMinutes * 60); }
  /** The non-native token when one side of the market is the native coin (null when both are ERC-20s). */
  private nativeOther(pool: LpPool) { return pool.def.base.native ? pool.quoteAddr : pool.def.quote.native ? pool.baseAddr : null; }

  private addFees(f: Coins, price: number) {
    const t = this.state.totals;
    t.fees += f.base * price + f.quote;
    t.feeCoins = { base: t.feeCoins.base + f.base, quote: t.feeCoins.quote + f.quote };
  }
  /**
   * The position is out (a move or closing) with `principal` (fees apart). It sold the coin that rose and bought the one
   * that fell: against the coins it went in with, at this price, that difference is now final ("lost to moves").
   */
  private exited(s: LpStep, fees: Coins, principal: Coins, v: PoolView) {
    const p = this.state.position!;
    if (p.putIn) this.state.totals.moveLoss += (p.putIn.base - principal.base) * v.price + (p.putIn.quote - principal.quote);
    this.state.position = null;
    this.state.outSince = null;
    this.blockMemo = null;
    const f = `${(fees.base * v.price + fees.quote).toPrecision(5)} ${this.quoteSym} in fees`;
    if (s.action === 'close' || this.state.closing) {
      this.markArchived(true);
      this.ev('stopped', `Liquidity ${this.label}: closed (${f}); ${this.state.idle.base.toPrecision(6)} ${this.baseSym} + ${this.state.idle.quote.toPrecision(6)} ${this.quoteSym} back in the wallet`, { level: 'success', notify: true });
    } else {
      s.stage = 'swap'; s.tries = 0; s.range = undefined;
      this.ev('filled', `Liquidity ${this.label}: took out ${p.lower.toPrecision(6)}–${p.upper.toPrecision(6)} (${f})`, { level: 'success' });
    }
  }

  /** Swap the idle coins to the range's mix at today's price. */
  private async swap(pool: LpPool, v: PoolView, s: LpStep) {
    const c = this.state.config!;
    if (s.swap) {
      const r = await this.executor.recover(s.swap.hash, s.swap.tokenOut, s.swap.decimalsOut);
      if (!r) return;
      this.state.totals.gas += r.gasPls * v.price;
      if (r.ok) this.applySwap(s.swap.side, s.swap.amountIn, r.amountOutHuman, v.price);
      s.swap = undefined;
      s.stage = this.state.mode === 'live' ? 'approve' : 'mint';
      return;
    }
    s.range ??= pool.ticksFor(v.price * (1 - c.bandPct), v.price * (1 + c.bandPct), v);
    this.parkOversize(pool, v, s.range.tickLower, s.range.tickUpper);
    const share = pool.baseShare(s.range.tickLower, s.range.tickUpper, v);
    const idle = this.state.idle, value = idle.base * v.price + idle.quote;
    const wantBase = share * value, haveBase = idle.base * v.price;
    const side: 'buy' | 'sell' = wantBase > haveBase ? 'buy' : 'sell';
    const gap = Math.abs(wantBase - haveBase);
    if (gap > value * LP_MIN_SWAP_SHARE) {
      let q = await this.executor.quote(side, side === 'buy' ? gap : gap / v.price, this.state.limits);
      if (!q.balanceOk) throw new Error(`can't swap to the range's mix: ${q.balanceNote}`);
      if (q.priceImpact > this.state.limits.maxPriceImpact) {
        const cap = this.state.limits.maxPriceImpact;
        let lo = 0, hi = q.amountInHuman, best = 0;
        let bestQ = q;
        for (let i = 0; i < 10 && hi - lo > hi * 1e-4; i++) {
          const mid = (lo + hi) / 2;
          const mq = await this.executor.quote(side, mid, this.state.limits);
          if (mq.balanceOk && mq.priceImpact <= cap) { best = mid; bestQ = mq; lo = mid; } else hi = mid;
        }
        const fitted = side === 'buy' ? best : best * v.price;
        if (!(fitted > value * LP_MIN_SWAP_SHARE)) {
          this.noteOnce(`left the mix alone: swapping to the range would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(cap * 100).toFixed(2)}%)`);
          s.stage = this.state.mode === 'live' ? 'approve' : 'mint';
          return;
        }
        this.noteOnce(`entry swap cut from ${q.amountInHuman.toPrecision(4)} to ${best.toPrecision(4)} so the price moves ${(bestQ.priceImpact * 100).toFixed(2)}% (cap ${(cap * 100).toFixed(2)}%)`);
        q = bestQ;
      }
      try {
        const f = await this.execute(q, 'swap');
        this.state.totals.gas += f.gasPls * v.price;
        this.applySwap(side, f.amountInHuman, f.amountOutHuman, v.price);
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        if (o.gasPls) this.state.totals.gas += o.gasPls * v.price;
        if (o.aborted) return;
        if (o.pending && o.swapTxHash) { s.swap = { hash: o.swapTxHash, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, side, amountIn: q.amountInHuman, price: q.price }; return; }
        throw e;
      }
    }
    s.stage = this.state.mode === 'live' ? 'approve' : 'mint';
  }
  /** Swaps go through the chain's queue (one at a time per chain, as the bots' and the smart trader's); only while running. */
  private async execute(q: Quote, what: string) {
    const run = () => this.executor.execute(q, { canSend: () => this.state.status === 'running', onSent: (_stage, hash) => this.log('info', `sent ${what} ${hash}`) });
    const g = this.gate;
    return g ? g.run(run) : run();
  }
  private closed() {
    this.state.step = null;
    this.state.status = 'closed';
    this.ev('stopped', `Liquidity ${this.label}: closed; ${this.state.idle.base.toPrecision(6)} ${this.baseSym} + ${this.state.idle.quote.toPrecision(6)} ${this.quoteSym} back in the wallet`, { level: 'success', notify: true });
  }

  /**
   * Close to cash: sell the idle base coin back to the quote coin, in pieces when all of it would go over the
   * price-impact cap (halved down to 1/64; when even that is over, the next try is in 10 minutes); then closed. A sale
   * of the chain's own coin leaves room for its gas. A broadcast sell is settled by hash like the range swap. Dust is
   * left: base worth under twice the sale's gas, or under 0.01% of what the bot holds.
   */
  private async sellToCash(v: PoolView, s: LpStep) {
    if (s.swap) {
      const r = await this.executor.recover(s.swap.hash, s.swap.tokenOut, s.swap.decimalsOut);
      if (!r) return;
      this.state.totals.gas += r.gasPls * v.price;
      if (r.ok) this.applySwap('sell', s.swap.amountIn, r.amountOutHuman, v.price);
      s.swap = undefined;
      return;
    }
    if (s.waitUntil != null && this.now() < s.waitUntil) return;
    const idle = this.state.idle;
    // What is left is dust: under 0.01% of what the bot holds (checked first: a quote for a few wei of a coin fails
    // with "rounds to zero"), or worth under twice the sale's gas.
    if (!(idle.base * v.price >= (idle.base * v.price + idle.quote) * 1e-4)) return this.closed();
    let amount = idle.base, q = await this.executor.quote('sell', amount, this.state.limits);
    if (idle.base * v.price < 2 * q.gasPlsEstimate * v.price) return this.closed();
    if (this.state.mode === 'live' && this.def!.base.native) {
      // The gas this bot paid came out of the same coin: sell what the wallet has, less room for this sale's gas
      const room = (await this.executor.balances()).pls - OPEN_GAS_HEADROOM * q.gasPlsEstimate;
      if (room < amount) {
        // What the wallet can't pay for beyond that went on gas (the bot's value already counts the gas it paid)
        if (!(room * v.price >= 2 * q.gasPlsEstimate * v.price)) { this.ev('info', `Liquidity ${this.label}: the ${idle.base.toPrecision(4)} ${this.baseSym} left in its count went on gas`); return this.closed(); }
        amount = room;
        q = await this.executor.quote('sell', amount, this.state.limits);
      }
    }
    const all = amount;
    while (q.priceImpact > this.state.limits.maxPriceImpact && amount > all / 64) {
      amount /= 2;
      q = await this.executor.quote('sell', amount, this.state.limits);
    }
    if (!q.balanceOk) throw new Error(`can't sell the ${this.baseSym} back: ${q.balanceNote}`);
    if (q.priceImpact > this.state.limits.maxPriceImpact) return this.waitToSell(s, `selling the ${this.baseSym} back would move the price ${(q.priceImpact * 100).toFixed(2)}% even in 1/64 pieces (cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%)`);
    s.waitUntil = undefined;
    try {
      const f = await this.execute(q, 'sell');
      this.state.totals.gas += f.gasPls * v.price;
      this.applySwap('sell', f.amountInHuman, f.amountOutHuman, v.price);
    } catch (e) {
      const o = e instanceof ExecError ? e.opts : {};
      if (o.gasPls) this.state.totals.gas += o.gasPls * v.price;
      if (o.aborted) return;
      if (o.pending && o.swapTxHash) { s.swap = { hash: o.swapTxHash, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, side: 'sell', amountIn: q.amountInHuman, price: q.price }; return; }
      throw e;
    }
  }

  /** The sale back can't go now: the next try in 10 minutes, said once (not on every check) */
  private waitToSell(s: LpStep, why: string) {
    const first = s.waitUntil == null;
    s.waitUntil = this.now() + CASH_WAIT_MS;
    this.ev('info', `Liquidity ${this.label}: ${why}; trying again every ${CASH_WAIT_MS / 60_000} minutes`, { level: 'warn', notify: first });
  }

  /** A swap to the range's mix landed; its cost is what went in less what came out, at the mid price. */
  private applySwap(side: 'buy' | 'sell', amountIn: number, amountOut: number, price: number) {
    this.state.totals.swapCost += side === 'buy' ? amountIn - amountOut * price : amountIn * price - amountOut;
    const i = this.state.idle;
    this.state.idle = side === 'buy' ? { base: i.base + amountOut, quote: i.quote - amountIn } : { base: i.base - amountIn, quote: i.quote + amountOut };
  }

  /** Live: let the position manager pull each ERC-20 side (the native side is paid with the tx value). */
  private async approve(pool: LpPool, s: LpStep) {
    if (s.hash) {
      const r = await this.settled(s, this.view?.v ?? (await pool.view()));
      if (!r) return;
    }
    const me = await (this.executor as LiveExecutor).address();
    for (const [t, amt] of [[pool.def.base, this.state.idle.base], [pool.def.quote, this.state.idle.quote]] as const) {
      if (t.native || !(amt > 0)) continue;
      const need = amountToUnits(amt, t.decimals);
      const [allowance] = await readCall<[bigint]>(pool.reader, t.address, ERC20, 'allowance', [me, pool.npm]);
      if (allowance >= need) continue;
      const amount = this.d.approval === 'max' ? MaxUint256 : need;
      return this.send(s, { to: t.address, data: ERC20.encodeFunctionData('approve', [pool.npm, amount]), value: 0n });
    }
    s.stage = 'mint';
  }

  /** Open the position with the idle coins (what the range can take; the rest stays idle). */
  private async mint(pool: LpPool, v: PoolView, s: LpStep) {
    const range = s.range!;
    if (this.state.mode === 'paper') {
      const { L, used } = pool.fund(this.state.idle, range.tickLower, range.tickUpper, v);
      if (!(L > 0)) throw new Error('nothing to put in the position');
      const snap = await this.hub.quoter(this.state.market).market();
      this.state.totals.gas += this.gasQuote(LP_GAS.v3.open, v, snap);
      const inRange = v.tick >= range.tickLower && v.tick < range.tickUpper;
      return this.minted(s, `paper-${this.now().toString(36)}`, BigInt(Math.floor(L)), used, v, pool, { g0: v.global0.toString(), g1: v.global1.toString(), inRange, owed0: '0', owed1: '0' });
    }
    if (s.hash) {
      const r = await this.settled(s, v);
      if (!r) return;
      const inc = events(r, pool.npm, 'IncreaseLiquidity')[0];
      if (!inc) throw new Error('mint receipt has no IncreaseLiquidity');
      return this.minted(s, (inc.args.tokenId as bigint).toString(), inc.args.liquidity as bigint, pool.coinsFromRaw(inc.args.amount0 as bigint, inc.args.amount1 as bigint, v), v, pool);
    }
    const ex = this.executor as LiveExecutor, me = await ex.address();
    // Never more than the wallet has (and the native side keeps what gas needs).
    const bal = await ex.balances();
    const keep = pool.def.base.native || pool.def.quote.native ? await this.nativeKeep(pool) : 0;
    const have: Coins = {
      base: Math.min(this.state.idle.base, pool.def.base.native ? Math.max(0, bal.pls - keep) : bal.pls),
      quote: Math.min(this.state.idle.quote, pool.def.quote.native ? Math.max(0, bal.stable - keep) : bal.stable),
    };
    const { L, used } = pool.fund(have, range.tickLower, range.tickUpper, v);
    if (!(L > 0)) throw new Error('nothing to put in the position');
    const want = pool.rawAmounts(have, v), min = pool.rawAmounts(used, v), k = 1 - this.state.limits.slippageBps / 10_000;
    const [token0, token1] = v.baseIs0 ? [pool.baseAddr, pool.quoteAddr] : [pool.quoteAddr, pool.baseAddr];
    const nativeIs0 = pool.def.base.native ? v.baseIs0 : pool.def.quote.native ? !v.baseIs0 : null;
    const tx = mintTx({
      token0, token1, fee: pool.fee, tickLower: range.tickLower, tickUpper: range.tickUpper,
      amount0: BigInt(Math.floor(want.a0)), amount1: BigInt(Math.floor(want.a1)), min0: BigInt(Math.floor(min.a0 * k)), min1: BigInt(Math.floor(min.a1 * k)),
      recipient: me, deadline: this.deadline(), native: nativeIs0 == null ? null : nativeIs0 ? 0 : 1,
    });
    await this.send(s, { to: pool.npm, ...tx });
  }
  private minted(s: LpStep, id: string, L: bigint, used: Coins, v: PoolView, pool: LpPool, paper?: LpPosition['paper']) {
    const range = s.range!;
    const { lower, upper } = pool.rangePrices(range.tickLower, range.tickUpper, v);
    this.state.position = { id, tickLower: range.tickLower, tickUpper: range.tickUpper, liquidity: L.toString(), lower, upper, openedAt: this.now(), putIn: used, feesBefore: { ...this.state.totals.feeCoins }, ...(paper ? { paper } : {}) };
    this.state.idle = { base: Math.max(0, this.state.idle.base - used.base), quote: Math.max(0, this.state.idle.quote - used.quote) };
    if (s.action === 'rerange') { this.state.lastRerangeAt = this.now(); this.state.reranges++; }
    this.state.step = null;
    this.state.outSince = null;
    this.blockMemo = null;
    this.ev('filled', `Liquidity ${this.label}: ${s.action === 'rerange' ? 're-opened' : 'opened'} ${lower.toPrecision(6)}–${upper.toPrecision(6)} with ${used.base.toPrecision(6)} ${this.baseSym} + ${used.quote.toPrecision(6)} ${this.quoteSym}`, { level: 'success', notify: true, data: { id } });
  }

  /** Send mode: once owed fees are worth PAYOUT_MIN_GAS_MULTIPLE × the collect's gas, collect them to the payout address. */
  private async maybeSend(pool: LpPool, v: PoolView) {
    const p = this.state.position!;
    const o = await this.owed(pool, p);
    const fees = pool.coinsFromRaw(o.raw0, o.raw1, v);
    const snap = await this.hub.quoter(this.state.market).market();
    if (fees.base * v.price + fees.quote < PAYOUT_MIN_GAS_MULTIPLE * this.gasQuote(LP_GAS.v3.close, v, snap)) return;
    this.state.step = { action: 'send', stage: 'collect', tries: 0 };
  }
  private async collect(pool: LpPool, v: PoolView, s: LpStep) {
    const p = this.state.position!, to = (this.state.profits as { to: string }).to;
    if (this.state.profits.mode !== 'send') { this.state.step = null; return; }
    if (this.state.mode === 'paper') {
      const o = await this.owed(pool, p);
      const fees = pool.coinsFromRaw(o.raw0, o.raw1, v);
      p.paper = { ...p.paper!, owed0: '0', owed1: '0' };
      const snap = await this.hub.quoter(this.state.market).market();
      this.state.totals.gas += this.gasQuote(LP_GAS.v3.close, v, snap);
      return this.sent(fees, v.price, to);
    }
    if (s.hash) {
      const r = await this.settled(s, v);
      if (!r) return;
      const col = events(r, pool.npm, 'Collect')[0];
      if (!col) throw new Error('collect receipt has no Collect');
      return this.sent(pool.coinsFromRaw(col.args.amount0 as bigint, col.args.amount1 as bigint, v), v.price, to);
    }
    await this.send(s, { to: pool.npm, data: collectData({ tokenId: BigInt(p.id), to, nativeOther: this.nativeOther(pool) }), value: 0n });
  }
  private sent(fees: Coins, price: number, to: string) {
    const worth = fees.base * price + fees.quote;
    this.addFees(fees, price);
    this.state.totals.sent += worth;
    this.state.step = null;
    this.ev('sent', `Liquidity ${this.label}: sent ${worth.toPrecision(5)} ${this.quoteSym} of fees to ${to}`, { level: 'success', notify: true });
  }

  /** For the screen: why the range can't move to the price now (a swap over the price-impact cap), or null. */
  private moveStatus() {
    return { block: this.blockMemo?.block ?? null };
  }

  status() {
    const s = this.state, vw = this.view;
    return {
      kind: 'lp' as const, id: s.id, mode: s.mode, market: s.market, label: this.label, chainId: this.chainId, base: this.baseSym, quote: this.quoteSym,
      dex: this.def?.pool.dex ?? null, dexName: this.def ? this.hub.dexName(this.def.chainId, this.def.pool.dex) : null, feeBps: this.def?.pool.feeBps ?? null, feeTier: this.def?.pool.feeTier ?? null,
      status: s.status, closing: !!s.closing, archivedAt: s.archivedAt ?? null, halt: s.halt ?? null, config: s.config, profits: s.profits, position: s.position, idle: s.idle, step: s.step ? { action: s.step.action, stage: s.step.stage, hash: s.step.hash ?? s.step.swap?.hash ?? null, sentAt: s.step.sentAt ?? null } : null,
      price: s.lastPrice, priceAt: s.lastPriceAt, inRange: vw?.inRange ?? null, coins: vw?.coins ?? null, owed: vw?.owed ?? null, value: vw?.value ?? null,
      outSince: s.outSince, move: this.moveStatus(), positionFees: this.positionFees(), lastRerangeAt: s.lastRerangeAt, reranges: s.reranges, totals: s.totals, pnl: this.pnl(), poolShare: this.poolShare(), startValue: this.startValue(), startedAt: s.startedAt, startPrice: s.startPrice, equity: s.equity.slice(-500),
      usdPerQuote: this.def ? this.hub.usdPerQuote(this.state.market) : null, lastError: this.lastError, available: !(this.executor instanceof UnavailableExecutor),
    };
  }
}
