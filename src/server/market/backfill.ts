/**
 * Candle backfill jobs, per market on any chain.
 *  - GeckoTerminal (primary, fast): native candles for each timeframe, paged backwards with before_timestamp,
 *    by chain slug + pool + base token (price quoted per base).
 *  - On-chain (fallback, slow, trustless): V2 Sync/Swap or V3 Swap(sqrtPriceX96) logs → 1m candles → every timeframe.
 */
import { Interface } from 'ethers';
import { TFS, TF_CAP, TF_SEC, type Candle, type TF } from '../../market/candles';
import type { LiveNetwork } from '../../live/networks';
import type { CandleStore } from './candleStore';
import { RateLimited, type GeckoSource } from './gecko';
import { rebuildFromChain, type LogReader } from './onchain';

const PAIR = new Interface(['function token0() view returns (address)']);

export interface ChainLogReader extends LogReader { call(tx: { to: string; data: string }): Promise<string> }

/** Where a market's candles come from. */
export interface CandleSource {
  key: string;
  label: string;
  /** GeckoTerminal network slug (null = no Gecko coverage, e.g. testnets) */
  network: string | null;
  pool: string;
  kind: 'v2' | 'v3';
  base: { address: string; decimals: number };
  quote: { address: string; decimals: number };
  feeBps: number;
  /** Max getLogs block span for the on-chain fallback */
  logChunk?: number;
}

/** Legacy PulseChain source by quote symbol (scripts / old call sites). */
export function poolOf(net: LiveNetwork, pair: string): CandleSource {
  const q = net.quotes.find((x) => x.symbol === pair);
  if (!q) throw new Error(`Unknown pair ${pair}`);
  if (!q.pool) throw new Error(`No verified pool for PLS/${pair} on ${net.key}`);
  return {
    key: pair, label: `PLS/${pair}`, network: net.isTestnet ? null : 'pulsechain', pool: q.pool, kind: 'v2',
    base: { address: net.pulsex.wpls, decimals: 18 }, quote: { address: q.address, decimals: q.decimals }, feeBps: net.pulsex.feeBps,
  };
}

export async function onchainBackfill(
  reader: ChainLogReader, src: CandleSource, store: CandleStore, days: number,
  onProgress?: (pct: number, msg: string) => void, chunk = src.logChunk ?? 5000,
): Promise<{ candles1m: number; fromSec: number; toSec: number; blocks: number }> {
  const t0 = PAIR.decodeFunctionResult('token0', await reader.call({ to: src.pool, data: PAIR.encodeFunctionData('token0') }))[0] as string;
  const token0IsQuote = t0.toLowerCase() === src.quote.address.toLowerCase();
  const latest = await reader.getBlockNumber();
  const span = Math.min(100_000, latest - 1);
  const [bl, bp] = await Promise.all([reader.getBlock(latest), reader.getBlock(latest - span)]);
  if (!bl || !bp) throw new Error('cannot read block timestamps');
  const blockSec = Math.max(0.05, (bl.timestamp - bp.timestamp) / span);
  const fromBlock = Math.max(1, Math.floor(latest - (days * 86_400) / blockSec));
  const all: Candle[] = [];
  const seg = chunk * 20;
  for (let from = fromBlock; from <= latest; from += seg) {
    const to = Math.min(latest, from + seg - 1);
    const part = await rebuildFromChain(reader, { decimals: src.quote.decimals, pool: src.pool }, {
      token0IsQuote, fromBlock: from, toBlock: to, chunk, feeBps: src.feeBps, kind: src.kind, baseDecimals: src.base.decimals,
    });
    // stitch: a 1m bucket can straddle two segments
    if (part.length && all.length && all[all.length - 1].t === part[0].t) {
      const a = all[all.length - 1], b = part.shift()!;
      a.h = Math.max(a.h, b.h); a.l = Math.min(a.l, b.l); a.c = b.c; a.v += b.v;
    }
    all.push(...part);
    store.mergeFrom1m(src.key, all, 'onchain');
    store.flush();
    onProgress?.(Math.min(1, (to - fromBlock) / Math.max(1, latest - fromBlock)), `${src.label} on-chain: blocks ${from}–${to}, ${all.length} 1m candles`);
  }
  return { candles1m: all.length, fromSec: all[0]?.t ?? 0, toSec: all[all.length - 1]?.t ?? 0, blocks: latest - fromBlock };
}

