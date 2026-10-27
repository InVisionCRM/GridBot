/**
 * The smart trader: turn it on with a budget per chain (an amount of a coin on that chain, e.g. 1,000 USDG on
 * Robinhood) and it runs grid and liquidity bots with it, in paper or live (data/autopilot.json).
 *  - It picks from every pool the opportunity scan found on the chain. A pool that spends another coin than the budget's
 *    (an ETH pool for a USDG budget) is reached by swapping into that coin over the app's markets (one or two swaps,
 *    market/convertRoute.ts) and back when the bot closes; the planner counts those swaps' fees against the pool.
 *  - Reviews when turned on, after each daily scan, and when money comes back from a bot. The decisions are
 *    market/autopilot.ts planBudget: the best pools after costs, a week's hold, switching only when it pays.
 *  - A bot it replaces is closed to cash (the grid sells what it holds, the liquidity bot takes its position out and
 *    sells the base coin) and removed; what it was worth goes back to the budget's account, and a coin other than the
 *    budget's is swapped back.
 *  - Loss limit per budget: when its value falls stopLossPct below the amount, its bots are closed to cash and it stops.
 * Every swap goes through the chain's transaction queue and nonce (the bots' own); one still unconfirmed when the
 * wait ends is settled by its hash later. Values are in the budget's coin at today's prices, gas counted.
 */
import type { MultiBot } from './multi';
import { systemHalt, type Halt } from './audit';
import type { Store } from './store';
import type { Emit } from './activity';
import type { Mode } from './engine';
import { ExecError, LiveExecutor, PaperExecutor, type Executor } from './chain';
import { candidates, HOLD_MS, planBudget, type Candidate, type PlanOptions } from '../../market/autopilot';
import { entryCostFraction, capGridEntry, capLpEntry } from '../../market/poolSize';
import { findRoute, type CoinId, type Hop, type RouteMarket } from '../../market/convertRoute';
import { NATIVE } from '../../live/swapMath';
import type { Opportunity } from '../../market/scan';

export interface AutoOptions extends PlanOptions { stopLossPct: number }
export interface Budget { chainId: number; coin: string; amount: number }
export interface AutoBot {
  id: string; kind: 'grid' | 'lp'; pool: string; pair: string; label: string; market: string;
  /** The coin it spends and how much of it it got */
  spend: string; capital: number;
  /** What it cost in the budget's coin */
  cost: number;
  openedAt: number; expected: number; feeBps: number;
  /** Being closed to cash: why, and whether the close has been started */
  retiring: { why: string; started: boolean } | null;
}
/** A swap sent but not confirmed when the wait ended: settled by its hash */
export interface PendingSwap { hash: string; key: string; side: 'buy' | 'sell'; from: string; to: string; amountIn: number; tokenOut: string; decimalsOut: number; at: number }
export interface Account {
  budget: Budget;
  /** Money not in a bot, per coin (symbol) */
  coins: Record<string, number>;
  /** Gas its swaps paid, in the chain's own coin */
  gasNative: number;
  bots: AutoBot[]; pending: PendingSwap[]; startedAt: number; halted: string | null;
  /** Stopped by Stop all / STOP chain: it opens nothing, sends no swap and starts no close until Carry on */
  killed?: string | null;
  /** The stop audit record of that press */
  killHalt?: Halt | null;
}
export interface AutoEntry { t: number; level: 'info' | 'success' | 'warn'; msg: string; chainId?: number }
export interface AutopilotState {
  version: 1; on: boolean; mode: Mode; options: AutoOptions; budgets: Budget[]; accounts: Account[];
  reviewedAt: number | null;
  /** The scan the last review used */
  scanAt: number | null;
  log: AutoEntry[];
}
export interface ScanView { at: number | null; chains: { chainId: number; items: Opportunity[] }[] }

export const DEFAULT_OPTIONS: AutoOptions = { grid: true, lp: true, newTokens: true, risk: 'any', slots: 3, stopLossPct: 0.2 };
/** A review at least this often, even without a new scan */
export const REVIEW_MS = 24 * 3600_000;
/** A coin other than the budget's worth under this share of the budget isn't swapped back */
const SWEEP_DUST = 0.002;
const LOG_MAX = 300;

