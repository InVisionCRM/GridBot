/**
 * Tools → Convert: what the wallet holds on one chain, into one coin.
 *
 *  - Coins (holdings.ts): the chain's own coin, this app's market coins and every ERC-20 the chain's explorer lists.
 *  - Amount: the balance less what live bots use (MultiBot.allocations: a grid's free coin and lots, a liquidity bot's
 *    spare coins) and, for the chain's own coin, what's kept for gas. A position's coins are in the pool, not the wallet.
 *  - Route (market/convertRoute): through this app's markets first. A coin with no route there gets its best pool from
 *    hub.inspect, which runs the same safety check as adding a market (honeypot and tax simulation); one that fails it
 *    isn't touched, nor one named like a website. Wrapped native (WPLS / WETH) is unwrapped first.
 *  - Each route is quoted for the plan. Skipped: a swap over the price-impact cap, or a coin worth less than twice the
 *    gas of converting it.
 *  - Running: one coin at a time, each transaction through the chain's gate and shared nonce (the bots' own), each swap
 *    quoted again just before it's sent; the second swap of a route spends what the first one actually returned.
 */
import { DEFAULT_LIMITS, type SafetyLimits } from '../../live/limits';
import type { MarketDef } from '../../live/markets';
import { amountToUnits } from '../../live/decimals';
import { fromUnits, NATIVE } from '../../live/swapMath';
import { findRoute, namedLikeSite, type CoinId, type Hop, type RouteMarket } from '../../market/convertRoute';
import type { Hub } from '../chains/hub';
import type { ChainRuntime } from '../chains/runtime';
import { LiveExecutor, type Quoter } from '../bot/chain';
import type { Emit } from '../bot/activity';
import { WRAPPED } from '../dex/abis';
import type { FetchJson } from '../fetchJson';
import { holdings, type Coin, type Unreadable } from './holdings';
import { noKey } from '../words';
import type { ReservedBalance } from '../swap/holds';

/** A plan older than this must be made again before it runs (prices and balances move). */
export const PLAN_TTL_MS = 10 * 60_000;
/** Gas of WETH9.withdraw, rounded up from real unwraps (~30–45k) */
const UNWRAP_GAS = 50_000;
const SITE_WHY = 'Named like a website, the way scam airdrops lure you to a site that drains wallets. Not touched.';

/** What live bots use of one coin (MultiBot.allocations rows). */
export interface Allocation { chainId: number; address: string; native: boolean; allocated: number }

export interface PlanRow {
  coin: Coin;
  /** On-chain balance, what live bots use, what's kept for gas, and what would be converted */
  balance: number; bots: number; keep: number; amount: number;
  /** The unwrap and swaps, in order ("HEX → PLS · PulseX V2") */
  steps: string[];
  /** Expected amount of the target, the largest price impact of its swaps, and their gas in the chain's own coin */
  out: number | null; impact: number | null; gasNative: number | null;
  ok: boolean;
  /** Why it isn't converted (ok false) */
  why: string | null;
}

export interface Plan {
  id: string; chainId: number; owner: string; at: number;
  target: Coin; targetBalance: number;
  keepNative: number; maxImpact: number;
  /** Where the coin list came from: the chain's explorer, or only this app's markets */
  listedBy: 'explorer' | 'markets';
  rows: PlanRow[];
  /** Coins the explorer lists that the chain wouldn't give a balance or decimals() for: left alone */
  unreadable: Unreadable[];
}

export interface JobRow {
  coin: Coin; amount: number;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
  steps: { label: string; hash: string | null; out: number | null }[];
  out: number | null; error: string | null;
}
export interface Job { id: string; chainId: number; target: Coin; startedAt: number; finishedAt: number | null; stopping: boolean; rows: JobRow[] }

interface Route { unwrap: boolean; hops: Hop[] }
interface Kept { plan: Plan; routes: Map<CoinId, Route>; drafts: Map<string, MarketDef>; limits: SafetyLimits }

