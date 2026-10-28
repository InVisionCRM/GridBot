/**
 * Multicall3 read batching. Reads that start in the same turn of the event loop (one poll's price batch, a quote's
 * quoter + slot0 + liquidity + token0, a wallet's balances) go out as one `aggregate3` eth_call instead of one request
 * each. Wraps a chain's reader; everything except `call` and `getBalance` passes straight through.
 *
 * Same answers as direct reads:
 * - Only allow-listed reads are batched: DEX contract views (V2 router getAmountsOut, pair reserves, factories, V3 pool
 *   state, QuoterV2 quotes, position manager views) and ERC-20 balanceOf / decimals on the chain's built-in coins.
 *   A call with `from`, any other selector (token metadata, the safety probe, Arbitrum's NodeInterface precompile,
 *   which contracts can't call) and balanceOf on a custom token go direct: those views don't depend on who asks, a
 *   custom token's code might, so it is never read through Multicall3.
 * - `allowFailure` per call: a call that fails inside the batch is re-run on its own, so its error (revert data,
 *   CALL_EXCEPTION) is exactly what a direct call gives.
 * - QuoterV2's gasEstimate can differ (storage warmed by earlier calls in the batch); nothing reads it.
 *
 * Fallback per chain: no Multicall3 code at the address → this chain reads direct for the rest of the run. A batch
 * that fails as a whole (RPC error, bad answer) → its calls run direct; after 3 such failures in a row the code check
 * runs again.
 */
import { Interface } from 'ethers';
import { ERC20, ERC721_ENUM, FACTORY, PAIR, ROUTER, V3_FACTORY, V3_NPM, V3_POOL, V3_POOL_FEES, V3_POOL_LP, V3_QUOTER } from '../dex/abis';
import type { RuntimeReader } from './runtime';

