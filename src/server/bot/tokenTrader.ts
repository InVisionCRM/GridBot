/**
 * Token trader. A separate file from the grid/liquidity state (data/token-trader.json, version 1) so a restart
 * resumes these positions without touching state.json.
 *
 * Paper uses the same discovery, safety gate, sizing and exit rules as live, and fills with simBuy / simSell
 * (impact, fee, tax). Live is opt-in: it needs a signing key and the existing safety classifier, and sends
 * through the injected broker (the chain's signer; an optional Ethereum MEV URL changes only the broadcast).
 */
import { HARD_CAPS, type SafetyLimits } from '../../live/limits';
import { simSell, type CostModel } from '../../market/costs';
import {
  decideExit, filterFresh,   gateToken, sizeBuy, splitSell, DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SIZE_IMPACT_CAP, DEFAULT_SNIPER_MIN_LIQ_USD,
  type FreshPool, type GateInput,
  effectiveEntry, sellSidePrice,
} from '../../market/tokenTrader';
import { TOKEN_MAX_POOL_SHARE } from '../../market/poolSize';
import type { Emit } from './activity';
import type { Store } from './store';
import type { PoolSniper, SnipeHit } from '../market/sniper';
import { requestHalt, type Halt } from './audit';
import type { Generated } from '../../types/generated';

export interface SniperOptions {
  on: boolean;
  minLiquidityUsd: number;
  delayBlocks: number;
  delaySec: number;
  maxPerHour: number;
  /** chain id → watched. Missing means on when the sniper is on. */
  chains: Record<number, boolean>;
  /** Ethereum send URL only (Flashbots Protect and the like). Quotes and limits are unchanged. */
  mevRpc: string | null;
}

export interface TraderOptions {
  mode: 'paper' | 'live';
  perTradeUsd: number;
  totalUsd: number;
  /** Scan discovery only. Snipes ignore it. */
  minPoolAgeSec: number;
  /** Empty = every chain the app trades */
  chains: number[];
  risk: 'safe' | 'medium' | 'any';
  maxImpact: number;
  maxPoolShare: number;
  /**
   * After sizing, quote that exact size and skip the buy when the impact is over `sizeImpactCap`.
   * Default off: nothing is quoted for this check, and the 3% sizing cap is the one that applies.
   */
  enforceSizeImpact: boolean;
  /** Used only when `enforceSizeImpact` is on. Default 1%. */
  sizeImpactCap: number;
  sniper: SniperOptions;
}

export interface Position {
  id: string;
  chainId: number;
  pool: string;
  dex: string;
  label: string;
  token: string;
  spend: string;
  mode: 'paper' | 'live';
  /**
   * Effective entry: spend per token received (entry fee, price impact, slippage and buy tax in), the same formula for
   * paper and live (effectiveEntry). Exits compare it with the mid after the exit fee (decideExit exitFee).
   */
  entryPrice: number;
  /** Pool mid when bought (reference only). null = unknown (a live position opened before effective entries). */
  entryMid?: number | null;
  /** 'effective' once entryPrice is spend/tokens. Missing = a file from before; migrated on load (migrateEntries). */
  entryBasis?: 'effective';
  price: number;
  peak: number;
  tokens: number;
  entryTokens: number;
  spent: number;
  spentUsd: number;
  openedAt: number;
  entryVolume: number;
  volume: number;
  entryLiq: number;
  liq: number;
  entrySellTax: number;
  sellTax: number;
  sellSimOk: boolean;
  feeBps: number;
  /** The pool's fee can change between blocks: re-read before each sell */
  dynamicFee?: boolean;
  quoteReserve: number;
  tokenReserve: number;
  usdPerSpend: number;
  buyTax: number;
  tp1Done: boolean;
  tp2Done: boolean;
  source: 'scan' | 'snipe';
  exitPlan: string;
  /** Generated bookkeeping (in the spend coin). Missing = a position from before; read as zeros (genOf). */
  gen?: PositionGen;
}

/**
 * A position's share of Generated, in its spend coin. The buy fee is booked when paid (feeBooked), so a sell's cost
 * basis is the rest of `spent` pro rata: a whole round trip costs exactly `spent`.
 */
