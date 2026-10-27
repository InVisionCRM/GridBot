/**
 * The smart trader: turn it on with a budget per chain (an amount of a coin on that chain, e.g. 1,000 USDG on
 * Robinhood) and it runs grid and liquidity bots with it, in paper or live (data/autopilot.json).
 *  - It picks from every pool the opportunity scan found on the chain. A pool that spends another coin than the budget's
 *    (an ETH pool for a USDG budget) is reached by swapping into that coin over the app's markets (one or two swaps,
 *    market/convertRoute.ts) and back when the bot closes; the planner counts those swaps' fees against the pool.
 *  - Reviews when turned on, after each daily scan, when money comes back from a bot, and when a swap into a pool's
 *    coin lands. The decisions are market/autopilot.ts planBudget: the best pools after costs, a week's hold,
 *    switching only when it pays. A chain whose scan failed or is still running is not reviewed: its bots stay.
 *  - A bot it replaces is closed to cash (the grid sells what it holds, the liquidity bot takes its position out and
 *    sells the base coin) and removed; what it was worth goes back to the budget's account, and a coin other than the
 *    budget's is swapped back. A bot that isn't running (stopped by hand, KILL ALL, a safety pause) is left alone:
 *    it keeps its slot, and a close waits until it runs again.
 *  - Loss limit per budget: when its value falls stopLossPct below the amount, its bots are closed to cash and it stops.
 *  - KILL ALL / STOP chain: nothing more is sent for those budgets (no swap, close or new bot) until it is turned on again.
 *  - Live, its money not in a bot counts as in use in the wallet (MultiBot.allocations), like a bot's: no other bot or
 *    Convert takes it. A budget must be in the wallet, beyond what live bots use, to turn it on.
 * Every swap goes through the chain's transaction queue and nonce (the bots' own), and is saved before it is sent; one
 * still unconfirmed when the wait ends is settled by its hash later (dropped after its deadline). Values are in the
 * budget's coin at today's prices; the gas its swaps pay comes out of the account's own coin of the chain.
 */
import { FundsError, type Holding, type MultiBot } from './multi';
import { systemHalt } from './audit';
import type { Store } from './store';
import type { Emit } from './activity';
import type { Mode } from './engine';
import { ExecError, LiveExecutor, PaperExecutor, type Executor } from './chain';
import { candidates, HOLD_MS, MIN_PIECE, planBudget, poolId, wayKey, type Candidate, type PlanOptions } from '../../market/autopilot';
import { DEFAULT_MAX_POOL_SHARE, capGridEntry, capLpEntry, entryCostFraction } from '../../market/poolSize';
import { findRoute, type CoinId, type Hop, type RouteMarket } from '../../market/convertRoute';
import { NATIVE } from '../../live/swapMath';
import { gasReserve, reserveCfg } from '../../live/gasReserve';
import type { Opportunity } from '../../market/scan';

export interface AutoOptions extends PlanOptions { stopLossPct: number }
export interface Budget { chainId: number; coin: string; amount: number }
export interface AutoBot {
  id: string; kind: 'grid' | 'lp'; pool: string; pair: string; label: string; market: string;
  /** The coin it spends and how much of it it got */
  spend: string; capital: number;
  /** Spend coins set aside with it for gas when it spends the chain's own coin (a live start needs them); back with it */
  reserve: number;
  /** What it cost in the budget's coin (the swaps into its coin included) */
  cost: number;
  openedAt: number; expected: number; feeBps: number;
  /** Being closed to cash: why, whether the close has been started, and the way it is replaced for (kept for its money) */
  retiring: { why: string; started: boolean; alt: string | null } | null;
}
/**
 * A swap being sent, or sent and not confirmed when the wait ended: its input is counted until it settles by its hash
 * (hash null: not sent yet). forOpen = a swap into a pool's coin for a new bot (a review follows when it lands).
 */
export interface PendingSwap { hash: string | null; key: string; side: 'buy' | 'sell'; from: string; to: string; amountIn: number; tokenOut: string; decimalsOut: number; at: number; deadline: number; forOpen: boolean }
export interface Account {
  budget: Budget;
  /** Money not in a bot, per coin (symbol); the gas its swaps paid is taken out of the chain's own coin */
  coins: Record<string, number>;
  /** Gas its swaps paid, in the chain's own coin */
  gasNative: number;
  bots: AutoBot[]; pending: PendingSwap[]; startedAt: number;
  /** Stopped by the loss limit: why */
  halted: string | null;
  /** Stopped by KILL ALL / STOP chain: nothing is sent for it until it is turned on again */
  killed: string | null;
  /** What bots removed by hand had cost: out of its hands, so out of the loss limit's baseline */
  withdrawn: number;
}
export interface AutoEntry { t: number; level: 'info' | 'success' | 'warn'; msg: string; chainId?: number }
export interface AutopilotState {
  version: 2; on: boolean; mode: Mode; options: AutoOptions; budgets: Budget[]; accounts: Account[];
  /** "Turn off, close its bots": every bot it runs is closed to cash, also one that opens after the click */
  closeAll: boolean;
  reviewedAt: number | null;
  /** The scan the last review used */
  scanAt: number | null;
  log: AutoEntry[];
}
export interface ScanView { at: number | null; chains: { chainId: number; items: Opportunity[]; error: string | null; partial?: boolean }[] }

export const DEFAULT_OPTIONS: AutoOptions = { grid: true, lp: true, newTokens: true, risk: 'any', slots: 3, stopLossPct: 0.2 };
/** A review at least this often, even without a new scan; a pool that failed to open is skipped this long */
export const REVIEW_MS = 24 * 3600_000;
/** A coin other than the budget's worth under this share of the budget isn't swapped back */
const SWEEP_DUST = 0.002;
/** A sent swap with no receipt this long after its deadline never mined: its input is back */
const PENDING_GRACE_S = 300;
const LOG_MAX = 300;

export interface AutopilotDeps {
  bot: MultiBot;
  /** The latest opportunity scan (null: the scan is off); throws when it can't be read */
  scan: () => Promise<ScanView | null>;
  store: Store<AutopilotState>;
  emit: Emit;
  now?: () => number;
  receiptTimeoutMs?: number;
}

/** Stopped (KILL ALL, STOP chain, turned off, the loss limit) while something was under way: not the pool's fault */
class Stopped extends Error {}