export interface AutopilotDeps {
  bot: MultiBot;
  /** The latest opportunity scan (null: the scan is off) */
  scan: () => Promise<ScanView | null>;
  store: Store<AutopilotState>;
  emit: Emit;
  now?: () => number;
  receiptTimeoutMs?: number;
}

const fresh = (): AutopilotState => ({ version: 1, on: false, mode: 'paper', options: { ...DEFAULT_OPTIONS }, budgets: [], accounts: [], reviewedAt: null, scanAt: null, log: [] });
const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : String(Number(x.toPrecision(4))));

export function checkOptions(o: AutoOptions): AutoOptions {
  if (!o.grid && !o.lp) throw new Error('Allow grids, liquidity, or both.');
  if (!Number.isInteger(o.slots) || o.slots < 1 || o.slots > 6) throw new Error('Bots per budget: 1 to 6.');
  if (!(o.stopLossPct >= 0.05 && o.stopLossPct <= 0.9)) throw new Error('Loss limit: 5% to 90%.');
  if (!['safe', 'medium', 'any'].includes(o.risk)) throw new Error('Risk must be safe, medium or any.');
  return { grid: !!o.grid, lp: !!o.lp, newTokens: !!o.newTokens, risk: o.risk, slots: o.slots, stopLossPct: o.stopLossPct };
}

export class Autopilot {
  state: AutopilotState;
  lastError: string | null = null;
  private busy = false;
  /** Budget coins per unit of a coin, per chain ("chainId:SYM"), at today's prices (refreshed every tick) */
  private rates = new Map<string, number>();

  constructor(private readonly d: AutopilotDeps) {
    this.state = d.store.load() ?? fresh();
    d.bot.stopHooks.push((chainId, halt) => this.kill(chainId, halt));
  }

  /**
   * Stop all (chainId null) or STOP chain: those budgets open nothing, send no swap and start no close (a close would
   * start a stopped bot again) until Carry on. A swap already being sent is stopped before it goes out.
   */
  kill(chainId: number | null, halt: Halt) {
    const hit = this.state.accounts.filter((a) => chainId == null || a.budget.chainId === chainId);
    if (!hit.length) return;
    const why = chainId == null ? 'Stop all' : `STOP ${this.hub.chain(chainId).name}`;
    for (const a of hit) { a.killed = why; a.killHalt = halt; }
    this.say(`${why}: opens nothing and sends nothing for ${hit.map((a) => this.hub.chain(a.budget.chainId).name).join(', ')} until you press Carry on`, 'warn', chainId ?? undefined);
    this.d.emit({ type: 'stopped', kind: 'system', level: 'warn', notify: true, msg: `Smart trader stopped by ${why}`, data: { halt }, ...(chainId != null ? { chainId } : {}) });
    this.save();
  }
  /** After Stop all / STOP chain: that budget may open bots and swap again. */
  carryOn(chainId: number) {
    const a = this.state.accounts.find((x) => x.budget.chainId === chainId && x.killed);
    if (!a) throw new Error(`The ${this.hub.chain(chainId).name} budget isn't stopped.`);
    a.killed = null; a.killHalt = null;
    this.say('carrying on', 'info', chainId);
    this.save();
  }

  private now() { return (this.d.now ?? Date.now)(); }
  private save() { this.d.store.save(this.state); }
  private get hub() { return this.d.bot.hub; }
  private say(msg: string, level: AutoEntry['level'] = 'info', chainId?: number) {
    this.state.log.push({ t: this.now(), level, msg, ...(chainId != null ? { chainId } : {}) });
    if (this.state.log.length > LOG_MAX) this.state.log.splice(0, this.state.log.length - LOG_MAX);
    this.d.emit({ type: 'info', kind: 'system', level, msg: `Smart trader: ${msg}`, ...(chainId != null ? { chainId } : {}) });
  }
  private get running() { return this.state.accounts.some((a) => a.bots.length || a.pending.length); }