export interface PositionGen {
  /** Pool fee paid on the buy (spent × fee), already counted in the bot's Generated */
  feeBooked: number;
  /** Cost basis of the tokens sold so far */
  costSold: number;
  /** Coins received from its sells */
  proceeds: number;
  fees: number;
  taxes: number;
  /** Gas its buy and sells paid, in the chain's own coin */
  gasNative: number;
}

/** Generated per spend coin (`chainId:address`), kept after positions close. */
export interface GenLedger {
  chainId: number; coin: string; symbol: string;
  proceeds: number; cost: number; fees: number; taxes: number; gasNative: number; closed: number;
}

export interface TradeLog { t: number; side: 'buy' | 'sell'; chainId: number; pool: string; label: string; usd: number; price: number; why: string; pnlUsd: number | null }
export interface FeedItem { t: number; chainId: number; pool: string; label: string; verdict: 'bought' | 'skipped'; why: string }

export interface TraderState {
  version: 1;
  on: boolean;
  options: TraderOptions;
  positions: Position[];
  trades: TradeLog[];
  feed: FeedItem[];
  cursors: Record<string, number>;
  /** Sniper buy timestamps (ms), for the per-hour cap */
  snipesAt: number[];
  /**
   * Stop all (chains null) or STOP chain: no new buys or snipes there until "Resume new buys". Exits of positions
   * already held keep running. The halt is the stop audit record (who, from where, when).
   */
  entriesHalt?: { halt: Halt; chains: number[] | null } | null;
  /** The last stop of the token trader itself (turned off, or new buys stopped), for the stop audit */
  lastHalt?: Halt | null;
  /** Generated per spend coin. Missing = a file from before (starts empty; nothing else changes). */
  generated?: Record<string, GenLedger>;
}

/** gasNative: gas the swap paid, in the chain's own coin (approval included). Missing = not known (counted as 0). */
export interface LiveFill { tokens: number; spent: number; spentUsd: number; price: number; impact: number; tx?: string; gasNative?: number }
export interface LiveSell { quoteOut: number; tokensIn: number; price: number; impact: number; tx?: string; gasNative?: number }

const genOf = (p: Position): PositionGen => p.gen ?? (p.gen = { feeBooked: 0, costSold: 0, proceeds: 0, fees: 0, taxes: 0, gasNative: 0 });
/** Gas a failed send still paid (ExecError opts), else 0 */
const gasOfError = (e: unknown): number => { const g = (e as { opts?: { gasNative?: number } } | null)?.opts?.gasNative; return typeof g === 'number' && g > 0 ? g : 0; };

const HOUR = 3600_000;
const FEED_MAX = 80;
const TRADE_MAX = 200;

export const DEFAULT_TRADER: TraderOptions = {
  mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC,
  chains: [], risk: 'safe', maxImpact: 0.03, maxPoolShare: TOKEN_MAX_POOL_SHARE,
  enforceSizeImpact: false, sizeImpactCap: DEFAULT_SIZE_IMPACT_CAP,
  sniper: { on: false, minLiquidityUsd: DEFAULT_SNIPER_MIN_LIQ_USD, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: {}, mevRpc: null },
};

const fresh = (): TraderState => ({ version: 1, on: false, options: structuredClone(DEFAULT_TRADER), positions: [], trades: [], feed: [], cursors: {}, snipesAt: [] });

export class TokenTrader {
  private state: TraderState;
  private busy = false;
  lastError: string | null = null;