/** Same address on Ethereum, PulseChain (forked Ethereum's state) and Robinhood Chain (eth_getCode checked 2026-10-27). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MC3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

const sel = (iface: Interface, ...fns: string[]) => fns.map((f) => iface.getFunction(f)!.selector);
/** DEX views: answers don't depend on msg.sender. */
const DEX_SELECTORS = new Set([
  ...sel(ROUTER, 'getAmountsOut', 'factory'),
  ...sel(FACTORY, 'getPair'), ...sel(PAIR, 'getReserves', 'token0', 'token1'),
  ...sel(V3_FACTORY, 'getPool'), ...sel(V3_POOL, 'slot0', 'liquidity', 'fee'), ...sel(V3_POOL_FEES, 'slot0'),
  ...sel(V3_POOL_LP, 'tickSpacing', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128', 'ticks'),
  ...sel(V3_QUOTER, 'quoteExactInputSingle', 'quoteExactInput'),
  ...sel(V3_NPM, 'positions', 'ownerOf'), ...sel(ERC721_ENUM, 'tokenOfOwnerByIndex'),
]);
/** ERC-20 reads batched only on tokens in `trusted` (the chain's built-in coins). */
const TOKEN_SELECTORS = new Set(sel(ERC20, 'balanceOf', 'decimals'));

export interface MulticallStats {
  state: 'unknown' | 'on' | 'off';
  /** Requests this wrapper sent (an aggregate3 counts once) */
  requests: number;
  /** Reads answered from a batch */
  batched: number;
  /** Reads sent on their own (not batchable, alone in their turn, off, or re-run after failing in a batch) */
  direct: number;
  /** Whole batches that failed and ran direct */
  fallbacks: number;
}

type Job =
  | { kind: 'call'; tx: { to: string; data: string }; ok: (v: string) => void; err: (e: unknown) => void }
  | { kind: 'bal'; address: string; ok: (v: bigint) => void; err: (e: unknown) => void };

export interface MulticallOptions {
  /** Most calls in one aggregate3 (keeps one eth_call well under public RPCs' gas caps: a V3 quote can cost ~1M) */
  maxBatch?: number;
  /** Lower-case token addresses whose balanceOf / decimals may be batched */
  trusted?: Set<string>;
  /** Told once when a chain falls back to direct reads for good */
  onOff?: (why: string) => void;
}

export type MulticallReader<R extends RuntimeReader> = R & { readonly multicall: MulticallStats };

export function withMulticall<R extends RuntimeReader>(inner: R, o: MulticallOptions = {}): MulticallReader<R> {
  const maxBatch = o.maxBatch ?? 10;
  const trusted = o.trusted ?? new Set<string>();
  const stats: MulticallStats = { state: inner.getCode ? 'unknown' : 'off', requests: 0, batched: 0, direct: 0, fallbacks: 0 };
  let queue: Job[] = [];
  let scheduled = false;
  let failsInRow = 0;
  let probing: Promise<void> | null = null;

  const directCall = (tx: { to: string; data: string; from?: string }) => { stats.requests++; stats.direct++; return inner.call(tx); };
  const directBal = (a: string) => { stats.requests++; stats.direct++; return inner.getBalance(a); };
  const runDirect = (j: Job) => {
    if (j.kind === 'call') directCall(j.tx).then(j.ok, j.err);
    else directBal(j.address).then(j.ok, j.err);
  };
  const off = (why: string) => { if (stats.state !== 'off') { stats.state = 'off'; o.onOff?.(why); } };
  const probe = () => probing ??= (async () => {
    try {
      stats.requests++;
      const code = await inner.getCode!(MULTICALL3);
      if (!code || code === '0x') off('no Multicall3 contract on this chain'); else { stats.state = 'on'; failsInRow = 0; }
    } catch { /* unknown: try again on the next batch */ } finally { probing = null; }
  })();

  const batchable = (tx: { to?: string; data?: string; from?: string }) => {
    if (!tx.to || !tx.data || tx.from || Object.keys(tx).some((k) => k !== 'to' && k !== 'data' && k !== 'from')) return false;
    const s = tx.data.slice(0, 10).toLowerCase();
    return DEX_SELECTORS.has(s) || (TOKEN_SELECTORS.has(s) && trusted.has(tx.to.toLowerCase()));
  };

  async function send(jobs: Job[]) {
    if (jobs.length === 1 || stats.state === 'off') { jobs.forEach(runDirect); return; }
    if (stats.state === 'unknown') { await probe(); if ((stats.state as MulticallStats['state']) !== 'on') { jobs.forEach(runDirect); return; } }
    const calls = jobs.map((j) => (j.kind === 'call' ? [j.tx.to, true, j.tx.data] : [MULTICALL3, true, MC3.encodeFunctionData('getEthBalance', [j.address])]));
    let res: { success: boolean; returnData: string }[];
    try {
      stats.requests++;
      const raw = await inner.call({ to: MULTICALL3, data: MC3.encodeFunctionData('aggregate3', [calls]) });
      res = MC3.decodeFunctionResult('aggregate3', raw)[0] as { success: boolean; returnData: string }[];
      if (res.length !== jobs.length) throw new Error('aggregate3: wrong number of results');
      failsInRow = 0;
    } catch {
      stats.fallbacks++;
      if (++failsInRow >= 3) { stats.state = 'unknown'; failsInRow = 0; }
      jobs.forEach(runDirect);
      return;
    }
    jobs.forEach((j, i) => {
      const r = res[i];
      if (!r.success) { runDirect(j); return; } // its own error, exactly as a direct call gives it
      if (j.kind === 'call') { stats.batched++; j.ok(r.returnData); return; }
      let v: bigint;
      try { v = MC3.decodeFunctionResult('getEthBalance', r.returnData)[0] as bigint; } catch { runDirect(j); return; }
      stats.batched++;
      j.ok(v);
    });
  }

  const flush = () => {
    scheduled = false;
    const all = queue;
    queue = [];
    for (let i = 0; i < all.length; i += maxBatch) void send(all.slice(i, i + maxBatch));
  };
  const enqueue = (j: Job) => {
    queue.push(j);
    if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
  };

  const call = (tx: { to: string; data: string; from?: string }): Promise<string> => {
    if (stats.state === 'off' || !batchable(tx)) return directCall(tx);
    return new Promise((ok, err) => enqueue({ kind: 'call', tx: { to: tx.to, data: tx.data }, ok, err }));
  };
  const getBalance = (address: string): Promise<bigint> => {
    if (stats.state === 'off') return directBal(address);
    return new Promise((ok, err) => enqueue({ kind: 'bal', address, ok, err }));
  };

  return new Proxy(inner, {
    get(t, p) {
      if (p === 'call') return call;
      if (p === 'getBalance') return getBalance;
      if (p === 'multicall') return stats;
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as MulticallReader<R>;
}