export interface ConverterDeps {
  hub: Hub;
  allocations(): Allocation[];
  approval: 'exact' | 'max';
  fetchJson: FetchJson;
  emit?: Emit;
  now?: () => number;
  receiptTimeoutMs?: number;
  /** How often an unwrap's receipt is looked for */
  pollMs?: number;
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const num = (x: number) => (Math.abs(x) >= 1 ? x.toLocaleString('en-US', { maximumFractionDigits: 4 }) : x.toPrecision(4));

export class Converter {
  private kept: Kept | null = null;
  private current: Job | null = null;
  constructor(private readonly d: ConverterDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  /** Coins a chain's wallet can be converted into: its own coin and every coin of this app's markets there. */
  targets(chainId: number): Coin[] {
    const cfg = this.d.hub.chain(chainId);
    const out: Coin[] = [{ id: NATIVE, address: null, symbol: cfg.nativeSymbol, name: cfg.nativeSymbol, decimals: 18, tracked: true }];
    for (const m of this.d.hub.byChain(chainId)) {
      for (const t of [m.base, m.quote]) {
        if (t.native || out.some((c) => c.id === t.address.toLowerCase())) continue;
        out.push({ id: t.address.toLowerCase(), address: t.address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals, tracked: true });
      }
    }
    return out;
  }

  private botsUse(chainId: number): Map<CoinId, number> {
    const m = new Map<CoinId, number>();
    for (const a of this.d.allocations()) {
      if (a.chainId !== chainId) continue;
      const id = a.native ? NATIVE : a.address.toLowerCase();
      m.set(id, (m.get(id) ?? 0) + a.allocated);
    }
    return m;
  }

  private markets(chainId: number): RouteMarket[] {
    const id = (t: MarketDef['base']) => (t.native ? NATIVE : t.address.toLowerCase());
    return this.d.hub.byChain(chainId).map((m) => ({ key: m.key, base: id(m.base), quote: id(m.quote) }));
  }
  private def(key: string, drafts: Map<string, MarketDef>): MarketDef { return drafts.get(key) ?? this.d.hub.def(key); }
  private quoter(key: string, drafts: Map<string, MarketDef>): Quoter {
    const d = drafts.get(key);
    return d ? this.d.hub.draftQuoter(d) : this.d.hub.quoter(key);
  }
  private async owner(chainId: number): Promise<string> {
    const s = this.d.hub.rt(chainId).signer;
    if (!s) throw new Error(noKey('Converting on this chain'));
    return s.getAddress();
  }

  /** The route for one coin: this app's markets, else its best pool after the safety check. */
  private async route(chainId: number, c: Coin, target: Coin, markets: RouteMarket[], drafts: Map<string, MarketDef>): Promise<Route> {
    const wrapped = this.d.hub.chain(chainId).wrappedNative.address.toLowerCase();
    const unwrap = c.id === wrapped;
    const from = unwrap ? NATIVE : c.id;
    let hops = findRoute(from, target.id, markets);
    if (!hops && !c.tracked) {
      const r = await this.d.hub.inspect({ chainId, address: c.address! });
      if (!r.draft) throw new Error('No pool for it on a DEX this app trades.');
      if (!r.safety?.liveAllowed) throw new Error(`Failed the safety check (${r.safety?.risk ?? 'unknown'} risk)${r.safety?.reasons.length ? `: ${r.safety.reasons.join(' ')}` : ''}`);
      const key = `convert:${c.id}`;
      drafts.set(key, { ...r.draft, key });
      markets.push({ key, base: c.id, quote: r.draft.quote.native ? NATIVE : r.draft.quote.address.toLowerCase() });
      hops = findRoute(from, target.id, markets);
    }
    if (!hops) throw new Error(`No route to ${target.symbol} through this app's markets.`);
    for (const h of hops) {
      const s = this.def(h.key, drafts).safety;
      if (s && !s.liveAllowed) throw new Error(`Its market failed the safety check (${s.risk} risk): ${s.reasons.join(' ')}`);
    }
    return { unwrap, hops };
  }

  private sym(chainId: number, id: CoinId, drafts: Map<string, MarketDef>): string {
    if (id === NATIVE) return this.d.hub.chain(chainId).nativeSymbol;
    for (const m of [...this.d.hub.byChain(chainId), ...drafts.values()]) for (const t of [m.base, m.quote]) if (!t.native && t.address.toLowerCase() === id) return t.symbol;
    return id.slice(0, 8);
  }
  private labels(chainId: number, r: Route, drafts: Map<string, MarketDef>): string[] {
    const cfg = this.d.hub.chain(chainId);
    return [
      ...(r.unwrap ? [`${cfg.wrappedNative.symbol} → ${cfg.nativeSymbol} · unwrap`] : []),
      ...r.hops.map((h) => `${this.sym(chainId, h.from, drafts)} → ${this.sym(chainId, h.to, drafts)} · ${this.d.hub.dexName(chainId, this.def(h.key, drafts).pool.dex)}`),
    ];
  }

  /** Target coins per chain coin at spot prices, along a route from the chain's own coin (gas is paid in it). */
  private async targetPerNative(chainId: number, target: Coin, markets: RouteMarket[], drafts: Map<string, MarketDef>): Promise<number> {
    const hops = findRoute(NATIVE, target.id, markets);
    if (!hops) throw new Error(`no route from ${this.d.hub.chain(chainId).nativeSymbol} to ${target.symbol}`);
    let k = 1;
    for (const h of hops) {
      const p = await this.quoter(h.key, drafts).getPrice();
      k *= h.side === 'sell' ? p : 1 / p;
    }
    return k;
  }

  /** What converting would do now: every coin's amount, route, expected result, or why it's left alone. */
  async plan(q: { chainId: number; target: CoinId; keepNative?: number; maxImpact?: number }, ownerOverride?: string): Promise<Plan> {
    const hub = this.d.hub, rt = hub.rt(q.chainId), cfg = rt.cfg;
    const target = this.targets(q.chainId).find((c) => c.id === q.target);
    if (!target) throw new Error(`${q.target} isn't a coin of ${cfg.name}'s markets`);
    const keepNative = q.keepNative ?? 2 * cfg.lowGasNative;
    const maxImpact = q.maxImpact ?? DEFAULT_LIMITS.maxPriceImpact;
    if (!(keepNative >= 0)) throw new Error('keep for gas must be 0 or more');
    if (!(maxImpact > 0 && maxImpact < 1)) throw new Error('max price impact must be between 0 and 100%');
    const limits: SafetyLimits = { ...DEFAULT_LIMITS, maxPriceImpact: maxImpact };
    const owner = ownerOverride ?? await this.owner(q.chainId);
    const { held, unreadable } = await holdings(hub, q.chainId, owner, this.d.fetchJson);
    const markets = this.markets(q.chainId), drafts = new Map<string, MarketDef>(), routes = new Map<CoinId, Route>();
    const bots = this.botsUse(q.chainId);
    const perNative = await this.targetPerNative(q.chainId, target, markets, drafts);
    const fee = await rt.reader.getFeeData();
    const gasPrice = fromUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, 18);
    const rows: PlanRow[] = [];
    for (const h of held) {
      if (h.id === target.id) continue;
      const used = bots.get(h.id) ?? 0, keep = h.id === NATIVE ? keepNative : 0;
      const amount = Math.max(0, h.balance - used - keep);
      const row: PlanRow = { coin: h, balance: h.balance, bots: used, keep, amount, steps: [], out: null, impact: null, gasNative: null, ok: false, why: null };
      rows.push(row);
      if (namedLikeSite(h.symbol, h.name)) { row.why = SITE_WHY; continue; }
      if (!(amount > 0)) { row.why = used > 0 ? 'Your live bots use all of it.' : 'All of it is kept for gas.'; continue; }
      try {
        const r = await this.route(q.chainId, h, target, markets, drafts);
        row.steps = this.labels(q.chainId, r, drafts);
        let amt = amount, gas = r.unwrap ? UNWRAP_GAS * gasPrice : 0, impact = 0;
        for (const hop of r.hops) {
          const qr = this.quoter(hop.key, drafts), tin = qr.tokenIn(hop.side);
          const qt = await qr.quote(hop.side, amt, limits, owner, tin === NATIVE ? null : await qr.allowance(owner, tin));
          if (qt.block) throw new Error(qt.block);
          impact = Math.max(impact, qt.priceImpact); gas += qt.gasNativeEstimate; amt = qt.quotedOutHuman;
        }
        Object.assign(row, { out: amt, impact, gasNative: gas });
        routes.set(h.id, r);
        if (impact > maxImpact) row.why = `Would move the price ${(impact * 100).toFixed(2)}% (your cap is ${(maxImpact * 100).toFixed(1)}%).`;
        else if (amt < 2 * gas * perNative) row.why = `Worth about ${num(amt)} ${target.symbol}, less than twice the gas it would cost (≈${num(gas * perNative)} ${target.symbol}).`;
        else row.ok = true;
      } catch (e) { row.why = msg(e); }
    }
    const plan: Plan = {
      id: `cv-${this.now().toString(36)}`, chainId: q.chainId, owner, at: this.now(), target,
      targetBalance: held.find((h) => h.id === target.id)?.balance ?? 0, keepNative, maxImpact,
      listedBy: cfg.tokenApi ? 'explorer' : 'markets', rows,
      unreadable: unreadable.map((u) => (namedLikeSite(u.symbol, u.name) ? { ...u, why: SITE_WHY } : u)),
    };
    this.kept = { plan, routes, drafts, limits };
    return plan;
  }