  constructor(private readonly d: {
    store: Store<TraderState>;
    now?: () => number;
    emit?: Emit;
    /** Scan discovery (new + trending pools, DexScreener). Sniper hits are separate. */
    discover?: () => Promise<FreshPool[]>;
    /** Safety inputs for a pool. Required before any buy. */
    assess?: (pool: FreshPool, mode: 'paper' | 'live', risk: TraderOptions['risk']) => Promise<GateInput>;
    /**
     * Impact of spending `spend` (human units of the pool's spend token) on this pool.
     * V3 must be a QuoterV2 (or equivalent tick-walk) quote. Called only when `enforceSizeImpact` is on.
     * A throw is "could not verify".
     */
    quoteImpact?: (pool: FreshPool, spend: number) => Promise<number>;
    /** Latest price, depth, volume, tax, sell simulation. Paper tests can omit this and call mark(). */
    mark?: (p: Position) => Promise<Partial<Position> | null>;
    live?: {
      buy(pool: FreshPool, spend: number, limits: SafetyLimits): Promise<LiveFill>;
      sell(p: Position, tokens: number, limits: SafetyLimits): Promise<LiveSell>;
    };
    signerReady?: (chainId: number) => boolean;
    sniper?: PoolSniper;
    /** A dynamic-fee pool's fee() right now, in bps (read before every sizing and sell; never cached). */
    feeNow?: (p: { chainId: number; pool: string }) => Promise<number>;
    /** Turn a sniper hit into a pool with depth and price. null = can't price it. */
    resolve?: (hit: SnipeHit) => Promise<FreshPool | null>;
    /**
     * For Generated only: whether a spend coin is the chain's own coin (or its wrapped form), and that coin's symbol.
     * Missing = not native (gas is reported apart, never price-converted).
     */
    coinInfo?: (chainId: number, spend: string) => { native: boolean; nativeSymbol: string } | null;
  }) {
    const loaded = d.store.load();
    this.state = loaded?.version === 1 ? { ...fresh(), ...loaded, options: { ...DEFAULT_TRADER, ...loaded.options, sniper: { ...DEFAULT_TRADER.sniper, ...loaded.options?.sniper } } } : fresh();
    this.migrateEntries();
  }

  /**
   * Open positions from before effective entries. Paper stored the pool mid as entryPrice; live stored the fill
   * (amountIn / amount received), already effective. Both have spent and entryTokens, so entryPrice becomes
   * spent / entryTokens for either (for live that is the same number). Paper keeps its old mid as entryMid; for live the
   * mid was never stored (null). A position without spent / entryTokens keeps its entryPrice (nothing better to use).
   * Peak, tokens, P&L basis (spentUsd) and TP flags are untouched.
   */
  private migrateEntries() {
    let n = 0;
    for (const p of this.state.positions) {
      // exits are net of the entry-time sell tax: a file without one uses the last measured sell tax (else 0)
      if (!Number.isFinite(p.entrySellTax)) { p.entrySellTax = Number.isFinite(p.sellTax) ? p.sellTax : 0; n++; }
      if (p.entryBasis === 'effective') continue;
      const eff = effectiveEntry(p.spent, p.entryTokens);
      p.entryMid = p.mode === 'paper' ? p.entryPrice : null;
      if (eff > 0) { p.entryPrice = eff; n++; }
      p.entryBasis = 'effective';
    }
    if (n) {
      this.save();
      this.say(`Token trader: ${n} open position(s) now use the effective entry (spend per token received, after fees, impact and tax; exits net of the exit fee and sell tax)`);
    }
  }

  private now() { return (this.d.now ?? Date.now)(); }
  private save() { this.d.store.save(this.state); }
  private say(msg: string, level: 'info' | 'warn' | 'success' = 'info') {
    this.d.emit?.({ type: 'info', kind: 'system', level, msg });
  }

  status() {
    const openUsd = this.openUsd();
    return {
      ...this.state,
      openUsd,
      lastError: this.lastError,
      entriesHalt: this.state.entriesHalt ?? null,
      lastHalt: this.state.lastHalt ?? null,
      /** Open positions whose exits (stops, take-profits) are still managed, also while new buys are stopped */
      exitsManaged: this.state.on ? this.state.positions.length : 0,
      positions: this.state.positions.map((p) => ({ ...p, pnlUsd: this.pnl(p), exitPlan: this.plan(p), generated: this.posGenerated(p) })),
      /** Generated per spend coin (closed sells, less buy fees and gas paid); see types/generated.ts */
      generated: this.generated(),
    };
  }

