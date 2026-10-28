/**
 * Wires the token trader to the chains this process already uses: GeckoTerminal new/trending pools,
 * the existing safety inspect, and (for live) the chain signer. An Ethereum https MEV URL, when set
 * on the trader, is used only to broadcast the signed transaction.
 */
import { JsonRpcProvider } from 'ethers';
import { NATIVE_EEEE, NATIVE_ZERO } from '../../market/scan';
import { fromTopPool, type FreshPool, type GateInput } from '../../market/tokenTrader';
import { mintInBytecode } from '../../market/tokenChecks';
import { ERC20, ROUTER } from '../dex/abis';
import { readCall } from '../dex/types';
import { fetchJson } from '../fetchJson';
import { holderApiBase, readHolderConcentration, type HolderChain } from './holderRead';
import { readOwnerPowers } from './ownerRead';
import { LiveExecutor, type ChainReader, type Fill, type Quote, type Quoter, type TxSender } from '../bot/chain';
import type { DexConfig } from '../../live/chains';
import type { SafetyLimits } from '../../live/limits';
import type { SharedNonce, TxGate } from '../bot/txGate';
import { poolFeeBps, readV3FeeBps } from '../dex/poolFee';
import { JsonStore, type Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import type { GeckoSource } from './gecko';
import { PoolSniper, type LogSource, type SniperChain } from './sniper';
import { TokenTrader, type Position, type TraderState } from '../bot/tokenTrader';
import { quoteTradeImpact } from './tradeImpact';

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
}): TokenTrader {
  const sniper = new PoolSniper({ chains: sniperChains(o.hub), source: logSource(o.hub) });
  const trader: TokenTrader = new TokenTrader({
    store: o.store, emit: o.emit, sniper,
    signerReady: (id) => !!o.hub.rt(id).signer,
    discover: () => discover(o.hub, o.gecko),
    assess: (pool, mode, risk) => assess(o.hub, pool, mode, risk),
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
    quoteImpact: (pool, spend) => quoteTradeImpact(o.hub.rt(pool.chainId), pool, spend),
    resolve: (hit) => resolveHit(o.hub, hit),
    ownerPowers: (pool) => readOwnerPowers(o.hub.rt(pool.chainId).reader, pool.chainId, pool.token),
    // dynamic-fee pools: the fee at quote time (never cached)
    feeNow: (p) => readV3FeeBps(o.hub.rt(p.chainId).reader, p.pool),
    live: {
      buy: async (pool, spend, limits) => {
        const draft = await draftOf(o.hub, pool);
        // A Stop all that lands while this buy waits in the chain's queue, or between the quote and the send, stops it
        // (sells keep running: they are exits).
        const { q, fill } = await liveSwap(o.hub.rt(pool.chainId), o.hub.draftQuoter(draft), swapOpts(o, pool.chainId, trader.status().options.sniper.mevRpc), 'buy', spend, limits, sendChecks(trader).buy(pool.chainId));
        const usd = fill.amountInHuman * pool.usdPerSpend;
        return { tokens: fill.amountOutHuman, spent: fill.amountInHuman, spentUsd: usd, price: fill.amountOutHuman > 0 ? fill.amountInHuman / fill.amountOutHuman : pool.price, impact: q.priceImpact, tx: fill.txHash };
      },
      sell: async (pos, tokens, limits) => {
        const pool = positionPool(pos);
        const draft = await draftOf(o.hub, pool);
        const { q, fill } = await liveSwap(o.hub.rt(pos.chainId), o.hub.draftQuoter(draft), swapOpts(o, pos.chainId, trader.status().options.sniper.mevRpc), 'sell', tokens, limits, sendChecks(trader).sell());
        return { quoteOut: fill.amountOutHuman, tokensIn: fill.amountInHuman, price: fill.amountInHuman > 0 ? fill.amountOutHuman / fill.amountInHuman : pos.price, impact: q.priceImpact, tx: fill.txHash };
      },
    },
  });
  return trader;
}

/** The halt checks a token-trader send runs right before it takes a nonce (and again between approve and swap). */
export function sendChecks(trader: Pick<TokenTrader, 'canBuy' | 'status'>) {
  return {
    buy: (chainId: number) => () => trader.canBuy(chainId),
    sell: () => () => trader.status().on,
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
    const fill = await ex.execute(q, { canSend, onSent: () => undefined });
    return { q, fill };
  });
}

function positionPool(p: Position): FreshPool {
  return {
    chainId: p.chainId, pool: p.pool, dex: p.dex, kind: 'v2', token: p.token, spend: p.spend,
    tokenSymbol: p.label.split('/')[0] ?? p.token, spendSymbol: p.spend, liquidityUsd: p.liq, volumeUsd: p.volume,
    createdAt: null, source: p.source === 'snipe' ? 'snipe' : 'new', quoteReserve: p.quoteReserve, tokenReserve: p.tokenReserve,
    feeBps: p.feeBps, price: p.price, usdPerSpend: p.usdPerSpend,
  };
}

