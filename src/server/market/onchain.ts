/**
 * Rebuild candles from pool events (no third party).
 *  - V2 (PulseX / 9mm V2 / Uniswap V2): every Sync(reserve0, reserve1) is a price tick
 *    (quote per base from reserves, × (1 − fee) for sell-side units), every Swap adds quote-side volume.
 *  - V3 (Uniswap / PancakeSwap V3): every Swap carries sqrtPriceX96 after the swap → price tick, |amountQuote| → volume.
 * Block timestamps are interpolated linearly inside each chunk (PulseChain ≈10 s blocks), ±1 block accuracy.
 * Slow: ~4k logs per 10k blocks on the DAI pool; public RPC rejects ranges ≳50k blocks, so chunks are 5k.
 */
import { Interface, id } from 'ethers';
import { applyTick, type Candle } from '../../market/candles';
import type { QuoteToken } from '../../live/networks';

async function retry<T>(fn: () => Promise<T>, n = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 700 * i)); }
  }
}

const PAIR_EV = new Interface([
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
]);
export const SYNC_TOPIC = id('Sync(uint112,uint112)');
export const SWAP_TOPIC = id('Swap(address,uint256,uint256,uint256,uint256,address)');
export const V3_SWAP_TOPIC = id('Swap(address,address,int256,int256,uint160,uint128,int24)');
/** PancakeSwap V3 adds protocolFeesToken0/1 */
export const PCS_V3_SWAP_TOPIC = id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');

export interface LogReader {
  getBlockNumber(): Promise<number>;
  getBlock(n: number): Promise<{ timestamp: number } | null>;
  getLogs(f: { address: string; topics: (string | string[])[]; fromBlock: number; toBlock: number }): Promise<readonly { blockNumber: number; index?: number; logIndex?: number; topics: readonly string[]; data: string }[]>;
}

type RawLog = Awaited<ReturnType<LogReader['getLogs']>>[number];

/** getLogs with retries; a range that keeps timing out is split in half (down to 250 blocks). */
export async function getLogsRobust(reader: LogReader, address: string, from: number, to: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), topics: string[] = [SYNC_TOPIC, SWAP_TOPIC]): Promise<RawLog[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return [...await reader.getLogs({ address, topics: [topics], fromBlock: from, toBlock: to })];
    } catch (e) {
      if (attempt === 3 || to - from < 250) {
        if (to - from >= 250) break;
        throw e;
      }
      await sleep(800 * attempt);
    }
  }
  const mid = Math.floor((from + to) / 2);
  return [...await getLogsRobust(reader, address, from, mid, sleep, topics), ...await getLogsRobust(reader, address, mid + 1, to, sleep, topics)];
}

export async function rebuildFromChain(
  reader: LogReader, quote: Pick<QuoteToken, 'decimals' | 'pool'>,
  opts: {
    token0IsQuote: boolean; fromBlock: number; toBlock: number; chunk?: number; concurrency?: number; feeBps?: number;
    onProgress?: (done: number, total: number) => void;
    /** Pool kind (default v2) and base decimals (default 18) */
    kind?: 'v2' | 'v3'; baseDecimals?: number;
  },
): Promise<Candle[]> {
  const chunk = opts.chunk ?? 5000;
  const f = 1 - (opts.feeBps ?? 29) / 10_000;
  const scaleQ = 10 ** quote.decimals;
  const decB = opts.baseDecimals ?? 18;
  const v3 = opts.kind === 'v3';
  const topics = v3 ? [V3_SWAP_TOPIC, PCS_V3_SWAP_TOPIC] : [SYNC_TOPIC, SWAP_TOPIC];
  const oneMin: Candle[] = [];
  const total = opts.toBlock - opts.fromBlock;
  const ranges: [number, number][] = [];
  for (let from = opts.fromBlock; from <= opts.toBlock; from += chunk) ranges.push([from, Math.min(from + chunk - 1, opts.toBlock)]);
  const par = Math.max(1, opts.concurrency ?? 4);
  for (let g = 0; g < ranges.length; g += par) {
    // fetch a group of chunks in parallel, then apply them strictly in block order
    const fetched = await Promise.all(ranges.slice(g, g + par).map(async ([from, to]) => {
      const [logs, b0, b1] = await Promise.all([
        getLogsRobust(reader, quote.pool!, from, to, undefined, topics),
        retry(() => reader.getBlock(from)), retry(() => reader.getBlock(to)),
      ]);
      if (!b0 || !b1) throw new Error(`missing block ${from}/${to}`);
      return { from, to, logs, b0, b1 };
    }));
    for (const { from, to, logs, b0, b1 } of fetched) {
      const ts = (bn: number) => (to === from ? b0.timestamp : b0.timestamp + ((bn - from) * (b1.timestamp - b0.timestamp)) / (to - from));
      const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0));
      // UniswapV2 swap() emits Sync then Swap: a Swap's volume belongs to the candle its Sync just ticked.
      for (const log of sorted) {
        if (v3) {
          // data: amount0 int256, amount1 int256, sqrtPriceX96 uint160, …
          const w = (i: number) => BigInt('0x' + log.data.slice(2 + i * 64, 2 + (i + 1) * 64));
          const signed = (x: bigint) => (x >= 1n << 255n ? x - (1n << 256n) : x);
          const a0 = signed(w(0)), a1 = signed(w(1)), sqrtP = w(2);
          if (sqrtP === 0n) continue;
          const p10 = (Number(sqrtP) / 2 ** 96) ** 2; // raw token1 per raw token0
          const decQ = quote.decimals;
          // quote per base (human): base = token1 when token0 is the quote
          const mid = opts.token0IsQuote ? (1 / p10) * 10 ** (decB - decQ) : p10 * 10 ** (decB - decQ);
          if (mid > 0 && Number.isFinite(mid)) applyTick(oneMin, mid * f, Math.floor(ts(log.blockNumber)), '1m');
          const qAmt = opts.token0IsQuote ? a0 : a1;
          const last = oneMin[oneMin.length - 1];
          if (last) last.v += Math.abs(Number(qAmt)) / scaleQ;
          continue;
        }
        const ev = PAIR_EV.parseLog({ topics: [...log.topics], data: log.data });
        if (!ev) continue;
        if (ev.name === 'Swap') {
          const [a0in, a1in, a0out, a1out] = [ev.args[1], ev.args[2], ev.args[3], ev.args[4]] as bigint[];
          const q = opts.token0IsQuote ? a0in + a0out : a1in + a1out;
          const last = oneMin[oneMin.length - 1];
          if (last) last.v += Number(q) / scaleQ;
        } else {
          const [r0, r1] = [ev.args[0], ev.args[1]] as bigint[];
          const rq = Number(opts.token0IsQuote ? r0 : r1) / scaleQ;
          const rw = Number(opts.token0IsQuote ? r1 : r0) / 10 ** decB;
          if (rq > 0 && rw > 0) applyTick(oneMin, (rq / rw) * f, Math.floor(ts(log.blockNumber)), '1m');
        }
      }
      opts.onProgress?.(to - opts.fromBlock, total);
    }
  }
  return oneMin;
}