  // ── Generated (coins, no USD): bookkeeping only, read by nothing that trades ──
  private ledger(chainId: number, coin: string, symbol: string): GenLedger {
    const g = this.state.generated ?? (this.state.generated = {});
    const k = `${chainId}:${coin.toLowerCase()}`;
    return g[k] ?? (g[k] = { chainId, coin: coin.toLowerCase(), symbol, proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0, closed: 0 });
  }
  private spendSymbol(p: Pick<Position, 'label' | 'spend'>) { return p.label.split('/')[1] ?? p.spend; }
  private view(coin: { chainId: number; coin: string; symbol: string }, x: Omit<GenLedger, 'chainId' | 'coin' | 'symbol'>): Generated {
    const info = this.d.coinInfo?.(coin.chainId, coin.coin) ?? null;
    const gasInAmount = !!info?.native;
    return {
      coin: { chainId: coin.chainId, address: coin.coin, symbol: coin.symbol, native: gasInAmount },
      amount: x.proceeds - x.cost - (gasInAmount ? x.gasNative : 0),
      proceeds: x.proceeds, cost: x.cost, fees: x.fees, taxes: x.taxes,
      gasNative: x.gasNative, gasSymbol: info?.nativeSymbol ?? null, gasInAmount, closed: x.closed, basis: 'closed',
    };
  }
  /** Per spend coin, every position since this was added (closed ones included) */
  generated(): Generated[] {
    return Object.values(this.state.generated ?? {}).map((l) => this.view(l, l));
  }
  /** One position: its sells so far, less its buy fee and gas (its unsold tokens count nothing: no mark to market) */
  private posGenerated(p: Position): Generated {
    const g = p.gen ?? { feeBooked: 0, costSold: 0, proceeds: 0, fees: 0, taxes: 0, gasNative: 0 };
    return this.view({ chainId: p.chainId, coin: p.spend, symbol: this.spendSymbol(p) }, {
      proceeds: g.proceeds, cost: g.costSold + g.feeBooked, fees: g.fees + g.feeBooked, taxes: g.taxes, gasNative: g.gasNative, closed: 0,
    });
  }
  /** A buy: its pool fee (paid in the spend coin) and its gas are booked now; the rest of what it spent is cost when sold */
  private bookBuy(p: Position, gasNative: number) {
    const g = genOf(p), l = this.ledger(p.chainId, p.spend, this.spendSymbol(p));
    const fee = p.spent * (p.feeBps / 10_000);
    g.feeBooked = fee; g.gasNative += gasNative;
    l.cost += fee; l.fees += fee; l.gasNative += gasNative;
  }
  /** A sell of `sold` tokens that brought `quote` spend coins (actual: after fee, tax and impact) */
  private bookSell(p: Position, sold: number, quote: number, gasNative: number) {
    const g = genOf(p), l = this.ledger(p.chainId, p.spend, this.spendSymbol(p));
    const basis = p.entryTokens > 0 ? (p.spent - g.feeBooked) * (sold / p.entryTokens) : 0;
    // For reference (already inside `quote`): the pool fee and the sell tax that came off it
    const f = p.feeBps / 10_000, t = Math.max(0, Math.min(p.sellTax, 0.99));
    const gross = quote / ((1 - f) * (1 - t));
    const fee = gross * (1 - t) * f, tax = gross * t;
    g.costSold += basis; g.proceeds += quote; g.fees += fee; g.taxes += tax; g.gasNative += gasNative;
    l.cost += basis; l.proceeds += quote; l.fees += fee; l.taxes += tax; l.gasNative += gasNative; l.closed++;
  }
  /** Gas a failed send paid (nothing else changed hands) */
  private bookGas(chainId: number, spend: string, symbol: string, gasNative: number, p?: Position) {
    if (!(gasNative > 0)) return;
    this.ledger(chainId, spend, symbol).gasNative += gasNative;
    if (p) genOf(p).gasNative += gasNative;
  }

