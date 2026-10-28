/**
 * Token trader. A separate file from the grid/liquidity state (data/token-trader.json, version 1) so a restart
 * resumes these positions without touching state.json.
 *
 * Paper uses the same discovery, safety gate, sizing and exit rules as live, and fills with simBuy / simSell
 * (impact, fee, tax). Live is opt-in: it needs a signing key and the existing safety classifier, and sends
 * through the injected broker (the chain's signer; an optional Ethereum MEV URL changes only the broadcast).
 */
import { chainById } from '../../live/chains';
import { DEFAULT_MAX_HOLDER_SHARE, DEFAULT_MAX_TOP10_SHARE, DEFAULT_MIN_HOLDER_COVERAGE, clampHolderCoverage, clampHolderShare } from '../../market/holders';
import { HARD_CAPS, type SafetyLimits } from '../../live/limits';
import { simSell, type CostModel } from '../../market/costs';
import {
  decideExit, filterFresh, gateToken, sizeBuy, splitSell, EXIT, DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SIZE_IMPACT_CAP, DEFAULT_SNIPER_MIN_LIQ_USD,
  type FreshPool, type GateInput,
  effectiveEntry, sellSidePrice,
} from '../../market/tokenTrader';
import { DEFAULT_MIN_LIQUIDITY_USD, effectiveMinLiquidityUsd, gateMinLiquidityUsd } from '../../market/liquidityFloor';
import { blankPlay, feeTierFromBps, playLeaderboard, type PlayRecord } from '../../metrics/playScore';
import { MemoryRejects, rejectKey, type RejectSink } from './playRejects';
import { TOKEN_MAX_POOL_SHARE } from '../../market/poolSize';
import type { Emit } from './activity';
import type { Store } from './store';
import type { PoolSniper, SnipeHit } from '../market/sniper';
import { requestHalt, type Halt } from './audit';
import type { ReservedBalance } from '../swap/holds';
import { NATIVE } from '../../live/swapMath';

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
  /**
   * Minimum pool liquidity (USD) for a scan buy and the safety gate. 0 matches the old hardcoded floor,
   * so existing installs do not start skipping pools. Snipes also still have to clear `sniper.minLiquidityUsd`.
   */
  minLiquidityUsd: number;
  /** When on, the floor in force is at least $50,000. Off by default. Never lowers a higher minimum. */
  enforceLiquidityFloor: boolean;
  /** Empty = every chain the app trades */
  chains: number[];
  risk: 'safe' | 'medium' | 'any';
  maxImpact: number;
  maxPoolShare: number;
  /**
   * Read Uniswap V3 position NFTs and attach the lock/burn report to the gate.
   * Off unless set: the gate then behaves exactly as it does without the field.
   */
  v3LpLockCheck: boolean;
  /**
   * Fill lpUnlocked from the pool (V2 burn share, or the V3 position-NFT check).
   * Off unless set: assess leaves lpUnlocked null and the gate output is unchanged.
   */
  lpUnlockCheck: boolean;
  /**
   * Read holder concentration and let the gate use it. Default off: assess still passes unknown concentration,
   * and the gate output matches a build that does not know about this flag.
   */
  enforceHolderCheck: boolean;
  /** Largest holder, as a share of circulating supply. Used only when `enforceHolderCheck` is on. Default 10%. */
  maxHolderShare: number;
  /** Top 10 holders, as a share of circulating supply. Used only when `enforceHolderCheck` is on. Default 40%. */
  maxTop10Share: number;
  /** Explained balances must cover at least this fraction of totalSupply. Default 90%. Used only when the check is on. */
  minHolderCoverage: number;
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
   * Passed plays only. Never trimmed (the trade log's 200-row cap does not apply).
   * Rejected candidates are not stored here; they go to the append-only reject log.
   * `status()` leaves this off so that payload stays the trade log.
   */
  plays: PlayRecord[];
  /**
   * Stop all (chains null) or STOP chain: no new buys or snipes there until "Resume new buys". Exits of positions
   * already held keep running. The halt is the stop audit record (who, from where, when).
   */
  entriesHalt?: { halt: Halt; chains: number[] | null } | null;
  /** The last stop of the token trader itself (turned off, or new buys stopped), for the stop audit */
  lastHalt?: Halt | null;
}

