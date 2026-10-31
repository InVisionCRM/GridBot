/**
 * Wires the token trader to the chains this process already uses: GeckoTerminal new/trending pools,
 * the existing safety inspect, and (for live) the chain signer. An Ethereum https MEV URL, when set
 * on the trader, is used only to broadcast the signed transaction.
 */
import { JsonRpcProvider } from 'ethers';
import { readDecimals } from '../../live/decimals';
import { NATIVE_EEEE, NATIVE_ZERO } from '../../market/scan';
import { fromTopPool, type FreshPool, type GateInput } from '../../market/tokenTrader';
import { applyLpUnlock, cachedTokenLp, LP_CHECK_TIMEOUT_MS, tokenLpKey, unverifiedLpUnlock, type TokenLpSnapshot } from '../../market/lpUnlock';
import { unverifiedV3Lp, V3_LP_LOCK_CACHE_TTL_MS } from '../../market/v3LpLock';
import { readLiveLpUnlock } from './lpUnlockRead';
import { readV3LpLock, type V3LockReader } from './v3LpLockRead';
import { ERC20, ROUTER } from '../dex/abis';
import { readCall } from '../dex/types';
import { fetchJson } from '../fetchJson';
import { holderApiBase, readHolderConcentration, type HolderChain } from './holderRead';
import { readOwnerPowers } from './ownerRead';
import { ExecError, LiveExecutor, gasOf, parseAmountOut, type ChainReader, type Fill, type Quote, type Quoter, type TxSender } from '../bot/chain';
import { fromUnits } from '../../live/swapMath';
import type { ChainConfig, DexConfig } from '../../live/chains';
import { VENUES, venueOf } from '../../live/venues';
import type { MarketDef } from '../../live/markets';
import { DEFAULT_LIMITS, type SafetyLimits } from '../../live/limits';
import type { SharedNonce, TxGate } from '../bot/txGate';
import { poolFeeBps, readV3FeeBps } from '../dex/poolFee';
import { JsonStore, type Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import { retryOnce, type GeckoSource } from './gecko';
import { PoolSniper, type LogSource, type SniperChain } from './sniper';
import { SwapPending, TokenTrader, type Position, type TraderState } from '../bot/tokenTrader';
import { PlayRejectLog } from '../bot/playRejects';

interface Reader extends ChainReader {
  getBlockNumber(): Promise<number>;
  getLogs(f: { address: string; topics: string[]; fromBlock: number; toBlock: number }): Promise<readonly { address?: string; topics: readonly string[]; data: string; blockNumber: number; transactionHash?: string; index?: number }[]>;
  getCode(a: string): Promise<string>;
}

export function sniperChains(hub: Hub): SniperChain[] {
  return hub.runtimes().filter((rt) => rt.tradable && rt.cfg.status === 'live').map((rt) => ({
    id: rt.cfg.id, name: rt.cfg.name,
    spendable: [rt.cfg.wrappedNative.address, NATIVE_ZERO, NATIVE_EEEE, ...rt.cfg.stables.map((s) => s.address)].map((a) => a.toLowerCase()),
    dexes: rt.cfg.dexes.filter((d) => d.factory && (d.kind === 'v2' || d.kind === 'v3')).map((d) => ({
      id: d.id, kind: d.kind as 'v2' | 'v3', factory: d.factory, router: d.router, quoter: d.quoter,
    })),
    logChunk: rt.cfg.logChunk,
  }));
}

export function logSource(hub: Hub): LogSource {
  const reader = (id: number) => hub.rt(id).reader as Reader;
  return {
    head: (id) => reader(id).getBlockNumber(),
    getCode: (id, a) => reader(id).getCode(a),
    factoryOf: async (id, address) => {
      try {
        const raw = await reader(id).call({ to: address, data: ROUTER.encodeFunctionData('factory', []) });
        return ROUTER.decodeFunctionResult('factory', raw)[0] as string;
      } catch { return null; }
    },
    getLogs: async (id, from, to, address, topics) => {
      const logs = await reader(id).getLogs({ address, topics, fromBlock: from, toBlock: to });
      return logs.map((l) => ({ address: l.address ?? address, topics: [...l.topics], data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.index }));
    },
    subscribe: wsSubscribe(hub),
  };
}

/** Websocket logs only when the chain's current RPC URL is already ws:// or wss://. https stays on getLogs. */
function wsSubscribe(hub: Hub): LogSource['subscribe'] {
  return (chainId, address, topic, onLog) => {
    const url = (hub.rt(chainId).reader as { currentUrl?: string }).currentUrl ?? '';
    if (!url.startsWith('ws')) return () => undefined;
    let dead = false;
    let provider: InstanceType<typeof import('ethers').WebSocketProvider> | null = null;
    void import('ethers').then(({ WebSocketProvider }) => {
      if (dead) return;
      try {
        provider = new WebSocketProvider(url);
        provider.on({ address, topics: [topic] }, (log: { address: string; topics: string[]; data: string; blockNumber: number; transactionHash?: string; index?: number }) => {
          if (!dead) onLog({ address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.index });
        });
      } catch { /* polling still runs */ }
    }).catch(() => undefined);
    return () => { dead = true; void provider?.destroy(); };
  };
}

const providers = new Map<string, JsonRpcProvider>();
function broadcast(url: string, raw: string): Promise<string> {
  let p = providers.get(url);
  if (!p) { p = new JsonRpcProvider(url); providers.set(url, p); }
  return p.send('eth_sendRawTransaction', [raw]);
}

export function createTokenTrader(o: {
  hub: Hub; gecko: GeckoSource; store: Store<TraderState>; emit: Emit;
  approval: 'exact' | 'max'; receiptTimeoutMs: number;
  /** Data directory for the append-only reject log. Omit in tests that keep rejects in memory. */
  dataDir?: string;
}): TokenTrader {
  const sniper = new PoolSniper({ chains: sniperChains(o.hub), source: logSource(o.hub) });
  const flags = {
    v3LpLockCheck: () => false,
    lpUnlockCheck: () => false,
    v3LpLockCacheEnabled: () => false,
    v3LpLockCacheTtlMs: () => V3_LP_LOCK_CACHE_TTL_MS,
    v3LpLockCallBudget: () => 0,
  };
  const drafts = draftStore();
  const lookEveryMs = () => discoverEveryMs(o.hub.runtimes().filter((rt) => rt.tradable && rt.cfg.geckoSlug && rt.cfg.status === 'live' && trader.wants(rt.cfg.id)).length);
  const trader: TokenTrader = new TokenTrader({
    store: o.store, emit: o.emit, sniper,
    liveChains: () => o.hub.runtimes().filter((rt) => rt.tradable).map((rt) => ({ id: rt.cfg.id, name: rt.cfg.name, signer: !!rt.signer })),
    discover: everyAtMost(() => discover(o.hub, o.gecko, (id) => trader.wants(id)), lookEveryMs),
    lookEveryMs,
    assess: (pool, mode, risk) => assess(o.hub, pool, mode, risk, (d) => drafts.keep(pool, d), flags.v3LpLockCheck(), flags.lpUnlockCheck(), {
      cacheEnabled: flags.v3LpLockCacheEnabled(), cacheTtlMs: flags.v3LpLockCacheTtlMs(), callBudget: flags.v3LpLockCallBudget(),
    }),
    // Called only when the holder check is on. Flag off never reaches this, so a scan makes no explorer calls.
    holders: (pool) => {
      const rt = o.hub.rt(pool.chainId);
      const cfg = rt.cfg;
      const reader = rt.reader as typeof rt.reader & {
        getBlockNumber?: () => Promise<number>; getLogs?: HolderChain['getLogs'];
        getCode?: (a: string) => Promise<string>; send?: (method: string, params: unknown[]) => Promise<unknown>;
      };
      const chain: HolderChain | undefined = reader.getBlockNumber && reader.getLogs ? {
        getBlockNumber: () => reader.getBlockNumber!(),
        getLogs: (f) => reader.getLogs!(f),
        call: (tx) => reader.call(tx),
        getCode: async (address, blockTag) => {
          if (reader.send) {
            const tag = blockTag === 'latest' ? 'latest' : `0x${blockTag.toString(16)}`;
            return String(await reader.send('eth_getCode', [address, tag]));
          }
          return reader.getCode ? reader.getCode(address) : '0x';
        },
      } : undefined;
      return readHolderConcentration({
        chainId: pool.chainId, chainName: cfg.name, token: pool.token, exclude: [pool.pool],
        api: holderApiBase(cfg),
        spends: [cfg.wrappedNative.address, ...cfg.stables.map((s) => s.address)],
        dexes: cfg.dexes, geckoSlug: cfg.geckoSlug,
      }, {
        fetchJson, chain,
        minCoverage: trader.status().options.minHolderCoverage,
        totalSupply: async (chainId, token) => {
          const [supply] = await readCall<[bigint]>(o.hub.rt(chainId).reader, token, ERC20, 'totalSupply');
          return supply;
        },
      });
    },
    // Called only when the trade-size impact check is on, and only for the size the buy would actually send.
    poolNow: (pool) => poolNowOf(o.hub, drafts.get(pool)),
    quoteBuy: (pool, spend) => quoteBuyOf(o.hub, drafts.get(pool), spend),
    resolve: (hit) => resolveHit(o.hub, hit),
    mark: positionMarker(o.hub),
    ownerPowers: (pool) => readOwnerPowers(o.hub.rt(pool.chainId).reader, pool.chainId, pool.token),
    // the signer's on-chain balance of the position's token (reconcile after a sell that stopped partway)
    balanceOf: async (p) => {
      const rt = o.hub.rt(p.chainId);
      if (!rt.signer) return null;
      const owner = await rt.signer.getAddress();
      const [raw, dec] = await Promise.all([rt.tokenBalance(owner, p.token), readDecimals(rt.reader, p.chainId, p.token)]);
      return Number(raw) / 10 ** dec;
    },
    // dynamic-fee pools: the fee at quote time (never cached)
    feeNow: (p) => readV3FeeBps(o.hub.rt(p.chainId).reader, p.pool),
    // Generated only: is the spend coin the chain's own (wrapped or not), so its gas comes out of Generated
    coinInfo: (chainId, spend) => {
      try {
        const cfg = o.hub.rt(chainId).cfg, a = spend.toLowerCase();
        return { native: [cfg.wrappedNative.address, NATIVE_ZERO, NATIVE_EEEE].some((x) => x.toLowerCase() === a), nativeSymbol: cfg.nativeSymbol };
      } catch { return null; } // a chain not on in this app: gas stays apart
    },
    rejects: o.dataDir ? new PlayRejectLog(o.dataDir) : undefined,
    live: {
      buy: async (pool, spend, limits) => {
        const draft = await draftOf(o.hub, pool, 'buy');
        // A Stop all that lands while this buy waits in the chain's queue, or between the quote and the send, stops it
        // (sells keep running: they are exits).
        const { q, fill } = await liveSwap(o.hub.rt(pool.chainId), o.hub.draftQuoter(draft), swapOpts(o, pool.chainId, trader.status().options.sniper.mevRpc), 'buy', spend, limits, sendChecks(trader).buy(pool.chainId));
        const usd = fill.amountInHuman * pool.usdPerSpend;
        return { tokens: fill.amountOutHuman, spent: fill.amountInHuman, spentUsd: usd, price: fill.amountOutHuman > 0 ? fill.amountInHuman / fill.amountOutHuman : pool.price, impact: q.priceImpact, tx: fill.txHash, gasUsed: fill.swapGasUsed, gasPriceWei: fill.swapGasPriceWei, gasNative: fill.gasNative };
      },
      sell: async (pos, tokens, limits) => {
        const pool = positionPool(pos);
        const draft = await draftOf(o.hub, pool, 'sell');
        const { q, fill } = await liveSwap(o.hub.rt(pos.chainId), o.hub.draftQuoter(draft), swapOpts(o, pos.chainId, trader.status().options.sniper.mevRpc), 'sell', tokens, limits, sendChecks(trader).sell());
        return { quoteOut: fill.amountOutHuman, tokensIn: fill.amountInHuman, price: fill.amountInHuman > 0 ? fill.amountOutHuman / fill.amountInHuman : pos.price, impact: q.priceImpact, tx: fill.txHash, gasUsed: fill.swapGasUsed, gasPriceWei: fill.swapGasPriceWei, gasNative: fill.gasNative };
      },
      recover: async (chainId, hash, tokenOut, decimalsOut) => {
        const rt = o.hub.rt(chainId);
        const r = await rt.reader.getTransactionReceipt(hash);
        if (!r) return null;
        const gasNative = fromUnits(gasOf(r), 18);
        if (r.status !== 1) return { ok: false, amountOut: 0, gasNative };
        if (!rt.signer) throw new Error('no signing key');
        const out = parseAmountOut(r, await rt.signer.getAddress(), tokenOut, rt.cfg.wrappedNative.address);
        return { ok: true, amountOut: out != null ? fromUnits(out, decimalsOut) : null, gasNative };
      },
    },
  });
  flags.v3LpLockCheck = () => trader.status().options.v3LpLockCheck === true;
  flags.lpUnlockCheck = () => trader.status().options.lpUnlockCheck === true;
  flags.v3LpLockCacheEnabled = () => trader.status().options.v3LpLockCacheEnabled === true;
  flags.v3LpLockCacheTtlMs = () => trader.status().options.v3LpLockCacheTtlMs;
  flags.v3LpLockCallBudget = () => trader.status().options.v3LpLockCallBudget;
  return trader;
}

/** The halt checks a token-trader send runs right before it takes a nonce (and again between approve and swap). */
export function sendChecks(trader: Pick<TokenTrader, 'canBuy' | 'canSell'>) {
  return {
    buy: (chainId: number) => () => trader.canBuy(chainId),
    // Exits: allowed on and in "off for new buys" (exits only), never when off completely.
    sell: () => () => trader.canSell(),
  };
}

function swapOpts(o: { approval: 'exact' | 'max'; receiptTimeoutMs: number }, chainId: number, mev: string | null) {
  const url = chainId === 1 && mev && /^https:\/\//.test(mev) ? mev : null;
  return { approval: o.approval, receiptTimeoutMs: o.receiptTimeoutMs, sendRaw: url ? (raw: string) => broadcast(url, raw) : undefined };
}

/**
 * One token-trader swap, sent the way the bots send: inside the chain's TxGate (one transaction at a time per chain,
 * shared with grids, LP and the converter) and with the wallet's SharedNonce. The halt check runs first thing inside
 * the gate, so a send that queued behind another is refused if Stop all / off landed while it waited; LiveExecutor
 * runs it again right before each nonce is taken. The quote is taken inside the gate too (fresh, and the balance-delta
 * fill measurement only sees this swap). Quote checks are unchanged.
 */
export async function liveSwap(
  rt: { signer: TxSender | null; gate: TxGate; nonce: SharedNonce }, quoter: Quoter,
  opts: { approval: 'exact' | 'max'; receiptTimeoutMs: number; sendRaw?: (raw: string) => Promise<string> },
  side: 'buy' | 'sell', amount: number, limits: SafetyLimits, canSend: () => boolean,
): Promise<{ q: Quote; fill: Fill }> {
  const signer = rt.signer;
  if (!signer) throw new Error('no signing key');
  const ex = new LiveExecutor(quoter, signer, { ...opts, sharedNonce: rt.nonce });
  return rt.gate.run(async () => {
    if (!canSend()) throw new Error('stopped before sending');
    const q = await ex.quote(side, amount, limits);
    if (q.block) throw new Error(q.block);
    if (!q.balanceOk) throw new Error(q.balanceNote ?? 'balance');
    if (q.priceImpact > limits.maxPriceImpact) throw new Error(`price impact ${(q.priceImpact * 100).toFixed(2)}% is over the cap`);
    try {
      const fill = await ex.execute(q, { canSend, onSent: () => undefined });
      return { q, fill };
    } catch (e) {
      // sent but not confirmed in time: hand the hash to the trader, which settles it later (never dropped)
      if (e instanceof ExecError && e.opts.pending && e.opts.swapTxHash) throw new SwapPending(e.opts.swapTxHash, q.tokenOut, q.decimalsOut, q.amountInHuman, e.opts.gasNative ?? 0);
      throw e;
    }
  });
}

/** The pool and its safety (sell tax, sell simulation) are looked up again this often; price and depth every tick. */
export const MARK_DRAFT_EVERY_MS = 10 * 60_000;

type MarkHub = Pick<Hub, 'inspect' | 'draftQuoter'>;

/**
 * Today's pool for an open position (2026-10-30: production passed no mark, so a position's price stayed at its entry;
 * the stop, take profits and trailing stop never fired and every position waited for the 6 h time stop).
 * Price is the pool mid (quote depth ÷ token depth: V2 reserves, V3/V4 active-range virtual reserves), with both
 * depths for sell sizing. Liquidity is 2 × quote depth in dollars; the first mark sets entryLiq to it, so the
 * liquidity-pulled exit compares like with like. Every MARK_DRAFT_EVERY_MS the safety check runs again: its sell tax
 * replaces the position's, and sellSimOk turns false only on a proven honeypot. A simulation that could not run (an
 * RPC refusing state overrides) changes nothing, so it can't set off a sell-everything.
 */
export function positionMarker(hub: MarkHub, now: () => number = Date.now) {
  const drafts = new Map<string, { at: number; draft: MarketDef }>();
  return async (p: Position): Promise<Partial<Position> | null> => {
    const out: Partial<Position> = {};
    let d = drafts.get(p.id);
    if (!d || now() - d.at >= MARK_DRAFT_EVERY_MS) {
      const draft = await draftOf(hub, positionPool(p), 'sell').catch(() => null);
      if (draft) {
        d = { at: now(), draft };
        drafts.set(p.id, d);
        const s = draft.safety;
        if (s?.simulated && s.sellTaxPct != null) out.sellTax = s.sellTaxPct;
        if (s?.honeypot === true) out.sellSimOk = false;
      }
    }
    if (!d) return Object.keys(out).length ? out : null;
    const m = await hub.draftQuoter(d.draft).market();
    if (!(m.plsReserve > 0) || !(m.quoteReserve > 0)) return Object.keys(out).length ? out : null;
    const liq = 2 * m.quoteReserve * p.usdPerSpend;
    return {
      ...out, price: m.quoteReserve / m.plsReserve, quoteReserve: m.quoteReserve, tokenReserve: m.plsReserve, liq,
      ...(p.liqBase !== 'chain' ? { entryLiq: liq, liqBase: 'chain' as const } : {}),
    };
  };
}

function positionPool(p: Position): FreshPool {
  return {
    chainId: p.chainId, pool: p.pool, dex: p.dex, kind: 'v2', token: p.token, spend: p.spend,
    tokenSymbol: p.label.split('/')[0] ?? p.token, spendSymbol: p.spend, liquidityUsd: p.liq, volumeUsd: p.volume,
    createdAt: null, source: p.source === 'snipe' ? 'snipe' : 'new', quoteReserve: p.quoteReserve, tokenReserve: p.tokenReserve,
    feeBps: p.feeBps, price: p.price, usdPerSpend: p.usdPerSpend,
  };
}

/**
 * The market to quote and swap through. A buy needs the safety check to allow live trading. A sell (an exit) does not:
 * a coin whose sell tax rose past the live cap is the one an exit wants out of, and a sell that would really revert
 * fails at its own quote or on-chain.
 */
async function draftOf(hub: Pick<Hub, 'inspect'>, pool: FreshPool, side: 'buy' | 'sell'): Promise<MarketDef> {
  const r = await hub.inspect({ chainId: pool.chainId, address: pool.token, quote: pool.spend, pool: pool.pool });
  if (!r.draft) throw new Error(r.safety?.reasons?.[0] ?? 'no pool to trade');
  if (side === 'buy' && !r.safety?.liveAllowed) throw new Error(r.safety?.reasons?.join(' ') || 'safety check does not allow live trading');
  return r.draft;
}

/**
 * How often GeckoTerminal's new/trending lists are read: two calls per chain the trader trades, kept to half of the
 * ~24 calls a minute the app's GeckoTerminal client allows (the daily scan, charts and logos share it), and never more
 * often than every 30 s (the lists themselves don't change faster). 1-3 chains: 30 s; all 8: 80 s.
 */
export const DISCOVER_MIN_MS = 30_000;
const DISCOVER_CALLS_PER_MIN = 12;
export const discoverEveryMs = (chains: number) => Math.max(DISCOVER_MIN_MS, Math.ceil((Math.max(1, chains) * 2 * 60_000) / DISCOVER_CALLS_PER_MIN));

/** `read` at most once per `everyMs()`; in between, null (not due). */
export function everyAtMost<T>(read: () => Promise<T[]>, everyMs: () => number, now: () => number = Date.now): () => Promise<T[] | null> {
  let at: number | null = null;
  return async () => {
    if (at != null && now() - at < everyMs()) return null;
    at = now();
    return read();
  };
}

/** Pools kept per chain from one discovery, after unknown DEXes are dropped (it was 40 across all chains, so the first chain crowded out the rest). */
export const DISCOVER_PER_CHAIN = 20;

/**
 * The DEX a GeckoTerminal row trades on, and its launch venue (venues.ts) when it has one. A venue's label wins: its
 * pools trade on the DEX it names (Pons V1 → Uniswap V3; V4 launchers → Uniswap V4, with their hook checked at the
 * safety check). null = a DEX this app doesn't trade.
 */
export function dexFor(cfg: Pick<ChainConfig, 'id' | 'dexes'>, geckoDex: string): { dex: DexConfig; venue: string | null } | null {
  const venue = venueOf(cfg.id, geckoDex);
  if (venue) {
    if (!('dex' in venue.via)) return null; // a Pons V2 curve: not a DEX pool
    const id = venue.via.dex;
    const dex = cfg.dexes.find((d) => d.id === id);
    return dex ? { dex, venue: venue.id } : null;
  }
  const dex = cfg.dexes.find((d) => d.gecko === geckoDex);
  return dex ? { dex, venue: null } : null;
}

/** `wants`: the chains the trader is set to trade ("Where"); the others are not read at all. */
export async function discover(hub: Pick<Hub, 'runtimes' | 'rt'>, gecko: Pick<GeckoSource, 'newPools' | 'trendingPools'>, wants: (chainId: number) => boolean): Promise<FreshPool[]> {
  const out: FreshPool[] = [];
  for (const rt of hub.runtimes()) {
    if (!rt.tradable || !rt.cfg.geckoSlug || rt.cfg.status !== 'live' || !wants(rt.cfg.id)) continue;
    const wrapped = rt.cfg.wrappedNative.address.toLowerCase();
    // V4 pools name the native coin address(0); the trader spends the wrapped address, and hub.inspect searches both
    const spend = [wrapped, NATIVE_ZERO, ...rt.cfg.stables.map((s) => s.address)];
    let fresh: Awaited<ReturnType<GeckoSource['newPools']>> = [];
    let hot: Awaited<ReturnType<GeckoSource['newPools']>> = [];
    const slug = rt.cfg.geckoSlug;
    try { fresh = await retryOnce(() => gecko.newPools(slug)); } catch { /* next chain */ }
    try { hot = await retryOnce(() => gecko.trendingPools(slug)); } catch { /* next chain */ }
    const mine: FreshPool[] = [];
    const take = (rows: typeof fresh, source: 'new' | 'trending') => {
      for (const row of rows) {
        const on = dexFor(rt.cfg, row.dex);
        if (!on) continue;
        // feeBps is a placeholder until withPoolFees reads the pool's real fee
        const pool = fromTopPool(row, { id: rt.cfg.id, spend, kind: on.dex.kind, feeBps: on.dex.feeBps ?? 30 }, source);
        if (!pool) continue;
        if (pool.spend === NATIVE_ZERO.toLowerCase()) pool.spend = wrapped;
        mine.push(on.venue ? { ...pool, venue: on.venue } : pool);
      }
    };
    take(fresh, 'new');
    take(hot, 'trending');
    out.push(...mine.slice(0, DISCOVER_PER_CHAIN));
  }
  return withPoolFees(out, (id) => hub.rt(id).reader, (p) => dexFor(hub.rt(p.chainId).cfg, p.dex)?.dex ?? null);
}

/**
 * Every discovered pool gets its real fee: V2 = the DEX's fee, V3 = the pool's fee(), V4 = StateView's lpFee (one
 * eth_call each). A pool whose fee can't be read is dropped: pricing it at a guessed tier is how 1 % pools were sized
 * as 0.01 % ones.
 */
export async function withPoolFees(
  pools: FreshPool[], readerFor: (chainId: number) => Pick<ChainReader, 'call'>,
  dexOf: (p: FreshPool) => Pick<DexConfig, 'kind' | 'feeBps' | 'dynamicFee' | 'stateView'> | null,
): Promise<FreshPool[]> {
  const read = await Promise.all(pools.map(async (p) => {
    const dex = dexOf(p);
    if (!dex) return null;
    const feeBps = await poolFeeBps(readerFor(p.chainId), p.pool, dex);
    return feeBps == null ? null : { ...p, kind: dex.kind, feeBps, ...(dex.dynamicFee ? { dynamicFee: true } : {}) };
  }));
  return read.filter((p): p is NonNullable<typeof p> => !!p);
}

/** Any address works for a quote: nothing is sent and no allowance is read */
const QUOTE_FROM = '0x000000000000000000000000000000000000dEaD';
/** Markets the safety check built, kept for the impact quote that follows it on the same buy */
const DRAFTS_KEPT = 200;

export function draftStore() {
  const m = new Map<string, MarketDef>();
  const key = (p: Pick<FreshPool, 'chainId' | 'pool'>) => `${p.chainId}:${p.pool.toLowerCase()}`;
  return {
    keep(p: Pick<FreshPool, 'chainId' | 'pool'>, d: MarketDef) {
      m.delete(key(p));
      m.set(key(p), d);
      if (m.size > DRAFTS_KEPT) m.delete(m.keys().next().value!);
    },
    get: (p: Pick<FreshPool, 'chainId' | 'pool'>) => m.get(key(p)) ?? null,
  };
}

/**
 * What spending `spend` brings on the market the safety check built (tokens after the token's buy tax) and its price
 * impact: the same quoter, pool reference (app DEX id, V4 pool key, native coin) and decimals the live buy uses. The
 * impact used to be quoted through the adapter named by the pool's GeckoTerminal label ('uniswap-v3-robinhood'), which
 * no adapter is called, so every pool outside PulseChain and every V4 pool failed it (2026-10-30).
 */
export async function quoteBuyOf(hub: Pick<Hub, 'draftQuoter'>, draft: MarketDef | null, spend: number): Promise<{ tokens: number; impact: number }> {
  if (!draft) throw new Error('no safety check result for this pool');
  const q = await hub.draftQuoter(draft).quote('buy', spend, DEFAULT_LIMITS, QUOTE_FROM, null);
  return { tokens: q.quotedOutHuman, impact: q.priceImpact };
}

/** The pool's price (spend per token) and depth now, read on-chain through the market the safety check built */
export async function poolNowOf(hub: Pick<Hub, 'draftQuoter'>, draft: MarketDef | null): Promise<{ price: number; quoteReserve: number; tokenReserve: number }> {
  if (!draft) throw new Error('no safety check result for this pool');
  const m = await hub.draftQuoter(draft).market();
  if (!(m.quoteReserve > 0) || !(m.plsReserve > 0)) throw new Error('one side of the pool is empty');
  return { price: m.quoteReserve / m.plsReserve, quoteReserve: m.quoteReserve, tokenReserve: m.plsReserve };
}

/**
 * A venue's V4 pool trades only through that venue's own hook (venues.ts; Uniswap V4 = no hook). A pool under its
 * label with any other hook is refused before it can be simulated as safe.
 */
export function venueHookCheck(pool: Pick<FreshPool, 'venue' | 'pool'>, hook: string | null) {
  const v = pool.venue ? VENUES.find((x) => x.id === pool.venue) : null;
  if (!v || !('dex' in v.via) || v.via.hook == null) return;
  if (hook == null || hook.toLowerCase() !== v.via.hook.toLowerCase()) throw new Error(`${v.name} pool ${pool.pool} trades through hook ${hook ?? '(none read)'}, not ${v.name}'s ${v.via.hook}`);
}

async function assess(hub: Hub, pool: FreshPool, mode: 'paper' | 'live', _risk: 'safe' | 'medium' | 'any', onDraft: (d: MarketDef) => void, v3LpLockCheck = false, lpUnlockCheck = false, v3Bounds: { cacheEnabled: boolean; cacheTtlMs: number; callBudget: number } = { cacheEnabled: false, cacheTtlMs: V3_LP_LOCK_CACHE_TTL_MS, callBudget: 0 }): Promise<GateInput> {
  const r = await hub.inspect({ chainId: pool.chainId, address: pool.token, quote: pool.spend, pool: pool.pool });
  venueHookCheck(pool, r.draft?.pool.v4?.hooks ?? null);
  if (r.draft) onDraft(r.draft);
  const s = r.safety;
  const gate: GateInput = {
    mode, risk: _risk, honeypot: s?.honeypot ?? null, sellSimOk: s ? s.simulated && s.honeypot !== true : false,
    paused: s?.paused ?? null, decimals: s?.decimals ?? r.token?.decimals ?? null,
    buyTax: s?.buyTaxPct ?? null, sellTax: s?.sellTaxPct ?? null,
    liquidityUsd: pool.liquidityUsd, minLiquidityUsd: pool.source === 'snipe' ? 0 : 0,
    canPause: s?.paused != null ? true : null, canBlacklist: s?.blacklist != null ? true : null,
    // Unknown until the trader's holder check is on. That check fills this in; leaving it null here keeps the gate
    // identical when the check is off, and keeps this function from calling an explorer on every assess.
    proxy: s?.proxy != null ? true : null, lpUnlocked: null, holderConcentration: null, recentLiqPull: false,
    liveAllowed: s?.liveAllowed ?? false,
  };
  // Both flags off: do not attach v3Lp or lpUnlock, so gateToken sees the same input it always has.
  // This read runs only from assess, which the trader calls on the buy path. Exits do not come through here.
  if (!lpUnlockCheck && (!v3LpLockCheck || pool.kind !== 'v3')) return gate;
  const kind = pool.kind === 'v3' ? 'v3' : pool.kind === 'v2' ? 'v2' : 'other';
  const snap = await cachedTokenLp(tokenLpKey(pool.chainId, pool.token), () => lpSnapshot(hub, pool, v3LpLockCheck, lpUnlockCheck, v3Bounds), {
    timeoutMs: LP_CHECK_TIMEOUT_MS,
    fallback: () => ({
      ...(v3LpLockCheck && pool.kind === 'v3' ? { v3: unverifiedV3Lp(pool.pool, '', 'lp check timed out') } : {}),
      ...(lpUnlockCheck ? { lp: unverifiedLpUnlock(kind, 'lp check timed out') } : {}),
    }),
  });
  if (v3LpLockCheck && snap.v3) gate.v3Lp = snap.v3;
  if (lpUnlockCheck && snap.lp) applyLpUnlock(gate, true, snap.lp);
  return gate;
}

async function lpSnapshot(hub: Hub, pool: FreshPool, v3LpLockCheck: boolean, lpUnlockCheck: boolean, v3Bounds: { cacheEnabled: boolean; cacheTtlMs: number; callBudget: number }): Promise<TokenLpSnapshot> {
  const timing = () => {
    const rt = hub.rt(pool.chainId);
    return {
      rt, nowSec: Math.floor(Date.now() / 1000), blockTimeSec: rt.cfg.blockTimeSec, logChunk: rt.cfg.logChunk,
      ...(v3Bounds.cacheEnabled ? { cacheEnabled: true as const, cacheTtlMs: v3Bounds.cacheTtlMs } : {}),
      ...(v3Bounds.callBudget > 0 ? { callBudget: v3Bounds.callBudget } : {}),
    };
  };
  const snap: TokenLpSnapshot = {};
  if (v3LpLockCheck && pool.kind === 'v3') {
    try {
      const t = timing();
      snap.v3 = await readV3LpLock(t.rt.reader as V3LockReader, pool, t.rt.cfg.dexes, t);
    } catch (e) {
      snap.v3 = unverifiedV3Lp(pool.pool, '', `rpc failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  if (!lpUnlockCheck) return snap;
  try {
    const t = timing();
    snap.lp = await readLiveLpUnlock(t.rt.reader as V3LockReader, pool, t.rt.cfg.dexes, t, snap.v3);
  } catch (e) {
    const kind = pool.kind === 'v3' ? 'v3' : pool.kind === 'v2' ? 'v2' : 'other';
    snap.lp = unverifiedLpUnlock(kind, `rpc failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  return snap;
}

async function resolveHit(hub: Hub, hit: import('./sniper').SnipeHit): Promise<FreshPool | null> {
  if (hit.skip || hit.kind === 'v4') return null;
  const rt = hub.rt(hit.chainId);
  const spendable = new Set([rt.cfg.wrappedNative.address, NATIVE_ZERO, NATIVE_EEEE, ...rt.cfg.stables.map((s) => s.address)].map((a) => a.toLowerCase()));
  const t0 = hit.token0.toLowerCase(), t1 = hit.token1.toLowerCase();
  const token = spendable.has(t0) ? t1 : t0;
  const spend = spendable.has(t0) ? t0 : t1;
  try {
    const r = await hub.inspect({ chainId: hit.chainId, address: token, quote: spend, pool: hit.pool });
    const chosen = r.chosen;
    if (!chosen?.mid || !r.token) return null;
    // the pool's own fee (V3 fee(), V2 DEX fee); unknown = can't price it
    const dex = rt.cfg.dexes.find((d) => d.id === chosen.dex) ?? null;
    const feeBps = chosen.feeBps ?? await poolFeeBps(rt.reader, hit.pool, dex);
    if (feeBps == null) return null;
    const usd = r.quote.kind === 'stable' ? 1 : (await hub.nativeUsdAsync(hit.chainId)) ?? 0;
    const liq = r.safety?.liquidityUsd ?? chosen.tvlUsd ?? 0;
    return {
      chainId: hit.chainId, pool: hit.pool, dex: hit.dex, kind: hit.kind, token, spend,
      tokenSymbol: r.token.symbol, spendSymbol: r.quote.symbol, liquidityUsd: liq, volumeUsd: 0, createdAt: null, source: 'snipe',
      quoteReserve: usd > 0 ? (liq / 2) / usd : 0, tokenReserve: chosen.mid > 0 && usd > 0 ? (liq / 2) / usd / chosen.mid : 0,
      feeBps, price: chosen.mid, usdPerSpend: usd || 1,
      ...(dex?.dynamicFee ? { dynamicFee: true } : {}),
    };
  } catch { return null; }
}

export function tokenTraderStore(file: string) { return new JsonStore<TraderState>(file); }