  configure(o: Partial<TraderOptions> & { sniper?: Partial<SniperOptions> }) {
    const n = { ...this.state.options, ...o, sniper: { ...this.state.options.sniper, ...(o.sniper ?? {}) } };
    if (!(n.perTradeUsd > 0) || !(n.totalUsd > 0)) throw new Error('Per-trade and total limits must be above 0.');
    if (n.perTradeUsd > n.totalUsd) throw new Error('Per-trade limit is above the total limit.');
    if (!(n.minPoolAgeSec >= 0)) throw new Error('Minimum pool age must be 0 or more seconds.');
    if (!(n.maxImpact > 0) || n.maxImpact > HARD_CAPS.maxPriceImpact) throw new Error('Price-impact cap must be between 0% and 5%.');
    if (!(n.sizeImpactCap > 0) || n.sizeImpactCap > HARD_CAPS.maxPriceImpact) throw new Error('Trade-size impact cap must be between 0% and 5%.');
    if (!(n.maxPoolShare > 0) || n.maxPoolShare > 0.5) throw new Error('Max pool share must be between 0% and 50%.');
    if (n.sniper.mevRpc && !/^https:\/\//.test(n.sniper.mevRpc)) throw new Error('MEV URL must be an https RPC.');
    this.state.options = n;
    this.save();
  }

  turnOn() {
    const o = this.state.options;
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('Live trading is not wired on this server.');
      if (this.d.signerReady && o.chains.length && o.chains.some((id) => !this.d.signerReady!(id))) throw new Error('Live needs a signing key on every chain you turned on.');
    }
    this.state.on = true;
    this.say(`token trader on (${o.mode}): up to ${o.perTradeUsd} USD a trade, ${o.totalUsd} USD open, pools at least ${Math.round(o.minPoolAgeSec / 3600)}h old unless the sniper is on`);
    this.save();
  }

  turnOff() {
    this.state.on = false;
    const halt = requestHalt('token-trader-off', 'POST /api/token-trader/off', this.now());
    this.state.lastHalt = halt;
    this.d.emit?.({ type: 'stopped', kind: 'system', level: 'warn', notify: true, msg: 'token trader off; open positions stay until their exit rules fire', data: { halt } });
    this.save();
  }

  /** New buys and snipes are stopped on this chain (Stop all or STOP chain). Exits still run. */
  entriesStopped(chainId: number): boolean {
    const h = this.state.entriesHalt;
    return !!h && (h.chains == null || h.chains.includes(chainId));
  }
  /** A buy may be sent: the trader is on and new buys aren't stopped on that chain. Checked again right before sending. */
  canBuy(chainId: number): boolean {
    return this.state.on && !this.entriesStopped(chainId);
  }

  /** Stop all (chainId null) / STOP chain: stop new buys and snipes; positions already held keep their exits. */
  stopEntries(chainId: number | null, halt: Halt) {
    const cur = this.state.entriesHalt;
    const chains = chainId == null || (cur && cur.chains == null) ? null : [...new Set([...(cur?.chains ?? []), chainId])];
    this.state.entriesHalt = { halt, chains };
    this.state.lastHalt = halt;
    const n = this.state.positions.length;
    const where = chains == null ? '' : ` on chain ${chains.join(', ')}`;
    this.d.emit?.({
      type: 'stopped', kind: 'system', level: 'warn', notify: true, data: { halt },
      msg: `token trader: new buys and snipes stopped${where} (${halt.detail}).${this.state.on ? ` Exits still managed: ${n}` : n ? ` It is off, so the exits of its ${n} position(s) are not watched until it is turned on` : ''}`,
    });
    this.save();
  }

  /** Lift a Stop all / STOP chain for the token trader: new buys and snipes may happen again. */
  resumeEntries() {
    if (!this.state.entriesHalt) return;
    this.state.entriesHalt = null;
    this.say('token trader: new buys and snipes allowed again');
    this.save();
  }

