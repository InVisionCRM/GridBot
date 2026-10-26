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
import type { Holding, MultiBot } from './multi';
import type { Store } from './store';
import type { Emit } from './activity';
import type { Mode } from './engine';
import { ExecError, LiveExecutor, PaperExecutor, type Executor } from './chain';
import { candidates, HOLD_MS, MIN_PIECE, planBudget, poolId, type Candidate, type PlanOptions } from '../../market/autopilot';
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

const fresh = (): AutopilotState => ({ version: 2, on: false, mode: 'paper', options: { ...DEFAULT_OPTIONS }, budgets: [], accounts: [], closeAll: false, reviewedAt: null, scanAt: null, log: [] });
const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : String(Number(x.toPrecision(4))));
const msg = (e: unknown) => (e as Error).message;

/** Version 1 (before the kill switch, withdrawals, swap deadlines and kept replacements) gets their defaults. */
function upgrade(raw: AutopilotState | null): AutopilotState {
  if (!raw) return fresh();
  if (raw.version === 2) return raw;
  return {
    ...raw, version: 2, closeAll: false,
    accounts: raw.accounts.map((a) => ({
      ...a, killed: null, withdrawn: 0,
      bots: a.bots.map((b) => ({ ...b, reserve: 0, retiring: b.retiring ? { ...b.retiring, alt: null } : null })),
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
  /** Ways that failed to open (candidate id → until): the planner moves on to other pools meanwhile */
  private failed = new Map<string, number>();
  /** Warnings said in the last tick and this one: a failure repeating every minute is said once */
  private warnedBefore = new Set<string>();
  private warnedNow = new Set<string>();

  constructor(private readonly d: AutopilotDeps) {
    this.state = upgrade(d.store.load());
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
  /** The app's markets on the chain that may trade live (swaps only go through those) */
  private markets(chainId: number): RouteMarket[] {
    const id = (t: { native?: boolean; address: string }) => (t.native ? NATIVE : t.address.toLowerCase());
    return this.hub.byChain(chainId).filter((m) => !m.safety || m.safety.liveAllowed).map((m) => ({ key: m.key, base: id(m.base), quote: id(m.quote) }));
  }
  private route(chainId: number, from: string, to: string): Hop[] | null {
    const a = this.coinId(chainId, from), b = this.coinId(chainId, to);
    return a && b ? findRoute(a, b, this.markets(chainId)) : null;
  }
  /** A coin from the budget's: the route's pool fees twice (in and back) and budget coins per unit; null: no route or price */
  private reach(a: Account) {
    const c = a.budget.chainId;
    return (coin: string): { cost: number; rate: number } | null => {
      const rate = this.rate(c, coin);
      if (rate == null) return null;
      if (coin === a.budget.coin) return { cost: 0, rate };
      const hops = this.route(c, a.budget.coin, coin);
      return hops ? { cost: (2 * hops.reduce((s, h) => s + (this.hub.def(h.key).pool.feeBps ?? 30), 0)) / 10_000, rate } : null;
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
      const hops = this.route(c, sym, a.budget.coin);
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
      if (!this.chainOn(c)) continue;
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
  /**
   * Swap `amount` of `from` into `to` along the route. Before each swap is sent its input moves to a pending record and is
   * saved (a restart while it confirms finds it); the output is added when it lands. Returns what arrived, or null
   * when a swap is still unconfirmed (settled by its hash on a later tick). Live, the wallet must hold all that live
   * bots and the trader count of the coin first.
   */
  private async swap(a: Account, from: string, to: string, amount: number, forOpen: boolean): Promise<number | null> {
    const c = a.budget.chainId, rt = this.hub.rt(c), limits = this.d.bot.limits;
    const hops = this.route(c, from, to);
    if (!hops) throw new Error(`no route from ${from} to ${to} over this app's markets`);
    let amt = amount, sym = from;
    for (const h of hops) {
      if (a.killed) throw new Error(`${a.killed}: nothing is sent`);
      const toSym = this.symOf(c, h.to);
      if (this.state.mode === 'live') await this.d.bot.assertBooked(c, this.token(c, sym)!);
      const ex = this.executor(c, h.key, h.side, amt);
      const q = await ex.quote(h.side, amt, limits);
      if (q.block) throw new Error(q.block);
      if (!q.balanceOk) throw new Error(`swapping ${sym} to ${toSym}: ${q.balanceNote}`);
      if (q.priceImpact > limits.maxPriceImpact) throw new Error(`swapping ${fmt(amt)} ${sym} to ${toSym} would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(limits.maxPriceImpact * 100).toFixed(1)}%)`);
      const p: PendingSwap = { hash: null, key: h.key, side: h.side, from: sym, to: toSym, amountIn: amt, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, at: this.now(), deadline: Number(q.call.deadline), forOpen };
      this.add(a, sym, -amt);
      a.pending.push(p);
      this.save();
      try {
        const f = await rt.gate.run(() => ex.execute(q, { canSend: () => !a.killed, onSent: (stage, hash) => { if (stage === 'swap') { p.hash = hash; this.save(); } } }));
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
   * deadline. One never sent (the app stopped before it was) is refunded. true = a swap into a pool's coin landed.
   */
  private async settleSwaps(a: Account): Promise<boolean> {
    const c = a.budget.chainId;
    let landed = false;
    for (const p of [...a.pending]) {
      const done = (ok: boolean) => { a.pending = a.pending.filter((x) => x !== p); if (!ok) this.add(a, p.from, p.amountIn); this.save(); };
      if (p.hash == null) { done(false); this.say(`a swap of ${fmt(p.amountIn)} ${p.from} was never sent (the app stopped first); the ${p.from} is back`, 'warn', c); continue; }
      const r = await this.executor(c, p.key, p.side, p.amountIn).recover(p.hash, p.tokenOut, p.decimalsOut);
      if (!r) {
        if (this.now() / 1000 > p.deadline + PENDING_GRACE_S) { done(false); this.say(`swap ${p.hash.slice(0, 10)}… never mined before its deadline; the ${p.from} is back`, 'warn', c); }
        continue;
      }
      this.gas(a, r.gasNative);
      if (r.ok) { this.add(a, p.to, r.amountOutHuman); landed ||= p.forOpen; }
      done(r.ok);
      this.say(r.ok ? `swap ${p.hash.slice(0, 10)}… landed: ${fmt(r.amountOutHuman)} ${p.to}` : `swap ${p.hash.slice(0, 10)}… reverted; the ${p.from} is back`, r.ok ? 'info' : 'warn', c);
    }
    return landed;
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
   * On: the first time (or after new budgets) an account per budget, live only when the wallet holds it beyond what live
   * bots use; after a turn-off or a stop, the accounts carry on as they are (a budget stopped by its loss limit stays
   * stopped). Also clears a KILL ALL / STOP chain.
   */
  async turnOn() {
    const offs = this.state.accounts.flatMap((a) => a.bots.filter((b) => b.retiring?.why === 'turned off'));
    if (offs.some((b) => b.retiring!.started)) throw new Error('Its bots are still closing to cash from turning it off. Turn it on again once they are back.');
    for (const b of offs) b.retiring = null; // asked to close but not started (a stopped bot): cancelled
    if (this.state.on && !this.state.accounts.some((a) => a.killed)) return;
    if (!this.state.budgets.length) throw new Error('Add a budget first.');
    const live = this.state.mode === 'live';
    if (live) for (const b of this.state.budgets) if (!this.hub.rt(b.chainId).signer) throw new Error(`Live needs a signing key on ${this.hub.chain(b.chainId).name}.`);
    if (!this.state.accounts.length) {
      if (live) for (const b of this.state.budgets) await this.d.bot.assertCoin(b.chainId, this.token(b.chainId, b.coin)!, b.amount);
      this.state.accounts = this.state.budgets.map((b) => ({ budget: b, coins: { [b.coin]: b.amount }, gasNative: 0, bots: [], pending: [], startedAt: this.now(), halted: null, killed: null, withdrawn: 0 }));
    }
    for (const a of this.state.accounts) a.killed = null;
    this.state.on = true;
    this.state.closeAll = false;
    this.state.reviewedAt = null; // a review is due: now, or on the next check if one is running
    this.say(`on (${this.state.mode}): ${this.state.budgets.map((b) => `${fmt(b.amount)} ${b.coin} on ${this.hub.chain(b.chainId).name}`).join(', ')}`);
    this.save();
    if (this.busy) { this.say('the first review runs with the next check (within a minute)'); return; }
    await this.review(true);
  }
  /** sell = close every bot to cash (its money comes back to the budget); otherwise the bots keep running unmanaged. */
  turnOff(sell: boolean) {
    this.state.on = false;
    if (sell) this.state.closeAll = true;
    this.say(sell ? 'off: closing its bots to cash' : 'off: its bots keep running on their own; turn it on again to manage them');
    this.save();
  }
  /** KILL ALL (chainId null; also turns it off) or STOP chain: nothing more is sent for those budgets until it is turned on again. */
  kill(chainId: number | null) {
    const why = chainId == null ? 'KILL ALL' : `STOP ${this.chainName(chainId)}`;
    const hit = this.state.accounts.filter((a) => chainId == null || a.budget.chainId === chainId);
    if (!hit.length && (chainId != null || !this.state.on)) return; // nothing of the trader's there
    for (const a of hit) a.killed = why;
    if (chainId == null) this.state.on = false;
    this.say(`${why}: nothing more is sent${hit.length ? ` for ${hit.map((a) => this.chainName(a.budget.chainId)).join(', ')}` : ''}; turn it on again to carry on`, 'warn', chainId ?? undefined);
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
      let landed = false;
      for (const a of this.state.accounts) {
        if (!this.chainOn(a.budget.chainId)) { this.warn(`${this.chainName(a.budget.chainId)}: its budget waits until the chain is on again`); continue; }
        try { await this.refreshRates(a); if (await this.settleSwaps(a)) landed = true; } catch (e) { this.warn(`${this.chainName(a.budget.chainId)}: ${msg(e)}`, a.budget.chainId); }
      }
      const back = this.settle();
      if (this.state.on) {
        this.lossLimits();
        let scan: ScanView | null | undefined;
        try { scan = await this.d.scan(); } catch (e) { this.warn(`couldn't read the opportunity scan: ${msg(e)}`); }
        const due = this.state.reviewedAt == null || this.now() - this.state.reviewedAt >= REVIEW_MS || (scan?.at != null && scan.at !== this.state.scanAt);
        if (scan !== undefined && (due || back || landed)) await this.reviewNow(false, scan);
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
   * Bots back in cash are removed and their value credited (once there is a reading of it); closes asked for start,
   * except on a bot that is stopped (by hand, KILL ALL or a safety pause: it waits until it runs again) or on a stopped
   * budget. A liquidity bot closed by hand is closed to cash. true = money came back.
   */
  private settle(): boolean {
    let back = false;
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
          const value = this.d.bot.botValue(b.kind, b.id);
          if (value == null) continue; // no reading of it yet
          if (b.kind === 'grid') this.d.bot.remove(b.id); else this.d.bot.removeLp(b.id);
          this.add(a, b.spend, value + b.reserve);
          a.bots = a.bots.filter((x) => x !== b);
          const r = value - b.capital;
          this.say(`closed ${b.label} (${b.retiring?.why ?? 'closed to cash by hand'}): ${fmt(value)} ${b.spend} back, ${r >= 0 ? '+' : ''}${fmt(r)} on the ${fmt(b.capital)} it had`, r >= 0 ? 'success' : 'warn', c);
          this.save();
          back = true;
          continue;
        }
        const st = this.d.bot.botStatus(b.kind, b.id);
        if (!b.retiring && (this.state.closeAll || st.status === 'closed')) b.retiring = { why: this.state.closeAll ? 'turned off' : 'closed by hand', started: false, alt: null };
        if (!b.retiring || b.retiring.started || a.killed || (st.status !== 'running' && st.status !== 'closed')) continue;
        try {
          if (b.kind === 'grid') this.d.bot.gridToCash(b.id); else this.d.bot.closeLp(b.id, true);
          b.retiring.started = true;
          this.save();
        } catch (e) { this.warn(`couldn't start closing ${b.label}: ${msg(e)}`, c); }
      }
    }
    return back;
  }

  /** A budget worth stopLossPct less than its amount (less what was taken out by hand) closes every bot to cash and stops. */
  private lossLimits() {
    for (const a of this.state.accounts) {
      if (a.halted || a.killed || !this.chainOn(a.budget.chainId)) continue;
      const v = this.value(a), base = a.budget.amount - a.withdrawn;
      if (v == null || v > base * (1 - this.state.options.stopLossPct)) continue;
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
    const { cands, gone } = candidates(items, o, this.reach(a));
    const runs = (b: AutoBot) => this.d.bot.botStatus(b.kind, b.id).status === 'running';
    // Bots closing or not running (stopped by hand, KILL ALL, a safety pause) keep their slot and pair, but aren't judged
    const held = a.bots.filter((b) => !b.retiring && runs(b)), parked = a.bots.filter((b) => b.retiring || !runs(b));
    const plan = planBudget({
      now, budget: a.budget.amount, cash: this.free(a), slots: o.slots, cands: cands.filter((x) => !this.failed.has(x.id)), gone,
      held: held.map((b) => ({ id: b.id, pool: b.pool, pair: b.pair, label: b.label, openedAt: b.openedAt, feeBps: b.feeBps })),
      retiring: parked.map((b) => ({ pool: b.pool, pair: b.pair, alt: b.retiring?.alt ?? null })),
    });
    let opened = 0, retired = 0;
    for (const d of plan) {
      if (!this.state.on || a.halted || a.killed) break; // turned off or stopped while an open was under way (live, minutes)
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
   * A new bot with `capital` (in the budget's coin) put into the pool's coin: what the account holds of that coin
   * first, then swapped from the budget's coin, then from any other coin it holds. Everything that can fail without
   * the pool's coin (its market, the safety check, a price) is checked before any swap. A way that fails to open is
   * skipped until the next daily review.
   */
  private async open(a: Account, c: Candidate, capital: number, why: string): Promise<boolean> {
    const bot = this.d.bot, mode = this.state.mode, chainId = a.budget.chainId, spend = c.o.spend;
    try {
      const market = c.o.key ?? await bot.addOpportunityMarket({ chainId, ...c.o.ref });
      const def = this.hub.def(market);
      if (def.quote.symbol !== spend) throw new Error(`its market spends ${def.quote.symbol}, not ${spend}`);
      if (mode === 'live' && def.safety && !def.safety.liveAllowed) throw new Error(`it failed its safety check (${def.safety.risk} risk), so it can only be paper traded`);
      const price = c.how === 'grid' ? (await bot.prices([market]))[market] : null;
      if (c.how === 'grid' && !(price! > 0)) throw new Error('no price for it right now');
      const r = this.rate(chainId, spend);
      if (r == null) throw new Error(`no price for ${spend} yet`);
      const want = capital / r;
      let paid = 0, got = 0;
      for (const from of [a.budget.coin, ...Object.keys(a.coins).filter((s) => s !== a.budget.coin && s !== spend)]) {
        const short = want - Math.max(0, a.coins[spend] ?? 0), rf = this.rate(chainId, from), have = a.coins[from] ?? 0;
        if (short <= want * 0.001) break;
        if (rf == null || !(have > 0) || from === spend) continue;
        const x = Math.min(have, (short * r) / rf);
        if (x * rf < a.budget.amount * SWEEP_DUST) continue;
        const out = await this.swap(a, from, spend, x, true);
        if (out == null) { this.say(`the swap into ${spend} for ${c.label} is waiting to confirm; it opens once it lands`, 'info', chainId); return false; }
        paid += x * rf; got += out;
      }
      // Spending the chain's own coin: the gas reserve a start needs comes out of the same coins and goes with the bot
      const have = Math.max(0, a.coins[spend] ?? 0), native = spend === this.nativeSym(chainId), cfg = reserveCfg(bot.limits);
      const amount = native ? Math.max(0, Math.min(want, have / (1 + cfg.pct), have - cfg.fixed)) : Math.min(want, have);
      const reserve = native ? gasReserve(amount, cfg) : 0;
      if (!(amount * r >= capital * MIN_PIECE)) throw new Error(`only ${fmt(amount)} ${spend} could be put in, too little of the ${fmt(capital)} ${a.budget.coin} planned`);
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
      this.failed.delete(c.id);
      this.say(`opened ${c.label} as a ${c.how === 'lp' ? `liquidity range ±${(c.o.lp!.bandPct * 100).toFixed(0)}%` : `grid ±${(c.o.grid!.bandPct * 100).toFixed(0)}%, ${c.o.grid!.gridCount} levels`} with ${fmt(amount)} ${spend}${spend !== a.budget.coin ? ` (≈ ${fmt(amount * r)} ${a.budget.coin})` : ''}: ${why}`, 'success', chainId);
      this.save();
      return true;
    } catch (e) {
      this.failed.set(c.id, this.now() + REVIEW_MS);
      this.say(`couldn't open ${c.label}: ${msg(e)}; it is skipped until the next daily review`, 'warn', chainId);
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
            return { ...b, value: v, valueBudget: v != null && r != null ? (v + b.reserve) * r : null, holdUntil: b.openedAt + HOLD_MS, status: st?.status ?? null, closing: st?.closing ?? false };
          }),
        };
      }),
      log: this.state.log.slice(-100).reverse(),
    };
  }
}
