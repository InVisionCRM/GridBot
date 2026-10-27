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
  decideExit, filterFresh, gateToken, sizeBuy, splitSell, EXIT, DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SNIPER_MIN_LIQ_USD,
  type FreshPool, type GateInput,
} from '../../market/tokenTrader';
import { blankPlay, feeTierFromBps, type PlayRecord } from '../../metrics/playScore';
import { TOKEN_MAX_POOL_SHARE } from '../../market/poolSize';
import type { Emit } from './activity';
import type { Store } from './store';
import type { PoolSniper, SnipeHit } from '../market/sniper';

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
  entryPrice: number;
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
  quoteReserve: number;
  tokenReserve: number;
  usdPerSpend: number;
  buyTax: number;
  tp1Done: boolean;
  tp2Done: boolean;
  source: 'scan' | 'snipe';
  exitPlan: string;
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
   * One row per fill and per rejected candidate. Never trimmed (the trade log's 200-row cap does not apply).
   * `status()` leaves this off so that payload stays the trade log.
   */
  plays: PlayRecord[];
}

export interface LiveFill { tokens: number; spent: number; spentUsd: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number }
export interface LiveSell { quoteOut: number; tokensIn: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number }

const HOUR = 3600_000;
const FEED_MAX = 80;
const TRADE_MAX = 200;

export const DEFAULT_TRADER: TraderOptions = {
  mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC,
  chains: [], risk: 'safe', maxImpact: 0.03, maxPoolShare: TOKEN_MAX_POOL_SHARE,
  sniper: { on: false, minLiquidityUsd: DEFAULT_SNIPER_MIN_LIQ_USD, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: {}, mevRpc: null },
};

const fresh = (): TraderState => ({ version: 1, on: false, options: structuredClone(DEFAULT_TRADER), positions: [], trades: [], feed: [], cursors: {}, snipesAt: [], plays: [] });

function signalOf(source: FreshPool['source']): string {
  if (source === 'trending') return 'trending';
  if (source === 'snipe') return 'snipe';
  return 'new_pool';
}