export interface LiveFill { tokens: number; spent: number; spentUsd: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number; /** Approve + swap + L1, native units. Absent when there is no receipt. */ gasNative?: number }
export interface LiveSell { quoteOut: number; tokensIn: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number; /** Approve + swap + L1, native units. Absent when there is no receipt. */ gasNative?: number }

const HOUR = 3600_000;
const FEED_MAX = 80;
const TRADE_MAX = 200;

export const DEFAULT_TRADER: TraderOptions = {
  mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC,
  minLiquidityUsd: DEFAULT_MIN_LIQUIDITY_USD, enforceLiquidityFloor: false,
  chains: [], risk: 'safe', maxImpact: 0.03, maxPoolShare: TOKEN_MAX_POOL_SHARE,
  v3LpLockCheck: false,
  lpUnlockCheck: false,
  enforceHolderCheck: false, maxHolderShare: DEFAULT_MAX_HOLDER_SHARE, maxTop10Share: DEFAULT_MAX_TOP10_SHARE,
  minHolderCoverage: DEFAULT_MIN_HOLDER_COVERAGE,
  enforceSizeImpact: false, sizeImpactCap: DEFAULT_SIZE_IMPACT_CAP,
  sniper: { on: false, minLiquidityUsd: DEFAULT_SNIPER_MIN_LIQ_USD, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: {}, mevRpc: null },
};

const fresh = (): TraderState => ({ version: 1, on: false, options: structuredClone(DEFAULT_TRADER), positions: [], trades: [], feed: [], cursors: {}, snipesAt: [], plays: [] });

function signalOf(source: FreshPool['source']): string {
  if (source === 'trending') return 'trending';
  if (source === 'snipe') return 'snipe';
  return 'new_pool';
}

/** Spend-coin units for 1 native coin. The symbols come from the chain config, so PulseChain matches WPLS and Robinhood matches WETH. */
function nativeToSpend(pool: FreshPool): number | null {
  const chain = chainById(pool.chainId);
  const native = chain?.nativeSymbol.toUpperCase();
  const wrapped = chain?.wrappedNative.symbol.toUpperCase();
  const spend = pool.spendSymbol.toUpperCase();
  const token = pool.tokenSymbol.toUpperCase();
  if (native && spend === native) return 1;
  if (wrapped && spend === wrapped) return 1;
  if (native && token === native && pool.price > 0) return pool.price;
  if (wrapped && token === wrapped && pool.price > 0) return pool.price;
  return null;
}

