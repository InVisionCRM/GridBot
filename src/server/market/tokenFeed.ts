/**
 * Wires the token trader to the chains this process already uses: GeckoTerminal new/trending pools,
 * the existing safety inspect, and (for live) the chain signer. An Ethereum https MEV URL, when set
 * on the trader, is used only to broadcast the signed transaction.
 */
import { JsonRpcProvider } from 'ethers';
import { NATIVE_EEEE, NATIVE_ZERO } from '../../market/scan';
import { fromTopPool, type FreshPool, type GateInput } from '../../market/tokenTrader';
import { mintInBytecode } from '../../market/tokenChecks';
import { ROUTER } from '../dex/abis';
import { LiveExecutor, type ChainReader } from '../bot/chain';
import { JsonStore, type Store } from '../bot/store';
import type { Emit } from '../bot/activity';
import type { Hub } from '../chains/hub';
import type { GeckoSource } from './gecko';
import { PoolSniper, type LogSource, type SniperChain } from './sniper';
import { TokenTrader, type Position, type TraderState } from '../bot/tokenTrader';

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
  const trader = new TokenTrader({
    store: o.store, emit: o.emit, sniper,
    signerReady: (id) => !!o.hub.rt(id).signer,
    discover: () => discover(o.hub, o.gecko),
    assess: (pool, mode, risk) => assess(o.hub, pool, mode, risk),
    resolve: (hit) => resolveHit(o.hub, hit),
    live: {
      buy: async (pool, spend, limits) => {
        const draft = await draftOf(o.hub, pool);
        const ex = executor(o, draft, pool.chainId, trader.status().options.sniper.mevRpc);
        const q = await ex.quote('buy', spend, limits);
        if (q.block) throw new Error(q.block);
        if (!q.balanceOk) throw new Error(q.balanceNote ?? 'balance');
        if (q.priceImpact > limits.maxPriceImpact) throw new Error(`price impact ${(q.priceImpact * 100).toFixed(2)}% is over the cap`);
        // A Stop all that lands between the quote and the send stops the buy (sells keep running: they are exits).
        const fill = await ex.execute(q, { canSend: () => trader.canBuy(pool.chainId), onSent: () => undefined });
        const usd = fill.amountInHuman * pool.usdPerSpend;
        return { tokens: fill.amountOutHuman, spent: fill.amountInHuman, spentUsd: usd, price: fill.amountOutHuman > 0 ? fill.amountInHuman / fill.amountOutHuman : pool.price, impact: q.priceImpact, tx: fill.txHash };
      },
      sell: async (pos, tokens, limits) => {
        const pool = positionPool(pos);
        const draft = await draftOf(o.hub, pool);
        const ex = executor(o, draft, pos.chainId, trader.status().options.sniper.mevRpc);
        const q = await ex.quote('sell', tokens, limits);
        if (q.block) throw new Error(q.block);
        if (!q.balanceOk) throw new Error(q.balanceNote ?? 'balance');
        if (q.priceImpact > limits.maxPriceImpact) throw new Error(`price impact ${(q.priceImpact * 100).toFixed(2)}% is over the cap`);
        const fill = await ex.execute(q, { canSend: () => trader.status().on, onSent: () => undefined });
        return { quoteOut: fill.amountOutHuman, tokensIn: fill.amountInHuman, price: fill.amountInHuman > 0 ? fill.amountOutHuman / fill.amountInHuman : pos.price, impact: q.priceImpact, tx: fill.txHash };
      },
    },
  });
  return trader;
}

function executor(o: { hub: Hub; approval: 'exact' | 'max'; receiptTimeoutMs: number }, draft: import('../../live/markets').MarketDef, chainId: number, mev: string | null) {
  const signer = o.hub.rt(chainId).signer;
  if (!signer) throw new Error('no signing key');
  const url = chainId === 1 && mev && /^https:\/\//.test(mev) ? mev : null;
  return new LiveExecutor(o.hub.draftQuoter(draft), signer, {
    approval: o.approval, receiptTimeoutMs: o.receiptTimeoutMs,
    sendRaw: url ? (raw) => broadcast(url, raw) : undefined,
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
        const feeBps = dex?.feeBps ?? (dex?.feeTiers?.[0] != null ? dex.feeTiers[0] / 100 : 30);
        const pool = fromTopPool(row, { id: rt.cfg.id, spend, kind: dex?.kind === 'v2' ? 'v2' : 'v3', feeBps }, source);
        if (pool) out.push(pool);
      }
    };
    take(fresh, 'new');
    take(hot, 'trending');
  }
  return out.slice(0, 40);
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
    const usd = r.quote.kind === 'stable' ? 1 : (await hub.nativeUsdAsync(hit.chainId)) ?? 0;
    const liq = r.safety?.liquidityUsd ?? chosen.tvlUsd ?? 0;
    return {
      chainId: hit.chainId, pool: hit.pool, dex: hit.dex, kind: hit.kind, token, spend,
      tokenSymbol: r.token.symbol, spendSymbol: r.quote.symbol, liquidityUsd: liq, volumeUsd: 0, createdAt: null, source: 'snipe',
      quoteReserve: usd > 0 ? (liq / 2) / usd : 0, tokenReserve: chosen.mid > 0 && usd > 0 ? (liq / 2) / usd / chosen.mid : 0,
      feeBps: chosen.feeBps ?? 30, price: chosen.mid, usdPerSpend: usd || 1,
    };
  } catch { return null; }
}

export function tokenTraderStore(file: string) { return new JsonStore<TraderState>(file); }