  job(): Job | null { return this.current; }

  /** Coins an unfinished conversion still intends to spend (waiting or the one running now). */
  reservations(): ReservedBalance[] {
    const job = this.current;
    if (!job || job.finishedAt) return [];
    return job.rows.filter((r) => r.status === 'waiting' || r.status === 'running').map((r) => ({
      chainId: job.chainId,
      address: r.coin.address ?? NATIVE,
      native: r.coin.address == null,
      amount: r.amount,
      source: 'converter' as const,
    }));
  }
  /** Finish the coin being converted (one whose first transaction is out goes all the way to the target), then stop. */
  stop() { if (this.current && !this.current.finishedAt) this.current.stopping = true; }

  /** Convert the chosen coins of the last plan; runs in the background (see job()). */
  run(planId: string, coins: CoinId[]): Job {
    const k = this.kept;
    if (!k || k.plan.id !== planId) throw new Error('That plan is gone: check again.');
    if (this.now() - k.plan.at > PLAN_TTL_MS) throw new Error('That plan is more than 10 minutes old: check again.');
    if (this.current && !this.current.finishedAt) throw new Error('A conversion is already running.');
    const rows = k.plan.rows.filter((r) => r.ok && coins.includes(r.coin.id));
    if (!rows.length) throw new Error('Nothing chosen to convert.');
    const job: Job = {
      id: `job-${this.now().toString(36)}`, chainId: k.plan.chainId, target: k.plan.target, startedAt: this.now(), finishedAt: null, stopping: false,
      rows: rows.map((r) => ({ coin: r.coin, amount: r.amount, status: 'waiting', steps: r.steps.map((label) => ({ label, hash: null, out: null })), out: null, error: null })),
    };
    this.current = job;
    void this.execute(job, k).finally(() => { job.finishedAt = this.now(); });
    return job;
  }