const fresh = (): AutopilotState => ({ version: 2, on: false, mode: 'paper', options: { ...DEFAULT_OPTIONS }, budgets: [], accounts: [], closeAll: false, reviewedAt: null, scanAt: null, log: [] });
const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : String(Number(x.toPrecision(4))));
const msg = (e: unknown) => (e as Error).message;

/**
 * Version 1 (before the kill switch, withdrawals, swap deadlines and kept replacements) gets their defaults; a bot's pool
 * id becomes its market's (version 1 kept a new token's pool address). Its swaps' gas is taken out in the constructor.
 */
function upgrade(raw: AutopilotState | null): AutopilotState {
  if (!raw) return fresh();
  if (raw.version === 2) return raw;
  return {
    ...raw, version: 2, closeAll: false,
    accounts: raw.accounts.map((a) => ({
      ...a, killed: null, withdrawn: 0,
      bots: a.bots.map((b) => ({ ...b, pool: `${a.budget.chainId}:${b.market}:${b.kind}`, reserve: 0, retiring: b.retiring ? { ...b.retiring, alt: null } : null })),
      pending: a.pending.map((p) => ({ ...p, deadline: Math.floor(p.at / 1000) + 600, forOpen: false })),
    })),
  };
}

export function checkOptions(o: AutoOptions): AutoOptions {
  for (const k of ['grid', 'lp', 'newTokens'] as const) if (typeof o[k] !== 'boolean') throw new Error(`${k} must be true or false.`);
  if (!o.grid && !o.lp) throw new Error('Allow grids, liquidity, or both.');
  if (!Number.isInteger(o.slots) || o.slots < 1 || o.slots > 6) throw new Error('Bots per budget: 1 to 6.');
  if (typeof o.stopLossPct !== 'number' || !(o.stopLossPct >= 0.05 && o.stopLossPct <= 0.9)) throw new Error('Loss limit: 5% to 90%.');
  if (!['safe', 'medium', 'any'].includes(o.risk)) throw new Error('Risk must be safe, medium or any.');
  return { grid: o.grid, lp: o.lp, newTokens: o.newTokens, risk: o.risk, slots: o.slots, stopLossPct: o.stopLossPct };
}

export class Autopilot {
  state: AutopilotState;
  lastError: string | null = null;
  private busy = false;
  /** Budget coins per unit of a coin, per chain ("chainId:SYM"), at today's prices (refreshed every tick) */
  private rates = new Map<string, number>();
  /** Ways that failed to open (wayKey → until): the planner moves on to other pools meanwhile */
  private failed = new Map<string, number>();
  /** A turn-on is under way (its wallet checks take a while): one at a time */
  private turning = false;
  /** KILL ALL (null) / STOP chain presses, in order: a turn-on that saw one of its chains meanwhile doesn't turn on */
  private kills: (number | null)[] = [];
  /** Warnings said in the last tick and this one: a failure repeating every minute is said once */
  private warnedBefore = new Set<string>();
  private warnedNow = new Set<string>();

  constructor(private readonly d: AutopilotDeps) {
    const raw = d.store.load();
    this.state = upgrade(raw);
    // Version 1 kept its swaps' gas apart; it now comes out of the account's own coin of the chain
    if (raw && raw.version !== 2) for (const a of this.state.accounts) if (this.chainOn(a.budget.chainId)) this.add(a, this.nativeSym(a.budget.chainId), -a.gasNative);
    d.bot.holdings = () => this.holdings();
    d.bot.onStop = (chainId) => this.kill(chainId);
  }

  private now() { return (this.d.now ?? Date.now)(); }
  private save() { this.d.store.save(this.state); }
  private get hub() { return this.d.bot.hub; }
  private say(m: string, level: AutoEntry['level'] = 'info', chainId?: number) {
    this.state.log.push({ t: this.now(), level, msg: m, ...(chainId != null ? { chainId } : {}) });
    if (this.state.log.length > LOG_MAX) this.state.log.splice(0, this.state.log.length - LOG_MAX);
    this.d.emit({ type: 'info', kind: 'system', level, msg: `Smart trader: ${m}`, ...(chainId != null ? { chainId } : {}) });
  }
  /** A failure: the last error, and said in the log when it starts (not on every minute it repeats) */
  private warn(m: string, chainId?: number) {
    this.lastError = m;
    if (!this.warnedBefore.has(m) && !this.warnedNow.has(m)) this.say(m, 'warn', chainId);
    this.warnedNow.add(m);
  }
  private chainOn(chainId: number) { return this.hub.runtimes().some((r) => r.cfg.id === chainId); }
  private chainName(chainId: number) { return this.chainOn(chainId) ? this.hub.chain(chainId).name : `chain ${chainId} (not on in this app)`; }
  private nativeSym(chainId: number) { return this.hub.chain(chainId).nativeSymbol; }
  /** Bots, swaps or coins other than the budget's still to settle: an account that isn't just its budget's coin */
  private holds(a: Account) {
    return a.bots.length > 0 || a.pending.length > 0 || Object.entries(a.coins).some(([s, x]) => s !== a.budget.coin && x > 0 && !(x * (this.rate(a.budget.chainId, s) ?? Infinity) < a.budget.amount * SWEEP_DUST));
  }