/** ETH per 1 of the spend coin is not what this returns: it is spend-coin units for 1 native coin. WETH spend is 1. A WETH-priced pool uses that pool's price. */
function nativeToSpend(pool: FreshPool): number | null {
  const spend = pool.spendSymbol.toUpperCase();
  const token = pool.tokenSymbol.toUpperCase();
  if (spend === 'WETH' || spend === 'ETH') return 1;
  if ((token === 'WETH' || token === 'ETH') && pool.price > 0) return pool.price;
  return null;
}

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
    /** Latest price, depth, volume, tax, sell simulation. Paper tests can omit this and call mark(). */
    mark?: (p: Position) => Promise<Partial<Position> | null>;
    live?: {
      buy(pool: FreshPool, spend: number, limits: SafetyLimits): Promise<LiveFill>;
      sell(p: Position, tokens: number, limits: SafetyLimits): Promise<LiveSell>;
    };
    signerReady?: (chainId: number) => boolean;
    sniper?: PoolSniper;
    /** Turn a sniper hit into a pool with depth and price. null = can't price it. */
    resolve?: (hit: SnipeHit) => Promise<FreshPool | null>;
  }) {
    const loaded = d.store.load();
    this.state = loaded?.version === 1 ? { ...fresh(), ...loaded, options: { ...DEFAULT_TRADER, ...loaded.options, sniper: { ...DEFAULT_TRADER.sniper, ...loaded.options?.sniper } }, plays: Array.isArray(loaded.plays) ? loaded.plays : [] } : fresh();
  }

  private now() { return (this.d.now ?? Date.now)(); }
  private save() { this.d.store.save(this.state); }
  private say(msg: string, level: 'info' | 'warn' | 'success' = 'info') {
    this.d.emit?.({ type: 'info', kind: 'system', level, msg });
  }

  status() {
    const openUsd = this.openUsd();
    const { plays, ...rest } = this.state;
    void plays;
    return {
      ...rest,
      openUsd,
      lastError: this.lastError,
      positions: rest.positions.map((p) => ({ ...p, pnlUsd: this.pnl(p), exitPlan: this.plan(p) })),
    };
  }

  /** Durable play records. Not trimmed, and not part of `status()`. */
  plays(): PlayRecord[] { return this.state.plays; }

  configure(o: Partial<TraderOptions> & { sniper?: Partial<SniperOptions> }) {
    const n = { ...this.state.options, ...o, sniper: { ...this.state.options.sniper, ...(o.sniper ?? {}) } };
    if (!(n.perTradeUsd > 0) || !(n.totalUsd > 0)) throw new Error('Per-trade and total limits must be above 0.');
    if (n.perTradeUsd > n.totalUsd) throw new Error('Per-trade limit is above the total limit.');
    if (!(n.minPoolAgeSec >= 0)) throw new Error('Minimum pool age must be 0 or more seconds.');
    if (!(n.maxImpact > 0) || n.maxImpact > HARD_CAPS.maxPriceImpact) throw new Error('Price-impact cap must be between 0% and 5%.');
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
    this.say('token trader off; open positions stay until their exit rules fire');
    this.save();
  }

  /** Test hook: push a mark onto an open position (price, reserves, tax, sell sim). */
  mark(id: string, m: Partial<Position>) {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, m);
    if (m.price != null && m.price > p.peak) p.peak = m.price;
    if (Object.prototype.hasOwnProperty.call(m, 'feeBps')) this.noteFeeReread(id);
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
    const out = p.tokens > 0 ? simSell(p.tokens, p.price, model).quote * p.usdPerSpend : 0;
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

  private async assess(pool: FreshPool): Promise<{ ok: boolean; reason: string | null; buyTax: number; sellTax: number }> {
    if (!this.d.assess) return { ok: false, reason: 'no safety check', buyTax: 0, sellTax: 0 };
    const g = await this.d.assess(pool, this.state.options.mode, this.state.options.risk);
    const r = gateToken({ ...g, mode: this.state.options.mode, risk: this.state.options.risk, minLiquidityUsd: g.minLiquidityUsd ?? (pool.source === 'snipe' ? this.state.options.sniper.minLiquidityUsd : 0) });
    return { ok: r.ok, reason: r.reason, buyTax: g.buyTax ?? 0, sellTax: g.sellTax ?? 0 };
  }

  private reject(o: { chainId: number; pool: string; token: string; signal: string; source: string; reason: string; price: number | null; feeBps: number | null; spendSymbol?: string }) {
    const pool = o.pool.toLowerCase();
    if (this.state.plays.some((p) => p.rejected && p.chain_id === o.chainId && p.pool_address.toLowerCase() === pool && p.reason === o.reason)) return;
    const now = this.now();
    this.state.plays.push(blankPlay({
      play_id: `rej-${now.toString(36)}-${pool.slice(2, 8)}`,
      kind: 'play', signal_type: o.signal, source: o.source, passed: false, rejected: true, reason: o.reason,
      chain_id: o.chainId, pool_address: pool, token_contract: o.token.toLowerCase(),
      priceAtFlag: o.price,
      feeTierEntry: o.feeBps != null ? feeTierFromBps(o.feeBps, now, 'pool.feeBps') : null,
      target_pct: EXIT.tp1, stop_pct: EXIT.hardStop, spend_symbol: o.spendSymbol ?? null,
    }));
  }

  private rememberEntry(pos: Position, pool: FreshPool, impact: number, tx: string | null, gasUsed: number | null, gasPrice: number | null) {
    const now = this.now();
    const gasNative = gasUsed != null && gasPrice != null ? (gasUsed * gasPrice) / 1e18 : null;
    this.state.plays.push(blankPlay({
      play_id: pos.id, kind: 'play', signal_type: signalOf(pool.source), source: pool.dex,
      passed: true, rejected: false, reason: null,
      chain_id: pool.chainId, pool_address: pool.pool.toLowerCase(), token_contract: pool.token.toLowerCase(),
      priceAtFlag: pool.price, entry_at: now, entry_price: pool.price,
      feeTierEntry: feeTierFromBps(pool.feeBps, now, 'pool.feeBps'),
      price_impact_entry: impact, tx_entry: tx,
      gas_used: gasUsed, gas_price: gasPrice, gas_assumed: false,
      gas_note: gasNative == null ? 'no receipt gas' : null,
      gas_native: gasNative, native_to_spend: nativeToSpend(pool),
      entry_gas_native: gasNative, entry_gas_used: gasUsed, entry_gas_price: gasPrice,
      size_spend: pos.spent, spend_symbol: pool.spendSymbol, usd_per_spend: pool.usdPerSpend,
      target_pct: EXIT.tp1, stop_pct: EXIT.hardStop,
    }));
  }

  private noteFeeReread(id: string) {
    const play = this.state.plays.find((x) => x.play_id === id);
    if (play) play.fee_reread = true;
  }

  private noteSell(p: Position, leg: {
    quote: number; sold: number; price: number; impact: number | null; txs: string[]; flat: boolean;
    gas: { native: number; used: number; price: number | null; mixed: boolean } | null;
  }) {
    const play = this.state.plays.find((x) => x.play_id === p.id);
    if (!play || !(leg.sold > 0)) return;
    play.sold_tokens = (play.sold_tokens ?? 0) + leg.sold;
    play.exit_notional = (play.exit_notional ?? 0) + leg.price * leg.sold;
    play.quote_out = (play.quote_out ?? 0) + leg.quote;
    if (leg.impact == null) play.impact_gap = true;
    else play.impact_notional = (play.impact_notional ?? 0) + leg.impact * leg.sold;
    if (leg.txs.length) play.tx_exit = leg.txs[leg.txs.length - 1] ?? null;
    if (leg.gas == null) play.exit_gas_gap = true;
    else {
      const had = (play.exit_gas_used ?? 0) > 0;
      play.exit_gas_native = (play.exit_gas_native ?? 0) + leg.gas.native;
      play.exit_gas_used = (play.exit_gas_used ?? 0) + leg.gas.used;
      if (leg.gas.mixed || leg.gas.price == null) play.exit_gas_mixed = true;
      else if (!had) play.exit_gas_price = leg.gas.price;
      else if (play.exit_gas_price !== leg.gas.price) { play.exit_gas_mixed = true; play.exit_gas_price = null; }
    }
    if (!leg.flat) return;
    const sold = play.sold_tokens ?? 0;
    play.exit_at = this.now();
    play.exit_price = sold > 0 ? (play.exit_notional ?? 0) / sold : leg.price;
    play.price_impact_exit = play.impact_gap || !(sold > 0) ? null : (play.impact_notional ?? 0) / sold;
    play.sell_tax = p.sellTax;
    const entryPct = typeof play.feeTierEntry === 'object' && play.feeTierEntry ? play.feeTierEntry.feePct : null;
    const changed = entryPct != null && Math.abs(entryPct - p.feeBps / 10_000) > 1e-12;
    if (play.fee_reread) play.feeTierExit = feeTierFromBps(p.feeBps, this.now(), 'position.feeBps', changed);
    else {
      play.feeTierExit = feeTierFromBps(p.feeBps, play.entry_at, 'assumed:entry-fee-not-reread', false);
      play.assumptions.push('exit fee tier was not read again; entry fee reused');
    }
    const entryNative = play.entry_gas_native;
    const exitNative = play.exit_gas_native;
    if (play.exit_gas_gap || entryNative == null || exitNative == null || play.entry_gas_used == null) {
      play.gas_used = null; play.gas_price = null; play.gas_native = null; play.gas_assumed = false; play.gas_note = 'no receipt gas';
    } else if (play.exit_gas_mixed || play.entry_gas_price == null || play.exit_gas_price == null || play.entry_gas_price !== play.exit_gas_price) {
      play.gas_used = null; play.gas_price = null; play.gas_native = entryNative + exitNative; play.gas_assumed = false;
      play.gas_note = 'entry and exit gas prices differed; gas_native is the receipt sum';
    } else {
      play.gas_used = play.entry_gas_used + (play.exit_gas_used ?? 0);
      play.gas_price = play.entry_gas_price;
      play.gas_native = entryNative + exitNative;
      play.gas_assumed = false;
      play.gas_note = null;
    }
  }

  private async buy(pool: FreshPool, source: 'scan' | 'snipe', buyTax: number, sellTax: number) {
    const o = this.state.options;
    if (this.state.positions.some((p) => p.pool.toLowerCase() === pool.pool.toLowerCase() && p.chainId === pool.chainId)) return;
    const sized = sizeBuy({
      perTradeUsd: o.perTradeUsd, totalUsd: o.totalUsd, openUsd: this.openUsd(),
      quoteReserve: pool.quoteReserve, usdPerSpend: pool.usdPerSpend, feeBps: pool.feeBps,
      buyTax, price: pool.price, maxImpact: o.maxImpact, maxPoolShare: o.maxPoolShare || TOKEN_MAX_POOL_SHARE,
    });
    if (!sized) {
      this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: 'size is under the limits or the pool is too thin' });
      this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: signalOf(pool.source), source: pool.dex, reason: 'size is under the limits or the pool is too thin', price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol });
      return;
    }
    let tokens = sized.tokens, spent = sized.spend, price = pool.price, spentUsd = sized.usd;
    let txEntry: string | null = null, gasUsed: number | null = null, gasPrice: number | null = null;
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('live broker missing');
      const fill = await this.d.live.buy({ ...pool }, sized.spend, this.limits());
      tokens = fill.tokens; spent = fill.spent; price = fill.price; spentUsd = fill.spentUsd;
      txEntry = fill.tx ?? null;
      if (fill.gasUsed != null && fill.gasPriceWei != null) { gasUsed = fill.gasUsed; gasPrice = fill.gasPriceWei; }
    }
    const pos: Position = {
      id: `tt-${this.now().toString(36)}-${pool.pool.slice(2, 6)}`, chainId: pool.chainId, pool: pool.pool, dex: pool.dex,
      label: `${pool.tokenSymbol}/${pool.spendSymbol}`, token: pool.token, spend: pool.spend, mode: o.mode,
      entryPrice: price, price, peak: price, tokens, entryTokens: tokens, spent, spentUsd, openedAt: this.now(),
      entryVolume: pool.volumeUsd, volume: pool.volumeUsd, entryLiq: pool.liquidityUsd, liq: pool.liquidityUsd,
      entrySellTax: sellTax, sellTax, sellSimOk: true, feeBps: pool.feeBps, quoteReserve: pool.quoteReserve,
      tokenReserve: pool.tokenReserve, usdPerSpend: pool.usdPerSpend, buyTax, tp1Done: false, tp2Done: false, source, exitPlan: 'hold',
    };
    this.state.positions.push(pos);
    const why = `buy ${sized.why}`;
    this.state.trades.unshift({ t: this.now(), side: 'buy', chainId: pool.chainId, pool: pool.pool, label: pos.label, usd: spentUsd, price, why, pnlUsd: null });
    this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: pos.label, verdict: 'bought', why });
    this.say(`bought ${pos.label} on ${pool.dex}: ${why}`, 'success');
    this.rememberEntry(pos, pool, sized.impact, txEntry, gasUsed, gasPrice);
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }

  private async consider(pool: FreshPool, source: 'scan' | 'snipe') {
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    const skip = (why: string) => {
      this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why });
      this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: signalOf(pool.source), source: pool.dex, reason: why, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol });
    };
    if (!this.wantChain(pool.chainId)) { skip('chain is off'); return; }
    if (pool.kind === 'v4') { skip("this app doesn't swap V4"); return; }
    const a = await this.assess(pool);
    if (!a.ok) { skip(a.reason ?? 'safety'); this.say(`skipped ${label}: ${a.reason}`, 'warn'); return; }
    await this.buy({ ...pool, source: source === 'snipe' ? 'snipe' : pool.source }, source, a.buyTax, a.sellTax);
  }

  private async scanEntries() {
    if (!this.d.discover) return;
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
      const rejectHit = (reason: string, label: string, token = hit.token0) => {
        this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label, verdict: 'skipped', why: reason });
        this.reject({ chainId: hit.chainId, pool: hit.pool, token, signal: 'snipe', source: hit.dex, reason, price: null, feeBps: hit.fee != null ? hit.fee / 100 : null });
      };
      if (sn.chains[hit.chainId] === false) { rejectHit('sniper is off for this chain', hit.pool.slice(0, 8)); continue; }
      if (hit.skip) { rejectHit(hit.skip, 'V4'); continue; }
      if (hit.kind === 'v4') { this.reject({ chainId: hit.chainId, pool: hit.pool, token: hit.token0, signal: 'snipe', source: hit.dex, reason: "this app doesn't swap V4", price: null, feeBps: hit.fee != null ? hit.fee / 100 : null }); continue; }
      const pool = await this.d.resolve?.(hit) ?? null;
      if (!pool) { rejectHit('could not price the new pool', hit.pool.slice(0, 8)); continue; }
      if (pool.liquidityUsd < sn.minLiquidityUsd) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `liquidity under $${sn.minLiquidityUsd.toLocaleString('en-US')}` }); this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: 'snipe', source: pool.dex, reason: `liquidity under $${sn.minLiquidityUsd.toLocaleString('en-US')}`, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol }); continue; }
      if (room <= 0) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `${sn.maxPerHour} snipes an hour already` }); this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: 'snipe', source: pool.dex, reason: `${sn.maxPerHour} snipes an hour already`, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol }); continue; }
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
    };
  }

  private async exits() {
    const left: Position[] = [];
    for (const p of this.state.positions) {
      if (this.d.mark) {
        const m = await this.d.mark(p);
        if (m) {
          Object.assign(p, m);
          if (Object.prototype.hasOwnProperty.call(m, 'feeBps')) this.noteFeeReread(p.id);
        }
      }
      if (p.price > p.peak) p.peak = p.price;
      const d = decideExit(this.exitOf(p));
      p.exitPlan = d.action === 'hold' ? 'hold' : d.why;
      if (d.action === 'hold') { left.push(p); continue; }
      const qty = Math.min(p.tokens, p.entryTokens * d.frac);
      const parts = splitSell(qty, Math.max(p.tokenReserve, 1e-12), p.feeBps, this.state.options.maxImpact);
      let quote = 0, sold = 0;
      let impactW = 0, impactN = 0, impactGap = false;
      const exitTxs: string[] = [];
      let gasNative = 0, gasUsed = 0, gasPrice: number | null = null, gasLegs = 0, gasMixed = false, gasGap = !(p.mode === 'live' && this.d.live);
      if (p.mode === 'live' && this.d.live) {
        for (const part of parts) {
          const s = await this.d.live.sell(p, part, this.limits());
          quote += s.quoteOut; sold += s.tokensIn;
          if (Number.isFinite(s.impact)) { impactW += s.impact * s.tokensIn; impactN += s.tokensIn; } else impactGap = true;
          if (s.tx) exitTxs.push(s.tx);
          if (s.gasUsed != null && s.gasPriceWei != null) {
            gasNative += (s.gasUsed * s.gasPriceWei) / 1e18;
            gasUsed += s.gasUsed;
            if (gasLegs === 0) gasPrice = s.gasPriceWei;
            else if (gasPrice !== s.gasPriceWei) { gasMixed = true; gasPrice = null; }
            gasLegs++;
          } else gasGap = true;
        }
      } else {
        const model = this.model(p);
        for (const part of parts) {
          const sim = simSell(part, p.price, model);
          quote += sim.quote; sold += part;
          if (Number.isFinite(sim.impactPct)) { impactW += sim.impactPct * part; impactN += part; } else impactGap = true;
        }
      }
      p.tokens -= sold;
      const usd = quote * p.usdPerSpend;
      const cost = p.spentUsd * (p.entryTokens > 0 ? sold / p.entryTokens : 0);
      this.state.trades.unshift({ t: this.now(), side: 'sell', chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why: d.why, pnlUsd: usd - cost });
      this.say(`sold ${p.label}: ${d.why}`, usd - cost >= 0 ? 'success' : 'warn');
      if (d.why.startsWith('take profit') && !p.tp1Done) p.tp1Done = true;
      else if (d.why.startsWith('take profit')) p.tp2Done = true;
      const flat = !(p.tokens > p.entryTokens * 1e-8);
      this.noteSell(p, {
        quote, sold, price: p.price, impact: impactGap || impactN <= 0 ? null : impactW / impactN, txs: exitTxs, flat,
        gas: gasGap || gasLegs === 0 ? null : { native: gasNative, used: gasUsed, price: gasPrice, mixed: gasMixed },
      });
      if (!flat) left.push(p);
    }
    this.state.positions = left;
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }
}
