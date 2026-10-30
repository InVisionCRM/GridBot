/**
 * Token trader. A separate file from the grid/liquidity state (data/token-trader.json, version 1) so a restart
 * resumes these positions without touching state.json.
 *
 * Paper uses the same discovery, safety gate, sizing and exit rules as live, and fills with simBuy / simSell
 * (impact, fee, tax). Live is opt-in: it needs a signing key and the existing safety classifier, and sends
 * through the injected broker (the chain's signer; an optional Ethereum MEV URL changes only the broadcast).
 */
import { usdAsEth } from '../../lib/ethUnits';
import { tokenMetrics, tokenSpendTotals } from '../../metrics/botMetrics';
import { chainById } from '../../live/chains';
import { DEFAULT_MAX_HOLDER_SHARE, DEFAULT_MAX_TOP10_SHARE, DEFAULT_MIN_HOLDER_COVERAGE, clampHolderCoverage, clampHolderShare } from '../../market/holders';
import { HARD_CAPS, type SafetyLimits } from '../../live/limits';
import { simSell, type CostModel } from '../../market/costs';
import { unverifiedOwnerReport, type OwnerReport } from '../../market/ownerPowers';
import {
  decideExit, exitTargets, filterFresh, gateToken, sizeBuy, splitSell, EXIT, DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SIZE_IMPACT_CAP, DEFAULT_SNIPER_MIN_LIQ_USD,
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
import { requestHalt, systemHalt, type Halt } from './audit';
import { VENUES } from '../../live/venues';
import type { Generated } from '../../types/generated';
import type { ReservedBalance } from '../swap/holds';
import { NATIVE } from '../../live/swapMath';

export interface SniperOptions {
  on: boolean;
  minLiquidityUsd: number;
  delayBlocks: number;
  delaySec: number;
  maxPerHour: number;
  /** Ethereum send URL only (Flashbots Protect and the like). Quotes and limits are unchanged. */
  mevRpc: string | null;
}

export interface TraderOptions {
  mode: 'paper' | 'live';
  perTradeUsd: number;
  totalUsd: number;
  /**
   * Only with enforceWashAndAge on: scan discovery skips a pool younger than this when its age is known, and the gate
   * uses the same number for scan pools (an unknown age skips safe and medium).
   * Snipes are exempt from the age leg (they only get the wash-volume leg).
   */
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
   * When on, safe and medium apply minPoolAgeSec in the gate, treat an unknown pool age as a skip,
   * and skip wash volume (24h volume over 20× liquidity). Off: the gate ignores this and discovery is unchanged.
   */
  enforceWashAndAge: boolean;
  /**
   * When on, safe and medium skip a non-renounced owner who can mint, blacklist, pause, or set tax or limits,
   * and a proxy a live admin can upgrade. Off: the gate ignores this and the trader makes no extra reads.
   */
  enforceOwnerPowers: boolean;
  /**
   * Read Uniswap V3 position NFTs and attach the lock/burn report to the gate.
   * Off unless set: the gate then behaves exactly as it does without the field.
   */
  v3LpLockCheck: boolean;
  /**
   * Reuse a V3 lock result for the same chain, pool, and scanned block window.
   * Off unless set: the check does not consult that cache.
   */
  v3LpLockCacheEnabled: boolean;
  /** TTL for `v3LpLockCacheEnabled`. Default 10 minutes. */
  v3LpLockCacheTtlMs: number;
  /** Max public RPC calls for one V3 lock check. 0 means no cap. */
  v3LpLockCallBudget: number;
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
  /** Launch venue (venues.ts id) → bought from. Missing means on. */
  venues: Record<string, boolean>;
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
  /** Its prices since the buy, [time, price] (the last MARKS_KEPT reads), and when the last one was read */
  marks?: [number, number][];
  markedAt?: number;
  /** Sell it all on the next exit pass: asked for by hand (Sell now). Stays until it is sold. */
  sellNow?: number;
  /**
   * 'chain' once entryLiq was set from the pool's own depth (the first on-chain mark). Until then entryLiq is
   * GeckoTerminal's reserve figure, which on-chain depth can't be compared with.
   */
  liqBase?: 'chain';
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
  /**
   * Live only: a sell part was sent but its receipt had not come when the executor stopped waiting. It is settled by
   * hash (recover) before this position decides or sends anything again; its tokens are not assumed sold until then.
   */
  pendingSell?: PendingSell | null;
  /** When the position became blocked on reconcile and why (lasting warning; cleared when reconciled). Saved. */
  blockedSince?: number | null;
  blockedWhy?: string | null;
  /**
   * A take-profit tranche that stopped partway: which one, its size (tokens, fixed when it first fired) and what was
   * sold toward it. The next time that take profit fires it sells only the rest, then counts as done.
   */
  tpPending?: { tp: 1 | 2; target: number; sold: number } | null;
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
  /** Times tokens left the wallet with no fill known (reconcile): their coins received and cost are not counted */
  unpriced?: number;
}

/**
 * Generated per mode and spend coin (`mode:chainId:address`), kept after positions close. Paper and live never share
 * an entry: a position books into the ledger of its own mode (p.mode, fixed at its buy), whatever the trader's mode is
 * now.
 */
export interface GenLedger {
  /** Missing only in a file from before the mode split (migrated on load: migrateLedgerModes) */
  mode: 'paper' | 'live';
  chainId: number; coin: string; symbol: string;
  proceeds: number; cost: number; fees: number; taxes: number; gasNative: number; closed: number;
  /** Buys and landed sell parts booked here (all-time; the trade log is trimmed). Set at load for older files (migrateCounts). */
  fills: number;
  /** Set on an entry split from a pre-mode entry whose mode was inferred, not recorded (see migrateLedgerModes) */
  modeInferred?: boolean;
  /** Sells whose coins received are not known (a reported-failed send that landed); not in proceeds or cost */
  unpriced?: number;
}
export type TradeMode = 'paper' | 'live';
const genKey = (mode: TradeMode, chainId: number, coin: string) => `${mode}:${chainId}:${coin.toLowerCase()}`;

/**
 * One fill. `usd`/`pnlUsd` are dollars (kept for the API); `spendSym`, `amount` (spend coin bought with / received) and
 * `pnl` (spend coin) are the same fill in the coin it spends, for the crypto-units screens. Older lines have only dollars.
 */
/** `mode`: paper or live (rows written before it was recorded have none). */
export interface TradeLog { t: number; side: 'buy' | 'sell'; mode?: TradeMode; chainId: number; pool: string; label: string; usd: number; price: number; why: string; pnlUsd: number | null; spendSym?: string; amount?: number; pnl?: number | null }
/**
 * Where a coin left the funnel: rules (the scan's age / liquidity floor, chain off, V4, sniper limits, Stop all),
 * checks (the safety check said no), buy (refused at the buy itself: size, impact, fee read, stopped meanwhile).
 * A bought coin has stage 'buy'. Items saved before stages were recorded have none.
 */
export type FunnelStage = 'rules' | 'checks' | 'buy';
export interface FeedItem { t: number; chainId: number; pool: string; label: string; verdict: 'bought' | 'skipped'; why: string; stage?: FunnelStage }
/** Today's funnel (the server's local day): coins the scan and the sniper found, and where each left or got bought */
export interface FunnelCounts { day: string; scouted: number; rules: number; checks: number; buy: number; bought: number }

export interface TraderState {
  version: 1;
  on: boolean;
  options: TraderOptions;
  positions: Position[];
  trades: TradeLog[];
  feed: FeedItem[];
  /** Today's funnel counts; reset at the server's local midnight. Missing until the first scan after this was added. */
  funnel?: FunnelCounts;
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
  /**
   * Generated per mode and spend coin (key genKey). Missing = a file from before (starts empty; nothing else changes).
   * Entries keyed `chainId:address` without a mode come from before the paper/live split: migrated on load.
   */
  generated?: Record<string, GenLedger>;
  /** Live buys sent whose receipt had not come when the executor stopped waiting: settled by hash on later ticks. */
  inflight?: InflightBuy[];
  /** When each mode's first buy happened: age and the estimates (the trade log is trimmed). Set at load for older files. */
  startedAt?: Partial<Record<TradeMode, number>>;
}

export type OffMode = 'exits' | 'full';
/** on: everything runs. exits: off for new buys, exits running. full: off completely, nothing runs. */
export type RunMode = 'on' | OffMode;
const MODE_LOG_MAX = 50;

export interface LiveFill { tokens: number; spent: number; spentUsd: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number; /** Approve + swap + L1, native units. Absent when there is no receipt. */ gasNative?: number }
export interface LiveSell { quoteOut: number; tokensIn: number; price: number; impact: number; tx?: string; gasUsed?: number; gasPriceWei?: number; /** Approve + swap + L1, native units. Absent when there is no receipt. */ gasNative?: number }

/**
 * A live swap that was sent but whose receipt had not come when the executor stopped waiting (the broker throws this
 * instead of the executor's 'not confirmed yet'). The trader keeps the hash and settles it later; it is never dropped.
 */
export class SwapPending extends Error {
  constructor(readonly hash: string, readonly tokenOut: string, readonly decimalsOut: number, readonly amountIn: number, readonly gasNative: number) {
    super(`swap ${hash} sent; waiting for its receipt`);
  }
}
/** A settled swap by hash: null = not mined yet. ok false = reverted (its gas still paid). amountOut null = mined but unreadable. */
export interface Recovered { ok: boolean; amountOut: number | null; gasNative: number }
export interface InflightBuy {
  hash: string; chainId: number; tokenOut: string; decimalsOut: number; spend: number; sentAt: number;
  pool: FreshPool; source: 'scan' | 'snipe'; buyTax: number; sellTax: number; impact: number; why: string;
  warn: string | null; note: string | null;
}
export interface PendingSell { hash: string; tokenOut: string; decimalsOut: number; tokens: number; sentAt: number; first: boolean }

const genOf = (p: Position): PositionGen => p.gen ?? (p.gen = { feeBooked: 0, costSold: 0, proceeds: 0, fees: 0, taxes: 0, gasNative: 0 });
/** Gas a failed send still paid (ExecError opts), else 0 */
const gasOfError = (e: unknown): number => { const g = (e as { opts?: { gasNative?: number } } | null)?.opts?.gasNative; return typeof g === 'number' && g > 0 ? g : 0; };

const HOUR = 3600_000;
/** Prices kept per open position for its chart: 6 h of 10 s ticks would be 2,160; one in 3 of the newest is plenty */
export const MARKS_KEPT = 240;
/** A buy the pool can take only below this share of the per-trade amount is skipped (dust) */
export const MIN_BUY_SHARE = 0.1;
const num = (n: number) => +n.toPrecision(6);
const FEED_MAX = 80;
const TRADE_MAX = 200;

export const DEFAULT_TRADER: TraderOptions = {
  mode: 'paper', perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC,
  minLiquidityUsd: DEFAULT_MIN_LIQUIDITY_USD, enforceLiquidityFloor: false,
  chains: [], risk: 'safe', maxImpact: 0.03, maxPoolShare: TOKEN_MAX_POOL_SHARE, enforceWashAndAge: false, enforceOwnerPowers: false,
  v3LpLockCheck: false,
  v3LpLockCacheEnabled: false,
  v3LpLockCacheTtlMs: 10 * 60_000,
  v3LpLockCallBudget: 0,
  lpUnlockCheck: false,
  enforceHolderCheck: false, maxHolderShare: DEFAULT_MAX_HOLDER_SHARE, maxTop10Share: DEFAULT_MAX_TOP10_SHARE,
  minHolderCoverage: DEFAULT_MIN_HOLDER_COVERAGE,
  enforceSizeImpact: false, sizeImpactCap: DEFAULT_SIZE_IMPACT_CAP,
  venues: {},
  sniper: { on: false, minLiquidityUsd: DEFAULT_SNIPER_MIN_LIQ_USD, delayBlocks: 2, delaySec: 15, maxPerHour: 3, mevRpc: null },
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
  /** The last discovery run: when, and how many pools it found (the page's radar sweeps between runs) */
  private lastLook: { at: number; found: number } | null = null;

  constructor(private readonly d: {
    store: Store<TraderState>;
    now?: () => number;
    emit?: Emit;
    /** Scan discovery (new + trending pools). null = not due yet (no run). Sniper hits are separate. */
    discover?: () => Promise<FreshPool[] | null>;
    /** How often discovery runs (tokenFeed.discoverEveryMs for the chains it reads) */
    lookEveryMs?: () => number;
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
    /**
     * The pool as it is now (price, depth), read on-chain through the market the safety check built. Every buy is sized
     * from it, paper and live: GeckoTerminal's figures are only what found the pool (2026-10-30: a paper buy priced at
     * GeckoTerminal's 2.4e-16 met an on-chain 1.0e-14 on its first mark and booked a +4079% take profit, twice).
     */
    poolNow?: (pool: FreshPool) => Promise<{ price: number; quoteReserve: number; tokenReserve: number }>;
    /** What spending `spend` on the pool brings now (tokens after the token's buy tax) and its price impact, quoted on-chain */
    quoteBuy?: (pool: FreshPool, spend: number) => Promise<{ tokens: number; impact: number }>;
    /** Latest price, depth, volume, tax, sell simulation. Paper tests can omit this and call mark(). */
    mark?: (p: Position) => Promise<Partial<Position> | null>;
    live?: {
      buy(pool: FreshPool, spend: number, limits: SafetyLimits): Promise<LiveFill>;
      sell(p: Position, tokens: number, limits: SafetyLimits): Promise<LiveSell>;
      /** A swap sent earlier, by hash (SwapPending): null = not mined yet */
      recover(chainId: number, hash: string, tokenOut: string, decimalsOut: number): Promise<Recovered | null>;
    };
    /** The chains this app can trade on, and whether each has a signing key (a live turn-on checks the ones it trades). */
    liveChains?: () => { id: number; name: string; signer: boolean }[];
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
    /**
     * Owner / proxy-admin / setter scan. Called only when enforceOwnerPowers is on.
     * A throw, or a missing callback while the flag is on, is unverified.
     */
    ownerPowers?: (pool: FreshPool) => Promise<OwnerReport>;
    /**
     * For Generated only: whether a spend coin is the chain's own coin (or its wrapped form), and that coin's symbol.
     * Missing = not native (gas is reported apart, never price-converted).
     */
    coinInfo?: (chainId: number, spend: string) => { native: boolean; nativeSymbol: string } | null;
    /**
     * Optional volume and age read. Called only when enforceWashAndAge is on.
     * Production does not set this: the gate uses the pool row it already has. A throw is unverified.
     */
    poolFacts?: (pool: FreshPool) => Promise<{ createdAt: number | null; volumeUsd: number; liquidityUsd: number }>;
    /** Rejected candidates. Omitted in tests that only need the in-memory window. */
    rejects?: RejectSink;
  }) {
    const loaded = d.store.load();
    this.rejects = d.rejects ?? new MemoryRejects();
    this.state = loaded?.version === 1 ? { ...fresh(), ...loaded, options: { ...DEFAULT_TRADER, ...loaded.options, sniper: { ...DEFAULT_TRADER.sniper, ...loaded.options?.sniper } }, plays: Array.isArray(loaded.plays) ? loaded.plays : [] } : fresh();
    this.spillRejects();
    this.migrateEntries();
    this.migrateLedgerModes();
    this.migrateCounts();
    this.migrateOffMode(loaded);
  }

  /**
   * Ledgers saved before paper and live were kept apart (no `mode`, keyed chainId:coin) may hold both. Split each:
   *  1. Open positions carry their own exact share (p.gen) and their mode (p.mode, fixed at the buy): that share goes
   *     to the position's mode. This part is recorded, not guessed.
   *  2. The rest (positions already closed, and gas of failed buys) has no recorded mode. Gas is paid only by live
   *     sends (paper books none), so a rest that paid gas is live; otherwise paper. A live rest whose broker reported no
   *     gas cannot be told from paper and stays paper (the safe side: nothing is shown as live money without
   *     evidence). Entries built from the rest are flagged modeInferred.
   * The closed-sell count is not kept per position: it stays with the rest, or with the open positions' mode when the
   * rest is empty and only one mode sold. Nothing is added or lost: per field, the split entries sum to the old one.
   */
  private migrateLedgerModes() {
    const g = this.state.generated;
    if (!g) return;
    const old = Object.entries(g).filter(([, l]) => l.mode !== 'paper' && l.mode !== 'live');
    if (!old.length) return;
    const fields = ['proceeds', 'cost', 'fees', 'taxes', 'gasNative'] as const;
    const into = (mode: TradeMode, src: GenLedger, add: Record<(typeof fields)[number], number>, closed: number, inferred: boolean) => {
      const k = genKey(mode, src.chainId, src.coin);
      const t = g[k] ?? (g[k] = { mode, chainId: src.chainId, coin: src.coin.toLowerCase(), symbol: src.symbol, proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0, closed: 0, fills: 0 });
      for (const f of fields) t[f] += add[f];
      t.closed += closed;
      if (inferred) t.modeInferred = true;
    };
    const lines: string[] = [];
    for (const [key, l] of old) {
      delete g[key];
      const coin = l.coin.toLowerCase();
      const rest = { proceeds: l.proceeds, cost: l.cost, fees: l.fees, taxes: l.taxes, gasNative: l.gasNative };
      const share: Record<TradeMode, typeof rest> = {
        paper: { proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0 },
        live: { proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0 },
      };
      for (const p of this.state.positions) {
        if (!p.gen || p.chainId !== l.chainId || p.spend.toLowerCase() !== coin) continue;
        const m: TradeMode = p.mode === 'live' ? 'live' : 'paper';
        const x = { proceeds: p.gen.proceeds, cost: p.gen.costSold + p.gen.feeBooked, fees: p.gen.fees + p.gen.feeBooked, taxes: p.gen.taxes, gasNative: p.gen.gasNative };
        for (const f of fields) { share[m][f] += x[f]; rest[f] -= x[f]; }
      }
      // float residue of the subtraction (or a position share above the entry: never negative)
      for (const f of fields) if (Math.abs(rest[f]) <= 1e-12 * Math.max(1, Math.abs(l[f]))) rest[f] = 0;
      const restEmpty = fields.every((f) => rest[f] === 0);
      const restMode: TradeMode = rest.gasNative > 0 ? 'live' : 'paper';
      const has = (m: TradeMode) => fields.some((f) => share[m][f] !== 0);
      // the rest is kept as its own (inferred) part when it holds anything, or when no open position had a share
      const keepRest = !restEmpty || (!has('paper') && !has('live'));
      const sold = (['paper', 'live'] as const).filter((m) => share[m].proceeds > 0);
      const closedTo: TradeMode = keepRest ? restMode : sold.length === 1 ? sold[0] : restMode;
      const zero = { proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0 };
      for (const m of ['paper', 'live'] as const) if (has(m)) into(m, l, share[m], !keepRest && closedTo === m ? l.closed : 0, false);
      if (keepRest) into(restMode, l, rest, l.closed, !restEmpty);
      else if (l.closed && !has(closedTo)) into(closedTo, l, zero, l.closed, true);
      lines.push(`${l.symbol} on chain ${l.chainId}: ${restEmpty ? 'open positions only' : `the rest as ${restMode}${restMode === 'live' ? ' (it paid gas)' : ' (no gas paid)'}`}`);
    }
    this.save();
    this.say(`Token trader: Generated now keeps paper and live apart; ${old.length} older entr${old.length === 1 ? 'y' : 'ies'} split (${lines.join('; ')})`);
  }

  /**
   * Files from before the start time and fill count were kept: both are set once, from what the screens showed (the
   * oldest row the trade log still has, and its rows per chain and spend coin), and kept from then on. Before this the
   * log carried no mode, so its rows count for the mode the trader is in now; the other mode starts at its oldest open
   * position.
   */
  private migrateCounts() {
    const s = this.state, now = s.options.mode === 'live' ? 'live' : 'paper';
    let changed = false;
    if (!s.startedAt) {
      s.startedAt = {};
      for (const m of ['paper', 'live'] as const) {
        const ts = [...s.positions.filter((p) => p.mode === m).map((p) => p.openedAt), ...(m === now ? s.trades.map((r) => r.t) : [])].filter((t) => t > 0);
        if (ts.length) s.startedAt[m] = Math.min(...ts);
      }
      changed = true;
    }
    for (const l of Object.values(s.generated ?? {})) {
      if (typeof l.fills === 'number') continue;
      l.fills = l.mode === now ? s.trades.filter((r) => r.chainId === l.chainId && r.spendSym === l.symbol).length : 0;
      changed = true;
    }
    if (changed) this.save();
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
  private say(msg: string, level: 'info' | 'warn' | 'success' = 'info', extra?: { notify?: boolean; data?: Record<string, unknown>; mode?: 'paper' | 'live' }) {
    const { mode, ...rest } = extra ?? {};
    this.d.emit?.({ type: 'info', kind: 'system', level, msg, ...rest, ...(mode ? { mode } : {}) });
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
    for (const b of this.state.inflight ?? []) out.push({ chainId: b.chainId, address: b.pool.spend, native: native(b.pool.spend), amount: b.spend, source: 'token-trader' });
    return out;
  }

  status() {
    const openUsd = this.openUsd();
    const { plays, ...rest } = this.state;
    void plays;
    const positions = rest.positions.map((p) => {
      const pnlUsd = this.pnl(p);
      const cost = p.spentUsd * (p.entryTokens > 0 ? p.tokens / p.entryTokens : 0);
      // the same open result in the spend coin (display only)
      const pnl = p.usdPerSpend > 0 ? pnlUsd / p.usdPerSpend : null;
      const share = p.entryTokens > 0 ? p.tokens / p.entryTokens : 0;
      return {
        ...p, pnlUsd, pnl, spendSym: this.spendSymbol(p), tokenSym: p.label.split('/')[0].trim(), pnlPct: cost > 0 ? pnlUsd / cost : null, exitPlan: this.plan(p),
        /** What it is worth now in its spend coin (what it cost, plus its open result) */
        value: pnl == null ? null : p.spent * share + pnl,
        exits: exitTargets(this.exitOf(p)),
      };
    });
    const out = {
      ...rest, id: 'token-trader', kind: 'token' as const,
      openUsd,
      /** Liquidity floor scan buys and the gate actually use (the setting, raised to $50,000 when that flag is on). */
      effectiveMinLiquidityUsd: this.floorUsd(),
      lastError: this.lastError,
      /** Discovery: the last run and how often it runs */
      look: { last: this.lastLook, everyMs: this.d.lookEveryMs?.() ?? null },
      entriesHalt: this.state.entriesHalt ?? null,
      lastHalt: this.state.lastHalt ?? null,
      /** Open positions whose exits (stops, take-profits) are still managed, also while new buys are stopped */
      exitsManaged: this.watched().length,
      runMode: this.runMode(),
      offMode: this.state.offMode ?? 'exits',
      modeLog: this.state.modeLog ?? [],
      pendingChoice: this.state.pendingChoice ?? null,
      positions: positions.map((p) => ({ ...p, exitsBlocked: this.blocked(p), generated: this.posGenerated(p) })),
      /** Live positions whose exits are blocked until the wallet balance can be read (lasting, until reconciled) */
      exitsBlocked: this.state.positions.filter((p) => this.blocked(p)).length,
      /** Generated per mode and spend coin (closed sells, less buy fees and gas paid); see types/generated.ts */
      generated: this.generated(),
    };
    return { ...out, metrics: tokenMetrics(out, Date.now()), spendTotals: tokenSpendTotals(out) };
  }

  /** Passed plays. Not trimmed, and not part of `status()`. */
  plays(): PlayRecord[] { return this.state.plays; }

  /** Recent rejects kept in memory. At most 500. The scorecard reads the log, not this window. */
  recentRejects(): readonly PlayRecord[] { return this.rejects.window(); }

  /** Leaderboard. Reads the reject log here, never from tick(). */
  scorecard() { return playLeaderboard([...this.state.plays, ...this.rejects.read()]); }

  // ── Generated (coins, no USD): bookkeeping only, read by nothing that trades ──
  /** The ledger of one mode (paper or live, never both) and spend coin */
  private ledger(mode: TradeMode, chainId: number, coin: string, symbol: string): GenLedger {
    const g = this.state.generated ?? (this.state.generated = {});
    const k = genKey(mode, chainId, coin);
    return g[k] ?? (g[k] = { mode, chainId, coin: coin.toLowerCase(), symbol, proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0, closed: 0, fills: 0 });
  }
  /** The spend coin's symbol. Labels saved before 2026-10-30 can carry the pool's fee tier ("WETH 0.3%"): first word only. */
  private spendSymbol(p: Pick<Position, 'label' | 'spend'>) { return p.label.split('/')[1]?.trim().split(/\s+/)[0] || p.spend; }
  private view(coin: { chainId: number; coin: string; symbol: string }, x: Omit<GenLedger, 'chainId' | 'coin' | 'symbol'>): Generated {
    const info = this.d.coinInfo?.(coin.chainId, coin.coin) ?? null;
    const gasInAmount = !!info?.native;
    return {
      coin: { chainId: coin.chainId, address: coin.coin, symbol: coin.symbol, native: gasInAmount },
      amount: x.proceeds - x.cost - (gasInAmount ? x.gasNative : 0),
      proceeds: x.proceeds, cost: x.cost, fees: x.fees, taxes: x.taxes,
      gasNative: x.gasNative, gasSymbol: info?.nativeSymbol ?? null, gasInAmount, closed: x.closed, fills: x.fills, basis: 'closed',
      mode: x.mode, ...(x.modeInferred ? { modeInferred: true } : {}), ...(x.unpriced ? { unpriced: x.unpriced } : {}),
    };
  }
  /** Per mode and spend coin (paper and live apart), every position since this was added (closed ones included) */
  generated(): Generated[] {
    return Object.values(this.state.generated ?? {}).map((l) => this.view(l, l));
  }
  /** One position: its sells so far, less its buy fee and gas (its unsold tokens count nothing: no mark to market) */
  private posGenerated(p: Position): Generated {
    const g = p.gen ?? { feeBooked: 0, costSold: 0, proceeds: 0, fees: 0, taxes: 0, gasNative: 0 };
    return this.view({ chainId: p.chainId, coin: p.spend, symbol: this.spendSymbol(p) }, {
      mode: p.mode, proceeds: g.proceeds, cost: g.costSold + g.feeBooked, fees: g.fees + g.feeBooked, taxes: g.taxes, gasNative: g.gasNative, closed: 0, fills: 0, unpriced: g.unpriced,
    });
  }
  /** A buy: its pool fee (paid in the spend coin) and its gas are booked now; the rest of what it spent is cost when sold */
  private bookBuy(p: Position, gasNative: number) {
    const g = genOf(p), l = this.ledger(p.mode, p.chainId, p.spend, this.spendSymbol(p));
    const fee = p.spent * (p.feeBps / 10_000);
    g.feeBooked = fee; g.gasNative += gasNative;
    l.cost += fee; l.fees += fee; l.gasNative += gasNative; l.fills++;
  }
  /**
   * A sell of `sold` tokens that brought `quote` spend coins (actual: after fee, tax and impact). Live: called once per
   * landed part of a split sell; `countClose` counts the exit as one closed sell (its first landed part only).
   */
  private bookSell(p: Position, sold: number, quote: number, gasNative: number, countClose: boolean) {
    const g = genOf(p), l = this.ledger(p.mode, p.chainId, p.spend, this.spendSymbol(p));
    const basis = p.entryTokens > 0 ? (p.spent - g.feeBooked) * (sold / p.entryTokens) : 0;
    // For reference (already inside `quote`): the pool fee and the sell tax that came off it
    const f = p.feeBps / 10_000, t = Math.max(0, Math.min(p.sellTax, 0.99));
    const gross = quote / ((1 - f) * (1 - t));
    const fee = gross * (1 - t) * f, tax = gross * t;
    g.costSold += basis; g.proceeds += quote; g.fees += fee; g.taxes += tax; g.gasNative += gasNative;
    l.cost += basis; l.proceeds += quote; l.fees += fee; l.taxes += tax; l.gasNative += gasNative; l.fills++; if (countClose) l.closed++;
  }
  /** Tokens left the wallet without a known fill (see reconcile): counted, not priced */
  private bookUnpriced(p: Position) {
    const g = genOf(p), l = this.ledger(p.mode, p.chainId, p.spend, this.spendSymbol(p));
    g.unpriced = (g.unpriced ?? 0) + 1;
    l.unpriced = (l.unpriced ?? 0) + 1;
  }
  /** Gas a failed send paid (nothing else changed hands) */
  private bookGas(mode: TradeMode, chainId: number, spend: string, symbol: string, gasNative: number, p?: Position) {
    if (!(gasNative > 0)) return;
    this.ledger(p?.mode ?? mode, chainId, spend, symbol).gasNative += gasNative;
    if (p) genOf(p).gasNative += gasNative;
  }

  configure(o: Partial<TraderOptions> & { sniper?: Partial<SniperOptions> }) {
    const n = { ...this.state.options, ...o, sniper: { ...this.state.options.sniper, ...(o.sniper ?? {}) } };
    if ('v3LpLockCheck' in o) n.v3LpLockCheck = o.v3LpLockCheck === true;
    if ('v3LpLockCacheEnabled' in o) n.v3LpLockCacheEnabled = o.v3LpLockCacheEnabled === true;
    if ('v3LpLockCallBudget' in o) {
      const b = Number(o.v3LpLockCallBudget);
      n.v3LpLockCallBudget = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
    }
    if ('v3LpLockCacheTtlMs' in o) {
      const t = Number(o.v3LpLockCacheTtlMs);
      n.v3LpLockCacheTtlMs = Number.isFinite(t) && t > 0 ? Math.floor(t) : 10 * 60_000;
    }
    if ('lpUnlockCheck' in o) n.lpUnlockCheck = o.lpUnlockCheck === true;
    if (!(n.perTradeUsd > 0) || !(n.totalUsd > 0)) throw new Error('Per-trade and total limits must be above 0.');
    if (n.perTradeUsd > n.totalUsd) throw new Error('Per-trade limit is above the total limit.');
    if (!(n.minPoolAgeSec >= 0)) throw new Error('Minimum pool age must be 0 or more seconds.');
    if (!(n.minLiquidityUsd >= 0)) throw new Error('Minimum liquidity must be 0 or more.');
    if (typeof n.enforceLiquidityFloor !== 'boolean') throw new Error('Liquidity floor flag must be on or off.');
    if (!(n.maxImpact > 0) || n.maxImpact > HARD_CAPS.maxPriceImpact) throw new Error('Price-impact cap must be between 0% and 5%.');
    if (!(n.sizeImpactCap > 0) || n.sizeImpactCap > HARD_CAPS.maxPriceImpact) throw new Error('Trade-size impact cap must be between 0% and 5%.');
    if (!(n.maxPoolShare > 0) || n.maxPoolShare > 0.5) throw new Error('Max pool share must be between 0% and 50%.');
    n.maxHolderShare = clampHolderShare(n.maxHolderShare, DEFAULT_MAX_HOLDER_SHARE);
    n.maxTop10Share = clampHolderShare(n.maxTop10Share, DEFAULT_MAX_TOP10_SHARE);
    n.minHolderCoverage = clampHolderCoverage(n.minHolderCoverage);
    if (n.sniper.mevRpc && !/^https:\/\//.test(n.sniper.mevRpc)) throw new Error('MEV URL must be an https RPC.');
    if ('venues' in o) {
      const v = o.venues;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Venues must be a list of on/off switches.');
      for (const [id, on] of Object.entries(v)) {
        if (!VENUES.some((x) => x.id === id)) throw new Error(`Unknown venue ${id}.`);
        if (typeof on !== 'boolean') throw new Error(`Venue ${id} must be on or off.`);
      }
      n.venues = { ...this.state.options.venues, ...v };
    }
    this.state.options = n;
    this.save();
  }

  turnOn() {
    const o = this.state.options;
    if (o.mode === 'live') {
      if (!this.d.live) throw new Error('Live trading is not wired on this server.');
      // every chain it would trade, "every chain" (no list) included
      const keyless = (this.d.liveChains?.() ?? []).filter((c) => this.wants(c.id) && !c.signer).map((c) => c.name);
      if (keyless.length) throw new Error(`Live needs a signing key on every chain it trades; there is none on ${keyless.join(', ')}. Pick only chains with a key, or add one.`);
    }
    this.state.on = true;
    this.state.pendingChoice = null;
    this.logMode('on', requestHalt('token-trader-on', 'POST /api/token-trader/on', this.now()));
    const ageH = Math.round(o.minPoolAgeSec / 3600);
    const ageNote = o.enforceWashAndAge
      ? `pools at least ${ageH}h old, safe/medium skip an unknown age or wash volume; snipes skip only wash volume`
      : 'pools of any age (the wash and pool age check is off)';
    this.say(`token trader on (${o.mode}): up to ${usdAsEth(o.perTradeUsd)} a trade, ${usdAsEth(o.totalUsd)} open, ${ageNote}`);
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
  /**
   * Sell now, by hand: the whole position sells on the next exit pass, through the same sell path (split under the impact
   * cap, booked like every exit). The request stays until it is sold, so a sell that stops partway goes again.
   */
  sellNow(id: string) {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) throw new Error('No open position with that id: it may have just sold.');
    if (!this.canSell()) throw new Error('The token trader is off completely, so nothing sells. Turn it on, or to "Off for new buys", first.');
    p.sellNow = this.now();
    this.say(`${p.label}: Sell now asked by hand; it sells on the next exit pass`, 'info', { mode: p.mode });
    this.save();
  }

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

  /**
   * on: snipes, exits, discovery. Off for new buys: exits only. Off completely: nothing. Every step re-reads the mode,
   * so an off (either kind) that lands while a tick is awaiting wins for the rest of that tick.
   */
  async tick() {
    if (!this.canSell() || this.exitBusy) return;
    this.exitBusy = true;
    let exitsOk = true;
    try {
      // cleared first: a sell that stopped partway sets it inside exits() and must stay visible
      this.lastError = null;
      if (this.state.inflight?.length) await this.settleInflight();
      await this.exits();
    } catch (e) {
      this.lastError = (e as Error).message;
      exitsOk = false;
    } finally {
      this.save();
      this.exitBusy = false;
    }
    // Buys, including LP checks, never share this lock. A tick that arrives while they run still exits.
    // Off (either kind), or turned off while the exits were awaited: no snipes or new entries this tick.
    if (!exitsOk || this.entryTask || !this.state.on) return;
    let task!: Promise<void>;
    task = this.runEntries().finally(() => { if (this.entryTask === task) this.entryTask = null; });
    this.entryTask = task;
    await task;
  }

  /** Snipes and the entry scan. LP reads happen in here, on the buy path only. */
  private async runEntries() {
    try {
      if (this.state.on) await this.takeSnipes();
      // Turned off while the snipes were awaited: no new entries this tick.
      if (this.state.on) await this.scanEntries();
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.save();
    }
  }

  private openUsd() {
    const held = this.state.positions.reduce((s, p) => s + p.spentUsd * (p.entryTokens > 0 ? p.tokens / p.entryTokens : 0), 0);
    return held + (this.state.inflight ?? []).reduce((s, b) => s + b.spend * b.pool.usdPerSpend, 0);
  }

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

  /** Configured minimum, or $50,000 when that flag is on. Does not include the sniper's own minimum. */
  private floorUsd() { return effectiveMinLiquidityUsd(this.state.options); }

  /** Gate floor for this pool: the floor in force, the sniper minimum on a snipe, and any higher floor assess reported. A reported 0 does not win. */
  private gateFloor(pool: FreshPool, reported: number | null | undefined) {
    const o = this.state.options;
    return gateMinLiquidityUsd(pool, reported, {
      minLiquidityUsd: o.minLiquidityUsd, enforceLiquidityFloor: o.enforceLiquidityFloor, sniperMinLiquidityUsd: o.sniper.minLiquidityUsd,
    });
  }

  /** A chain the trader is set to trade ("Where": an empty list means every chain). Discovery and the sniper read only these. */
  wants(id: number) {
    const c = this.state.options.chains;
    return !c.length || c.includes(id);
  }

  private feed(item: FeedItem & { stage: FunnelStage }) {
    this.state.feed.unshift(item);
    if (this.state.feed.length > FEED_MAX) this.state.feed.length = FEED_MAX;
    const f = this.funnelToday();
    if (item.verdict === 'bought') f.bought++;
    else f[item.stage]++;
  }
  /** Today's counts, started fresh on a new local day */
  private funnelToday(): FunnelCounts {
    const day = new Date(this.now()).toDateString();
    if (this.state.funnel?.day !== day) this.state.funnel = { day, scouted: 0, rules: 0, checks: 0, buy: 0, bought: 0 };
    return this.state.funnel;
  }

  private async assess(pool: FreshPool): Promise<{ ok: boolean; reason: string | null; buyTax: number; sellTax: number; gate: GateInput | null; warn: string | null; note: string | null }> {
    if (!this.d.assess) return { ok: false, reason: 'no safety check', buyTax: 0, sellTax: 0, gate: null, warn: null, note: null };
    // A check that throws (pool not found, a V4 log scan the RPC refused) skips this pool only. The scan checks its pools
    // together, so one throw used to end the whole round.
    let g: GateInput;
    try { g = await this.d.assess(pool, this.state.options.mode, this.state.options.risk); }
    catch (e) { return { ok: false, reason: `safety check failed: ${(e as Error).message}`, buyTax: 0, sellTax: 0, gate: null, warn: null, note: null }; }
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
    if (this.state.options.enforceWashAndAge) {
      let volumeUsd = pool.volumeUsd;
      let liquidityUsd = pool.liquidityUsd;
      let createdAt = pool.createdAt;
      let freshnessUnverified = false;
      if (this.d.poolFacts) {
        try {
          const f = await this.d.poolFacts(pool);
          volumeUsd = f.volumeUsd;
          liquidityUsd = f.liquidityUsd;
          createdAt = f.createdAt;
        } catch {
          freshnessUnverified = true;
        }
      }
      gate.enforceWashAndAge = true;
      gate.freshnessUnverified = freshnessUnverified;
      gate.volumeUsd = volumeUsd;
      gate.liquidityUsd = liquidityUsd;
      gate.poolAgeSec = createdAt == null ? null : Math.max(0, (this.now() - createdAt) / 1000);
      // A snipe is a just-created pool with no age by design ("a snipe ignores the age"): the age leg would block
      // every snipe at safe/medium, so snipes get only the wash-volume leg.
      gate.gateMinPoolAgeSec = pool.source === 'snipe' ? 0 : this.state.options.minPoolAgeSec;
    }
    let note: string | null = null;
    if (this.state.options.enforceOwnerPowers) {
      let report: OwnerReport;
      try {
        report = this.d.ownerPowers ? await this.d.ownerPowers(pool) : unverifiedOwnerReport('owner powers could not be verified');
      } catch {
        report = unverifiedOwnerReport('owner powers could not be verified');
      }
      gate.enforceOwnerPowers = true;
      gate.ownerPowersUnverified = report.unverified;
      gate.ownerPowersWhy = report.why;
      note = report.note;
    }
    const r = gateToken(gate);
    return { ok: r.ok, reason: r.reason, buyTax: g.buyTax ?? 0, sellTax: g.sellTax ?? 0, gate, warn: r.warn ?? null, note: r.ok ? note : null };
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

  private async buy(pool: FreshPool, source: 'scan' | 'snipe', buyTax: number, sellTax: number, gate: GateInput, warn: string | null, note: string | null) {
    const o = this.state.options;
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    const skip = (why: string) => {
      this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why, stage: 'buy' });
      this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: signalOf(pool.source), source: pool.dex, reason: why, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol });
    };
    const same = (x: { pool: string; chainId: number }) => x.pool.toLowerCase() === pool.pool.toLowerCase() && x.chainId === pool.chainId;
    if (this.state.positions.some(same) || (this.state.inflight ?? []).some((b) => same(b.pool))) return;
    // Checked again after the safety check's awaits: a Stop all that landed meanwhile wins.
    if (!this.canBuy(pool.chainId)) { skip('new buys are stopped'); return; }
    if (pool.dynamicFee) {
      // the fee at quote time: it may have moved since discovery
      const fee = this.d.feeNow ? await this.d.feeNow(pool).catch(() => null) : null;
      if (fee == null) { skip("could not read the pool's current fee"); return; }
      pool = { ...pool, feeBps: fee };
    }
    // Its own reason: a full "Total open" read as "too thin" (2026-10-30: a paper run filled $500 on Robinhood, then
    // skipped all 10 Base pools, deep ones included, as "size is under the limits or the pool is too thin")
    if (this.d.poolNow) {
      let now: { price: number; quoteReserve: number; tokenReserve: number };
      try { now = await this.d.poolNow(pool); } catch (e) { skip(`could not read the pool now (${(e as Error).message.slice(0, 120)})`); return; }
      pool = { ...pool, ...now };
    }
    const openUsd = this.openUsd();
    if (!(o.totalUsd - openUsd > 0)) { skip(`Total open is used up (${usdAsEth(openUsd)} open of ${usdAsEth(o.totalUsd)}); buys start again as positions close`); return; }
    const sized = sizeBuy({
      perTradeUsd: o.perTradeUsd, totalUsd: o.totalUsd, openUsd,
      quoteReserve: pool.quoteReserve, usdPerSpend: pool.usdPerSpend, feeBps: pool.feeBps,
      buyTax, price: pool.price, maxImpact: o.maxImpact, maxPoolShare: o.maxPoolShare || TOKEN_MAX_POOL_SHARE,
    });
    if (!sized) { skip('the pool is too thin for a buy within the impact cap, or its price is unknown'); return; }
    // A pool that takes only a sliver of the per-trade amount is skipped: such a position can't pay its own exit
    if (sized.usd < o.perTradeUsd * MIN_BUY_SHARE) { skip(`the pool takes only ${usdAsEth(sized.usd)} within the impact cap, under ${MIN_BUY_SHARE * 100}% of the ${usdAsEth(o.perTradeUsd)} per trade`); return; }
    let recordedImpact = sized.impact, quotedTokens: number | null = null;
    if (this.d.quoteBuy) {
      let q: { tokens: number; impact: number };
      try { q = await this.d.quoteBuy(pool, sized.spend); } catch (e) { skip(`could not quote this buy on the pool (${(e as Error).message.slice(0, 120)})`); return; }
      if (!(q.tokens > 0)) { skip('the pool quotes no tokens for this buy'); return; }
      quotedTokens = q.tokens;
      if (Number.isFinite(q.impact)) recordedImpact = q.impact;
    }
    if (o.enforceSizeImpact) {
      const again = gateToken({ ...gate, enforceSizeImpact: true, sizeImpact: quotedTokens != null ? recordedImpact : null, sizeImpactCap: o.sizeImpactCap });
      if (!again.ok) { skip(again.reason ?? 'price impact'); return; }
    }
    const ctx = { pool, source, buyTax, sellTax, impact: recordedImpact, why: sized.why, warn, note };
    if (o.mode !== 'live') {
      // paper fills at the pool's own quote, as a live buy would
      this.opened(ctx, 'paper', { tokens: quotedTokens ?? sized.tokens, spent: sized.spend, spentUsd: sized.usd, tx: null, gasUsed: null, gasPrice: null, gasNative: null });
      return;
    }
    if (!this.d.live) throw new Error('live broker missing');
    // #59: reserve the spend before the send so other bots can't use it; released on success or failure.
    // #76: gas a failed send still paid is booked once (catch), a filled buy's gas once (bookBuy).
    this.pendingBuy = { chainId: pool.chainId, address: pool.spend, amount: sized.spend };
    let fill: LiveFill;
    try {
      fill = await this.d.live.buy({ ...pool }, sized.spend, this.limits());
    } catch (e) {
      if (e instanceof SwapPending) {
        // sent, receipt not in yet: kept by hash (and its spend stays reserved) until a later tick settles it
        this.bookGas('live', pool.chainId, pool.spend, pool.spendSymbol, e.gasNative);
        (this.state.inflight ??= []).push({ ...ctx, hash: e.hash, chainId: pool.chainId, tokenOut: e.tokenOut, decimalsOut: e.decimalsOut, spend: e.amountIn, sentAt: this.now() });
        this.save();
        this.say(`${label}: buy ${e.hash} sent; its receipt has not come yet, so it is settled by hash on the next ticks`, 'warn', { mode: 'live' });
        return;
      }
      this.bookGas(o.mode, pool.chainId, pool.spend, pool.spendSymbol, gasOfError(e));
      throw e;
    } finally {
      this.pendingBuy = null;
    }
    this.opened(ctx, 'live', {
      tokens: fill.tokens, spent: fill.spent, spentUsd: fill.spentUsd, tx: fill.tx ?? null,
      gasUsed: fill.gasUsed != null && fill.gasPriceWei != null ? fill.gasUsed : null,
      gasPrice: fill.gasUsed != null && fill.gasPriceWei != null ? fill.gasPriceWei : null,
      gasNative: typeof fill.gasNative === 'number' && Number.isFinite(fill.gasNative) ? fill.gasNative : null,
    });
  }

  /** A buy that filled (at once, or settled later by hash): the position, its booking, the trade log and the play. */
  private opened(
    c: { pool: FreshPool; source: 'scan' | 'snipe'; buyTax: number; sellTax: number; impact: number; why: string; warn: string | null; note: string | null },
    mode: TradeMode,
    f: { tokens: number; spent: number; spentUsd: number; tx: string | null; gasUsed: number | null; gasPrice: number | null; gasNative: number | null },
  ) {
    const { pool, source, buyTax, sellTax } = c;
    const { tokens, spent, spentUsd } = f;
    // One formula for paper and live: what was spent over what arrived (fee, impact, slippage and buy tax in).
    // A fill that reports no tokens (shouldn't happen) still gets booked, at the mid, never dropped.
    const eff = effectiveEntry(spent, tokens);
    const entry = eff > 0 ? eff : pool.price;
    if (!(eff > 0)) this.say(`${pool.tokenSymbol}: buy reported ${tokens} tokens for ${spent}; entry set to the pool mid`, 'warn');
    const price = pool.price;
    const pos: Position = {
      id: `tt-${this.now().toString(36)}-${pool.pool.slice(2, 6)}`, chainId: pool.chainId, pool: pool.pool, dex: pool.dex,
      label: `${pool.tokenSymbol}/${pool.spendSymbol}`, token: pool.token, spend: pool.spend, mode,
      entryPrice: entry, entryMid: pool.price, entryBasis: 'effective', price, peak: price, tokens, entryTokens: tokens, spent, spentUsd, openedAt: this.now(),
      entryVolume: pool.volumeUsd, volume: pool.volumeUsd, entryLiq: pool.liquidityUsd, liq: pool.liquidityUsd,
      entrySellTax: sellTax, sellTax, sellSimOk: true, feeBps: pool.feeBps, ...(pool.dynamicFee ? { dynamicFee: true } : {}), quoteReserve: pool.quoteReserve,
      tokenReserve: pool.tokenReserve, usdPerSpend: pool.usdPerSpend, buyTax, tp1Done: false, tp2Done: false, source, exitPlan: 'hold',
    };
    this.state.positions.push(pos);
    (this.state.startedAt ??= {})[mode] ??= this.now();
    this.bookBuy(pos, f.gasNative ?? 0);
    const extra = [c.warn, c.note].filter((s): s is string => !!s).join('; ');
    const why = extra ? `buy ${c.why}; ${extra}` : `buy ${c.why}`;
    this.state.trades.unshift({ t: this.now(), side: 'buy', mode, chainId: pool.chainId, pool: pool.pool, label: pos.label, usd: spentUsd, price: entry, why, pnlUsd: null, spendSym: pool.spendSymbol, amount: spent, pnl: null });
    this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label: pos.label, verdict: 'bought', why, stage: 'buy' });
    this.say(`bought ${pos.label} on ${pool.dex}: ${why}`, 'success', source === 'snipe' ? { notify: true, data: { push: 'sniper' }, mode } : { mode });
    this.rememberEntry(pos, pool, c.impact, f.tx, f.gasUsed, f.gasPrice, f.gasNative);
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
  }

  /**
   * Live buys sent earlier whose receipt had not come: filled ones open their position (from the receipt's token
   * amount), reverted ones book their gas, unmined ones wait. A mined buy whose token amount can't be read stays with
   * an error naming its hash (never guessed).
   */
  private async settleInflight() {
    const live = this.d.live;
    if (!live || !this.state.inflight?.length) return;
    const wait: InflightBuy[] = [];
    for (const b of this.state.inflight) {
      // a failed read is "not known yet": it waits (an RPC error never blocks the exits that follow)
      const r = await live.recover(b.chainId, b.hash, b.tokenOut, b.decimalsOut).catch(() => null);
      if (!r) { wait.push(b); continue; }
      const label = `${b.pool.tokenSymbol}/${b.pool.spendSymbol}`;
      if (!r.ok) {
        this.bookGas('live', b.chainId, b.pool.spend, b.pool.spendSymbol, r.gasNative);
        this.say(`${label}: buy ${b.hash} reverted; only its gas was spent`, 'warn', { mode: 'live' });
        continue;
      }
      if (r.amountOut == null) {
        wait.push(b);
        this.lastError = `${label}: buy ${b.hash} mined but the tokens it bought could not be read from its receipt; check it on the explorer`;
        continue;
      }
      this.opened(b, 'live', { tokens: r.amountOut, spent: b.spend, spentUsd: b.spend * b.pool.usdPerSpend, tx: b.hash, gasUsed: null, gasPrice: null, gasNative: r.gasNative });
    }
    this.state.inflight = wait;
  }

  private async consider(pool: FreshPool, source: 'scan' | 'snipe') {
    const label = `${pool.tokenSymbol}/${pool.spendSymbol}`;
    // Turned off since this tick started (POST /on runs a tick at once; discovery can take minutes): stop here,
    // before the safety check's reads. buy() checks canBuy() again after them.
    if (!this.state.on) return;
    const skip = (why: string, stage: FunnelStage) => {
      this.feed({ t: this.now(), chainId: pool.chainId, pool: pool.pool, label, verdict: 'skipped', why, stage });
      this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: signalOf(pool.source), source: pool.dex, reason: why, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol });
    };
    if (!this.wants(pool.chainId)) { skip('chain is off', 'rules'); return; }
    if (this.entriesStopped(pool.chainId)) { skip('new buys are stopped (Stop all)', 'rules'); return; }
    const a = await this.assess(pool);
    if (!a.ok || !a.gate) { skip(a.reason ?? 'safety', 'checks'); this.say(`skipped ${label}: ${a.reason}`, 'warn'); return; }
    await this.buy({ ...pool, source: source === 'snipe' ? 'snipe' : pool.source }, source, a.buyTax, a.sellTax, a.gate, a.warn, a.note);
  }

  private async scanEntries() {
    if (!this.d.discover) return;
    if (this.state.entriesHalt?.chains === null) return; // stopped everywhere: don't even look
    const pools = await this.d.discover();
    if (pools == null) return; // not due yet
    if (!this.state.on) return; // turned off while discovery was pending (2026-10-27: 4 paper buys ~3 min after off)
    const scanned = pools.filter((p) => p.source !== 'snipe');
    this.lastLook = { at: this.now(), found: scanned.length };
    this.funnelToday().scouted += scanned.length;
    // The minimum age is part of the "wash and pool age" check: off, new pools are looked at too (2026-10-30: it applied
    // in every style, and every pool of GeckoTerminal's new-pools lists was under 24 h old, so half of discovery was
    // thrown away before any check, in Wild too)
    const o = this.state.options;
    const { keep, skipped } = filterFresh(scanned, { now: this.now(), minAgeMs: o.enforceWashAndAge ? o.minPoolAgeSec * 1000 : 0, minLiquidityUsd: this.floorUsd() });
    for (const s of skipped) this.feed({ t: this.now(), chainId: s.pool.chainId, pool: s.pool.pool, label: `${s.pool.tokenSymbol}/${s.pool.spendSymbol}`, verdict: 'skipped', why: s.why, stage: 'rules' });
    const eligible: FreshPool[] = [];
    for (const p of keep) {
      if (!this.state.on) break;
      const label = `${p.tokenSymbol}/${p.spendSymbol}`;
      const skip = (why: string) => {
        this.feed({ t: this.now(), chainId: p.chainId, pool: p.pool, label, verdict: 'skipped', why, stage: 'rules' });
        this.reject({ chainId: p.chainId, pool: p.pool, token: p.token, signal: signalOf(p.source), source: p.dex, reason: why, price: p.price, feeBps: p.feeBps, spendSymbol: p.spendSymbol });
      };
      if (!this.wants(p.chainId)) { skip('chain is off'); continue; }
      if (p.venue && this.state.options.venues[p.venue] === false) { skip(`${VENUES.find((v) => v.id === p.venue)?.name ?? p.venue} is switched off`); continue; }
      if (this.entriesStopped(p.chainId)) { skip('new buys are stopped (Stop all)'); continue; }
      eligible.push(p);
    }
    // Safety reads, including LP checks, overlap, and each pool is decided as soon as its own check finishes, one
    // decision at a time in the order they finish (2026-10-30: a batch of 29 checks took 4 min, single Robinhood checks
    // 34-52 s, and nothing was shown or bought until the slowest one finished).
    let line: Promise<void> = Promise.resolve();
    await Promise.all(eligible.map(async (p) => {
      const a = await this.assess(p);
      const turn = line.then(() => this.decideScanned(p, a));
      line = turn;
      await turn;
    }));
  }

  /** A scanned pool after its safety check: skipped with the reason, or bought. */
  private async decideScanned(p: FreshPool, a: Awaited<ReturnType<TokenTrader['assess']>>) {
    if (!this.state.on) return; // turned off while the safety reads were pending
    const label = `${p.tokenSymbol}/${p.spendSymbol}`;
    if (!a.ok || !a.gate) {
      const why = a.reason ?? 'safety';
      this.feed({ t: this.now(), chainId: p.chainId, pool: p.pool, label, verdict: 'skipped', why, stage: 'checks' });
      this.reject({ chainId: p.chainId, pool: p.pool, token: p.token, signal: signalOf(p.source), source: p.dex, reason: why, price: p.price, feeBps: p.feeBps, spendSymbol: p.spendSymbol });
      this.say(`skipped ${label}: ${a.reason}`, 'warn');
      return;
    }
    // one buy that fails (a send error, no key on its chain) is recorded; the other pools still get their turn
    try { await this.buy(p, 'scan', a.buyTax, a.sellTax, a.gate, a.warn, a.note); } catch (e) { this.lastError = `${label}: ${(e as Error).message}`; }
  }

  private hourRoom() {
    const since = this.now() - HOUR;
    this.state.snipesAt = this.state.snipesAt.filter((t) => t >= since);
    return Math.max(0, this.state.options.sniper.maxPerHour - this.state.snipesAt.length);
  }

  private async takeSnipes() {
    const sn = this.state.options.sniper;
    if (!sn.on || !this.d.sniper) return;
    const { cursors, hits: all, notes } = await this.d.sniper.tick(this.state.cursors, { delayBlocks: sn.delayBlocks, delaySec: sn.delaySec, wants: (id) => this.wants(id) });
    this.state.cursors = cursors;
    // V4 creations the sniper can't buy (it reads Ethereum's PoolManager and has no pool key route) go to the reject
    // log only: counting them as found, then filtered, buried the funnel (2026-10-30: 1,474 found, 1,474 out).
    for (const hit of all.filter((h) => h.skip || h.kind === 'v4')) {
      this.reject({ chainId: hit.chainId, pool: hit.pool, token: hit.token0, signal: 'snipe', source: hit.dex, reason: hit.skip ?? "the sniper doesn't buy V4 pools", price: null, feeBps: hit.fee != null ? hit.fee / 100 : null });
    }
    const hits = all.filter((h) => !h.skip && h.kind !== 'v4');
    if (hits.length) this.funnelToday().scouted += hits.length;
    for (const n of notes) this.say(n.msg, n.level);
    let room = this.hourRoom();
    for (const hit of hits) {
      if (!this.state.on) break; // turned off while the sniper's log read was pending
      const rejectHit = (reason: string, label: string, token = hit.token0) => {
        this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label, verdict: 'skipped', why: reason, stage: 'rules' });
        this.reject({ chainId: hit.chainId, pool: hit.pool, token, signal: 'snipe', source: hit.dex, reason, price: null, feeBps: hit.fee != null ? hit.fee / 100 : null });
      };
      const pool = await this.d.resolve?.(hit) ?? null;
      if (!pool) { rejectHit('could not price the new pool', hit.pool.slice(0, 8)); continue; }
      const minLiq = Math.max(sn.minLiquidityUsd, this.floorUsd());
      // the gate compares dollars (unchanged); the reason a screen shows is in ETH (src/lib/ethUnits.ts)
      const thinWhy = `liquidity under ${usdAsEth(minLiq)}`;
      if (pool.liquidityUsd < minLiq) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: thinWhy, stage: 'rules' }); this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: 'snipe', source: pool.dex, reason: thinWhy, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol }); continue; }
      if (room <= 0) { this.feed({ t: this.now(), chainId: hit.chainId, pool: hit.pool, label: `${pool.tokenSymbol}/${pool.spendSymbol}`, verdict: 'skipped', why: `${sn.maxPerHour} snipes an hour already`, stage: 'rules' }); this.reject({ chainId: pool.chainId, pool: pool.pool, token: pool.token, signal: 'snipe', source: pool.dex, reason: `${sn.maxPerHour} snipes an hour already`, price: pool.price, feeBps: pool.feeBps, spendSymbol: pool.spendSymbol }); continue; }
      const before = this.state.positions.length;
      try { await this.consider({ ...pool, source: 'snipe', createdAt: null }, 'snipe'); } catch (e) { this.lastError = `${pool.tokenSymbol}/${pool.spendSymbol}: ${(e as Error).message}`; }
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
   * A sell part sent earlier (pendingSell), by hash. true = settled (landed: tokens and proceeds booked; reverted: gas
   * booked; mined but unreadable: reconcile reads the wallet); false = not mined yet, so this position waits.
   */
  private async settleSell(p: Position): Promise<boolean> {
    const ps = p.pendingSell!;
    if (!this.d.live) return false;
    // a failed read is "not known yet": this position waits; the others still run their exits
    const r = await this.d.live.recover(p.chainId, ps.hash, ps.tokenOut, ps.decimalsOut).catch(() => null);
    if (!r) { p.exitPlan = `sell ${ps.hash} waiting for its receipt`; return false; }
    p.pendingSell = null;
    if (!r.ok) {
      this.bookGas(p.mode, p.chainId, p.spend, this.spendSymbol(p), r.gasNative, p);
      this.say(`${p.label}: sell ${ps.hash} reverted; only its gas was spent`, 'warn', { mode: p.mode });
      return true;
    }
    if (r.amountOut == null) {
      // it landed but what it brought can't be read: the wallet says what left (booked unpriced, never guessed)
      this.bookGas(p.mode, p.chainId, p.spend, this.spendSymbol(p), r.gasNative, p);
      p.reconcile = true;
      return true;
    }
    p.tokens = Math.max(0, p.tokens - ps.tokens);
    this.bookSell(p, ps.tokens, r.amountOut, r.gasNative, ps.first);
    if (p.tpPending) p.tpPending.sold += ps.tokens;
    const usd = r.amountOut * p.usdPerSpend;
    const share = p.entryTokens > 0 ? ps.tokens / p.entryTokens : 0;
    const why = `sell ${ps.hash} settled`;
    this.state.trades.unshift({ t: this.now(), side: 'sell', mode: p.mode, chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why, pnlUsd: usd - p.spentUsd * share, spendSym: this.spendSymbol(p), amount: r.amountOut, pnl: r.amountOut - p.spent * share });
    if (this.state.trades.length > TRADE_MAX) this.state.trades.length = TRADE_MAX;
    this.say(`sold ${p.label}: ${why}`, 'success', { mode: p.mode });
    this.noteSell(p, { quote: r.amountOut, sold: ps.tokens, price: p.price, impact: null, txs: [ps.hash], flat: !(p.tokens > p.entryTokens * 1e-8), gas: null });
    return true;
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
    // #76: tokens that left with no fill known (a part reported failed that landed): what they brought is unknown, so
    // Generated counts neither their coins nor their cost (never guessed, never booked twice); flagged as unpriced.
    if (gone > p.entryTokens * 1e-6) this.bookUnpriced(p);
    p.reconcile = false;
    p.reconcileBase = null;
    p.blockedSince = null;
    p.blockedWhy = null;
    if (Math.abs(gone) > p.entryTokens * 1e-6) this.say(`${p.label}: tokens set from the wallet, ${num(before)} → ${num(p.tokens)}`, 'warn', { mode: p.mode });
    return true;
  }

  private async exits() {
    const left: Position[] = [];
    // Every position's price is read at once; the exits below still go one by one (2026-10-30: read one after another,
    // 11 open positions took minutes on Robinhood and held back each discovery behind them)
    const marks = new Map<string, Promise<{ m: Partial<Position> | null } | { e: unknown }>>();
    if (this.d.mark) for (const p of this.state.positions) marks.set(p.id, this.d.mark(p).then((m) => ({ m }), (e: unknown) => ({ e })));
    for (const p of this.state.positions) {
      // Turned off completely while this loop was awaiting: leave the rest alone.
      if (!this.canSell()) { left.push(p); continue; }
      const read = marks.get(p.id);
      if (read) {
        // One pool whose price can't be read keeps its last price; it doesn't stop the other exits and every buy (a
        // throw here failed the whole tick, and a failed exit pass skips entries: 2026-10-30, a thin V4 pool's quote
        // reverted on each tick and the trader bought nothing more)
        const r = await read;
        if ('e' in r) this.lastError = `${p.label}: price read failed, last price kept (${(r.e as Error).message.slice(0, 120)})`;
        const m = 'm' in r ? r.m : null;
        if (m) {
          Object.assign(p, m);
          if (m.price != null) {
            p.markedAt = this.now();
            p.marks = [...(p.marks ?? []), [p.markedAt, p.price] as [number, number]].slice(-MARKS_KEPT);
          }
          if (Object.prototype.hasOwnProperty.call(m, 'feeBps')) this.noteFeeReread(p.id);
        }
        // Off completely landed while the mark was read: don't sell (a live send is refused by canSell too).
        if (!this.canSell()) { left.push(p); continue; }
      }
      // the peak follows the price even while the position is blocked on reconcile (its trailing stop stays right)
      if (p.price > p.peak) p.peak = p.price;
      if (p.mode === 'live' && p.pendingSell) {
        // a sell part sent earlier: settle it by hash before deciding or sending anything else
        if (!(await this.settleSell(p))) { left.push(p); continue; }
        if (!p.reconcile && !(p.tokens > p.entryTokens * 1e-8)) continue;
      }
      if (p.mode === 'live' && p.reconcile) {
        // the last split sell stopped partway: take the wallet's balance before deciding anything
        if (!(await this.reconcile(p))) { p.exitPlan = this.blocked(p) ?? p.exitPlan; left.push(p); continue; }
        if (!(p.tokens > p.entryTokens * 1e-8)) continue;
      }
      const ex = this.exitOf(p);
      const d: ReturnType<typeof decideExit> = p.sellNow ? { action: 'sell', frac: Math.max(0, Math.min(1, ex.remainingFrac)), why: 'sold by hand (Sell now)' } : decideExit(ex);
      p.exitPlan = d.action === 'hold' ? 'hold' : d.why;
      if (d.action === 'hold') { left.push(p); continue; }
      if (p.dynamicFee && this.d.feeNow) {
        // the fee this sell pays, read now (keeps the last one if the read fails)
        const fee = await this.d.feeNow(p).catch(() => null);
        if (fee != null) { p.feeBps = fee; this.noteFeeReread(p.id); }
      }
      // Take profit 1 / 2 each sell one tranche of the entry (d.frac of entryTokens). One that stopped partway sells
      // only the rest of that tranche the next time it fires.
      const tp: 0 | 1 | 2 = d.why.startsWith('take profit') ? (p.tp1Done ? 2 : 1) : 0;
      const pend = tp && p.tpPending?.tp === tp ? p.tpPending : null;
      const target = pend ? pend.target : p.entryTokens * d.frac;
      const qty = Math.min(p.tokens, pend ? Math.max(0, pend.target - pend.sold) : p.entryTokens * d.frac);
      const parts = splitSell(qty, Math.max(p.tokenReserve, 1e-12), p.feeBps, this.state.options.maxImpact);
      let quote = 0, sold = 0, stopped: string | null = null, pending = false;
      let impactW = 0, impactN = 0, impactGap = false;
      const exitTxs: string[] = [];
      let gasNative = 0, gasUsed = 0, gasPrice: number | null = null, gasLegs = 0, gasMixed = false, gasGap = !(p.mode === 'live' && this.d.live);
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
          let s: LiveSell;
          try {
            s = await this.d.live.sell(p, part, this.limits());
          } catch (e) {
            if (e instanceof SwapPending) {
              // sent, receipt not in yet: its tokens are not assumed sold; the next ticks settle it by hash first
              this.bookGas(p.mode, p.chainId, p.spend, this.spendSymbol(p), e.gasNative, p);
              p.pendingSell = { hash: e.hash, tokenOut: e.tokenOut, decimalsOut: e.decimalsOut, tokens: part, sentAt: this.now(), first: sold === 0 };
              this.say(`${p.label}: sell ${e.hash} sent; its receipt has not come yet, so it is settled by hash before this position sells again`, 'warn', { mode: p.mode });
              pending = true;
              break;
            }
            // #76: gas a failed send still paid, once. Its tokens are not booked here: reconcile reads the wallet.
            this.bookGas(p.mode, p.chainId, p.spend, this.spendSymbol(p), gasOfError(e), p);
            stopped = (e as Error).message;
            break;
          }
          // #76: a landed part is booked into Generated at once (tokens, proceeds, gas), so a later part that fails
          // never loses it; the closed sell is counted once per exit (its first landed part).
          p.tokens = Math.max(0, p.tokens - s.tokensIn);
          this.bookSell(p, s.tokensIn, s.quoteOut, typeof s.gasNative === 'number' && Number.isFinite(s.gasNative) ? s.gasNative : 0, sold === 0);
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
          this.save(); // the landed part is on disk before the next part is sent (a restart keeps it)
        }
      } else {
        const model = this.model(p);
        const px = sellSidePrice(p.price, p.feeBps);
        for (const part of parts) {
          const sim = simSell(part, px, model);
          quote += sim.quote; sold += part;
          if (Number.isFinite(sim.impactPct)) { impactW += sim.impactPct * part; impactN += part; } else impactGap = true;
        }
        // paper: the whole simulated sell at once (live parts were booked as they landed, above)
        p.tokens = Math.max(0, p.tokens - sold);
        if (sold > 0) this.bookSell(p, sold, quote, 0, true);
      }
      if (sold > 0) {
        const usd = quote * p.usdPerSpend;
        const cost = p.spentUsd * (p.entryTokens > 0 ? sold / p.entryTokens : 0);
        const costCoin = p.spent * (p.entryTokens > 0 ? sold / p.entryTokens : 0); // the same cost in the spend coin (log only)
        const why = stopped ? `${d.why} (partial: ${num(sold)} of ${num(qty)})` : d.why;
        this.state.trades.unshift({ t: this.now(), side: 'sell', mode: p.mode, chainId: p.chainId, pool: p.pool, label: p.label, usd, price: p.price, why, pnlUsd: usd - cost, spendSym: this.spendSymbol(p), amount: quote, pnl: quote - costCoin });
        this.say(`sold ${p.label}: ${why}`, usd - cost >= 0 ? 'success' : 'warn', { mode: p.mode });
      }
      if (tp && (sold > 0 || pend || stopped)) {
        // Done only when the whole tranche went out with nothing interrupting it; a stop partway leaves the rest pending.
        const total = (pend?.sold ?? 0) + sold;
        if (!stopped && !pending && parts.length) {
          if (tp === 1) p.tp1Done = true; else p.tp2Done = true;
          p.tpPending = null;
        } else p.tpPending = { tp, target, sold: total };
      }
      if (stopped) {
        this.lastError = `${p.label}: sell stopped after ${num(sold)} of ${num(qty)} — ${stopped}`;
        this.say(`${p.label}: sell stopped partway (${stopped}); reading the wallet balance before it sells again`, 'warn', { mode: p.mode });
        p.reconcile = true;
        await this.reconcile(p);
      } else p.reconcileBase = null;
      // Generated ledger: the parts that landed, booked even when a later part stopped. Flat only once reconciled.
      const flat = !(p.tokens > p.entryTokens * 1e-8) && !p.reconcile;
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