  private async execute(job: Job, k: Kept) {
    const hub = this.d.hub, rt = hub.rt(job.chainId), signer = rt.signer;
    const cfg = rt.cfg, owner = k.plan.owner;
    for (const row of job.rows) {
      if (job.stopping) { row.status = 'stopped'; continue; }
      row.status = 'running';
      try {
        if (!signer) throw new Error('no key for this chain');
        const r = k.routes.get(row.coin.id)!;
        // what's there now, less what live bots use now (a bot may have traded since the plan)
        const raw = row.coin.address ? await rt.tokenBalance(owner, row.coin.address) : await rt.reader.getBalance(owner);
        const free = fromUnits(raw, row.coin.decimals) - (this.botsUse(job.chainId).get(row.coin.id) ?? 0) - (row.coin.id === NATIVE ? k.plan.keepNative : 0);
        let amt = Math.min(row.amount, free);
        if (!(amt > 0)) throw new Error('nothing left of it to convert (spent, or now used by a bot)');
        row.amount = amt;
        // Stop leaves a coin alone only before its first transaction; after that it's seen through to the target
        let sent = false;
        let step = 0;
        if (r.unwrap) {
          const units = amountToUnits(amt, row.coin.decimals), use = units < raw ? units : raw;
          const ex = this.executor(rt, hub.quoter(hub.usdRefKey(job.chainId) ?? r.hops[0].key));
          const { hash } = await rt.gate.run(() => ex.sendTx({ to: cfg.wrappedNative.address, data: WRAPPED.encodeFunctionData('withdraw', [use]), value: 0n }));
          sent = true;
          row.steps[step].hash = hash;
          await this.mined(rt, hash);
          amt = fromUnits(use, row.coin.decimals);
          row.steps[step++].out = amt;
        }
        for (const hop of r.hops) {
          const ex = this.executor(rt, this.quoter(hop.key, k.drafts));
          const q = await ex.quote(hop.side, amt, k.limits);
          if (q.block) throw new Error(q.block);
          if (q.priceImpact > k.limits.maxPriceImpact) throw new Error(`the price impact is now ${(q.priceImpact * 100).toFixed(2)}%, over your ${(k.limits.maxPriceImpact * 100).toFixed(1)}% cap`);
          const s = row.steps[step++];
          const fill = await rt.gate.run(() => ex.execute(q, { canSend: () => sent || !job.stopping, onSent: (stage, hash) => { sent = true; if (stage === 'swap') s.hash = hash; } }));
          s.hash = fill.txHash; s.out = fill.amountOutHuman;
          amt = fill.amountOutHuman;
        }
        row.out = amt; row.status = 'done';
        this.d.emit?.({ type: 'filled', kind: 'system', level: 'success', chainId: job.chainId, notify: true, msg: `Converted ${num(row.amount)} ${row.coin.symbol} → ${num(amt)} ${job.target.symbol}` });
      } catch (e) {
        const aborted = (e as { opts?: { aborted?: boolean } }).opts?.aborted;
        row.status = aborted ? 'stopped' : 'failed';
        row.error = msg(e);
        this.d.emit?.({ type: 'error', kind: 'system', level: 'warn', chainId: job.chainId, notify: !aborted, msg: `Converting ${row.coin.symbol} to ${job.target.symbol} ${aborted ? 'stopped' : `failed: ${row.error}`}` });
      }
    }
  }

  private executor(rt: ChainRuntime, quoter: Quoter): LiveExecutor {
    return new LiveExecutor(quoter, rt.signer!, { approval: this.d.approval, receiptTimeoutMs: this.d.receiptTimeoutMs ?? 180_000, sharedNonce: rt.nonce });
  }

  /** Wait for a transaction sent with sendTx; a revert or no receipt in time is an error. */
  private async mined(rt: ChainRuntime, hash: string) {
    const until = this.now() + (this.d.receiptTimeoutMs ?? 180_000), poll = this.d.pollMs ?? 2000;
    for (;;) {
      const r = await rt.reader.getTransactionReceipt(hash);
      if (r) { if (r.status !== 1) throw new Error(`unwrap ${hash} reverted`); return; }
      if (this.now() > until) throw new Error(`unwrap ${hash} not confirmed in time; check it on the explorer`);
      await new Promise((res) => setTimeout(res, poll));
    }
  }
}