/** Page GeckoTerminal backwards for one market/timeframe until the cap, the history end, or maxPages. */
export async function geckoBackfill(gecko: GeckoSource, src: CandleSource, store: CandleStore, tf: TF, maxPages = 6): Promise<number> {
  if (!src.network) throw new Error(`${src.label}: no GeckoTerminal coverage`);
  let before: number | undefined;
  let got = 0;
  for (let p = 0; p < maxPages && got < TF_CAP[tf]; p++) {
    const k = await gecko.ohlcv(src.pool, src.base.address, tf, before, 1000, { network: src.network, feeBps: src.feeBps });
    if (!k.length) break;
    store.merge(src.key, tf, k, 'gecko');
    got += k.length;
    before = k[0].t;
    if (k.length < 1000) break;
  }
  return got;
}

/**
 * Background GeckoTerminal scheduler across every market with a Gecko slug: initial backfill per
 * market×timeframe, then round-robin refresh of the newest candles (each series refreshed every max(2 min, tf/2)).
 * Throttling + 429 backoff live in GeckoSource. Markets are re-read on every step (custom markets appear live).
 */
export class CandleSync {
  private due = new Map<string, number>();
  private backfilled = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  lastError: string | null = null;
  lastOkAt: number | null = null;
  enabled = true;

  constructor(
    private readonly gecko: GeckoSource, private readonly sources: () => CandleSource[], private readonly store: CandleStore,
    private readonly opts: { onEvent?: (msg: string, level: 'info' | 'warn') => void; now?: () => number } = {},
  ) {}

  private now() { return (this.opts.now ?? Date.now)(); }
  private list() { return this.sources().filter((s) => s.network && s.pool); }
  get pairs() { return this.list().map((s) => s.key); }
  private src(key: string) { return this.list().find((s) => s.key === key) ?? null; }

  /** Next task: missing backfills first (higher timeframes first: most useful), then the most overdue refresh. */
  nextTask(): { pair: string; tf: TF; kind: 'backfill' | 'refresh' } | null {
    const pairs = this.pairs;
    const order: TF[] = ['1h', '4h', '1d', '15m', '5m', '1m'];
    for (const tf of order) for (const pair of pairs) {
      if (!this.backfilled.has(`${pair}|${tf}`)) return { pair, tf, kind: 'backfill' };
    }
    let best: { pair: string; tf: TF; at: number } | null = null;
    for (const tf of TFS) for (const pair of pairs) {
      const at = this.due.get(`${pair}|${tf}`) ?? 0;
      if (at <= this.now() && (!best || at < best.at)) best = { pair, tf, at };
    }
    return best ? { pair: best.pair, tf: best.tf, kind: 'refresh' } : null;
  }

  async step(): Promise<boolean> {
    const t = this.nextTask();
    if (!t || !this.enabled) return false;
    const key = `${t.pair}|${t.tf}`;
    const src = this.src(t.pair)!;
    try {
      if (t.kind === 'backfill') {
        const n = await geckoBackfill(this.gecko, src, this.store, t.tf, Math.ceil(TF_CAP[t.tf] / 1000));
        this.backfilled.add(key);
        this.opts.onEvent?.(`Candles ${src.label} ${t.tf}: backfilled ${n} from GeckoTerminal`, 'info');
      } else {
        const k = await this.gecko.ohlcv(src.pool, src.base.address, t.tf, undefined, 100, { network: src.network!, feeBps: src.feeBps });
        this.store.merge(t.pair, t.tf, k, 'gecko');
      }
      this.due.set(key, this.now() + Math.max(120_000, (TF_SEC[t.tf] * 1000) / 2));
      this.lastOkAt = this.now();
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      if (!(e instanceof RateLimited)) {
        this.backfilled.add(key); // don't hammer a failing series; retry on refresh cadence
        this.due.set(key, this.now() + 600_000);
      }
      this.opts.onEvent?.(`Candles ${src.label} ${t.tf}: ${this.lastError}`, 'warn');
      return false;
    }
  }

  start(intervalMs = 2600) {
    if (this.timer) return;
    const loop = async () => {
      if (!this.busy && this.pairs.length) { this.busy = true; try { await this.step(); } finally { this.busy = false; } }
      this.timer = setTimeout(loop, Math.max(intervalMs, this.gecko.blockedUntil - this.now()));
    };
    this.timer = setTimeout(loop, 1000);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  status() {
    const n = this.pairs.length;
    return { enabled: this.enabled, backfilled: this.backfilled.size, total: n * TFS.length, markets: n, lastError: this.lastError, lastOkAt: this.lastOkAt, blockedUntil: this.gecko.blockedUntil || null, calls: this.gecko.calls };
  }
}