  /** Test hook: push a mark onto an open position (price, reserves, tax, sell sim). */
  mark(id: string, m: Partial<Position>) {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, m);
    if (m.price != null && m.price > p.peak) p.peak = m.price;
  }

  async tick() {
    if (this.busy || !this.state.on) return;
    this.busy = true;
    try {
      await this.takeSnipes();
      await this.exits();
      await this.scanEntries();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.save();
      this.busy = false;
    }
  }

  private openUsd() { return this.state.positions.reduce((s, p) => s + p.spentUsd * (p.entryTokens > 0 ? p.tokens / p.entryTokens : 0), 0); }

  private pnl(p: Position) {
    const model = this.model(p);
    const out = p.tokens > 0 ? simSell(p.tokens, sellSidePrice(p.price, p.feeBps), model).quote * p.usdPerSpend : 0;
    return out - p.spentUsd * (p.entryTokens > 0 ? p.tokens / p.entryTokens : 0);
  }

  private plan(p: Position) {
    const d = decideExit(this.exitOf(p));
    return d.action === 'hold' ? 'hold' : d.why;
  }

  private model(p: Pick<Position, 'feeBps' | 'quoteReserve' | 'tokenReserve' | 'buyTax' | 'sellTax'>): CostModel {
    return {
      feeBps: p.feeBps, pool: { quoteReserve: Math.max(p.quoteReserve, 1e-12), plsReserve: Math.max(p.tokenReserve, 1e-12) },
      gasPricePls: 0, approval: 'exact', slippageBps: 0, buyTaxPct: p.buyTax, sellTaxPct: p.sellTax,
    };
  }

  private limits(): SafetyLimits {
    return { maxPriceImpact: Math.min(this.state.options.maxImpact, HARD_CAPS.maxPriceImpact), slippageBps: 100, deadlineMinutes: 10 };
  }

  private wantChain(id: number) {
    const c = this.state.options.chains;
    return !c.length || c.includes(id);
  }

  private feed(item: FeedItem) {
    this.state.feed.unshift(item);
    if (this.state.feed.length > FEED_MAX) this.state.feed.length = FEED_MAX;
  }

  private async assess(pool: FreshPool): Promise<{ ok: boolean; reason: string | null; buyTax: number; sellTax: number; gate: GateInput | null }> {
    if (!this.d.assess) return { ok: false, reason: 'no safety check', buyTax: 0, sellTax: 0, gate: null };
    const g = await this.d.assess(pool, this.state.options.mode, this.state.options.risk);
    const gate: GateInput = { ...g, mode: this.state.options.mode, risk: this.state.options.risk, minLiquidityUsd: g.minLiquidityUsd ?? (pool.source === 'snipe' ? this.state.options.sniper.minLiquidityUsd : 0) };
    const r = gateToken(gate);
    return { ok: r.ok, reason: r.reason, buyTax: g.buyTax ?? 0, sellTax: g.sellTax ?? 0, gate };
  }

  private async buy(pool: FreshPool, source: 'scan' | 'snipe', buyTax: number, sellTax: number, gate: GateInput) {
    const o = this.state.options;
    if (this.state.positions.some((p) => p.pool.toLowerCase() === pool.pool.toLowerCase() && p.chainId === pool.chainId)) return;
    // Checked again after the safety check's awaits: a Stop all that landed meanwhile wins.
    if (!this.canBuy(pool.chainId)) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: 'new buys are stopped' }); return; }
    if (pool.dynamicFee) {
      // the fee at quote time: it may have moved since discovery
      const fee = this.d.feeNow ? await this.d.feeNow(pool).catch(() => null) : null;
      if (fee == null) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: "could not read the pool's current fee" }); return; }
      pool = { ...pool, feeBps: fee };
    }
    const sized = sizeBuy({
      perTradeUsd: o.perTradeUsd, totalUsd: o.totalUsd, openUsd: this.openUsd(),
      quoteReserve: pool.quoteReserve, usdPerSpend: pool.usdPerSpend, feeBps: pool.feeBps,
      buyTax, price: pool.price, maxImpact: o.maxImpact, maxPoolShare: o.maxPoolShare || TOKEN_MAX_POOL_SHARE,
    });
    if (!sized) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: 'size is under the limits or the pool is too thin' }); return; }
    if (o.enforceSizeImpact) {
      let impact: number | null = null;
      try {
        if (!this.d.quoteImpact) throw new Error('no impact quote');
        const quoted = await this.d.quoteImpact(pool, sized.spend);
        impact = Number.isFinite(quoted) ? quoted : null;
      } catch { impact = null; }
      const again = gateToken({ ...gate, enforceSizeImpact: true, sizeImpact: impact, sizeImpactCap: o.sizeImpactCap });
      if (!again.ok) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: again.reason ?? 'price impact' }); return; }
    }
    let tokens = sized.tokens, spent = sized.spend, spentUsd = sized.usd;
    let gasNative = 0;
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('live broker missing');
      let fill: LiveFill;
      try { fill = await this.d.live.buy({ ...pool }, sized.spend, this.limits()); } catch (e) { this.bookGas(pool.chainId, pool.spend, pool.spendSymbol, gasOfError(e)); throw e; }
      tokens = fill.tokens; spent = fill.spent; spentUsd = fill.spentUsd;
      gasNative = fill.gasNative ?? 0;
    }
    // One formula for paper and live: what was spent over what arrived (fee, impact, slippage and buy tax in).
    // A fill that reports no tokens (shouldn't happen) still gets booked, at the mid, never dropped.
    const eff = effectiveEntry(spent, tokens);
    const entry = eff > 0 ? eff : pool.price;
    if (!(eff > 0)) this.say(`${pool.tokenSymbol}: buy reported ${tokens} tokens for ${spent}; entry set to the pool mid`, 'warn');
    const price = pool.price;
    const pos: Position = {
      id: `tt-${this.now().toString(36)}-${pool.pool.slice(2, 6)}`, chainId: pool.chainId, pool: pool.pool, dex: pool.dex,
      label: `${pool.tokenSymbol}/${pool.spendSymbol}`, token: pool.token, spend: pool.spend, mode: o.mode,
      entryPrice: entry, entryMid: pool.price, entryBasis: 'effective', price, peak: price, tokens, entryTokens: tokens, spent, spentUsd, openedAt: this.now(),
      entryVolume: pool.volumeUsd, volume: pool.volumeUsd, entryLiq: pool.liquidityUsd, liq: pool.liquidityUsd,
      entrySellTax: sellTax, sellTax, sellSimOk: true, feeBps: pool.feeBps, ...(pool.dynamicFee ? { dynamicFee: true } : {}), quoteReserve: pool.quoteReserve,
      tokenReserve: pool.tokenReserve, usdPerSpend: pool.usdPerSpend, buyTax, tp1Done: false, tp2Done: false, source, exitPlan: 'hold',
    };
    this.state.positions.push(pos);
    this.bookBuy(pos, gasNative);
    const why = `buy ${sized.why}`;
    this.state.trades.unshift({ t: this.now(), side: 'buy', chainId: pool.chainId, pool: pool.pool, label: pos.label, usd: spentUsd, price: entry, why, pnlUsd: null });
    this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: pos.label, verdict: 'bought', why });
    this.say(`bought ${pos.label} on ${pool.dex}: ${why}`, 'success');
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }

  private async consider(pool: FreshPool, source: 'scan' | 'snipe') {
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    if (!this.wantChain(pool.chainId)) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: 'chain is off' }); return; }
    if (pool.kind === 'v4') { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: "this app doesn't swap V4" }); return; }
    if (this.entriesStopped(pool.chainId)) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: 'new buys are stopped (Stop all)' }); return; }
    const a = await this.assess(pool);
    if (!a.ok || !a.gate) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: a.reason ?? 'safety' }); this.say(`skipped ${label}: ${a.reason}`, 'warn'); return; }
    await this.buy({ ...pool, source: source === 'snipe' ? 'snipe' : pool.source }, source, a.buyTax, a.sellTax, a.gate);
  }

  private async scanEntries() {
    if (!this.d.discover) return;
    if (this.state.entriesHalt?.chains === null) return; // stopped everywhere: don't even look
    const pools = await this.d.discover();
    const { keep, skipped } = filterFresh(pools.filter((p) => p.source !== 'snipe'), { now: this.now(), minAgeMs: this.state.options.minPoolAgeSec * 1000, minLiquidityUsd: 0 });
    for (const s of skipped) this.feed({ t: this.now(), chainId: 0, pool: s.pool, label: s.pool.slice(0, 8), verdict: 'skipped', why: s.why });
    for (const p of keep) await this.consider(p, 'scan');
  }

  private hourRoom() {
    const since = this.now() - HOUR;
    this.state.snipesAt = this.state.snipesAt.filter((t) => t >= since);
    return Math.max(0, this.state.options.sniper.maxPerHour - this.state.snipesAt.length);
  }

  private async takeSnipes() {
    const sn = this.state.options.sniper;
    if (!sn.on || !this.d.sniper) return;
    const { cursors, hits, notes } = await this.d.sniper.tick(this.state.cursors, { delayBlocks: sn.delayBlocks, delaySec: sn.delaySec });
    this.state.cursors = cursors;
    for (const n of notes) this.say(n.msg, n.level);
    let room = this.hourRoom();
    for (const hit of hits) {
      if (sn.chains[hit.chainId] === false) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: hit.pool.slice(0, 8), verdict: 'skipped', why: 'sniper is off for this chain' }); continue; }
      if (hit.skip) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: 'V4', verdict: 'skipped', why: hit.skip }); continue; }
      if (hit.kind === 'v4') continue;
      const pool = await this.d.resolve?.(hit) ?? null;
      if (!pool) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: hit.pool.slice(0, 8), verdict: 'skipped', why: 'could not price the new pool' }); continue; }
      if (pool.liquidityUsd < sn.minLiquidityUsd) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `liquidity under $${sn.minLiquidityUsd.toLocaleString('en-US')}` }); continue; }
      if (room <= 0) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `${sn.maxPerHour} snipes an hour already` }); continue; }
      const before = this.state.positions.length;
      await this.consider({ ...pool, source: 'snipe', createdAt: null }, 'snipe');
      if (this.state.positions.length > before) { this.state.snipesAt.push(this.now()); room--; }
    }
  }

  private exitOf(p: Position) {
    return {
      entryPrice: p.entryPrice, price: p.price, peak: p.peak, openedAt: p.openedAt, now: this.now(),
      entryVolume: p.entryVolume, volume: p.volume, entryLiq: p.entryLiq, liq: p.liq,
      sellTax: p.sellTax, entrySellTax: p.entrySellTax, sellSimOk: p.sellSimOk,
      tp1Done: p.tp1Done, tp2Done: p.tp2Done, remainingFrac: p.entryTokens > 0 ? p.tokens / p.entryTokens : 0,
      exitFee: p.feeBps / 10_000, exitTax: p.entrySellTax,
    };
  }

  private async exits() {
    const left: Position[] = [];
    for (const p of this.state.positions) {
      if (this.d.mark) {
        const m = await this.d.mark(p);
        if (m) Object.assign(p, m);
      }
      if (p.price > p.peak) p.peak = p.price;
      const d = decideExit(this.exitOf(p));
      p.exitPlan = d.action === 'hold' ? 'hold' : d.why;
      if (d.action === 'hold') { left.push(p); continue; }
      if (p.dynamicFee && this.d.feeNow) {
        // the fee this sell pays, read now (keeps the last one if the read fails)
        const fee = await this.d.feeNow(p).catch(() => null);
        if (fee != null) p.feeBps = fee;
      }
      const qty = Math.min(p.tokens, p.entryTokens * d.frac);
      const parts = splitSell(qty, Math.max(p.tokenReserve, 1e-12), p.feeBps, this.state.options.maxImpact);
      let quote = 0, sold = 0, gasNative = 0;
      if (p.mode === 'live' && this.d.live) {
        for (const part of parts) {
          let s: LiveSell;
          try { s = await this.d.live.sell(p, part, this.limits()); } catch (e) { this.bookGas(p.chainId, p.spend, this.spendSymbol(p), gasOfError(e), p); throw e; }
          quote += s.quoteOut; sold += s.tokensIn; gasNative += s.gasNative ?? 0;
        }
      } else {
        const model = this.model(p);
        for (const part of parts) { quote += simSell(part, sellSidePrice(p.price, p.feeBps), model).quote; sold += part; }
      }
      p.tokens -= sold;
      this.bookSell(p, sold, quote, gasNative);
      const usd = quote * p.usdPerSpend;
      const cost = p.spentUsd * (p.entryTokens > 0 ? sold / p.entryTokens : 0);
      this.state.trades.unshift({ t: this.now(), side: 'sell', chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why: d.why, pnlUsd: usd - cost });
      this.say(`sold ${p.label}: ${d.why}`, usd - cost >= 0 ? 'success' : 'warn');
      if (d.why.startsWith('take profit') && !p.tp1Done) p.tp1Done = true;
      else if (d.why.startsWith('take profit')) p.tp2Done = true;
      if (p.tokens > p.entryTokens * 1e-8) left.push(p);
    }
    this.state.positions = left;
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }
}
