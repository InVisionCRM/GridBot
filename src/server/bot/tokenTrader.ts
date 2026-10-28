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
  decideExit, filterFresh,   gateToken, sizeBuy, splitSell, DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SIZE_IMPACT_CAP, DEFAULT_SNIPER_MIN_LIQ_USD,
  type FreshPool, type GateInput,
  effectiveEntry, sellSidePrice,
} from '../../market/tokenTrader';
import { TOKEN_MAX_POOL_SHARE } from '../../market/poolSize';
import type { Emit } from './activity';
import type { Store } from './store';
import type { PoolSniper, SnipeHit } from '../market/sniper';
import { requestHalt, systemHalt, type Halt } from './audit';
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
  /** Empty = every chain the app trades */
  chains: number[];
  risk: 'safe' | 'medium' | 'any';
  maxImpact: number;
  maxPoolShare: number;
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
  /**
   * Live only: a split sell stopped partway (a part failed, reverted, or Off completely landed between parts). The
   * token amount is re-read from the wallet before this position may sell again; the remaining parts are never
   * assumed sold.
   */
  reconcile?: boolean;
  /**
   * Live only, set with `reconcile`: the wallet's balance of this token and this position's tokens right before the
   * split sell began. Reconcile then books only what left the wallet during this sell (before − after), so tokens of
   * the same coin the bot didn't buy (manual buys, airdrops) are never counted as the position's. null = the read
   * before the sell failed (the wallet balance is then only an upper bound).
   */
  reconcileBase?: { bal: number; tokens: number } | null;
  /** When the position became blocked on reconcile and why (lasting warning; cleared when reconciled). Saved. */
  blockedSince?: number | null;
  blockedWhy?: string | null;
  /**
   * A take-profit tranche that stopped partway: which one, its size (tokens, fixed when it first fired) and what was
   * sold toward it. The next time that take profit fires it sells only the rest, then counts as done.
   */
  tpPending?: { tp: 1 | 2; target: number; sold: number } | null;
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
  /**
   * What "off" means (only read while on is false). 'exits': no discovery, buys or snipes, but stop-loss / take-profit
   * exits keep running on open positions (live sells included). 'full': nothing runs. Missing (files written before
   * this field) = 'exits': the old off message promised "open positions stay until their exit rules fire".
   */
  offMode?: OffMode;
  /** Mode changes (on, off for new buys, off completely), newest first, for the stop audit */
  modeLog?: { mode: RunMode; halt: Halt }[];
  /**
   * Set when a file from before off modes (on: false, no offMode) held LIVE positions: it loads off completely and the
   * owner must choose "run exits" or "keep fully off" (no real sell goes out before that). Cleared by any mode change.
   */
  pendingChoice?: { livePositions: number; at: number } | null;
}

export type OffMode = 'exits' | 'full';
/** on: everything runs. exits: off for new buys, exits running. full: off completely, nothing runs. */
export type RunMode = 'on' | OffMode;
const MODE_LOG_MAX = 50;

export interface LiveFill { tokens: number; spent: number; spentUsd: number; price: number; impact: number; tx?: string }
export interface LiveSell { quoteOut: number; tokensIn: number; price: number; impact: number; tx?: string }

const HOUR = 3600_000;
const num = (n: number) => +n.toPrecision(6);
const FEED_MAX = 80;
const TRADE_MAX = 200;

export const DEFAULT_TRADER: TraderOptions = {
  mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC,
  chains: [], risk: 'safe', maxImpact: 0.03, maxPoolShare: TOKEN_MAX_POOL_SHARE,
  enforceHolderCheck: false, maxHolderShare: DEFAULT_MAX_HOLDER_SHARE, maxTop10Share: DEFAULT_MAX_TOP10_SHARE,
  minHolderCoverage: DEFAULT_MIN_HOLDER_COVERAGE,
  enforceSizeImpact: false, sizeImpactCap: DEFAULT_SIZE_IMPACT_CAP,
  sniper: { on: false, minLiquidityUsd: DEFAULT_SNIPER_MIN_LIQ_USD, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: {}, mevRpc: null },
};

const fresh = (): TraderState => ({ version: 1, on: false, options: structuredClone(DEFAULT_TRADER), positions: [], trades: [], feed: [], cursors: {}, snipesAt: [] });