  // ── Coins and routes on a chain ───────────────────────────────────────
  /** A coin by its symbol: the chain's own coin, or a token of one of the app's markets there. */
  private coinId(chainId: number, sym: string): CoinId | null {
    if (sym === this.hub.chain(chainId).nativeSymbol) return NATIVE;
    for (const m of this.hub.byChain(chainId)) for (const t of [m.base, m.quote]) if (!t.native && t.symbol === sym) return t.address.toLowerCase();
    return null;
  }
  private symOf(chainId: number, id: CoinId): string {
    if (id === NATIVE) return this.hub.chain(chainId).nativeSymbol;
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
  /** Swapping the budget's coin into `coin` and back: the route's pool fees, twice (null: no route) */
  private convertCost(chainId: number, budget: string) {
    return (coin: string): number | null => {
      if (coin === budget) return 0;
      const hops = this.route(chainId, budget, coin);
      return hops ? (2 * hops.reduce((s, h) => s + (this.hub.def(h.key).pool.feeBps ?? 30), 0)) / 10_000 : null;
    };
  }
  private rate(chainId: number, sym: string): number | null { return this.rates.get(`${chainId}:${sym}`) ?? null; }
  /** Budget coins per unit of every coin the account holds or its bots spend, along the route, at mid prices. */
  private async refreshRates(a: Account) {
    const c = a.budget.chainId;
    const syms = new Set([a.budget.coin, this.hub.chain(c).nativeSymbol, ...Object.keys(a.coins), ...a.bots.map((b) => b.spend), ...a.pending.flatMap((p) => [p.from, p.to])]);
    for (const sym of syms) {
      const hops = this.route(c, sym, a.budget.coin);
      if (!hops) continue;
      let k = 1;
      try {
        for (const h of hops) { const p = await this.hub.quoter(h.key).getPrice(); k *= h.side === 'sell' ? p : 1 / p; }
        this.rates.set(`${c}:${sym}`, k);
      } catch { /* keep the last rate */ }
    }
  }
  private add(a: Account, sym: string, x: number) {
    a.coins[sym] = (a.coins[sym] ?? 0) + x;
    if (Math.abs(a.coins[sym]) < 1e-12) delete a.coins[sym];
  }

  // ── Swaps ─────────────────────────────────────────────────────────────
  private executor(chainId: number, key: string, side: 'buy' | 'sell', amount: number): Executor {
    const q = this.hub.quoter(key), rt = this.hub.rt(chainId), approval = 'exact' as const;
    if (this.state.mode === 'live') return new LiveExecutor(q, rt.signer!, { approval, receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000, sharedNonce: rt.nonce });
    return new PaperExecutor(q, () => (side === 'buy' ? { pls: 0, stable: amount } : { pls: amount, stable: 0 }), approval);
  }
  /**
   * Swap `amount` of `from` into `to` along the route; the account's coins move as each swap lands. Returns what
   * arrived, or null when a swap is still unconfirmed (it is settled by its hash on a later tick).
   */
  private async swap(a: Account, from: string, to: string, amount: number): Promise<number | null> {
    const c = a.budget.chainId, rt = this.hub.rt(c), limits = this.d.bot.limits;
    const hops = this.route(c, from, to);
    if (!hops) throw new Error(`no route from ${from} to ${to} over this app's markets`);
    let amt = amount, sym = from;
    for (const h of hops) {
      const toSym = this.symOf(c, h.to);
      const ex = this.executor(c, h.key, h.side, amt);
      const q = await ex.quote(h.side, amt, limits);
      if (q.block) throw new Error(q.block);
      if (!q.balanceOk) throw new Error(`swapping ${sym} to ${toSym}: ${q.balanceNote}`);
      if (q.priceImpact > limits.maxPriceImpact) throw new Error(`swapping ${fmt(amt)} ${sym} to ${toSym} would move the price ${(q.priceImpact * 100).toFixed(2)}% (cap ${(limits.maxPriceImpact * 100).toFixed(1)}%)`);
      this.add(a, sym, -amt);
      try {
        if (a.killed) throw new Error(`${a.killed} was pressed: nothing is sent`);
        const f = await rt.gate.run(() => ex.execute(q, { canSend: () => !a.killed, onSent: () => undefined }));
        a.gasNative += f.gasNative ?? 0;
        amt = f.amountOutHuman; sym = toSym;
        this.add(a, sym, amt);
        this.save();
      } catch (e) {
        const o = e instanceof ExecError ? e.opts : {};
        if (o.pending && o.swapTxHash) {
          a.pending.push({ hash: o.swapTxHash, key: h.key, side: h.side, from: sym, to: toSym, amountIn: amt, tokenOut: q.tokenOut, decimalsOut: q.decimalsOut, at: this.now() });
          this.save();
          return null;
        }
        this.add(a, sym, amt); // nothing was swapped
        throw e;
      }
    }
    return amt;
  }
  /** Swaps sent before and not confirmed then: credited when they land, refunded when they reverted. */
  private async settleSwaps(a: Account) {
    for (const p of [...a.pending]) {
      const r = await this.executor(a.budget.chainId, p.key, p.side, p.amountIn).recover(p.hash, p.tokenOut, p.decimalsOut);
      if (!r) continue;
      a.pending = a.pending.filter((x) => x !== p);
      if (r.ok) this.add(a, p.to, r.amountOutHuman); else this.add(a, p.from, p.amountIn);
      this.say(r.ok ? `swap ${p.hash.slice(0, 10)}… landed: ${fmt(r.amountOutHuman)} ${p.to}` : `swap ${p.hash.slice(0, 10)}… reverted; the ${p.from} is back`, r.ok ? 'info' : 'warn', a.budget.chainId);
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
        const got = await this.swap(a, sym, a.budget.coin, amt);
        if (got != null) this.say(`swapped ${fmt(amt)} ${sym} back to ${fmt(got)} ${a.budget.coin}`, 'info', a.budget.chainId);
      } catch (e) { this.lastError = `swapping ${sym} back: ${(e as Error).message}`; }
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────
  /** Mode and budgets change only while it is off and runs no bots; options any time. */
  configure(p: { mode: Mode; options: AutoOptions; budgets: Budget[] }) {
    if (this.state.on || this.running) throw new Error('Turn it off (and let it close its bots) before changing the mode or the budgets.');
    if (p.mode !== 'paper' && p.mode !== 'live') throw new Error('Mode must be paper or live.');
    const seen = new Set<string>();
    const budgets = p.budgets.map((b) => {
      const amount = Number(b.amount), chainId = Number(b.chainId), coin = String(b.coin ?? '').trim();
      if (!this.hub.runtimes().some((r) => r.cfg.id === chainId)) throw new Error(`Chain ${chainId} isn't on in this app.`);
      if (!coin || !this.coinId(chainId, coin)) throw new Error(`Pick a coin this app trades on ${this.hub.chain(chainId).name}.`);
      if (!(amount > 0)) throw new Error(`The ${coin} budget must be more than 0.`);
      const k = `${chainId}`;
      if (seen.has(k)) throw new Error(`${this.hub.chain(chainId).name} has two budgets: one per chain.`);
      seen.add(k);
      return { chainId, coin, amount };
    });
    this.state = { ...this.state, mode: p.mode, options: checkOptions(p.options), budgets, accounts: [] };
    this.save();
  }
  setOptions(o: Partial<AutoOptions>) {
    this.state.options = checkOptions({ ...this.state.options, ...o });
    this.save();
  }

  async turnOn() {
    if (this.state.on) return;
    if (!this.state.budgets.length) throw new Error('Add a budget first.');
    if (this.state.mode === 'live') {
      for (const b of this.state.budgets) if (!this.hub.rt(b.chainId).signer) throw new Error(`Live needs a signing key on ${this.hub.chain(b.chainId).name}.`);
    }
    // Kept bots from before (turned off without closing them) carry on with their budget.
    if (!this.running) {
      this.state.accounts = this.state.budgets.map((b) => ({ budget: b, coins: { [b.coin]: b.amount }, gasNative: 0, bots: [], pending: [], startedAt: this.now(), halted: null }));
    }
    this.state.on = true;
    this.say(`on (${this.state.mode}): ${this.state.budgets.map((b) => `${fmt(b.amount)} ${b.coin} on ${this.hub.chain(b.chainId).name}`).join(', ')}`);
    this.save();
    for (const a of this.state.accounts) await this.refreshRates(a);
    await this.review(true);
  }
  /** sell = close every bot to cash (its money comes back to the budget); otherwise the bots keep running unmanaged. */
  turnOff(sell: boolean) {
    this.state.on = false;
    if (sell) for (const a of this.state.accounts) for (const b of a.bots) if (!b.retiring) b.retiring = { why: 'turned off', started: false };
    this.say(sell ? 'off: closing its bots to cash' : 'off: its bots keep running on their own; turn it on again to manage them');
    this.save();
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  /** Every minute: settle swaps and closes, check the loss limits, review when due, swap leftover coins back. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const a of this.state.accounts) { await this.refreshRates(a); await this.settleSwaps(a); }
      const back = this.settle();
      if (this.state.on) {
        this.lossLimits();
        const scan = await this.d.scan();
        const due = this.state.reviewedAt == null || this.now() - this.state.reviewedAt >= REVIEW_MS || (scan?.at != null && scan.at !== this.state.scanAt);
        if (due || back) await this.reviewNow(false, scan);
      }
      this.settle(); // closes decided this tick start now
      for (const a of this.state.accounts) await this.sweep(a);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.save();
      this.busy = false;
    }
  }

  /** Start pending closes; a bot that is back in cash is removed and its value goes to the account. true = money came back. */
  private settle(): boolean {
    let back = false;
    for (const a of this.state.accounts) {
      for (const b of [...a.bots]) {
        if (!this.d.bot.hasBot(b.kind, b.id)) {
          a.bots = a.bots.filter((x) => x !== b);
          this.say(`${b.label} was removed by hand; its money isn't counted back to the budget`, 'warn', a.budget.chainId);
          continue;
        }
        if (!b.retiring) continue;
        if (!b.retiring.started) {
          if (a.killed) continue; // a close would start the stopped bot again; it waits for Carry on
          try {
            const halt = systemHalt(b.retiring.why === 'loss limit' ? 'loss-limit' : 'autopilot', b.retiring.why === 'loss limit' ? (a.halted || 'loss limit') : b.retiring.why, this.now());
            if (b.kind === 'grid') this.d.bot.closeGrid(b.id, halt); else this.d.bot.closeLp(b.id, halt);
            b.retiring.started = true;
          } catch (e) { this.lastError = `${b.label}: ${(e as Error).message}`; }
          continue;
        }
        if (!this.d.bot.botCashedOut(b.kind, b.id)) continue;
        const value = this.d.bot.botValue(b.kind, b.id) ?? b.capital;
        if (b.kind === 'grid') this.d.bot.remove(b.id); else this.d.bot.removeLp(b.id);
        this.add(a, b.spend, value);
        a.bots = a.bots.filter((x) => x !== b);
        const r = value - b.capital;
        this.say(`closed ${b.label} (${b.retiring.why}): ${fmt(value)} ${b.spend} back, ${r >= 0 ? '+' : ''}${fmt(r)} on the ${fmt(b.capital)} it had`, r >= 0 ? 'success' : 'warn', a.budget.chainId);
        back = true;
      }
    }
    return back;
  }

  /** A budget worth stopLossPct less than its amount closes every bot to cash and stops. */
  private lossLimits() {
    for (const a of this.state.accounts) {
      if (a.halted) continue;
      const v = this.value(a);
      if (v == null || v > a.budget.amount * (1 - this.state.options.stopLossPct)) continue;
      a.halted = `worth ${fmt(v)} ${a.budget.coin}, ${((1 - v / a.budget.amount) * 100).toFixed(1)}% under the ${fmt(a.budget.amount)} it started with (limit ${(this.state.options.stopLossPct * 100).toFixed(0)}%)`;
      for (const b of a.bots) if (!b.retiring) b.retiring = { why: 'loss limit', started: false };
      this.say(`loss limit: ${a.halted}; closing its bots to cash and stopping this budget`, 'warn', a.budget.chainId);
    }
  }

  /** The account's worth in the budget's coin: its coins, its bots and swaps in flight at today's prices, less gas. null while something has no price or reading yet. */
  value(a: Account): number | null {
    const c = a.budget.chainId;
    let v = 0;
    const at = (sym: string, x: number) => { const r = this.rate(c, sym); if (r == null) return false; v += x * r; return true; };
    for (const [sym, x] of Object.entries(a.coins)) if (!at(sym, x)) return null;
    for (const p of a.pending) if (!at(p.from, p.amountIn)) return null;
    for (const b of a.bots) {
      const x = this.d.bot.hasBot(b.kind, b.id) ? this.d.bot.botValue(b.kind, b.id) : null;
      if (x == null || !at(b.spend, x)) return null;
    }
    if (a.gasNative && !at(this.hub.chain(c).nativeSymbol, -a.gasNative)) return null;
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
      for (const a of this.state.accounts) await this.refreshRates(a);
      await this.reviewNow(force);
      this.settle();
    } finally { this.save(); this.busy = false; }
  }

  private async reviewNow(force: boolean, scanIn?: ScanView | null) {
    if (!this.state.on) return;
    const scan = scanIn === undefined ? await this.d.scan() : scanIn;
    if (!scan) { this.say('no opportunity scan (it is off: CANDLES_GECKO=off), so nothing to pick from', 'warn'); this.state.reviewedAt = this.now(); return; }
    if (scan.at == null) { if (force) this.say('waiting for the first opportunity scan to finish (up to an hour)'); return; }
    const o = this.state.options, newScan = scan.at !== this.state.scanAt;
    for (const a of this.state.accounts) {
      if (a.halted || a.killed) continue;
      const items = scan.chains.find((c) => c.chainId === a.budget.chainId)?.items ?? [];
      const piece = a.budget.amount / Math.max(1, o.slots);
      const cands = candidates(items, o, this.convertCost(a.budget.chainId, a.budget.coin), (opp, how) => {
        const liq = opp.activity?.liquidityUsd ?? 0;
        if (!(liq > 0) || !(opp.capital > 0)) return 0;
        const usdPer = opp.usd / opp.capital;
        const rate = this.rate(a.budget.chainId, opp.spend) ?? (opp.spend === a.budget.coin ? 1 : null);
        if (!(usdPer > 0) || rate == null) return 0;
        return entryCostFraction({
          capital: piece / rate, quoteReserve: (liq / 2) / usdPer, feeBps: opp.feeBps, maxImpact: 0.03,
          baseShare: how === 'lp' ? 0.5 : Math.min(1, 0.5), maxPoolShare: 0.1,
        });
      });
      const live = a.bots.filter((b) => !b.retiring), retiring = a.bots.length - live.length;
      const plan = planBudget({
        now: this.now(), budget: a.budget.amount, cash: this.free(a), slots: o.slots - retiring, cands,
        held: live.map((b) => ({ id: b.id, pool: b.pool, pair: b.pair, label: b.label, openedAt: b.openedAt, feeBps: b.feeBps })),
      });
      let opened = 0, retired = 0;
      for (const d of plan) {
        if (d.kind === 'retire') {
          const b = a.bots.find((x) => x.id === d.id)!;
          b.retiring = { why: d.why, started: false };
          retired++;
          this.say(`replacing ${b.label}: ${d.why}`, 'info', a.budget.chainId);
        } else if (d.kind === 'open') {
          if (await this.open(a, d.cand, d.capital, d.why)) opened++;
        } else if (d.kind === 'wait' && (force || newScan)) {
          this.say(d.why, 'info', a.budget.chainId);
        }
      }
      if (force || newScan || opened || retired) {
        this.say(`reviewed ${fmt(a.budget.amount)} ${a.budget.coin} on ${this.hub.chain(a.budget.chainId).name}: ${cands.length} pools expected to earn; ${live.length - retired} kept, ${retired} to replace, ${opened} opened`, 'info', a.budget.chainId);
      }
    }
    this.state.reviewedAt = this.now();
    this.state.scanAt = scan.at;
    this.save();
  }

  /**
   * A new bot with `capital` (in the budget's coin) put into the pool's coin: what the account already holds of that
   * coin first, the rest swapped from the budget's coin. A token not in the app yet is added first (safety re-checked).
   */
  private async open(a: Account, c: Candidate, capitalIn: number, why: string): Promise<boolean> {
    const bot = this.d.bot, mode = this.state.mode, chainId = a.budget.chainId, spend = c.o.spend;
    let capital = capitalIn;
    try {
      const liq = c.o.activity?.liquidityUsd ?? 0;
      const usdPer = c.o.capital > 0 ? c.o.usd / c.o.capital : 0;
      const rate = this.rate(chainId, spend) ?? (spend === a.budget.coin ? 1 : null);
      if (liq > 0 && usdPer > 0 && rate) {
        const ask = capital / rate;
        const fit = c.how === 'lp'
          ? capLpEntry({ capital: ask, quoteReserve: (liq / 2) / usdPer, feeBps: c.feeBps, maxImpact: 0.03 })
          : capGridEntry({ capital: ask, quoteReserve: (liq / 2) / usdPer, feeBps: c.feeBps, maxImpact: 0.03, gridCount: c.o.grid?.gridCount ?? 10 });
        if (fit.why && fit.amount < ask * 0.98) {
          capital = fit.amount * rate;
          this.say(`${c.label}: ${fit.why}`, 'info', chainId);
        }
      }
      if (!(capital > 0)) throw new Error('the pool is too thin for the price-impact cap');
      if (a.killed) throw new Error(`${a.killed} was pressed`);
      const market = c.o.key ?? await bot.addOpportunityMarket({ chainId: c.o.chainId, ...c.o.add! });
      const r = this.rate(chainId, spend) ?? (spend === a.budget.coin ? 1 : null);
      if (r == null) throw new Error(`no price for ${spend} yet`);
      const want = capital / r, have = Math.max(0, a.coins[spend] ?? 0);
      if (have < want * 0.999) {
        const from = Math.min((want - have) * r, a.coins[a.budget.coin] ?? 0);
        if (!(from > 0)) throw new Error(`no ${a.budget.coin} left to swap into ${spend}`);
        const got = await this.swap(a, a.budget.coin, spend, from);
        if (got == null) { this.say(`the swap into ${spend} for ${c.label} is waiting to confirm; it opens on a later review`, 'info', chainId); return false; }
      }
      const amount = Math.min(want, a.coins[spend] ?? 0);
      if (!(amount > 0)) throw new Error(`no ${spend} to put in`);
      // Stop all during the swap above: nothing is opened (the coins stay in the budget). One during the start below
      // is refused by the bot's own start guard.
      if (a.killed) throw new Error(`${a.killed} was pressed`);
      let id: string;
      if (c.how === 'grid') {
        const price = (await bot.prices([market]))[market];
        if (!(price > 0)) throw new Error('no price');
        const band = c.o.grid!.bandPct;
        id = await bot.add({ mode, stable: market, lowerPrice: price * (1 - band), upperPrice: price * (1 + band), gridCount: c.o.grid!.gridCount, totalCapitalQuote: amount, recenter: true });
      } else {
        id = await bot.addLp({ mode, market, bandPct: c.o.lp!.bandPct, capital: amount, rerange: true });
      }
      this.add(a, spend, -amount);
      a.bots.push({ id, kind: c.how, pool: c.id, pair: c.pair, label: c.label, market, spend, capital: amount, cost: amount * r, openedAt: this.now(), expected: c.expected, feeBps: c.feeBps, retiring: null });
      this.say(`opened ${c.label} as a ${c.how === 'lp' ? `liquidity range ±${(c.o.lp!.bandPct * 100).toFixed(0)}%` : `grid ±${(c.o.grid!.bandPct * 100).toFixed(0)}%, ${c.o.grid!.gridCount} levels`} with ${fmt(amount)} ${spend}${spend !== a.budget.coin ? ` (≈ ${fmt(amount * r)} ${a.budget.coin})` : ''}: ${why}`, 'success', chainId);
      this.save();
      return true;
    } catch (e) {
      this.say(`couldn't open ${c.label}: ${(e as Error).message}`, 'warn', chainId);
      return false;
    }
  }

  status() {
    return {
      on: this.state.on, mode: this.state.mode, options: this.state.options, budgets: this.state.budgets,
      reviewedAt: this.state.reviewedAt, scanAt: this.state.scanAt, lastError: this.lastError,
      accounts: this.state.accounts.map((a) => {
        const c = a.budget.chainId;
        return {
          chainId: c, chain: this.hub.chain(c).name, coin: a.budget.coin, amount: a.budget.amount,
          coins: a.coins, free: this.free(a), value: this.value(a), pending: a.pending.length, startedAt: a.startedAt, halted: a.halted,
          killed: a.killed ?? null, killHalt: a.killHalt ?? null,
          bots: a.bots.map((b) => {
            const v = this.d.bot.hasBot(b.kind, b.id) ? this.d.bot.botValue(b.kind, b.id) : null, r = this.rate(c, b.spend);
            return { ...b, value: v, valueBudget: v != null && r != null ? v * r : null, holdUntil: b.openedAt + HOLD_MS };
          }),
        };
      }),
      log: this.state.log.slice(-100).reverse(),
    };
  }
}