export class TokenTrader {
  private state: TraderState;
  /** Held only while exits run, so a buy-path LP check cannot block the next stop. */
  private exitBusy = false;
  /** In-flight buy path (snipes and the entry scan). The next tick still runs exits. */
  private entryTask: Promise<void> | null = null;
  /** Spend coin of a live buy that has started and not yet landed or failed. Not persisted. */
  private pendingBuy: { chainId: number; address: string; amount: number } | null = null;
  private readonly rejects: RejectSink;
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
     * Largest holder and top 10, excluding pools, burn addresses and lockers.
     * Called only when `enforceHolderCheck` is on. A throw is a failed read.
     */
    holders?: (pool: FreshPool) => Promise<{
      largest: number | null; top10: number | null; unverified: boolean;
      unavailable?: 'no-source' | 'read-failed'; chainName?: string;
      unseen?: number | null; top10Exact?: boolean;
      coverage?: number | null; thin?: boolean; holders?: string;
      windowFrom?: number | null; creationBlock?: number | null;
    }>;
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
    /** Rejected candidates. Omitted in tests that only need the in-memory window. */
    rejects?: RejectSink;
  }) {
    const loaded = d.store.load();
    this.rejects = d.rejects ?? new MemoryRejects();
    this.state = loaded?.version === 1 ? { ...fresh(), ...loaded, options: { ...DEFAULT_TRADER, ...loaded.options, sniper: { ...DEFAULT_TRADER.sniper, ...loaded.options?.sniper } }, plays: Array.isArray(loaded.plays) ? loaded.plays : [] } : fresh();
    this.spillRejects();
    this.migrateEntries();
  }

  /** Older state files kept rejects next to passed plays. Move them out so the hot file stays small. */
  private spillRejects() {
    const kept: PlayRecord[] = [];
    let moved = false;
    for (const p of this.state.plays) {
      if (p.passed && !p.rejected) { kept.push(p); continue; }
      moved = true;
      const key = rejectKey(p.chain_id, p.pool_address, p.reason);
      if (!this.rejects.has(key)) this.rejects.append(p);
    }
    if (moved) { this.state.plays = kept; this.save(); }
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
  private say(msg: string, level: 'info' | 'warn' | 'success' = 'info', extra?: { notify?: boolean; data?: Record<string, unknown>; mode?: 'paper' | 'live' }) {
    const { mode, ...rest } = extra ?? {};
    this.d.emit?.({ type: 'info', kind: 'system', level, msg, ...rest, ...(mode ? { mode } : {}) });
  }

  /**
   * Live positions sit in the wallet: the token they hold, and the spend coin that bought it.
   * A live buy that has not landed yet reserves its spend coin the same way. Paper positions move no coins.
   */
  reservations(): ReservedBalance[] {
    const out: ReservedBalance[] = [];
    const native = (addr: string) => addr.toLowerCase() === NATIVE;
    for (const p of this.state.positions) {
      if (p.mode !== 'live') continue;
      if (p.tokens > 0) out.push({ chainId: p.chainId, address: p.token, native: native(p.token), amount: p.tokens, source: 'token-trader' });
      if (p.spent > 0) out.push({ chainId: p.chainId, address: p.spend, native: native(p.spend), amount: p.spent, source: 'token-trader' });
    }
    const pend = this.pendingBuy;
    if (pend && pend.amount > 0) out.push({ chainId: pend.chainId, address: pend.address, native: native(pend.address), amount: pend.amount, source: 'token-trader' });
    return out;
  }

  status() {
    const openUsd = this.openUsd();
    const { plays, ...rest } = this.state;
    void plays;
    return {
      ...rest,
      openUsd,
      /** Liquidity floor scan buys and the gate actually use (the setting, raised to $50,000 when that flag is on). */
      effectiveMinLiquidityUsd: this.floorUsd(),
      lastError: this.lastError,
      entriesHalt: this.state.entriesHalt ?? null,
      lastHalt: this.state.lastHalt ?? null,
      /** Open positions whose exits (stops, take-profits) are still managed, also while new buys are stopped */
      exitsManaged: this.state.on ? rest.positions.length : 0,
      positions: rest.positions.map((p) => ({ ...p, pnlUsd: this.pnl(p), exitPlan: this.plan(p) })),
    };
  }

  /** Passed plays. Not trimmed, and not part of `status()`. */
  plays(): PlayRecord[] { return this.state.plays; }

  /** Recent rejects kept in memory. At most 500. The scorecard reads the log, not this window. */
  recentRejects(): readonly PlayRecord[] { return this.rejects.window(); }

  /** Leaderboard. Reads the reject log here, never from tick(). */
  scorecard() { return playLeaderboard([...this.state.plays, ...this.rejects.read()]); }

  configure(o: Partial<TraderOptions> & { sniper?: Partial<SniperOptions> }) {
    const n = { ...this.state.options, ...o, sniper: { ...this.state.options.sniper, ...(o.sniper ?? {}) } };
    if ('v3LpLockCheck' in o) n.v3LpLockCheck = o.v3LpLockCheck === true;
    if ('lpUnlockCheck' in o) n.lpUnlockCheck = o.lpUnlockCheck === true;
    if (!(n.perTradeUsd > 0) || !(n.totalUsd > 0)) throw new Error('Per-trade and total limits must be above 0.');
    if (n.perTradeUsd > n.totalUsd) throw new Error('Per-trade limit is above the total limit.');
    if (!(n.minPoolAgeSec >= 0)) throw new Error('Minimum pool age must be 0 or more seconds.');
    if (!(n.minLiquidityUsd >= 0)) throw new Error('Minimum liquidity must be 0 or more USD.');
    if (typeof n.enforceLiquidityFloor !== 'boolean') throw new Error('Liquidity floor flag must be on or off.');
    if (!(n.maxImpact > 0) || n.maxImpact > HARD_CAPS.maxPriceImpact) throw new Error('Price-impact cap must be between 0% and 5%.');
    if (!(n.sizeImpactCap > 0) || n.sizeImpactCap > HARD_CAPS.maxPriceImpact) throw new Error('Trade-size impact cap must be between 0% and 5%.');
    if (!(n.maxPoolShare > 0) || n.maxPoolShare > 0.5) throw new Error('Max pool share must be between 0% and 50%.');
    n.maxHolderShare = clampHolderShare(n.maxHolderShare, DEFAULT_MAX_HOLDER_SHARE);
    n.maxTop10Share = clampHolderShare(n.maxTop10Share, DEFAULT_MAX_TOP10_SHARE);
    n.minHolderCoverage = clampHolderCoverage(n.minHolderCoverage);
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
    if (Object.prototype.hasOwnProperty.call(m, 'feeBps')) this.noteFeeReread(id);
  }

  async tick() {
    if (!this.state.on || this.exitBusy) return;
    this.exitBusy = true;
    let exitsOk = true;
    try {
      await this.exits();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      exitsOk = false;
    } finally {
      this.save();
      this.exitBusy = false;
    }
    // Buys, including LP checks, never share this lock. A tick that arrives while they run still exits.
    if (!exitsOk || this.entryTask) return;
    let task!: Promise<void>;
    task = this.runEntries().finally(() => { if (this.entryTask === task) this.entryTask = null; });
    this.entryTask = task;
    await task;
  }

  /** Snipes and the entry scan. LP reads happen in here, on the buy path only. */
  private async runEntries() {
    try {
      await this.takeSnipes();
      await this.scanEntries();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.save();
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

  /** Configured minimum, or $50,000 when that flag is on. Does not include the sniper's own minimum. */
  private floorUsd() { return effectiveMinLiquidityUsd(this.state.options); }

  /** Gate floor for this pool: the floor in force, the sniper minimum on a snipe, and any higher floor assess reported. A reported 0 does not win. */
  private gateFloor(pool: FreshPool, reported: number | null | undefined) {
    const o = this.state.options;
    return gateMinLiquidityUsd(pool, reported, {
      minLiquidityUsd: o.minLiquidityUsd, enforceLiquidityFloor: o.enforceLiquidityFloor, sniperMinLiquidityUsd: o.sniper.minLiquidityUsd,
    });
  }

  private wantChain(id: number) {
    const c = this.state.options.chains;
    return !c.length || c.includes(id);
  }

  private feed(item: FeedItem) {
    this.state.feed.unshift(item);
    if (this.state.feed.length > FEED_MAX) this.state.feed.length = FEED_MAX;
  }

  private async assess(pool: FreshPool): Promise<{ ok: boolean; reason: string | null; buyTax: number; sellTax: number; gate: GateInput | null; warn: string | null }> {
    if (!this.d.assess) return { ok: false, reason: 'no safety check', buyTax: 0, sellTax: 0, gate: null, warn: null };
    const g = await this.d.assess(pool, this.state.options.mode, this.state.options.risk);
    let gate: GateInput = { ...g, mode: this.state.options.mode, risk: this.state.options.risk, minLiquidityUsd: this.gateFloor(pool, g.minLiquidityUsd) };
    if (this.state.options.enforceHolderCheck) {
      const chainName = chainById(pool.chainId)?.name ?? `chain ${pool.chainId}`;
      let h: { largest: number | null; top10: number | null; unverified: boolean; unavailable?: 'no-source' | 'read-failed'; chainName?: string; unseen?: number | null; top10Exact?: boolean; coverage?: number | null; thin?: boolean; windowFrom?: number | null; creationBlock?: number | null } = {
        largest: null, top10: null, unverified: true, unavailable: 'read-failed', chainName, coverage: null,
      };
      if (this.d.holders) {
        try { h = await this.d.holders(pool); } catch { /* the read failed; the reason names the chain */ }
      }
      const thin = h.thin === true;
      const unverified = !thin && (h.unverified || h.largest == null || h.top10 == null);
      gate = {
        ...gate,
        enforceHolderCheck: true,
        holdersUnverified: unverified,
        holderUnavailable: unverified ? (h.unavailable ?? 'read-failed') : undefined,
        holderChain: h.chainName?.trim() || chainName,
        holderConcentration: unverified || thin ? null : h.largest,
        top10Concentration: unverified || thin ? null : h.top10,
        holderUnseen: unverified || thin ? null : h.unseen ?? 0,
        top10Exact: unverified || thin ? false : h.top10Exact,
        holderCoverage: h.coverage ?? null,
        holderThin: thin,
        holderWindowFrom: h.windowFrom ?? null,
        holderCreationBlock: h.creationBlock ?? null,
        maxHolderShare: this.state.options.maxHolderShare,
        maxTop10Share: this.state.options.maxTop10Share,
      };
    }
    const r = gateToken(gate);
    return { ok: r.ok, reason: r.reason, buyTax: g.buyTax ?? 0, sellTax: g.sellTax ?? 0, gate, warn: r.warn ?? null };
  }

  private reject(o: { chainId: number; pool: string; token: string; signal: string; source: string; reason: string; price: number | null; feeBps: number | null; spendSymbol?: string }) {
    const pool = o.pool.toLowerCase();
    const key = rejectKey(o.chainId, pool, o.reason);
    if (this.rejects.has(key)) return;
    const now = this.now();
    this.rejects.append(blankPlay({
      play_id: `rej-${now.toString(36)}-${pool.slice(2, 8)}`,
      kind: 'play', signal_type: o.signal, source: o.source, passed: false, rejected: true, reason: o.reason,
      chain_id: o.chainId, pool_address: pool, token_contract: o.token.toLowerCase(),
      priceAtFlag: o.price,
      feeTierEntry: o.feeBps != null ? feeTierFromBps(o.feeBps, now, 'pool.feeBps') : null,
      target_pct: EXIT.tp1, stop_pct: EXIT.hardStop, spend_symbol: o.spendSymbol ?? null,
    }));
  }

  private rememberEntry(pos: Position, pool: FreshPool, impact: number, tx: string | null, gasUsed: number | null, gasPrice: number | null, gasNative: number | null) {
    const now = this.now();
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
    if (play.exit_gas_gap || entryNative == null || exitNative == null) {
      play.gas_used = null; play.gas_price = null; play.gas_native = null; play.gas_assumed = false; play.gas_note = 'no receipt gas';
    } else if (play.exit_gas_mixed || play.entry_gas_used == null || play.entry_gas_price == null || play.exit_gas_price == null || play.entry_gas_price !== play.exit_gas_price) {
      play.gas_used = null; play.gas_price = null; play.gas_native = entryNative + exitNative; play.gas_assumed = false;
      play.gas_note = play.entry_gas_price != null && play.exit_gas_price != null && play.entry_gas_price !== play.exit_gas_price
        ? 'entry and exit gas prices differed; gas_native is the full receipt total and gas_used is left null' : null;
    } else {
      play.gas_used = play.entry_gas_used + (play.exit_gas_used ?? 0);
      play.gas_price = play.entry_gas_price;
      play.gas_native = entryNative + exitNative;
      play.gas_assumed = false;
      play.gas_note = null;
    }
  }

  private async buy(pool: FreshPool, source: 'scan' | 'snipe', buyTax: number, sellTax: number, gate: GateInput, warn: string | null) {
    const o = this.state.options;
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    const skip = (why: string) => {
      this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why });
      this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: signalOf(pool.source), source: pool.dex, reason: why, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol });
    };
    if (this.state.positions.some((p) => p.pool.toLowerCase() === pool.pool.toLowerCase() && p.chainId === pool.chainId)) return;
    // Checked again after the safety check's awaits: a Stop all that landed meanwhile wins.
    if (!this.canBuy(pool.chainId)) { skip('new buys are stopped'); return; }
    if (pool.dynamicFee) {
      // the fee at quote time: it may have moved since discovery
      const fee = this.d.feeNow ? await this.d.feeNow(pool).catch(() => null) : null;
      if (fee == null) { skip("could not read the pool's current fee"); return; }
      pool = { ...pool, feeBps: fee };
    }
    const sized = sizeBuy({
      perTradeUsd: o.perTradeUsd, totalUsd: o.totalUsd, openUsd: this.openUsd(),
      quoteReserve: pool.quoteReserve, usdPerSpend: pool.usdPerSpend, feeBps: pool.feeBps,
      buyTax, price: pool.price, maxImpact: o.maxImpact, maxPoolShare: o.maxPoolShare || TOKEN_MAX_POOL_SHARE,
    });
    if (!sized) { skip('size is under the limits or the pool is too thin'); return; }
    let recordedImpact = sized.impact;
    if (o.enforceSizeImpact) {
      let impact: number | null = null;
      try {
        if (!this.d.quoteImpact) throw new Error('no impact quote');
        const quoted = await this.d.quoteImpact(pool, sized.spend);
        impact = Number.isFinite(quoted) ? quoted : null;
      } catch { impact = null; }
      const again = gateToken({ ...gate, enforceSizeImpact: true, sizeImpact: impact, sizeImpactCap: o.sizeImpactCap });
      if (!again.ok) { skip(again.reason ?? 'price impact'); return; }
      if (impact != null) recordedImpact = impact;
    }
    let tokens = sized.tokens, spent = sized.spend, spentUsd = sized.usd;
    let txEntry: string | null = null, gasUsed: number | null = null, gasPrice: number | null = null, gasNative: number | null = null;
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('live broker missing');
      this.pendingBuy = { chainId: pool.chainId, address: pool.spend, amount: sized.spend };
      try {
        const fill = await this.d.live.buy({ ...pool }, sized.spend, this.limits());
        tokens = fill.tokens; spent = fill.spent; spentUsd = fill.spentUsd;
        txEntry = fill.tx ?? null;
        if (fill.gasUsed != null && fill.gasPriceWei != null) { gasUsed = fill.gasUsed; gasPrice = fill.gasPriceWei; }
        if (typeof fill.gasNative === 'number' && Number.isFinite(fill.gasNative)) gasNative = fill.gasNative;
      } finally {
        this.pendingBuy = null;
      }
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
    const why = warn ? `buy ${sized.why}; ${warn}` : `buy ${sized.why}`;
    this.state.trades.unshift({ t: this.now(), side: 'buy', chainId: pool.chainId, pool: pool.pool, label: pos.label, usd: spentUsd, price: entry, why, pnlUsd: null });
    this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: pos.label, verdict: 'bought', why });
    this.say(`bought ${pos.label} on ${pool.dex}: ${why}`, 'success', source === 'snipe' ? { notify: true, data: { push: 'sniper' }, mode: o.mode } : { mode: o.mode });
    this.rememberEntry(pos, pool, recordedImpact, txEntry, gasUsed, gasPrice, gasNative);
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
    if (this.entriesStopped(pool.chainId)) { skip('new buys are stopped (Stop all)'); return; }
    const a = await this.assess(pool);
    if (!a.ok || !a.gate) { skip(a.reason ?? 'safety'); this.say(`skipped ${label}: ${a.reason}`, 'warn'); return; }
    await this.buy({ ...pool, source: source === 'snipe' ? 'snipe' : pool.source }, source, a.buyTax, a.sellTax, a.gate, a.warn);
  }

  private async scanEntries() {
    if (!this.d.discover) return;
    if (this.state.entriesHalt?.chains === null) return; // stopped everywhere: don't even look
    const pools = await this.d.discover();
    const { keep, skipped } = filterFresh(pools.filter((p) => p.source !== 'snipe'), { now: this.now(), minAgeMs: this.state.options.minPoolAgeSec * 1000, minLiquidityUsd: this.floorUsd() });
    for (const s of skipped) this.feed({ t: this.now(), chainId: 0, pool: s.pool, label: s.pool.slice(0, 8), verdict: 'skipped', why: s.why });
    const eligible: FreshPool[] = [];
    for (const p of keep) {
      const label = `${p.tokenSymbol}/${p.spendSymbol}`;
      const skip = (why: string) => {
        this.feed({ t: this.now(), chainId: p.chainId, pool: p.pool, label, verdict: 'skipped', why });
        this.reject({ chainId: p.chainId, pool: p.pool, token: p.token, signal: signalOf(p.source), source: p.dex, reason: why, price: p.price, feeBps: p.feeBps, spendSymbol: p.spendSymbol });
      };
      if (!this.wantChain(p.chainId)) { skip('chain is off'); continue; }
      if (p.kind === 'v4') { skip("this app doesn't swap V4"); continue; }
      if (this.entriesStopped(p.chainId)) { skip('new buys are stopped (Stop all)'); continue; }
      eligible.push(p);
    }
    // Safety reads, including LP checks, overlap. Each check has its own timeout, so one pool cannot stall the rest.
    const checked = await Promise.all(eligible.map(async (p) => ({ p, a: await this.assess(p) })));
    for (const { p, a } of checked) {
      const label = `${p.tokenSymbol}/${p.spendSymbol}`;
      if (!a.ok || !a.gate) {
        const why = a.reason ?? 'safety';
        this.feed({ t: this.now(), chainId: p.chainId, pool: p.pool, label, verdict: 'skipped', why });
        this.reject({ chainId: p.chainId, pool: p.pool, token: p.token, signal: signalOf(p.source), source: p.dex, reason: why, price: p.price, feeBps: p.feeBps, spendSymbol: p.spendSymbol });
        this.say(`skipped ${label}: ${a.reason}`, 'warn');
        continue;
      }
      await this.buy(p, 'scan', a.buyTax, a.sellTax, a.gate, a.warn);
    }
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
      const minLiq = Math.max(sn.minLiquidityUsd, this.floorUsd());
      if (pool.liquidityUsd < minLiq) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `liquidity under $${minLiq.toLocaleString('en-US')}` }); this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: 'snipe', source: pool.dex, reason: `liquidity under $${minLiq.toLocaleString('en-US')}`, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol }); continue; }
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
      exitFee: p.feeBps / 10_000, exitTax: p.entrySellTax,
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
      if (p.dynamicFee && this.d.feeNow) {
        // the fee this sell pays, read now (keeps the last one if the read fails)
        const fee = await this.d.feeNow(p).catch(() => null);
        if (fee != null) { p.feeBps = fee; this.noteFeeReread(p.id); }
      }
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
          if (typeof s.gasNative === 'number' && Number.isFinite(s.gasNative)) {
            gasNative += s.gasNative;
            gasLegs++;
            if (s.gasUsed != null && s.gasPriceWei != null) {
              gasUsed += s.gasUsed;
              if (gasPrice == null) gasPrice = s.gasPriceWei;
              else if (gasPrice !== s.gasPriceWei) { gasMixed = true; gasPrice = null; }
            }
          } else gasGap = true;
        }
      } else {
        const model = this.model(p);
        const px = sellSidePrice(p.price, p.feeBps);
        for (const part of parts) {
          const sim = simSell(part, px, model);
          quote += sim.quote; sold += part;
          if (Number.isFinite(sim.impactPct)) { impactW += sim.impactPct * part; impactN += part; } else impactGap = true;
        }
      }
      p.tokens -= sold;
      const usd = quote * p.usdPerSpend;
      const cost = p.spentUsd * (p.entryTokens > 0 ? sold / p.entryTokens : 0);
      this.state.trades.unshift({ t: this.now(), side: 'sell', chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why: d.why, pnlUsd: usd - cost });
      this.say(`sold ${p.label}: ${d.why}`, usd - cost >= 0 ? 'success' : 'warn', { mode: p.mode });
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
