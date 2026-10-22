/**
 * Liquidity-position bot on a V3 pool (Uniswap V3 on Ethereum / Robinhood, 9mm V3 on PulseChain).
 *
 *  open     swap part of the coin into the other one (the range's mix at today's price), approve, mint the position
 *  run      fees build up inside the position (counted in its value from the pool's own counters — the same numbers
 *           collect() pays out, checked against live positions on all three chains)
 *  re-range once the fees missed out of range (either way) reach what moving costs (see watchRange): exit (remove all,
 *           collect, burn) → swap back to the range's mix → open around the price. Reinvested fees roll in here.
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
import { feesOwed, rangeBaseShare } from '../../live/v3Liquidity';
import { gasInBase, LP_BAND, LP_GAS, LP_MAX_MOVES_PER_DAY, LP_MIN_SWAP_SHARE } from '../../market/lp';
import { gasReserve, reserveCfg } from '../../live/gasReserve';
import { amountToUnits } from '../../live/decimals';
import { fromUnits } from '../../live/swapMath';
import { pushCapped } from '../../market/stats';
import { Hub } from '../chains/hub';
import { ERC20, V3_NPM } from '../dex/abis';
import { readCall, sameAddr } from '../dex/types';
import { LpPool, type Coins, type PoolView } from '../lp/lpPool';
import { collectAllData, collectData, exitData, mintTx } from '../lp/npmCalls';
import { ExecError, LiveExecutor, PaperExecutor, UnavailableExecutor, type Executor, type LogLike, type ReceiptLike, type TxSender } from './chain';
import { checkProfitMode, type Mode, type ProfitMode } from './engine';
import { PAYOUT_MIN_GAS_MULTIPLE } from '../../live/payout';
import type { Emit } from './activity';
import type { Logger } from './logger';
import type { Store } from './store';

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
}

export interface LpState {
  kind: 'lp';
  /** 4: the coins it opened with are kept (see upgradeLp) */
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
  step: LpStep | null;
  outSince: number | null;
  lastRerangeAt: number | null;
  reranges: number;
  /** Fees the position missed while out of range, less what it earned back since (quote, never below 0) */
  missed: number;
  /** The pool's fee counters at the last reading taken (the highest seen) and whether the position was out of range then (null: no position) */
  seen: { g0: string; g1: string; out: boolean | null } | null;
  /** When the range moved in the last 24 hours */
  moves: number[];
  /** Fees collected so far (quote, valued when collected), gas paid (quote), fees sent to the payout address (quote) */
  totals: { fees: number; gas: number; sent: number };
  startedAt: number | null;
  /** Price when the bot started (for "if you'd held") */
  startPrice: number | null;
  /** The coins it held right after the first open (position + leftovers) and the gas paid up to then: "vs holding" compares with these */
  opening: { base: number; quote: number; gas: number } | null;
  lastPrice: number | null;
  lastPriceAt: number | null;
  /** [ms, value in quote] */
  equity: [number, number][];
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
const newId = () => `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function freshLp(net: LiveNetwork, id?: string): LpState {
  return {
    kind: 'lp', version: 4, id: id ?? newId(), mode: 'paper', network: net.key, market: net.defaultQuote, status: 'idle', config: null,
    limits: { ...DEFAULT_LIMITS }, profits: { mode: 'reinvest' }, position: null, idle: { base: 0, quote: 0 }, step: null,
    outSince: null, lastRerangeAt: null, reranges: 0, missed: 0, seen: null, moves: [], totals: { fees: 0, gas: 0, sent: 0 }, startedAt: null, startPrice: null, opening: null, lastPrice: null, lastPriceAt: null, equity: [],
  };
}

/** How long a move's cost (gas plus the swap back to the range's mix, from a live quote) is reused before it's quoted again. */
const MOVE_COST_TTL_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;

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
 * 4: the coins it opened with are kept for "vs holding". A bot that opened before has them worked out once: what it was
 *    given at the start price, split in the mix of its first range there (the opening swap's fee and gas, a few cents
 *    on $2,000 at Robinhood's gas, aren't taken off).
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
  if (t.version < 4) {
    const c = t.config, p0 = t.startPrice, opened = !!t.position || t.reranges > 0 || t.status === 'closed';
    let opening: LpState['opening'] = null;
    if (c && p0 != null && t.startedAt != null && opened) {
      const value = c.capital + c.baseAmount * p0, share = rangeBaseShare(p0, p0 * (1 - c.bandPct), p0 * (1 + c.bandPct));
      opening = { base: (share * value) / p0, quote: (1 - share) * value, gas: 0 };
    }
    t = { ...t, version: 4, opening };
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
  /** The last estimate of what moving the range costs (see moveCost) */
  private costMemo: { at: number; cost: number; block: string | null } | null = null;
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
    this.d.emit?.({ type, msg, botId: this.state.id, kind: 'lp', pair: this.state.market, chainId: this.chainId, ...extra });
  }
  private save() { this.d.store.save(this.state); }

  private makeExecutor(): Executor {
    try {
      const q = this.hub.quoter(this.state.market);
      if (this.state.mode === 'live') {
        const rt = this.hub.chainOf(this.state.market);
        if (!rt.signer) throw new Error('Live mode needs PRIVATE_KEY in .env');
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
    this.state = {
      ...this.state, status: 'running', config: { bandPct: p.bandPct, capital: p.capital, baseAmount, rerange: p.rerange ?? true },
      limits: { ...this.state.limits, ...(p.limits ?? {}) }, profits, position: null, idle: { base: baseAmount, quote: p.capital },
      step: { action: 'open', stage: 'swap', tries: 0 }, outSince: null, lastRerangeAt: null, reranges: 0, missed: 0, seen: null, moves: [],
      totals: { fees: 0, gas: 0, sent: 0 }, startedAt: this.now(), startPrice: v.price, opening: null, lastPrice: v.price, lastPriceAt: this.now(), equity: [[this.now(), p.capital + baseAmount * v.price]],
    };
    this.lastError = null;
    this.save();
    this.ev('started', `Liquidity ${this.label}: opening ±${(p.bandPct * 100).toFixed(0)}% around ${v.price.toPrecision(6)} with ${p.capital} ${this.quoteSym}${baseAmount > 0 ? ` + ${baseAmount} ${this.baseSym}` : ''} (${p.mode})`, { level: 'success' });
  }

  /** Pause managing (no re-range, no sends); a position stays open and keeps earning. A tx already sent is still settled. */
  stop(why?: string) {
    if (this.state.status !== 'running') return;
    this.state.status = 'stopped';
    this.save();
    this.ev('stopped', `Liquidity ${this.label} ${why ? `paused — ${why}` : 'stopped'}${this.state.position ? '; the position stays open' : ''}`, { level: 'warn', notify: true });
  }
  resume() {
    if (this.state.status !== 'stopped') return;
    if (this.executor instanceof UnavailableExecutor) throw new Error(this.lastError ?? 'market unavailable');
    this.state.status = 'running';
    this.save();
    this.ev('started', `Liquidity ${this.label} resumed`);
  }
  /** Take everything out: the coins go back to the wallet and the bot ends. */
  close() {
    if (this.state.status === 'closed') return;
    if (this.state.step?.hash || this.state.step?.swap) throw new Error('A transaction is still being confirmed. Try again in a minute.');
    if (!this.state.position) { this.state.status = 'closed'; this.state.step = null; this.save(); this.ev('stopped', `Liquidity ${this.label} closed`); return; }
    this.state.status = 'running';
    this.state.step = { action: 'close', stage: 'exit', tries: 0 };
    this.save();
  }
  setRerange(enabled: boolean) {
    if (!this.state.config) throw new Error('Start it first.');
    this.state.config.rerange = enabled;
    this.save();
  }
  async setProfits(p: ProfitMode) {
    const next = checkProfitMode(p);
    if (next.mode === 'send' && this.signer && sameAddr(await this.signer.getAddress(), next.to)) throw new Error('That is the bot\'s own wallet: fees already stay there when reinvested.');
    this.state.profits = next;
    this.save();
  }

  // ── Tick ───────────────────────────────────────────────────────────────
  async tick(): Promise<void> {
    if (this.ticking || this.state.status === 'idle' || this.state.status === 'closed') return;
    this.ticking = true;
    try {
      const pool = this.lp();
      const v = await pool.view();
      if (this.stale(v)) return;
      if (this.state.position?.paper) this.accruePaper(this.state.position, v);
      this.tally(pool, v);
      this.state.lastPrice = v.price;
      this.state.lastPriceAt = this.now();
      if (this.state.step) {
        // a sent tx is always settled, even while stopped; new work only while running
        if (this.state.status === 'running' || this.state.step.hash || this.state.step.swap) await this.advance(pool, v);
      } else if (this.state.status === 'running' && this.state.position) {
        await this.watchRange(pool, v);
        if (!this.state.step && this.state.profits.mode === 'send') await this.maybeSend(pool, v);
        if (this.state.step) await this.advance(pool, v); // a re-range or send that just became due starts now
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

  /**
   * Out of range, the range moves once the fees missed (see tally) reach what moving costs (see moveCost): waiting longer
   * would lose more than moving, and a price that comes back by itself first saves the move (rent or buy: never more
   * than twice the best choice in hindsight). At most LP_MAX_MOVES_PER_DAY moves in any 24 hours.
   */
  private async watchRange(pool: LpPool, v: PoolView) {
    const p = this.state.position!, c = this.state.config!;
    const out = v.tick < p.tickLower || v.tick >= p.tickUpper;
    if (!out) { this.state.outSince = null; return; }
    const now = this.now();
    this.state.outSince ??= now;
    if (!c.rerange || this.capped(now)) return;
    const m = await this.moveCost(pool, v);
    if (m.block || this.state.missed < m.cost) return;
    this.state.step = { action: 'rerange', stage: 'exit', tries: 0 };
    const q = this.quoteSym;
    this.ev('range', `Liquidity ${this.label}: price ${v.price.toPrecision(6)} is outside ${p.lower.toPrecision(6)}–${p.upper.toPrecision(6)} and the position has missed ≈${this.state.missed.toPrecision(3)} ${q} in fees, more than moving costs (≈${m.cost.toPrecision(3)} ${q}); moving the range to the price`, { level: 'info', notify: true });
  }

  /** Moved LP_MAX_MOVES_PER_DAY times in the last 24 hours (and drops older moves from the list). */
  private capped(now: number) {
    this.state.moves = this.state.moves.filter((t) => now - t < DAY_MS);
    return this.state.moves.length >= LP_MAX_MOVES_PER_DAY;
  }

  /**
   * What moving the range would cost now, in the quote coin: gas to take the position out, approve and open the new one,
   * plus the swap back to the new range's mix (its pool fee and price impact from a live quote, and its gas). A swap over
   * the price-impact cap blocks the move: it would stop halfway, with the coins out of the position.
   */
  private async moveCost(pool: LpPool, v: PoolView): Promise<{ cost: number; block: string | null }> {
    const now = this.now();
    if (this.costMemo && now - this.costMemo.at < MOVE_COST_TTL_MS) return this.costMemo;
    const p = this.state.position!, c = this.state.config!;
    const snap = await this.hub.quoter(this.state.market).market();
    const approvals = this.d.approval === 'max' ? 0 : [pool.def.base, pool.def.quote].filter((t) => !t.native).length;
    let cost = this.gasQuote(LP_GAS.v3.close, v, snap) + this.gasQuote(LP_GAS.v3.open, v, snap)
      + approvals * this.gasQuote(this.hub.rt(this.chainId).cfg.gasUnits.approve, v, snap);
    let block: string | null = null;
    // the swap the move would make (as swap() works it out): what the bot holds now → the new range's mix
    const range = pool.ticksFor(v.price * (1 - c.bandPct), v.price * (1 + c.bandPct), v);
    const coins = pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v), idle = this.state.idle, owed = this.view?.owed ?? { base: 0, quote: 0 };
    const haveBase = (coins.base + idle.base + owed.base) * v.price, value = haveBase + coins.quote + idle.quote + owed.quote;
    const wantBase = pool.baseShare(range.tickLower, range.tickUpper, v) * value, gap = Math.abs(wantBase - haveBase);
    if (gap > value * LP_MIN_SWAP_SHARE) {
      const side: 'buy' | 'sell' = wantBase > haveBase ? 'buy' : 'sell';
      const q = await this.executor.quote(side, side === 'buy' ? gap : gap / v.price, this.state.limits);
      cost += (side === 'buy' ? q.amountInHuman - q.quotedOutHuman * v.price : q.amountInHuman * v.price - q.quotedOutHuman) + q.gasPlsEstimate * v.price;
      if (q.priceImpact > this.state.limits.maxPriceImpact) {
        block = `the swap back to the range's mix would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%)`;
      }
    }
    this.costMemo = { at: now, cost, block };
    return this.costMemo;
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
   * Fees missed out of range, from the pool's own counters: what in-range liquidity of this size earned between two
   * readings while the position was out (as part of the pool, like a paper position), less what it earns back while in
   * range again. A short return into the range barely lowers it; a long one earns it back to 0.
   */
  private tally(pool: LpPool, v: PoolView) {
    const p = this.state.position, s = this.state.seen;
    const out = p ? v.tick < p.tickLower || v.tick >= p.tickUpper : null;
    if (p && s && s.out != null) {
      const L = BigInt(p.liquidity);
      // a position outside the pool's active liquidity (out of range, or paper) would have been part of it
      const part = (raw: bigint) => (s.out || p.paper ? (raw * v.liquidity) / (v.liquidity + L) : raw);
      const c = pool.coinsFromRaw(part(feesOwed(v.global0, BigInt(s.g0), L)), part(feesOwed(v.global1, BigInt(s.g1), L)), v);
      const d = c.base * v.price + c.quote;
      this.state.missed = s.out ? this.state.missed + d : Math.max(0, this.state.missed - d);
    }
    this.state.seen = { g0: v.global0.toString(), g1: v.global1.toString(), out };
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
    const value = val(coins) + val(owedCoins) + val(this.state.idle);
    this.view = { v, inRange: !!p && v.tick >= p.tickLower && v.tick < p.tickUpper, coins, owed: owedCoins, value };
    const eq = this.state.equity, pnl = this.pnl();
    if (pnl && (!eq.length || this.now() - eq[eq.length - 1][0] >= 60_000)) pushCapped(eq, [this.now(), pnl.equity], 3000);
  }

  /**
   * Where the money stands, in the quote coin at today's price (null until the first reading):
   *  equity = the bot's coins (position + fees owed + idle) + fees sent out − gas paid
   *  profit = equity − start value = fees − gas + price, where price is what price moves and swap costs did to the coins
   *  hold = the coins it opened with at today's price; vsHold = equity, with the gas paid before opening added back, − hold
   *  (what everything after the open did, the same measure as the replay in market/lpReplay)
   */
  pnl(): { equity: number; profit: number; fees: number; gas: number; price: number; hold: number | null; vsHold: number | null } | null {
    const c = this.state.config, vw = this.view, start = this.startValue();
    if (!c || !vw || start == null) return null;
    const t = this.state.totals, o = this.state.opening;
    const equity = vw.value + t.sent - t.gas;
    const fees = t.fees + vw.owed.base * vw.v.price + vw.owed.quote;
    const hold = o ? o.base * vw.v.price + o.quote : null;
    return { equity, profit: equity - start, fees, gas: t.gas, price: equity - start - fees + t.gas, hold, vsHold: o && hold != null ? equity + o.gas - hold : null };
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
      if (this.state.step?.hash || this.state.step?.swap || key() === before) return;
    }
  }
  private async advanceOnce(pool: LpPool, v: PoolView) {
    const s = this.state.step!;
    if (s.stage === 'exit') return this.exit(pool, v, s);
    if (s.stage === 'swap') return this.swap(pool, v, s);
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

  /** A sent tx stage: null = not mined yet; otherwise the receipt (reverted ones are counted and retried up to MAX_TRIES). */
  private async settled(s: LpStep, v: PoolView): Promise<ReceiptLike | null> {
    const r = await this.hub.rt(this.chainId).reader.getTransactionReceipt(s.hash!);
    if (!r) return null;
    this.state.totals.gas += await this.receiptGas(r, v);
    s.hash = undefined; s.sentAt = undefined;
    if (r.status === 1) return r;
    s.tries++;
    if (s.tries >= MAX_TRIES) { this.state.status = 'stopped'; throw new Error(`${s.action} ${s.stage} reverted ${s.tries} times; stopped (nothing is lost: the coins are in the wallet or the position)`); }
    this.ev('info', `Liquidity ${this.label}: ${s.stage} reverted; trying again`, { level: 'warn' });
    return null;
  }
  private async send(s: LpStep, req: { to: string; data: string; value: bigint }) {
    const run = async () => {
      s.hash = await (this.executor as LiveExecutor).sendTx(req);
      s.sentAt = this.now();
      this.save();
    };
    const g = this.gate;
    if (g) await g.run(run); else await run();
    this.log('info', `sent ${s.action} ${s.stage} ${s.hash}`);
  }

  /** Remove all liquidity, collect principal + fees, burn the NFT (one multicall). */
  private async exit(pool: LpPool, v: PoolView, s: LpStep) {
    const p = this.state.position!;
    if (this.state.mode === 'paper') {
      const o = await this.owed(pool, p);
      const coins = pool.coinsFor(Number(p.liquidity), p.tickLower, p.tickUpper, v), fees = pool.coinsFromRaw(o.raw0, o.raw1, v);
      const snap = await this.hub.quoter(this.state.market).market();
      this.addIdle({ base: coins.base + fees.base, quote: coins.quote + fees.quote });
      this.state.totals.fees += fees.base * v.price + fees.quote;
      this.state.totals.gas += this.gasQuote(LP_GAS.v3.close, v, snap);
      return this.exited(s, fees, v);
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
      this.state.totals.fees += fees.base * v.price + fees.quote;
      return this.exited(s, fees, v);
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

  private exited(s: LpStep, fees: Coins, v: PoolView) {
    const p = this.state.position!;
    this.state.position = null;
    this.state.outSince = null;
    this.restartTally(null);
    const f = `${(fees.base * v.price + fees.quote).toPrecision(5)} ${this.quoteSym} in fees`;
    if (s.action === 'close') {
      this.state.step = null;
      this.state.status = 'closed';
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
      if (r.ok) this.applySwap(s.swap.side, s.swap.amountIn, r.amountOutHuman);
      s.swap = undefined;
      s.stage = this.state.mode === 'live' ? 'approve' : 'mint';
      return;
    }
    s.range ??= pool.ticksFor(v.price * (1 - c.bandPct), v.price * (1 + c.bandPct), v);
    const share = pool.baseShare(s.range.tickLower, s.range.tickUpper, v);
    const idle = this.state.idle, value = idle.base * v.price + idle.quote;
    const wantBase = share * value, haveBase = idle.base * v.price;
    const side: 'buy' | 'sell' = wantBase > haveBase ? 'buy' : 'sell';
    const gap = Math.abs(wantBase - haveBase);
    if (gap > value * LP_MIN_SWAP_SHARE) {
      const amountIn = side === 'buy' ? gap : gap / v.price;
      const q = await this.executor.quote(side, amountIn, this.state.limits);
      if (!q.balanceOk) throw new Error(`can't swap to the range's mix: ${q.balanceNote}`);
      if (q.priceImpact > this.state.limits.maxPriceImpact) throw new Error(`the swap to the range's mix would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(this.state.limits.maxPriceImpact * 100).toFixed(2)}%)`);
      try {
        const f = await this.executor.execute(q, { canSend: () => true, onSent: (_stage, hash) => this.log('info', `sent swap ${hash}`) });
        this.state.totals.gas += f.gasPls * v.price;
        this.applySwap(side, f.amountInHuman, f.amountOutHuman);
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        if (o.gasPls) this.state.totals.gas += o.gasPls * v.price;
        if (o.pending && o.swapTxHash) { s.swap = { hash: o.swapTxHash, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, side, amountIn: q.amountInHuman, price: q.price }; return; }
        throw e;
      }
    }
    s.stage = this.state.mode === 'live' ? 'approve' : 'mint';
  }
  private applySwap(side: 'buy' | 'sell', amountIn: number, amountOut: number) {
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
  /** A position opened (out of range or not) or none: the missed-fees tally and the move's cost start over. */
  private restartTally(out: boolean | null) {
    this.state.missed = 0;
    if (this.state.seen) this.state.seen = { ...this.state.seen, out };
    this.costMemo = null;
  }

  private minted(s: LpStep, id: string, L: bigint, used: Coins, v: PoolView, pool: LpPool, paper?: LpPosition['paper']) {
    const range = s.range!;
    const { lower, upper } = pool.rangePrices(range.tickLower, range.tickUpper, v);
    this.state.position = { id, tickLower: range.tickLower, tickUpper: range.tickUpper, liquidity: L.toString(), lower, upper, openedAt: this.now(), ...(paper ? { paper } : {}) };
    this.state.idle = { base: Math.max(0, this.state.idle.base - used.base), quote: Math.max(0, this.state.idle.quote - used.quote) };
    if (s.action === 'open') this.state.opening = { base: used.base + this.state.idle.base, quote: used.quote + this.state.idle.quote, gas: this.state.totals.gas };
    if (s.action === 'rerange') { this.state.lastRerangeAt = this.now(); this.state.reranges++; this.state.moves.push(this.now()); }
    this.state.step = null;
    this.state.outSince = null;
    this.restartTally(v.tick < range.tickLower || v.tick >= range.tickUpper);
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
      const fees = pool.coinsFromRaw(o.raw0, o.raw1, v), worth = fees.base * v.price + fees.quote;
      p.paper = { ...p.paper!, owed0: '0', owed1: '0' };
      const snap = await this.hub.quoter(this.state.market).market();
      this.state.totals.gas += this.gasQuote(LP_GAS.v3.close, v, snap);
      return this.sent(worth, to);
    }
    if (s.hash) {
      const r = await this.settled(s, v);
      if (!r) return;
      const col = events(r, pool.npm, 'Collect')[0];
      if (!col) throw new Error('collect receipt has no Collect');
      const fees = pool.coinsFromRaw(col.args.amount0 as bigint, col.args.amount1 as bigint, v);
      return this.sent(fees.base * v.price + fees.quote, to);
    }
    await this.send(s, { to: pool.npm, data: collectData({ tokenId: BigInt(p.id), to, nativeOther: this.nativeOther(pool) }), value: 0n });
  }
  private sent(worth: number, to: string) {
    this.state.totals.fees += worth;
    this.state.totals.sent += worth;
    this.state.step = null;
    this.ev('sent', `Liquidity ${this.label}: sent ${worth.toPrecision(5)} ${this.quoteSym} of fees to ${to}`, { level: 'success', notify: true });
  }

  /**
   * For the screen: fees missed out of range so far, what moving costs (null until first worked out), why it can't move
   * (a swap over the impact cap), and until when the daily limit holds it back.
   */
  private moveStatus() {
    const now = this.now(), recent = this.state.moves.filter((t) => now - t < DAY_MS);
    return {
      missed: this.state.missed, cost: this.costMemo?.cost ?? null, block: this.costMemo?.block ?? null,
      cappedUntil: recent.length >= LP_MAX_MOVES_PER_DAY ? Math.min(...recent) + DAY_MS : null, perDay: LP_MAX_MOVES_PER_DAY,
    };
  }

  status() {
    const s = this.state, vw = this.view;
    return {
      kind: 'lp' as const, id: s.id, mode: s.mode, market: s.market, label: this.label, chainId: this.chainId, base: this.baseSym, quote: this.quoteSym,
      dex: this.def?.pool.dex ?? null, dexName: this.def ? this.hub.dexName(this.def.chainId, this.def.pool.dex) : null, feeBps: this.def?.pool.feeBps ?? null, feeTier: this.def?.pool.feeTier ?? null,
      status: s.status, config: s.config, profits: s.profits, position: s.position, idle: s.idle, step: s.step ? { action: s.step.action, stage: s.step.stage, hash: s.step.hash ?? s.step.swap?.hash ?? null, sentAt: s.step.sentAt ?? null } : null,
      price: s.lastPrice, priceAt: s.lastPriceAt, inRange: vw?.inRange ?? null, coins: vw?.coins ?? null, owed: vw?.owed ?? null, value: vw?.value ?? null,
      outSince: s.outSince, move: this.moveStatus(), lastRerangeAt: s.lastRerangeAt, reranges: s.reranges, totals: s.totals, pnl: this.pnl(), startValue: this.startValue(), startedAt: s.startedAt, startPrice: s.startPrice, opening: s.opening, equity: s.equity.slice(-500),
      usdPerQuote: this.def ? this.hub.usdPerQuote(this.state.market) : null, lastError: this.lastError, available: !(this.executor instanceof UnavailableExecutor),
    };
  }
}