  // ── Coins and routes on a chain ───────────────────────────────────────
  /** A coin by its symbol: the chain's own coin, or a token of one of the app's markets there. */
  private token(chainId: number, sym: string): Holding['token'] | null {
    const c = this.hub.chain(chainId);
    if (sym === c.nativeSymbol) return { address: c.wrappedNative.address, native: true, symbol: sym };
    for (const m of this.hub.byChain(chainId)) for (const t of [m.base, m.quote]) if (!t.native && t.symbol === sym) return { address: t.address, symbol: sym };
    return null;
  }
  private coinId(chainId: number, sym: string): CoinId | null {
    const t = this.token(chainId, sym);
    return t ? (t.native ? NATIVE : t.address.toLowerCase()) : null;
  }
  private symOf(chainId: number, id: CoinId): string {
    if (id === NATIVE) return this.nativeSym(chainId);
    for (const m of this.hub.byChain(chainId)) for (const t of [m.base, m.quote]) if (!t.native && t.address.toLowerCase() === id) return t.symbol;
    throw new Error(`unknown coin ${id}`);
  }
  /**
   * The app's markets on the chain: swaps only go through those that may trade live; prices (what a coin is worth) are
   * read through any of them, so a coin whose market failed a safety re-check still has a value.
   */
  private markets(chainId: number, pricing: boolean): RouteMarket[] {
    const id = (t: { native?: boolean; address: string }) => (t.native ? NATIVE : t.address.toLowerCase());
    return this.hub.byChain(chainId).filter((m) => pricing || !m.safety || m.safety.liveAllowed).map((m) => ({ key: m.key, base: id(m.base), quote: id(m.quote) }));
  }
  private route(chainId: number, from: string, to: string, pricing = false): Hop[] | null {
    const a = this.coinId(chainId, from), b = this.coinId(chainId, to);
    return a && b ? findRoute(a, b, this.markets(chainId, pricing)) : null;
  }
  /** A coin from the budget's: the route's pool fees twice (in and back) and budget coins per unit (null: no price yet); null: no route */
  private reach(a: Account) {
    const c = a.budget.chainId;
    return (coin: string): { cost: number; rate: number | null } | null => {
      if (coin === a.budget.coin) return { cost: 0, rate: 1 };
      const hops = this.route(c, a.budget.coin, coin);
      return hops ? { cost: (2 * hops.reduce((s, h) => s + (this.hub.def(h.key).pool.feeBps ?? 30), 0)) / 10_000, rate: this.rate(c, coin) } : null;
    };
  }
  /** Budget coins per unit of `sym` (1 for the budget's own coin) */
  private rate(chainId: number, sym: string): number | null {
    if (this.state.budgets.some((b) => b.chainId === chainId && b.coin === sym)) return 1;
    return this.rates.get(`${chainId}:${sym}`) ?? null;
  }
  /** Budget coins per unit of every coin the account holds, its bots spend, its swaps move and `extra`, along the route, at mid prices. */
  private async refreshRates(a: Account, extra: string[] = []) {
    const c = a.budget.chainId;
    const syms = new Set([this.nativeSym(c), ...Object.keys(a.coins), ...a.bots.map((b) => b.spend), ...a.pending.flatMap((p) => [p.from, p.to]), ...extra]);
    syms.delete(a.budget.coin);
    for (const sym of syms) {
      const hops = this.route(c, sym, a.budget.coin, true);
      if (!hops) continue;
      let k = 1;
      try {
        for (const h of hops) { const p = await this.hub.quoter(h.key).getPrice(); k *= h.side === 'sell' ? p : 1 / p; }
        this.rates.set(`${c}:${sym}`, k);
      } catch { /* the last rate stays; a coin never priced has none */ }
    }
  }
  private add(a: Account, sym: string, x: number) {
    a.coins[sym] = (a.coins[sym] ?? 0) + x;
    if (Math.abs(a.coins[sym]) < 1e-12) delete a.coins[sym];
  }
  /** Gas a swap paid comes out of the chain's own coin in the account (below 0 when it holds none: owed to the wallet's gas) */
  private gas(a: Account, g: number | undefined) {
    if (!(g! > 0)) return;
    a.gasNative += g!;
    this.add(a, this.nativeSym(a.budget.chainId), -g!);
  }
  /** Live: its coins not in a bot (and swaps' inputs not settled, and gas set aside with bots) are in use in the wallet */
  private holdings(): Holding[] {
    if (this.state.mode !== 'live') return [];
    const out: Holding[] = [];
    for (const a of this.state.accounts) {
      const c = a.budget.chainId;
      // Off (or stopped by its loss limit) with nothing left to settle: its money is released (a turn-on checks it again)
      if (!this.chainOn(c) || ((!this.state.on || a.halted) && !this.holds(a))) continue;
      const put = (sym: string, amount: number) => { const t = this.token(c, sym); if (t && amount > 0) out.push({ chainId: c, token: t, amount, id: 'smart trader' }); };
      for (const [sym, x] of Object.entries(a.coins)) put(sym, x);
      for (const p of a.pending) put(p.from, p.amountIn);
      for (const b of a.bots) put(b.spend, b.reserve);
    }
    return out;
  }