async function draftOf(hub: Hub, pool: FreshPool) {
  const r = await hub.inspect({ chainId: pool.chainId, address: pool.token, quote: pool.spend, pool: pool.pool });
  if (!r.draft) throw new Error(r.safety?.reasons?.[0] ?? 'no pool to trade');
  if (!r.safety?.liveAllowed) throw new Error(r.safety?.reasons?.join(' ') || 'safety check does not allow live trading');
  return r.draft;
}

async function discover(hub: Hub, gecko: GeckoSource): Promise<FreshPool[]> {
  const out: FreshPool[] = [];
  for (const rt of hub.runtimes()) {
    if (!rt.tradable || !rt.cfg.geckoSlug || rt.cfg.status !== 'live') continue;
    const spend = [rt.cfg.wrappedNative.address, ...rt.cfg.stables.map((s) => s.address)];
    let fresh: Awaited<ReturnType<GeckoSource['newPools']>> = [];
    let hot: Awaited<ReturnType<GeckoSource['newPools']>> = [];
    try { fresh = await gecko.newPools(rt.cfg.geckoSlug); } catch { /* next chain */ }
    try { hot = await gecko.trendingPools(rt.cfg.geckoSlug); } catch { /* next chain */ }
    const take = (rows: typeof fresh, source: 'new' | 'trending') => {
      for (const row of rows) {
        const dex = rt.cfg.dexes.find((d) => d.gecko === row.dex);
        // V4 rows stay out of the token trader. Labelling them V3 would try to swap a pool id on a V3 router.
        if (dex?.kind === 'v4') continue;
        // feeBps is a placeholder until withPoolFees reads the pool's real fee (V3 fee(), or the DEX's V2 fee)
        const pool = fromTopPool(row, { id: rt.cfg.id, spend, kind: dex?.kind === 'v2' ? 'v2' : 'v3', feeBps: dex?.feeBps ?? 30 }, source);
        if (pool) out.push(pool);
      }
    };
    take(fresh, 'new');
    take(hot, 'trending');
  }
  return withPoolFees(out.slice(0, 40), (id) => hub.rt(id).reader, (p) => hub.rt(p.chainId).cfg.dexes.find((d) => d.gecko === p.dex) ?? null);
}

/**
 * Every discovered pool gets its real fee: V2 = the DEX's fee, V3 = the pool's fee() (one eth_call each). A pool whose
 * fee can't be read is dropped: pricing it at a guessed tier is how 1 % pools were sized as 0.01 % ones. V4 is dropped
 * here too: this trader does not swap it, and a pool id must not be relabelled V3.
 */
export async function withPoolFees(
  pools: FreshPool[], readerFor: (chainId: number) => Pick<ChainReader, 'call'>,
  dexOf: (p: FreshPool) => Pick<DexConfig, 'kind' | 'feeBps' | 'dynamicFee'> | null,
): Promise<FreshPool[]> {
  const read = await Promise.all(pools.map(async (p) => {
    const dex = dexOf(p);
    // Unknown DEX, or V4: this trader does not swap it. A V4 pool id must not be relabelled V3.
    if (!dex || dex.kind === 'v4') return null;
    const feeBps = await poolFeeBps(readerFor(p.chainId), p.pool, dex);
    return feeBps == null ? null : { ...p, kind: dex.kind, feeBps, ...(dex.dynamicFee ? { dynamicFee: true } : {}) };
  }));
  return read.filter((p): p is NonNullable<typeof p> => !!p);
}

async function assess(hub: Hub, pool: FreshPool, mode: 'paper' | 'live', _risk: 'safe' | 'medium' | 'any'): Promise<GateInput> {
  const r = await hub.inspect({ chainId: pool.chainId, address: pool.token, quote: pool.spend, pool: pool.pool });
  const s = r.safety;
  let canMint: boolean | null = null;
  try { canMint = mintInBytecode(await (hub.rt(pool.chainId).reader as Reader).getCode(pool.token)); } catch { canMint = null; }
  return {
    mode, risk: _risk, honeypot: s?.honeypot ?? null, sellSimOk: s ? s.simulated && s.honeypot !== true : false,
    paused: s?.paused ?? null, decimals: s?.decimals ?? r.token?.decimals ?? null,
    buyTax: s?.buyTaxPct ?? null, sellTax: s?.sellTaxPct ?? null,
    liquidityUsd: pool.liquidityUsd, minLiquidityUsd: pool.source === 'snipe' ? 0 : 0,
    canMint, canPause: s?.paused != null ? true : null, canBlacklist: s?.blacklist != null ? true : null,
    // Unknown until the trader's holder check is on. That check fills this in; leaving it null here keeps the gate
    // identical when the check is off, and keeps this function from calling an explorer on every assess.
    proxy: s?.proxy != null ? true : null, lpUnlocked: null, holderConcentration: null, recentLiqPull: false,
    liveAllowed: s?.liveAllowed ?? false,
  };
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