export class TokenTrader {
  private state: TraderState;
  private busy = false;
  /** Spend coin of a live buy that has started and not yet landed or failed. Not persisted. */
  private pendingBuy: { chainId: number; address: string; amount: number } | null = null;
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
    /**
     * The wallet's on-chain balance of a live position's token (human units), for reconciling after a partial,
     * failed or halted split sell. null = unknown (no key, read failed).
     */
    balanceOf?: (p: Position) => Promise<number | null>;
    /** A dynamic-fee pool's fee() right now, in bps (read before every sizing and sell; never cached). */
    feeNow?: (p: { chainId: number; pool: string }) => Promise<number>;
    /** Turn a sniper hit into a pool with depth and price. null = can't price it. */
    resolve?: (hit: SnipeHit) => Promise<FreshPool | null>;
  }) {
    const loaded = d.store.load();
    this.state = loaded?.version === 1 ? { ...fresh(), ...loaded, options: { ...DEFAULT_TRADER, ...loaded.options, sniper: { ...DEFAULT_TRADER.sniper, ...loaded.options?.sniper } } } : fresh();
    this.migrateEntries();
    this.migrateOffMode(loaded);
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

  /**
   * A file written before off modes has on: false and no offMode. Only paper positions (or none): exits-only, which is
   * what the old off message promised. Any LIVE position: off completely until the owner chooses, so no real sell goes
   * out on the first boot after the update.
   */
  private migrateOffMode(loaded: TraderState | null | undefined) {
    // Only a file that is explicitly on skips the check: a missing `on` is not "on".
    if (!loaded || loaded.version !== 1 || loaded.on === true || loaded.offMode != null) return;
    const live = this.state.positions.filter((p) => p.mode === 'live').length;
    if (live > 0) {
      this.state.offMode = 'full';
      this.state.pendingChoice = { livePositions: live, at: this.now() };
      this.logMode('full', systemHalt('token-trader-migrate', `Update: off with ${live} live position(s) loads off completely until you choose`, this.now()));
      this.d.emit?.({ type: 'alert', kind: 'system', level: 'warn', notify: true, msg: `Token trader has ${live} live position(s) unwatched — choose: run exits / keep fully off` });
    } else {
      this.state.offMode = 'exits';
    }
    this.save();
  }

  private now() { return (this.d.now ?? Date.now)(); }
  private save() { this.d.store.save(this.state); }
  private say(msg: string, level: 'info' | 'warn' | 'success' = 'info') {
    this.d.emit?.({ type: 'info', kind: 'system', level, msg });
  }

  /** on / exits (off for new buys, exits running) / full (off completely). */
  runMode(): RunMode {
    return this.state.on ? 'on' : this.state.offMode === 'full' ? 'full' : 'exits';
  }
  /** A sell (an exit) may run and be sent: anything but "off completely". Never allows a buy. */
  canSell(): boolean {
    return this.runMode() !== 'full';
  }
  /** Open positions whose exits actually run: all of them unless off completely. */
  private watched(): Position[] {
    return this.canSell() ? this.state.positions : [];
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
    return {
      ...this.state,
      openUsd,
      lastError: this.lastError,
      entriesHalt: this.state.entriesHalt ?? null,
      lastHalt: this.state.lastHalt ?? null,
      /** Open positions whose exits (stops, take-profits) are still managed, also while new buys are stopped */
      exitsManaged: this.watched().length,
      runMode: this.runMode(),
      offMode: this.state.offMode ?? 'exits',
      modeLog: this.state.modeLog ?? [],
      pendingChoice: this.state.pendingChoice ?? null,
      positions: this.state.positions.map((p) => ({ ...p, pnlUsd: this.pnl(p), exitPlan: this.plan(p), exitsBlocked: this.blocked(p) })),
      /** Live positions whose exits are blocked until the wallet balance can be read (lasting, until reconciled) */
      exitsBlocked: this.state.positions.filter((p) => this.blocked(p)).length,
    };
  }

  configure(o: Partial<TraderOptions> & { sniper?: Partial<SniperOptions> }) {
    const n = { ...this.state.options, ...o, sniper: { ...this.state.options.sniper, ...(o.sniper ?? {}) } };
    if (!(n.perTradeUsd > 0) || !(n.totalUsd > 0)) throw new Error('Per-trade and total limits must be above 0.');
    if (n.perTradeUsd > n.totalUsd) throw new Error('Per-trade limit is above the total limit.');
    if (!(n.minPoolAgeSec >= 0)) throw new Error('Minimum pool age must be 0 or more seconds.');
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
    this.state.pendingChoice = null;
    this.logMode('on', requestHalt('token-trader-on', 'POST /api/token-trader/on', this.now()));
    this.say(`token trader on (${o.mode}): up to ${o.perTradeUsd} USD a trade, ${o.totalUsd} USD open, pools at least ${Math.round(o.minPoolAgeSec / 3600)}h old unless the sniper is on`);
    this.save();
  }

  /**
   * mode 'exits' (default, and what "Off" always did on paper): no discovery, buys or snipes; exits keep running.
   * mode 'full' ("Off completely, no exits"): nothing runs, open positions are left alone.
   */
  turnOff(mode: OffMode = 'exits') {
    if (mode !== 'exits' && mode !== 'full') throw new Error('Off mode must be "exits" or "full".');
    const choice = this.state.pendingChoice;
    this.state.on = false;
    this.state.offMode = mode;
    this.state.pendingChoice = null;
    const what = mode === 'full' ? 'off completely' : 'off for new buys';
    const halt = requestHalt('token-trader-off', choice ? `POST /api/token-trader/off (update choice: ${mode === 'full' ? 'keep fully off' : 'run exits'} for ${choice.livePositions} live position(s))` : `POST /api/token-trader/off (${what})`, this.now());
    this.state.lastHalt = halt;
    this.logMode(mode, halt);
    const n = this.state.positions.length, w = this.watched().length;
    const msg = mode === 'full'
      ? `token trader off completely: no buys, no snipes and no exits${n ? `; the stops and take-profits of its ${n} open position(s) are not watched` : ''}`
      : `token trader off for new buys: no discovery, buys or snipes; exits running on ${w} open position(s)`;
    this.d.emit?.({ type: 'stopped', kind: 'system', level: 'warn', notify: true, msg, data: { halt, mode } });
    this.save();
  }

  private logMode(mode: RunMode, halt: Halt) {
    const l = this.state.modeLog ??= [];
    l.unshift({ mode, halt });
    if (l.length > MODE_LOG_MAX) l.length = MODE_LOG_MAX;
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
      msg: `token trader: new buys and snipes stopped${where} (${halt.detail}).${this.canSell() ? ` Exits still managed: ${this.watched().length}` : n ? ` It is off completely, so the exits of its ${n} position(s) are not watched` : ''}`,
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

  /**
   * on: snipes, exits, discovery. Off for new buys: exits only. Off completely: nothing. Every step re-reads the mode,
   * so an off (either kind) that lands while a tick is awaiting wins for the rest of that tick.
   */
  async tick() {
    if (this.busy || !this.canSell()) return;
    this.busy = true;
    try {
      // cleared first: a sell that stopped partway sets it inside exits() and must stay visible
      this.lastError = null;
      if (this.state.on) await this.takeSnipes();
      await this.exits();
      // Turned off while the snipes or exits were awaited: no new entries this tick.
      if (this.state.on) await this.scanEntries();
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
    const b = this.blocked(p);
    if (b) return b;
    const d = decideExit(this.exitOf(p));
    return d.action === 'hold' ? 'hold' : d.why;
  }

  /** A live position stuck on reconcile: its exits don't run until the wallet balance is read. null = not blocked. */
  private blocked(p: Position): string | null {
    if (p.mode !== 'live' || !p.reconcile) return null;
    return `exits blocked: can't read the wallet balance${p.blockedWhy ? ` (${p.blockedWhy})` : ''}`;
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

  private async assess(pool: FreshPool): Promise<{ ok: boolean; reason: string | null; buyTax: number; sellTax: number; gate: GateInput | null; warn: string | null }> {
    if (!this.d.assess) return { ok: false, reason: 'no safety check', buyTax: 0, sellTax: 0, gate: null, warn: null };
    const g = await this.d.assess(pool, this.state.options.mode, this.state.options.risk);
    let gate: GateInput = { ...g, mode: this.state.options.mode, risk: this.state.options.risk, minLiquidityUsd: g.minLiquidityUsd ?? (pool.source === 'snipe' ? this.state.options.sniper.minLiquidityUsd : 0) };
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

  private async buy(pool: FreshPool, source: 'scan' | 'snipe', buyTax: number, sellTax: number, gate: GateInput, warn: string | null) {
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
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('live broker missing');
      this.pendingBuy = { chainId: pool.chainId, address: pool.spend, amount: sized.spend };
      try {
        const fill = await this.d.live.buy({ ...pool }, sized.spend, this.limits());
        tokens = fill.tokens; spent = fill.spent; spentUsd = fill.spentUsd;
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
    this.say(`bought ${pos.label} on ${pool.dex}: ${why}`, 'success');
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }

  private async consider(pool: FreshPool, source: 'scan' | 'snipe') {
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    // Turned off since this tick started (POST /on runs a tick at once; discovery can take minutes): stop here,
    // before the safety check's reads. buy() checks canBuy() again after them.
    if (!this.state.on) return;
    if (!this.wantChain(pool.chainId)) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: 'chain is off' }); return; }
    if (pool.kind === 'v4') { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: "this app doesn't swap V4" }); return; }
    if (this.entriesStopped(pool.chainId)) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: 'new buys are stopped (Stop all)' }); return; }
    const a = await this.assess(pool);
    if (!a.ok || !a.gate) { this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why: a.reason ?? 'safety' }); this.say(`skipped ${label}: ${a.reason}`, 'warn'); return; }
    await this.buy({ ...pool, source: source === 'snipe' ? 'snipe' : pool.source }, source, a.buyTax, a.sellTax, a.gate, a.warn);
  }

  private async scanEntries() {
    if (!this.d.discover) return;
    if (this.state.entriesHalt?.chains === null) return; // stopped everywhere: don't even look
    const pools = await this.d.discover();
    if (!this.state.on) return; // turned off while discovery was pending (2026-10-27: 4 paper buys ~3 min after off)
    const { keep, skipped } = filterFresh(pools.filter((p) => p.source !== 'snipe'), { now: this.now(), minAgeMs: this.state.options.minPoolAgeSec * 1000, minLiquidityUsd: 0 });
    for (const s of skipped) this.feed({ t: this.now(), chainId: 0, pool: s.pool, label: s.pool.slice(0, 8), verdict: 'skipped', why: s.why });
    for (const p of keep) {
      if (!this.state.on) break;
      await this.consider(p, 'scan');
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
      if (!this.state.on) break; // turned off while the sniper's log read was pending
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

  /**
   * Set a live position's tokens from the wallet after a sell that stopped partway. Only what left the wallet during
   * that sell is booked (balance before − balance now, from `reconcileBase`), never more than the booked fills left,
   * and never more than the wallet holds beyond the other live positions in the same token: tokens the bot didn't buy
   * are never counted as this position's. The position's tokens only ever go down here.
   * true = reconciled (flag cleared); false = balance unknown, so it must not sell this tick (lasting warning).
   */
  private async reconcile(p: Position): Promise<boolean> {
    let err: string | null = null;
    const bal = this.d.balanceOf ? await this.d.balanceOf(p).catch((e: Error) => { err = e.message; return null; }) : null;
    if (bal == null || !Number.isFinite(bal)) {
      p.blockedSince ??= this.now();
      p.blockedWhy = (err ?? (this.d.balanceOf ? 'balance read failed' : 'no wallet reader')).slice(0, 160);
      return false;
    }
    const others = this.state.positions.filter((x) => x !== p && x.mode === 'live' && x.chainId === p.chainId && x.token.toLowerCase() === p.token.toLowerCase())
      .reduce((s, x) => s + x.tokens, 0);
    const before = p.tokens;
    const base = p.reconcileBase;
    const fromSell = base ? base.tokens - Math.max(0, base.bal - bal) : Infinity;
    p.tokens = Math.max(0, Math.min(before, fromSell, bal - others));
    const gone = before - p.tokens;
    // a take-profit tranche in progress: what the wallet shows also left counts toward it
    if (gone > 0 && p.tpPending) p.tpPending.sold += gone;
    p.reconcile = false;
    p.reconcileBase = null;
    p.blockedSince = null;
    p.blockedWhy = null;
    if (Math.abs(gone) > p.entryTokens * 1e-6) this.say(`${p.label}: tokens set from the wallet, ${num(before)} → ${num(p.tokens)}`, 'warn');
    return true;
  }

  private async exits() {
    const left: Position[] = [];
    for (const p of this.state.positions) {
      // Turned off completely while this loop was awaiting: leave the rest alone.
      if (!this.canSell()) { left.push(p); continue; }
      if (this.d.mark) {
        const m = await this.d.mark(p);
        if (m) Object.assign(p, m);
        // Off completely landed while the mark was read: don't sell (a live send is refused by canSell too).
        if (!this.canSell()) { left.push(p); continue; }
      }
      // the peak follows the price even while the position is blocked on reconcile (its trailing stop stays right)
      if (p.price > p.peak) p.peak = p.price;
      if (p.mode === 'live' && p.reconcile) {
        // the last split sell stopped partway: take the wallet's balance before deciding anything
        if (!(await this.reconcile(p))) { p.exitPlan = this.blocked(p) ?? p.exitPlan; left.push(p); continue; }
        if (!(p.tokens > p.entryTokens * 1e-8)) continue;
      }
      const d = decideExit(this.exitOf(p));
      p.exitPlan = d.action === 'hold' ? 'hold' : d.why;
      if (d.action === 'hold') { left.push(p); continue; }
      if (p.dynamicFee && this.d.feeNow) {
        // the fee this sell pays, read now (keeps the last one if the read fails)
        const fee = await this.d.feeNow(p).catch(() => null);
        if (fee != null) p.feeBps = fee;
      }
      // Take profit 1 / 2 each sell one tranche of the entry (d.frac of entryTokens). One that stopped partway sells
      // only the rest of that tranche the next time it fires.
      const tp: 0 | 1 | 2 = d.why.startsWith('take profit') ? (p.tp1Done ? 2 : 1) : 0;
      const pend = tp && p.tpPending?.tp === tp ? p.tpPending : null;
      const target = pend ? pend.target : p.entryTokens * d.frac;
      const qty = Math.min(p.tokens, pend ? Math.max(0, pend.target - pend.sold) : p.entryTokens * d.frac);
      const parts = splitSell(qty, Math.max(p.tokenReserve, 1e-12), p.feeBps, this.state.options.maxImpact);
      let quote = 0, sold = 0, stopped: string | null = null;
      if (p.mode === 'live' && this.d.live && parts.length) {
        // what the wallet holds right before this sell: a stop partway books only what left during it
        const bal = this.d.balanceOf ? await this.d.balanceOf(p).catch(() => null) : null;
        p.reconcileBase = bal != null && Number.isFinite(bal) ? { bal, tokens: p.tokens } : null;
      }
      if (p.mode === 'live' && this.d.live) {
        // Each part's fill is booked as it lands. A part that fails, or Off completely between parts, stops the rest;
        // what really left the wallet is then read back (reconcile), never assumed.
        for (const part of parts) {
          if (!this.canSell()) { stopped = 'turned off completely'; break; }
          try {
            const s = await this.d.live.sell(p, part, this.limits());
            quote += s.quoteOut; sold += s.tokensIn;
          } catch (e) { stopped = (e as Error).message; break; }
        }
      } else {
        const model = this.model(p);
        for (const part of parts) { quote += simSell(part, sellSidePrice(p.price, p.feeBps), model).quote; sold += part; }
      }
      p.tokens = Math.max(0, p.tokens - sold);
      if (sold > 0) {
        const usd = quote * p.usdPerSpend;
        const cost = p.spentUsd * (p.entryTokens > 0 ? sold / p.entryTokens : 0);
        const why = stopped ? `${d.why} (partial: ${num(sold)} of ${num(qty)})` : d.why;
        this.state.trades.unshift({ t: this.now(), side: 'sell', chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why, pnlUsd: usd - cost });
        this.say(`sold ${p.label}: ${why}`, usd - cost >= 0 ? 'success' : 'warn');
      }
      if (tp && (sold > 0 || pend || stopped)) {
        // Done only when the whole tranche went out with nothing interrupting it; a stop partway leaves the rest pending.
        const total = (pend?.sold ?? 0) + sold;
        if (!stopped && parts.length) {
          if (tp === 1) p.tp1Done = true; else p.tp2Done = true;
          p.tpPending = null;
        } else p.tpPending = { tp, target, sold: total };
      }
      if (stopped) {
        this.lastError = `${p.label}: sell stopped after ${num(sold)} of ${num(qty)} — ${stopped}`;
        this.say(`${p.label}: sell stopped partway (${stopped}); reading the wallet balance before it sells again`, 'warn');
        p.reconcile = true;
        await this.reconcile(p);
      } else p.reconcileBase = null;
      if (p.tokens > p.entryTokens * 1e-8 || p.reconcile) left.push(p);
    }
    this.state.positions = left;
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }
}