  // ── Swaps ─────────────────────────────────────────────────────────────
  private executor(chainId: number, key: string, side: 'buy' | 'sell', amount: number): Executor {
    const q = this.hub.quoter(key), rt = this.hub.rt(chainId), approval = 'exact' as const;
    if (this.state.mode === 'live') return new LiveExecutor(q, rt.signer!, { approval, receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000, sharedNonce: rt.nonce });
    return new PaperExecutor(q, () => (side === 'buy' ? { pls: 0, stable: amount } : { pls: amount, stable: 0 }), approval);
  }
  /** A quote for one hop that would go through (no block, the coins there, under the impact cap); throws why not */
  private async quoteHop(a: Account, h: Hop, sym: string, amt: number) {
    const c = a.budget.chainId, limits = this.d.bot.limits, toSym = this.symOf(c, h.to);
    const ex = this.executor(c, h.key, h.side, amt);
    const q = await ex.quote(h.side, amt, limits);
    if (q.block) throw new Error(q.block);
    if (!q.balanceOk) throw new Error(`swapping ${sym} to ${toSym}: ${q.balanceNote}`);
    if (q.priceImpact > limits.maxPriceImpact) throw new Error(`swapping ${fmt(amt)} ${sym} to ${toSym} would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(limits.maxPriceImpact * 100).toFixed(1)}%)`);
    return { ex, q, toSym };
  }
  /** What `amount` of `from` would bring in `to`, every hop quoted and checked as a swap would be (nothing is sent) */
  private async preview(a: Account, from: string, to: string, amount: number): Promise<number> {
    const hops = this.route(a.budget.chainId, from, to);
    if (!hops) throw new Error(`no route from ${from} to ${to} over this app's markets`);
    let amt = amount, sym = from;
    for (const h of hops) { const { q, toSym } = await this.quoteHop(a, h, sym, amt); amt = q.quotedOutHuman; sym = toSym; }
    return amt;
  }
  /**
   * Swap `amount` of `from` into `to` along the route. Before each swap is sent its input moves to a pending record and is
   * saved (a restart while it confirms finds it); the output is added when it lands. Returns what arrived, or null
   * when a swap is still unconfirmed (settled by its hash on a later tick). Live, in its turn in the chain's queue, the
   * wallet must hold all that live bots and the trader count of the coin (nothing else is mid-transaction then).
   */
  private async swap(a: Account, from: string, to: string, amount: number, forOpen: boolean): Promise<number | null> {
    const c = a.budget.chainId, rt = this.hub.rt(c);
    const hops = this.route(c, from, to);
    if (!hops) throw new Error(`no route from ${from} to ${to} over this app's markets`);
    let amt = amount, sym = from;
    for (const h of hops) {
      if (a.killed) throw new Stopped(`${a.killed}: nothing is sent`);
      const { ex, q, toSym } = await this.quoteHop(a, h, sym, amt);
      const p: PendingSwap = { hash: null, key: h.key, side: h.side, from: sym, to: toSym, amountIn: amt, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, at: this.now(), deadline: Number(q.call.deadline), forOpen };
      this.add(a, sym, -amt);
      a.pending.push(p);
      this.save();
      try {
        const coin = sym;
        const f = await rt.gate.run(async () => {
          if (this.state.mode === 'live') await this.d.bot.assertBooked(c, this.token(c, coin)!);
          return ex.execute(q, { canSend: () => !a.killed, onSent: (stage, hash) => { if (stage === 'swap') { p.hash = hash; this.save(); } } });
        });
        a.pending = a.pending.filter((x) => x !== p);
        this.gas(a, f.gasNative);
        amt = f.amountOutHuman; sym = toSym;
        this.add(a, sym, amt);
        this.save();
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        this.gas(a, o.gasNative);
        if (o.pending && p.hash) { this.save(); return null; }
        a.pending = a.pending.filter((x) => x !== p);
        this.add(a, sym, amt); // not swapped
        this.save();
        throw e;
      }
    }
    return amt;
  }
  /**
   * Swaps sent and not confirmed: credited when they land, refunded when they reverted or never mined before their
   * deadline. One never sent (the app stopped before it was) is refunded. A swap into a pool's coin that landed makes a
   * review due (it opens that bot).
   */
  private async settleSwaps(a: Account) {
    const c = a.budget.chainId;
    for (const p of [...a.pending]) {
      const done = (ok: boolean) => { a.pending = a.pending.filter((x) => x !== p); if (!ok) this.add(a, p.from, p.amountIn); this.save(); };
      if (p.hash == null) { done(false); this.say(`a swap of ${fmt(p.amountIn)} ${p.from} was never sent (the app stopped first); the ${p.from} is back`, 'warn', c); continue; }
      const r = await this.executor(c, p.key, p.side, p.amountIn).recover(p.hash, p.tokenOut, p.decimalsOut);
      if (!r) {
        if (this.now() / 1000 > p.deadline + PENDING_GRACE_S) { done(false); this.say(`swap ${p.hash.slice(0, 10)}… never mined before its deadline; the ${p.from} is back`, 'warn', c); }
        continue;
      }
      this.gas(a, r.gasNative);
      if (r.ok) { this.add(a, p.to, r.amountOutHuman); if (p.forOpen) this.state.reviewedAt = null; }
      done(r.ok);
      this.say(r.ok ? `swap ${p.hash.slice(0, 10)}… landed: ${fmt(r.amountOutHuman)} ${p.to}` : `swap ${p.hash.slice(0, 10)}… reverted; the ${p.from} is back`, r.ok ? 'info' : 'warn', c);
    }
  }
  /** Coins other than the budget's (back from a bot that spent them) are swapped back to it. */
  private async sweep(a: Account) {
    if (a.pending.length || a.killed) return;
    for (const [sym, amt] of Object.entries(a.coins)) {
      if (sym === a.budget.coin || !(amt > 0)) continue;
      const r = this.rate(a.budget.chainId, sym);
      if (r == null || amt * r < a.budget.amount * SWEEP_DUST) continue;
      try {
        const got = await this.swap(a, sym, a.budget.coin, amt, false);
        if (got != null) this.say(`swapped ${fmt(amt)} ${sym} back to ${fmt(got)} ${a.budget.coin}`, 'info', a.budget.chainId);
      } catch (e) { this.warn(`couldn't swap ${fmt(amt)} ${sym} back to ${a.budget.coin}: ${msg(e)}`, a.budget.chainId); }
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────
  /** Mode and budgets change only while it is off and its accounts hold nothing but their budget's coin; options any time. */
  configure(p: { mode: Mode; options: Partial<AutoOptions>; budgets: Budget[] }) {
    if (this.state.on) throw new Error('Turn it off before changing the mode or the budgets.');
    if (this.busy || this.turning) throw new Error('It is busy; try again in a moment.');
    const busy = this.state.accounts.find((a) => this.holds(a));
    if (busy) throw new Error(`The ${this.chainName(busy.budget.chainId)} budget still has bots, a swap or coins other than ${busy.budget.coin} to settle. Turn it off with "close its bots" and let it finish first.`);
    if (p.mode !== 'paper' && p.mode !== 'live') throw new Error('Mode must be paper or live.');
    const seen = new Set<number>();
    const budgets = p.budgets.map((b) => {
      const amount = Number(b.amount), chainId = Number(b.chainId), coin = String(b.coin ?? '').trim();
      if (!this.chainOn(chainId)) throw new Error(`Chain ${chainId} isn't on in this app.`);
      if (!coin || !this.coinId(chainId, coin)) throw new Error(`Pick a coin this app trades on ${this.hub.chain(chainId).name}.`);
      if (!(Number.isFinite(amount) && amount > 0)) throw new Error(`The ${coin} budget must be a number above 0.`);
      if (seen.has(chainId)) throw new Error(`${this.hub.chain(chainId).name} has two budgets: one per chain.`);
      seen.add(chainId);
      return { chainId, coin, amount };
    });
    this.state = { ...this.state, mode: p.mode, options: checkOptions({ ...this.state.options, ...(p.options ?? {}) }), budgets, accounts: [], closeAll: false };
    this.save();
  }
  setOptions(o: Partial<AutoOptions>) {
    this.state.options = checkOptions({ ...this.state.options, ...o });
    this.save();
  }

  /**
   * On: the first time (or after new budgets) an account per budget; after a turn-off the accounts carry on as they are
   * (a budget stopped by its loss limit stays stopped; one stopped by KILL ALL / STOP chain waits for Carry on). Live, the
   * money it will use must be in the wallet beyond what live bots use (it was released while it was off). A KILL ALL or
   * STOP of one of its chains pressed meanwhile keeps it off.
   */
  async turnOn() {
    if (this.turning) throw new Error('It is already turning on.');
    const offs = this.state.accounts.flatMap((a) => a.bots.filter((b) => b.retiring?.why === 'turned off'));
    if (offs.some((b) => b.retiring!.started)) throw new Error('Its bots are still closing to cash from turning it off. Turn it on again once they are back.');
    if (this.state.on) return;
    if (!this.state.budgets.length) throw new Error('Add a budget first.');
    const live = this.state.mode === 'live';
    if (live) for (const b of this.state.budgets) if (!this.hub.rt(b.chainId).signer) throw new Error(`Live needs a signing key on ${this.hub.chain(b.chainId).name}.`);
    this.turning = true;
    try {
      const k = this.kills.length, coin = (c: number, sym: string) => this.token(c, sym)!;
      if (live && !this.state.accounts.length) for (const b of this.state.budgets) await this.d.bot.assertCoin(b.chainId, coin(b.chainId, b.coin), b.amount);
      if (live) for (const a of this.state.accounts) {
        const x = a.coins[a.budget.coin] ?? 0;
        if (!a.halted && !this.holds(a) && x > 0) await this.d.bot.assertCoin(a.budget.chainId, coin(a.budget.chainId, a.budget.coin), x);
      }
      if (this.kills.slice(k).some((c) => c == null || this.state.budgets.some((b) => b.chainId === c))) throw new Error('KILL ALL or STOP was pressed while it was turning on, so it stays off.');
      for (const b of offs) b.retiring = null; // asked to close but never started (a stopped bot): cancelled by turning on
      if (!this.state.accounts.length) this.state.accounts = this.state.budgets.map((b) => ({ budget: b, coins: { [b.coin]: b.amount }, gasNative: 0, bots: [], pending: [], startedAt: this.now(), halted: null, killed: null, withdrawn: 0 }));
      this.state.on = true;
      this.state.closeAll = false;
      this.state.reviewedAt = null; // a review is due: now, or on the next check if one is running
      this.say(`on (${this.state.mode}): ${this.state.budgets.map((b) => `${fmt(b.amount)} ${b.coin} on ${this.hub.chain(b.chainId).name}`).join(', ')}`);
      this.save();
    } finally { this.turning = false; }
    if (this.busy) { this.say('the first review runs with the next check (within a minute)'); return; }
    await this.review(true);
  }
  /**
   * sell = close every bot to cash (its money comes back to the budget; this also lifts a KILL ALL / STOP chain, as an
   * explicit ask to send those closes); otherwise the bots keep running unmanaged.
   */
  turnOff(sell: boolean) {
    this.state.on = false;
    if (sell) { this.state.closeAll = true; for (const a of this.state.accounts) a.killed = null; }
    this.say(sell ? 'off: closing its bots to cash' : 'off: its bots keep running on their own; turn it on again to manage them');
    this.save();
  }
  /**
   * KILL ALL (chainId null) or STOP chain: nothing more is sent for those budgets (no swap, close or new bot) until
   * Carry on. On or off is left as it was.
   */
  kill(chainId: number | null) {
    this.kills.push(chainId);
    const why = chainId == null ? 'KILL ALL' : `STOP ${this.chainName(chainId)}`;
    const hit = this.state.accounts.filter((a) => chainId == null || a.budget.chainId === chainId);
    if (!hit.length) return;
    for (const a of hit) a.killed = why;
    this.say(`${why}: nothing more is sent for ${hit.map((a) => this.chainName(a.budget.chainId)).join(', ')} until you carry on`, 'warn', chainId ?? undefined);
    this.save();
  }
  /** After KILL ALL / STOP chain: that budget sends again (closes, swaps back, and new bots while it is on). */
  carryOn(chainId: number) {
    const a = this.state.accounts.find((x) => x.budget.chainId === chainId && x.killed);
    if (!a) throw new Error(`The ${this.chainName(chainId)} budget isn't stopped.`);
    a.killed = null;
    this.state.reviewedAt = null;
    this.say(`${this.chainName(chainId)}: carrying on after the stop`, 'info', chainId);
    this.save();
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  /** Every minute: settle swaps and closes, check the loss limits, review when due, swap leftover coins back. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    this.lastError = null;
    this.warnedBefore = this.warnedNow;
    this.warnedNow = new Set();
    try {
      for (const a of this.state.accounts) {
        if (!this.chainOn(a.budget.chainId)) { this.warn(`${this.chainName(a.budget.chainId)}: its budget waits until the chain is on again`); continue; }
        try { await this.refreshRates(a); await this.settleSwaps(a); } catch (e) { this.warn(`${this.chainName(a.budget.chainId)}: ${msg(e)}`, a.budget.chainId); }
      }
      this.settle();
      if (this.state.on) {
        this.lossLimits();
        let scan: ScanView | null | undefined;
        try { scan = await this.d.scan(); } catch (e) { this.warn(`couldn't read the opportunity scan: ${msg(e)}`); }
        // Due: a day since the last review, a new scan, money back from a bot, or a swap for a new bot landed (those
        // set reviewedAt to null, so a review missed now, e.g. the scan unread, still comes on the next check)
        const due = this.state.reviewedAt == null || this.now() - this.state.reviewedAt >= REVIEW_MS || (scan?.at != null && scan.at !== this.state.scanAt);
        if (scan !== undefined && due) await this.reviewNow(false, scan);
      }
      this.settle(); // closes decided this tick start now
      for (const a of this.state.accounts) if (this.chainOn(a.budget.chainId)) await this.sweep(a);
    } catch (e) {
      this.lastError = msg(e);
    } finally {
      this.save();
      this.busy = false;
    }
  }

  /**
   * Bots whose close finished (asked by the trader or by hand: off the active list) are removed, what they hold goes to
   * the account (their spend coin, and the base coin a liquidity bot withdraws or a grid still held, to be swapped back),
   * and a review is due. A bot to close whose close isn't under way is asked to close, except a bot that is stopped (by
   * hand, KILL ALL or a safety pause: it waits until it runs again) or one of a stopped budget.
   */
  private settle() {
    for (const a of this.state.accounts) {
      const c = a.budget.chainId;
      if (!this.chainOn(c)) continue;
      for (const b of [...a.bots]) {
        if (!this.d.bot.hasBot(b.kind, b.id)) {
          a.bots = a.bots.filter((x) => x !== b);
          a.withdrawn += b.cost;
          this.say(`${b.label} was removed by hand: the ${fmt(b.cost)} ${a.budget.coin} it cost is out of this budget (and of its loss limit)`, 'warn', c);
          this.save();
          continue;
        }
        if (this.d.bot.botCashedOut(b.kind, b.id)) {
          const value = this.d.bot.botValue(b.kind, b.id), back = this.d.bot.botCoins(b.kind, b.id);
          if (value == null || back == null) continue; // no reading of it yet
          const d = this.hub.def(b.market), base = d.base.native ? this.nativeSym(c) : d.base.symbol;
          if (b.kind === 'grid') this.d.bot.remove(b.id); else this.d.bot.removeLp(b.id);
          this.add(a, b.spend, back.quote + b.reserve);
          if (back.base > 0) this.add(a, base, back.base);
          a.bots = a.bots.filter((x) => x !== b);
          const r = value - b.capital;
          this.say(`closed ${b.label} (${b.retiring?.why ?? 'closed by hand'}): ${fmt(value)} ${b.spend} back${back.base > 0 ? ` (${fmt(back.base)} ${base} of it, to swap back)` : ''}, ${r >= 0 ? '+' : ''}${fmt(r)} on the ${fmt(b.capital)} it had`, r >= 0 ? 'success' : 'warn', c);
          this.state.reviewedAt = null;
          this.save();
          continue;
        }
        const st = this.d.bot.botStatus(b.kind, b.id);
        if (!b.retiring && this.state.closeAll) b.retiring = { why: 'turned off', started: false, alt: null };
        if (!b.retiring || st.closing || a.killed || st.status !== 'running') continue;
        try {
          // The stop audit (#28): this close is the smart trader's, for the loss limit or its own reason.
          const halt = systemHalt(b.retiring.why === 'loss limit' ? 'loss-limit' : 'autopilot', b.retiring.why === 'loss limit' ? (a.halted || 'loss limit') : b.retiring.why, this.now());
          if (b.kind === 'grid') this.d.bot.closeGrid(b.id, halt); else this.d.bot.closeLp(b.id, halt);
          b.retiring.started = true;
          this.save();
        } catch (e) { this.warn(`couldn't start closing ${b.label}: ${msg(e)}`, c); }
      }
    }
  }

  /** A budget worth stopLossPct less than its amount (less what was taken out by hand) closes every bot to cash and stops. */
  private lossLimits() {
    for (const a of this.state.accounts) {
      if (a.halted || a.killed || !this.chainOn(a.budget.chainId)) continue;
      const v = this.value(a), base = a.budget.amount - a.withdrawn;
      // Everything taken out by hand: nothing left to protect
      if (!(base > a.budget.amount * SWEEP_DUST)) continue;
      if (v == null) { this.warn(`${this.chainName(a.budget.chainId)}: something in this budget has no price right now, so its loss limit isn't checked`, a.budget.chainId); continue; }
      if (v > base * (1 - this.state.options.stopLossPct)) continue;
      a.halted = `worth ${fmt(v)} ${a.budget.coin}, ${((1 - v / base) * 100).toFixed(1)}% under the ${fmt(base)} it started with (limit ${(this.state.options.stopLossPct * 100).toFixed(0)}%)`;
      for (const b of a.bots) if (!b.retiring) b.retiring = { why: 'loss limit', started: false, alt: null };
      this.say(`loss limit: ${a.halted}; closing its bots to cash and stopping this budget`, 'warn', a.budget.chainId);
    }
  }

  /** The account's worth in the budget's coin: its coins (gas paid taken out), its swaps in flight and its bots at today's prices. null while something has no price or reading yet. */
  value(a: Account): number | null {
    const c = a.budget.chainId;
    if (!this.chainOn(c)) return null;
    let v = 0;
    const at = (sym: string, x: number) => { const r = this.rate(c, sym); if (r == null) return false; v += x * r; return true; };
    for (const [sym, x] of Object.entries(a.coins)) if (!at(sym, x)) return null;
    for (const p of a.pending) if (!at(p.from, p.amountIn)) return null;
    for (const b of a.bots) {
      const x = this.d.bot.hasBot(b.kind, b.id) ? this.d.bot.botValue(b.kind, b.id) : null;
      if (x == null || !at(b.spend, x + b.reserve)) return null;
    }
    return v;
  }
  /** Money not in a bot, in the budget's coin (coins without a price yet don't count) */
  private free(a: Account): number {
    return Object.entries(a.coins).reduce((s, [sym, x]) => s + (x > 0 ? x * (this.rate(a.budget.chainId, sym) ?? 0) : 0), 0);
  }

  async review(force = false) {
    if (this.busy) throw new Error('It is busy; try again in a moment.');
    this.busy = true;
    try {
      for (const a of this.state.accounts) if (this.chainOn(a.budget.chainId)) await this.refreshRates(a);
      this.settle(); // bots removed or closed since the last check are settled first
      await this.reviewNow(force);
      this.settle();
    } finally { this.save(); this.busy = false; }
  }

  private async reviewNow(force: boolean, scanIn?: ScanView | null) {
    if (!this.state.on) return;
    const scan = scanIn === undefined ? await this.d.scan() : scanIn;
    if (!scan) { this.say('no opportunity scan (it is off: CANDLES_GECKO=off), so nothing to pick from', 'warn'); this.state.reviewedAt = this.now(); return; }
    if (scan.at == null) { if (force) this.say('waiting for the first opportunity scan to finish (up to an hour)'); return; }
    const loud = force || scan.at !== this.state.scanAt;
    for (const a of this.state.accounts) {
      if (!this.state.on) break; // turned off meanwhile
      if (a.halted || a.killed || !this.chainOn(a.budget.chainId)) continue;
      try { await this.reviewAccount(a, scan, loud); } catch (e) { this.warn(`${this.chainName(a.budget.chainId)}: ${msg(e)}`, a.budget.chainId); }
    }
    this.state.reviewedAt = this.now();
    this.state.scanAt = scan.at;
    this.save();
  }

  private async reviewAccount(a: Account, scan: ScanView, loud: boolean) {
    const c = a.budget.chainId, name = this.hub.chain(c).name, o = this.state.options;
    const chain = scan.chains.find((x) => x.chainId === c);
    if (!chain || chain.error || chain.partial) {
      if (loud) this.say(`${name}: ${!chain ? 'not in the scan' : chain.error ? `today's scan of it failed (${chain.error})` : 'still being scanned'}; its bots stay as they are`, 'warn', c);
      return;
    }
    if (a.pending.length) { if (loud) this.say(`${name}: waiting for a swap to confirm before deciding`, 'info', c); return; }
    // A pool of another app (a friend's copy reads its host's scan) that isn't in this one and has no address can't be added here
    const items = chain.items.filter((x) => x.key != null || x.ref.pool);
    await this.refreshRates(a, [...new Set(items.map((x) => x.spend))]);
    const now = this.now();
    for (const [id, until] of this.failed) if (until <= now) this.failed.delete(id);
    // An entry swap's cost at the size it would open at (a pool of unknown depth is taken as deep enough)
    const piece = a.budget.amount / Math.max(1, o.slots), cap = this.d.bot.limits.maxPriceImpact;
    const { cands, gone } = candidates(items, o, this.reach(a), (x) => {
      const liq = x.activity?.liquidityUsd ?? 0, usdPer = x.capital > 0 ? x.usd / x.capital : 0;
      if (!(liq > 0) || !(usdPer > 0)) return 0;
      return entryCostFraction({ capital: piece / this.rate(c, x.spend)!, quoteReserve: liq / 2 / usdPer, feeBps: x.feeBps, maxImpact: cap, maxPoolShare: DEFAULT_MAX_POOL_SHARE });
    });
    // Bots closing or not running (stopped by hand, KILL ALL, a safety pause) keep their slot and pair, but aren't judged.
    // One removed by hand since the last check isn't counted (the next settle drops it).
    const bots = a.bots.filter((b) => this.d.bot.hasBot(b.kind, b.id)), runs = (b: AutoBot) => this.d.bot.botStatus(b.kind, b.id).status === 'running';
    const held = bots.filter((b) => !b.retiring && runs(b)), parked = bots.filter((b) => b.retiring || !runs(b));
    const plan = planBudget({
      now, budget: a.budget.amount, cash: this.free(a), slots: o.slots, cands: cands.filter((x) => !this.failed.has(wayKey(x.o, x.how))), gone,
      held: held.map((b) => ({ id: b.id, pool: b.pool, pair: b.pair, label: b.label, openedAt: b.openedAt, feeBps: b.feeBps, capital: b.cost })),
      parked: parked.map((b) => ({ pool: b.pool, pair: b.pair, closing: !!b.retiring, alt: b.retiring?.alt ?? null })),
    });
    let opened = 0, retired = 0;
    for (const d of plan) {
      if (!this.state.on || a.halted || a.killed) break; // turned off or stopped while an open was under way (live, minutes)
      // A swap for an open still confirming: the other opens wait for the review that follows when it lands
      if (d.kind === 'open' && a.pending.length) break;
      if (d.kind === 'retire') {
        const b = a.bots.find((x) => x.id === d.id)!;
        b.retiring = { why: d.why, started: false, alt: d.alt };
        retired++;
        this.say(`replacing ${b.label}: ${d.why}`, 'info', c);
      } else if (d.kind === 'open') {
        if (await this.open(a, d.cand, d.capital, d.why)) opened++;
      } else if (d.kind === 'wait' && loud) {
        this.say(d.why, 'info', c);
      }
    }
    if (loud || opened || retired) {
      this.say(`reviewed ${fmt(a.budget.amount)} ${a.budget.coin} on ${name}: ${cands.filter((x) => x.score > 0).length} ways expected to earn; ${held.length - retired} kept, ${retired} to replace, ${opened} opened${parked.length ? `, ${parked.length} closing or stopped` : ''}`, 'info', c);
    }
  }

  /**
   * `capital` (in the budget's coin) cut to what the pool takes under the price-impact cap and the pool-share cap; `r` =
   * budget coins per unit of the pool's coin. A pool of unknown depth is taken as deep enough.
   */
  private fitEntry(c: Candidate, capital: number, r: number): number {
    const liq = c.o.activity?.liquidityUsd ?? 0, usdPer = c.o.capital > 0 ? c.o.usd / c.o.capital : 0;
    if (!(liq > 0) || !(usdPer > 0)) return capital;
    const ask = capital / r, reserve = liq / 2 / usdPer, maxImpact = this.d.bot.limits.maxPriceImpact;
    const fit = c.how === 'lp'
      ? capLpEntry({ capital: ask, quoteReserve: reserve, feeBps: c.feeBps, maxImpact })
      : capGridEntry({ capital: ask, quoteReserve: reserve, feeBps: c.feeBps, maxImpact, gridCount: c.o.grid!.gridCount });
    if (!(fit.amount > 0)) throw new Error('the pool is too thin for the price-impact cap');
    if (!fit.why || fit.amount >= ask * 0.98) return capital;
    this.say(`${c.label}: ${fit.why}`, 'info', c.o.chainId);
    return fit.amount * r;
  }

  /**
   * A new bot with `capital` (in the budget's coin) put into the pool's coin: what the account holds of that coin
   * first, then swapped from the budget's coin, then from any other coin it holds. Everything that can fail before a
   * swap is checked first: its market, the safety check, a price, and every swap into the pool's coin is planned and
   * quoted (route, impact, the coins in the wallet) before the first is sent. Turned off, stopped (KILL ALL, STOP chain,
   * the loss limit) or set up anew meanwhile: nothing more is sent, and a bot that started anyway is stopped at once. A
   * way that fails to open for a reason of its own is skipped until the next daily review.
   */
  private async open(a: Account, c: Candidate, capitalIn: number, why: string): Promise<boolean> {
    const bot = this.d.bot, mode = this.state.mode, chainId = a.budget.chainId, spend = c.o.spend;
    let capital = capitalIn;
    const alive = () => { if (!this.state.on || a.killed || a.halted || !this.state.accounts.includes(a)) throw new Stopped(`stopped meanwhile (${a.killed ?? (a.halted ? 'the loss limit' : 'turned off')}): nothing more is sent`); };
    try {
      const market = c.o.key ?? await bot.addOpportunityMarket({ chainId, ...c.o.ref });
      alive();
      const def = this.hub.def(market);
      if (def.quote.symbol !== spend) throw new Error(`its market spends ${def.quote.symbol}, not ${spend}`);
      if (mode === 'live' && def.safety && !def.safety.liveAllowed) throw new Error(`it failed its safety check (${def.safety.risk} risk), so it can only be paper traded`);
      const price = c.how === 'grid' ? (await bot.prices([market]))[market] : null;
      if (c.how === 'grid' && !(price! > 0)) throw new Error('no price for it right now');
      alive();
      const r = this.rate(chainId, spend);
      if (r == null) throw new Error(`no price for ${spend} yet`);
      capital = this.fitEntry(c, capital, r);
      // Spending the chain's own coin: the gas reserve a start needs comes out of the same coins and goes with the bot
      const native = spend === this.nativeSym(chainId), cfg = reserveCfg(bot.limits), want = capital / r;
      const sized = (h: number) => (native ? Math.max(0, Math.min(want, h / (1 + cfg.pct), h - cfg.fixed)) : Math.min(want, h));
      const enough = (h: number) => { if (!(sized(h) * r >= capital * MIN_PIECE)) throw new Error(`only ${fmt(sized(h))} ${spend} could be put in, too little of the ${fmt(capital)} ${a.budget.coin} planned`); };
      const legs: { from: string; x: number }[] = [];
      let planned = Math.max(0, a.coins[spend] ?? 0);
      for (const from of [a.budget.coin, ...Object.keys(a.coins).filter((s) => s !== a.budget.coin && s !== spend)]) {
        const short = want - planned, rf = this.rate(chainId, from), hold = a.coins[from] ?? 0;
        if (short <= want * 0.001) break;
        if (rf == null || !(hold > 0) || from === spend) continue;
        const x = Math.min(hold, (short * r) / rf);
        if (x * rf < a.budget.amount * SWEEP_DUST) continue;
        if (mode === 'live') await bot.assertBooked(chainId, this.token(chainId, from)!);
        planned += await this.preview(a, from, spend, x);
        legs.push({ from, x });
      }
      enough(planned);
      alive();
      let paid = 0, got = 0;
      for (const l of legs) {
        const out = await this.swap(a, l.from, spend, l.x, true);
        if (out == null) { this.say(`the swap into ${spend} for ${c.label} is waiting to confirm; it opens once it lands`, 'info', chainId); return false; }
        paid += l.x * this.rate(chainId, l.from)!; got += out;
        alive();
      }
      const have = Math.max(0, a.coins[spend] ?? 0);
      enough(have);
      const amount = sized(have), reserve = native ? gasReserve(amount, cfg) : 0;
      this.add(a, spend, -(amount + reserve));
      let id: string;
      try {
        id = c.how === 'grid'
          ? await bot.add({ mode, stable: market, lowerPrice: price! * (1 - c.o.grid!.bandPct), upperPrice: price! * (1 + c.o.grid!.bandPct), gridCount: c.o.grid!.gridCount, totalCapitalUsd: amount, recenter: true })
          : await bot.addLp({ mode, market, bandPct: c.o.lp!.bandPct, capital: amount, rerange: true });
      } catch (e) { this.add(a, spend, amount + reserve); throw e; }
      a.bots.push({
        id, kind: c.how, pool: poolId({ ...c.o, key: market }, c.how), pair: c.pair, label: c.label, market, spend, capital: amount, reserve,
        // what it cost: its coins (and the gas set aside with it) at the mid price, plus what the swaps into them lost
        cost: (amount + reserve) * r + Math.max(0, paid - got * r),
        openedAt: this.now(), expected: c.expected, feeBps: c.feeBps, retiring: null,
      });
      this.failed.delete(wayKey(c.o, c.how));
      this.say(`opened ${c.label} as a ${c.how === 'lp' ? `liquidity range ±${(c.o.lp!.bandPct * 100).toFixed(0)}%` : `grid ±${(c.o.grid!.bandPct * 100).toFixed(0)}%, ${c.o.grid!.gridCount} levels`} with ${fmt(amount)} ${spend}${spend !== a.budget.coin ? ` (≈ ${fmt(amount * r)} ${a.budget.coin})` : ''}: ${why}`, 'success', chainId);
      // KILL ALL / STOP while it was starting: stopped at once (it keeps its slot; Resume and Carry on bring it back)
      if (a.killed) { if (c.how === 'grid') bot.stop(id); else bot.stopLp(id); this.say(`${c.label} started as ${a.killed} came: stopped at once`, 'warn', chainId); }
      this.save();
      return true;
    } catch (e) {
      // A failure that isn't the pool's (stopped meanwhile, the wallet short) doesn't hold the pool back
      const own = !(e instanceof Stopped) && !(e instanceof FundsError) && !a.killed && this.state.on;
      if (own) this.failed.set(wayKey(c.o, c.how), this.now() + REVIEW_MS);
      this.say(`couldn't open ${c.label}: ${msg(e)}${own ? '; it is skipped until the next daily review' : ''}`, 'warn', chainId);
      return false;
    }
  }

  status() {
    return {
      on: this.state.on, mode: this.state.mode, options: this.state.options, budgets: this.state.budgets,
      reviewedAt: this.state.reviewedAt, scanAt: this.state.scanAt, lastError: this.lastError, closeAll: this.state.closeAll,
      accounts: this.state.accounts.map((a) => {
        const c = a.budget.chainId, on = this.chainOn(c);
        return {
          chainId: c, chain: this.chainName(c), coin: a.budget.coin, amount: a.budget.amount,
          coins: a.coins, free: this.free(a), value: this.value(a), pending: a.pending.length, startedAt: a.startedAt,
          halted: a.halted, killed: a.killed, withdrawn: a.withdrawn, gasNative: a.gasNative, nativeSym: on ? this.nativeSym(c) : null, holds: this.holds(a),
          bots: a.bots.map((b) => {
            const here = on && this.d.bot.hasBot(b.kind, b.id);
            const v = here ? this.d.bot.botValue(b.kind, b.id) : null, r = this.rate(c, b.spend), st = here ? this.d.bot.botStatus(b.kind, b.id) : null;
            return { ...b, value: v, valueBudget: v != null && r != null ? (v + b.reserve) * r : null, holdUntil: b.openedAt + HOLD_MS, status: st?.status ?? null, closing: st?.closing ?? false, cashedOut: here ? this.d.bot.botCashedOut(b.kind, b.id) : false };
          }),
        };
      }),
      log: this.state.log.slice(-100).reverse(),
    };
  }
}
